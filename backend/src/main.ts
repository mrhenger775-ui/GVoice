import cors from "cors";
import cookieParser from "cookie-parser";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Server } from "socket.io";
import { AccessToken } from "livekit-server-sdk";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { verifyAccessToken } from "./lib/auth.js";
import { asyncHandler } from "./lib/async-handler.js";
import { requireAuth } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { channelsRouter } from "./routes/channels.js";
import { messagesRouter } from "./routes/messages.js";
import { isMediaWorkerSource, startMediaJob, stopMediaJob } from "./lib/media-worker.js";

type VoiceParticipant = {
  socketId: string;
  userId: string;
  username: string;
};

type MediaKind = "youtube" | "rutube" | "vkvideo" | "twitch" | "video" | "audio" | "link";
type MediaSessionState = {
  channelId: string;
  isActive: boolean;
  isPaused: boolean;
  mediaUrl: string | null;
  mediaKind: MediaKind | null;
  title: string | null;
  positionSec: number;
  syncedAt: string;
  masterUserId: string | null;
  masterUsername: string | null;
  updatedByUserId: string | null;
  updatedByUsername: string | null;
  updatedAt: string;
};

const voiceRooms = new Map<string, Map<string, VoiceParticipant>>();
const mediaSessions = new Map<string, MediaSessionState>();

function getEmptyMediaSession(channelId: string): MediaSessionState {
  return {
    channelId,
    isActive: false,
    isPaused: false,
    mediaUrl: null,
    mediaKind: null,
    title: null,
    positionSec: 0,
    syncedAt: new Date().toISOString(),
    masterUserId: null,
    masterUsername: null,
    updatedByUserId: null,
    updatedByUsername: null,
    updatedAt: new Date().toISOString()
  };
}

function getMediaKindByUrl(url: string): MediaKind {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com/") || lower.includes("youtu.be/")) {
    return "youtube";
  }
  if (lower.includes("rutube.ru/")) {
    return "rutube";
  }
  if (lower.includes("vkvideo.ru/") || lower.includes("vk.com/video") || lower.includes("m.vk.com/video")) {
    return "vkvideo";
  }
  if (lower.includes("twitch.tv/") || lower.includes("clips.twitch.tv/")) {
    return "twitch";
  }
  if (/\.(mp4|webm|m4v|mov|mkv|avi)(\?|#|$)/i.test(lower)) {
    return "video";
  }
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|#|$)/i.test(lower)) {
    return "audio";
  }
  return "link";
}

function normalizeMediaUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getVoiceParticipants(channelId: string): VoiceParticipant[] {
  const participants = voiceRooms.get(channelId);
  if (!participants) {
    return [];
  }
  return Array.from(participants.values());
}

const app = express();
const allowedOrigins = new Set<string>([
  env.FRONTEND_ORIGIN,
  "capacitor://localhost",
  "http://localhost",
  "https://localhost"
]);

const corsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  if (!origin || allowedOrigins.has(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`CORS origin blocked: ${origin}`));
};

app.use(cors({
  origin: corsOrigin,
  credentials: true,
  exposedHeaders: ["x-gvoice-access-token"]
}));
app.use(cookieParser());
app.use(express.json());
app.use("/uploads", express.static(path.join(process.cwd(), "backend", "uploads")));
app.use("/media", express.static(path.join(process.cwd(), "backend", "uploads", "media")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gvoice-backend" });
});

app.get("/voice/ice", requireAuth, (_req, res) => {
  const stunUrls = env.VOICE_STUN_URLS.split(",").map((item) => item.trim()).filter(Boolean);
  const turnUrls = (env.VOICE_TURN_URLS ?? "").split(",").map((item) => item.trim()).filter(Boolean);

  const iceServers: Array<{ urls: string[] | string; username?: string; credential?: string }> = [];

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length > 0 && env.VOICE_TURN_USERNAME && env.VOICE_TURN_PASSWORD) {
    iceServers.push({
      urls: turnUrls,
      username: env.VOICE_TURN_USERNAME,
      credential: env.VOICE_TURN_PASSWORD
    });
  }

  res.json({ iceServers });
});

app.post("/voice/livekit-token", requireAuth, asyncHandler(async (req, res) => {
  const { channelId } = req.body as { channelId?: string };
  if (!channelId) {
    res.status(400).json({ error: "channelId is required" });
    return;
  }

  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    res.status(503).json({ error: "LiveKit is not configured" });
    return;
  }

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: { members: { where: { userId: req.auth!.userId }, select: { userId: true } } }
  });

  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const workspaceMember = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: req.auth!.userId } },
    select: { userId: true }
  });

  if (!workspaceMember || (channel.isPrivate && channel.members.length === 0)) {
    res.status(403).json({ error: "No channel access" });
    return;
  }

  if (channel.type !== "voice") {
    res.status(400).json({ error: "LiveKit tokens are available only for voice channels" });
    return;
  }

  const roomName = `voice-${channelId}`;
  const livekitIdentity = `${req.auth!.userId}:${randomUUID()}`;
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: livekitIdentity,
    name: req.auth!.username
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true
  });
  const token = await at.toJwt();

  res.json({
    url: env.LIVEKIT_URL,
    token,
    roomName
  });
}));

app.get("/channels/:channelId/voice-participants", requireAuth, asyncHandler(async (req, res) => {
  const { channelId } = req.params;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: { members: { where: { userId: req.auth!.userId }, select: { userId: true } } }
  });

  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const workspaceMember = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: req.auth!.userId } },
    select: { userId: true }
  });

  if (!workspaceMember || (channel.isPrivate && channel.members.length === 0)) {
    res.status(403).json({ error: "No channel access" });
    return;
  }

  if (channel.type !== "voice") {
    res.json([]);
    return;
  }

  res.json(getVoiceParticipants(channelId));
}));

// Fallback search endpoint kept at app level to avoid route-order/cache surprises.
app.get("/workspaces/search", requireAuth, asyncHandler(async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";

  if (query.length < 1) {
    res.json([]);
    return;
  }

  const found = await prisma.workspace.findMany({
    where: {
      OR: [{ name: { contains: query } }, { slug: { contains: query } }]
    },
    select: {
      id: true,
      name: true,
      slug: true,
      joinPolicy: true,
      owner: { select: { username: true } },
      members: {
        where: { userId: req.auth!.userId },
        select: { userId: true }
      },
      joinRequests: {
        where: { userId: req.auth!.userId },
        select: { status: true }
      }
    },
    orderBy: { createdAt: "desc" },
    take: 20
  });

  res.json(
    found.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      joinPolicy: workspace.joinPolicy,
      ownerUsername: workspace.owner.username,
      isMember: workspace.members.length > 0,
      joinRequestStatus: workspace.joinRequests[0]?.status ?? null
    }))
  );
}));

app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/workspaces", workspacesRouter);
app.use(channelsRouter);
app.use(messagesRouter);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled API error:", error);
  res.status(500).json({
    error: "Internal server error",
    details: error instanceof Error ? error.message : "Unknown error"
  });
});

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    credentials: true
  }
});

function broadcastVoiceParticipants(channelId: string) {
  const participants = getVoiceParticipants(channelId);
  io.to(`voice:${channelId}`).emit("voice:participants", { channelId, participants });
  io.to(`channel:${channelId}`).emit("voice:participants", { channelId, participants });
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token as string | undefined;
  if (!token) {
    next(new Error("Unauthorized"));
    return;
  }

  try {
    const payload = verifyAccessToken(token.replace(/^Bearer\s+/i, ""));
    socket.data.userId = payload.sub;
    socket.data.username = payload.username;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  socket.emit("system", { text: "Connected to GVoice socket" });

  async function getAccessibleChannel(channelId: string) {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      include: { members: { where: { userId: socket.data.userId }, select: { userId: true } } }
    });

    if (!channel) {
      return null;
    }

    const workspaceMember = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: channel.workspaceId,
          userId: socket.data.userId
        }
      },
      select: { userId: true }
    });

    if (!workspaceMember || (channel.isPrivate && channel.members.length === 0)) {
      return null;
    }

    return channel;
  }

  function leaveAllVoiceRooms() {
    for (const [channelId, participants] of voiceRooms.entries()) {
      const removed = participants.get(socket.id);
      if (!removed) {
        continue;
      }

      participants.delete(socket.id);
      socket.leave(`voice:${channelId}`);
      io.to(`voice:${channelId}`).emit("voice:user-left", {
        channelId,
        socketId: socket.id,
        userId: removed.userId,
        username: removed.username
      });
      io.to(`channel:${channelId}`).emit("voice:user-left", {
        channelId,
        socketId: socket.id,
        userId: removed.userId,
        username: removed.username
      });
      broadcastVoiceParticipants(channelId);

      if (participants.size === 0) {
        voiceRooms.delete(channelId);
      }
    }
  }

  socket.on("workspace:join", async ({ workspaceId }: { workspaceId: string }) => {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: socket.data.userId } },
      select: { userId: true }
    });

    if (!membership) {
      socket.emit("error", { code: "FORBIDDEN", message: "Not workspace member" });
      return;
    }

    socket.join(`workspace:${workspaceId}`);
  });

  socket.on("channel:join", async ({ channelId }: { channelId: string }) => {
    const channel = await getAccessibleChannel(channelId);

    if (!channel) {
      socket.emit("error", { code: "FORBIDDEN", message: "No channel access" });
      return;
    }

    socket.join(`channel:${channelId}`);
    const mediaState = mediaSessions.get(channelId) ?? getEmptyMediaSession(channelId);
    socket.emit("media:state", mediaState);
    if (channel.type === "voice") {
      socket.emit("voice:participants", { channelId, participants: getVoiceParticipants(channelId) });
    }
  });

  socket.on(
    "media:get",
    async ({ channelId }: { channelId: string }) => {
      const channel = await getAccessibleChannel(channelId);
      if (!channel) {
        socket.emit("error", { code: "FORBIDDEN", message: "No channel access" });
        return;
      }
      socket.emit("media:state", mediaSessions.get(channelId) ?? getEmptyMediaSession(channelId));
    }
  );

  socket.on(
    "media:command",
    async ({
      channelId,
      command,
      url,
      positionSec
    }: {
      channelId: string;
      command: "play" | "pause" | "resume" | "seek" | "stop";
      url?: string;
      positionSec?: number;
    }) => {
      const channel = await getAccessibleChannel(channelId);
      if (!channel) {
        socket.emit("error", { code: "FORBIDDEN", message: "No channel access" });
        return;
      }

      let state = mediaSessions.get(channelId) ?? getEmptyMediaSession(channelId);

      const normalizedPosition =
        typeof positionSec === "number" && Number.isFinite(positionSec) && positionSec >= 0
          ? positionSec
          : Math.max(0, state.positionSec || 0);

      const isPlay = command === "play";
      const isMaster = state.masterUserId === socket.data.userId;
      if (!isPlay && state.masterUserId && !isMaster) {
        socket.emit("error", { code: "FORBIDDEN", message: `Только мастер (${state.masterUsername ?? "неизвестно"}) может управлять плеером` });
        return;
      }

      if (command === "play") {
        const normalized = normalizeMediaUrl(url ?? "");
        if (!normalized) {
          socket.emit("error", { code: "BAD_REQUEST", message: "Некорректная ссылка для /play" });
          return;
        }
        let resolvedMediaUrl = normalized;
        let resolvedMediaKind = getMediaKindByUrl(normalized);

        if (isMediaWorkerSource(normalized)) {
          try {
            const mediaResult = await startMediaJob(channelId, normalized);
            resolvedMediaUrl = mediaResult.mediaUrl;
            resolvedMediaKind = mediaResult.kind;
          } catch (error) {
            const message = error instanceof Error ? error.message : "unknown media-worker error";
            socket.emit("error", { code: "MEDIA_WORKER_FAILED", message: `Media-worker error: ${message}` });
            return;
          }
        } else {
          await stopMediaJob(channelId);
        }

        state = {
          channelId,
          isActive: true,
          isPaused: false,
          mediaUrl: resolvedMediaUrl,
          mediaKind: resolvedMediaKind,
          title: null,
          positionSec: normalizedPosition > 0 ? normalizedPosition : 0,
          syncedAt: new Date().toISOString(),
          masterUserId: socket.data.userId,
          masterUsername: socket.data.username,
          updatedByUserId: socket.data.userId,
          updatedByUsername: socket.data.username,
          updatedAt: new Date().toISOString()
        };
        mediaSessions.set(channelId, state);
      } else if (command === "pause") {
        state = {
          ...state,
          isPaused: true,
          positionSec: normalizedPosition,
          syncedAt: new Date().toISOString(),
          updatedByUserId: socket.data.userId,
          updatedByUsername: socket.data.username,
          updatedAt: new Date().toISOString()
        };
        mediaSessions.set(channelId, state);
      } else if (command === "resume") {
        state = {
          ...state,
          isPaused: false,
          positionSec: normalizedPosition,
          syncedAt: new Date().toISOString(),
          updatedByUserId: socket.data.userId,
          updatedByUsername: socket.data.username,
          updatedAt: new Date().toISOString()
        };
        mediaSessions.set(channelId, state);
      } else if (command === "seek") {
        state = {
          ...state,
          positionSec: normalizedPosition,
          syncedAt: new Date().toISOString(),
          updatedByUserId: socket.data.userId,
          updatedByUsername: socket.data.username,
          updatedAt: new Date().toISOString()
        };
        mediaSessions.set(channelId, state);
      } else if (command === "stop") {
        await stopMediaJob(channelId);
        state = {
          channelId,
          isActive: false,
          isPaused: false,
          mediaUrl: null,
          mediaKind: null,
          title: null,
          positionSec: 0,
          syncedAt: new Date().toISOString(),
          masterUserId: null,
          masterUsername: null,
          updatedByUserId: socket.data.userId,
          updatedByUsername: socket.data.username,
          updatedAt: new Date().toISOString()
        };
        mediaSessions.set(channelId, state);
      } else {
        socket.emit("error", { code: "BAD_REQUEST", message: "Неизвестная media-команда" });
        return;
      }

      io.to(`channel:${channelId}`).emit("media:state", state);
    }
  );

  socket.on("voice:join", async ({ channelId }: { channelId: string }) => {
    const channel = await getAccessibleChannel(channelId);
    if (!channel || channel.type !== "voice") {
      socket.emit("error", { code: "FORBIDDEN", message: "No voice access" });
      return;
    }

    let participants = voiceRooms.get(channelId);
    if (!participants) {
      participants = new Map<string, VoiceParticipant>();
      voiceRooms.set(channelId, participants);
    }

    participants.set(socket.id, {
      socketId: socket.id,
      userId: socket.data.userId,
      username: socket.data.username
    });

    socket.join(`voice:${channelId}`);
    broadcastVoiceParticipants(channelId);
    socket.to(`voice:${channelId}`).emit("voice:user-joined", {
      channelId,
      participant: {
        socketId: socket.id,
        userId: socket.data.userId,
        username: socket.data.username
      }
    });
    socket.to(`channel:${channelId}`).emit("voice:user-joined", {
      channelId,
      participant: {
        socketId: socket.id,
        userId: socket.data.userId,
        username: socket.data.username
      }
    });
  });

  socket.on("voice:get-participants", async ({ channelId }: { channelId: string }) => {
    const channel = await getAccessibleChannel(channelId);
    if (!channel || channel.type !== "voice") {
      socket.emit("error", { code: "FORBIDDEN", message: "No voice access" });
      return;
    }

    socket.emit("voice:participants", { channelId, participants: getVoiceParticipants(channelId) });
  });

  socket.on("voice:leave", ({ channelId }: { channelId: string }) => {
    const participants = voiceRooms.get(channelId);
    if (!participants) {
      return;
    }

    const removed = participants.get(socket.id);
    if (!removed) {
      return;
    }

    participants.delete(socket.id);
    socket.leave(`voice:${channelId}`);
    io.to(`voice:${channelId}`).emit("voice:user-left", {
      channelId,
      socketId: socket.id,
      userId: removed.userId,
      username: removed.username
    });
    io.to(`channel:${channelId}`).emit("voice:user-left", {
      channelId,
      socketId: socket.id,
      userId: removed.userId,
      username: removed.username
    });
    broadcastVoiceParticipants(channelId);

    if (participants.size === 0) {
      voiceRooms.delete(channelId);
    }
  });

  socket.on("voice:signal", ({ channelId, targetSocketId, data }: { channelId: string; targetSocketId: string; data: unknown }) => {
    const participants = voiceRooms.get(channelId);
    if (!participants) {
      return;
    }

    if (!participants.has(socket.id) || !participants.has(targetSocketId)) {
      return;
    }

    io.to(targetSocketId).emit("voice:signal", {
      channelId,
      fromSocketId: socket.id,
      fromUserId: socket.data.userId,
      fromUsername: socket.data.username,
      data
    });
  });

  socket.on("voice:screen-share-state", ({ channelId, isSharing }: { channelId: string; isSharing: boolean }) => {
    const participants = voiceRooms.get(channelId);
    if (!participants || !participants.has(socket.id)) {
      return;
    }

    socket.to(`voice:${channelId}`).emit("voice:screen-share-state", {
      channelId,
      socketId: socket.id,
      userId: socket.data.userId,
      username: socket.data.username,
      isSharing: Boolean(isSharing)
    });
  });

  socket.on("voice:mic-state", ({ channelId, isMuted }: { channelId: string; isMuted: boolean }) => {
    const participants = voiceRooms.get(channelId);
    if (!participants || !participants.has(socket.id)) {
      return;
    }

    socket.to(`voice:${channelId}`).emit("voice:mic-state", {
      channelId,
      socketId: socket.id,
      userId: socket.data.userId,
      username: socket.data.username,
      isMuted: Boolean(isMuted)
    });
  });

  socket.on("chat:send", async ({ channelId, body, clientMsgId }: { channelId: string; body: string; clientMsgId?: string }) => {
    if (!body || body.length > 4000) {
      socket.emit("error", { code: "BAD_REQUEST", message: "Message body is invalid" });
      return;
    }

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      include: { members: { where: { userId: socket.data.userId }, select: { userId: true } } }
    });

    if (!channel) {
      socket.emit("error", { code: "NOT_FOUND", message: "Channel not found" });
      return;
    }

    const workspaceMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: socket.data.userId } },
      select: { userId: true }
    });

    if (!workspaceMember || (channel.isPrivate && channel.members.length === 0)) {
      socket.emit("error", { code: "FORBIDDEN", message: "No channel access" });
      return;
    }

    const message = await prisma.message.create({
      data: {
        channelId,
        authorId: socket.data.userId,
        body
      },
      include: { author: { select: { id: true, username: true, avatarUrl: true } } }
    });

    io.to(`channel:${channelId}`).emit("chat:message", message);

    if (clientMsgId) {
      socket.emit("chat:ack", { clientMsgId, messageId: message.id });
    }
  });

  socket.on("profile:refresh", async () => {
    const user = await prisma.user.findUnique({
      where: { id: socket.data.userId },
      select: { id: true, username: true, avatarUrl: true }
    });
    if (!user) {
      return;
    }
    io.emit("user:profile-updated", {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl ?? null
    });
  });

  socket.on("disconnect", () => {
    leaveAllVoiceRooms();
  });
});

server.listen(env.PORT, () => {
  console.log(`GVoice backend started: http://localhost:${env.PORT}`);
});

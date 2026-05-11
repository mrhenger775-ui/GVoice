import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { asyncHandler } from "../lib/async-handler.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const createMessageSchema = z.object({
  body: z.string().max(4000).optional()
});
const updateMessageSchema = z.object({
  body: z.string().min(1).max(4000)
});

const uploadsDir = path.join(process.cwd(), "backend", "uploads", "chat");
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname).slice(0, 12);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
    }
  }),
  limits: { fileSize: 60 * 1024 * 1024 }
});

export const messagesRouter = Router();

function uploadSingleAttachment(req: unknown, res: unknown) {
  return new Promise<void>((resolve, reject) => {
    upload.single("attachment")(req as never, res as never, (err: unknown) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

messagesRouter.get("/channels/:channelId/messages", requireAuth, asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const limit = Math.min(Number(req.query.limit ?? 1000), 1000);
  const cursor = typeof req.query.cursor === "string" ? new Date(req.query.cursor) : null;

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

  if (!workspaceMember) {
    res.status(403).json({ error: "Not a workspace member" });
    return;
  }

  if (channel.isPrivate && channel.members.length === 0) {
    res.status(403).json({ error: "No channel access" });
    return;
  }

  const messages = await prisma.message.findMany({
    where: {
      channelId,
      ...(cursor ? { createdAt: { lt: cursor } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      author: {
        select: { id: true, username: true, avatarUrl: true }
      }
    }
  });

  res.json(messages);
}));

messagesRouter.post("/channels/:channelId/messages", requireAuth, asyncHandler(async (req, res) => {
  try {
    await uploadSingleAttachment(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ошибка загрузки файла";
    if (message.toLowerCase().includes("file too large")) {
      res.status(413).json({ error: "Файл слишком большой. Максимум 60 МБ." });
      return;
    }
    res.status(400).json({ error: `Ошибка загрузки файла: ${message}` });
    return;
  }

  const parsed = createMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

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

  if (!workspaceMember) {
    res.status(403).json({ error: "Not a workspace member" });
    return;
  }

  if (channel.isPrivate && channel.members.length === 0) {
    res.status(403).json({ error: "No channel access" });
    return;
  }

  const body = (parsed.data.body ?? "").trim();
  const attachment = req.file;
  if (!body && !attachment) {
    res.status(400).json({ error: "Message body or attachment is required" });
    return;
  }

  const message = await prisma.message.create({
    data: {
      channelId,
      authorId: req.auth!.userId,
      body,
      attachmentUrl: attachment ? `/uploads/chat/${attachment.filename}` : null,
      attachmentName: attachment?.originalname ?? null,
      attachmentMime: attachment?.mimetype ?? null,
      attachmentSize: attachment?.size ?? null
    },
    include: {
      author: {
        select: { id: true, username: true, avatarUrl: true }
      }
    }
  });

  res.status(201).json(message);
}));

messagesRouter.put("/channels/:channelId/messages/:messageId", requireAuth, asyncHandler(async (req, res) => {
  const parsed = updateMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { channelId, messageId } = req.params;
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

  if (!workspaceMember) {
    res.status(403).json({ error: "Not a workspace member" });
    return;
  }

  if (channel.isPrivate && channel.members.length === 0) {
    res.status(403).json({ error: "No channel access" });
    return;
  }

  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, channelId: true, authorId: true }
  });

  if (!existing || existing.channelId !== channelId) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  if (existing.authorId !== req.auth!.userId) {
    res.status(403).json({ error: "You can edit only your own messages" });
    return;
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      body: parsed.data.body,
      editedAt: new Date()
    },
    include: {
      author: {
        select: { id: true, username: true, avatarUrl: true }
      }
    }
  });

  res.json(updated);
}));

messagesRouter.delete("/channels/:channelId/messages/:messageId", requireAuth, asyncHandler(async (req, res) => {
  const { channelId, messageId } = req.params;
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
    select: { userId: true, role: true }
  });

  if (!workspaceMember) {
    res.status(403).json({ error: "Not a workspace member" });
    return;
  }

  if (channel.isPrivate && channel.members.length === 0) {
    res.status(403).json({ error: "No channel access" });
    return;
  }

  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, channelId: true, attachmentUrl: true, authorId: true }
  });

  if (!existing || existing.channelId !== channelId) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  const canDeleteForeignMessages = workspaceMember.role === "owner" || workspaceMember.role === "admin" || workspaceMember.role === "moderator";
  const isOwnMessage = existing.authorId === req.auth!.userId;
  if (!isOwnMessage && !canDeleteForeignMessages) {
    res.status(403).json({ error: "You can delete only your own messages" });
    return;
  }

  await prisma.message.delete({ where: { id: messageId } });

  if (existing.attachmentUrl?.startsWith("/uploads/chat/")) {
    const filename = path.basename(existing.attachmentUrl);
    const filePath = path.join(uploadsDir, filename);
    fs.promises.unlink(filePath).catch(() => undefined);
  }

  res.status(204).send();
}));

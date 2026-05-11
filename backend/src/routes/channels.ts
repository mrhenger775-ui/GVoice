import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const createChannelSchema = z.object({
  name: z.string().min(2).max(80),
  type: z.enum(["text", "voice"]),
  isPrivate: z.boolean().optional().default(false)
});

const updateChannelSchema = z.object({
  name: z.string().min(2).max(80)
});

const inviteToChannelSchema = z.object({
  username: z.string().min(3).max(48).regex(/^[a-zA-Z0-9_#]+$/)
});

async function getWorkspaceRole(workspaceId: string, userId: string): Promise<string | null> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true }
  });

  return membership?.role ?? null;
}

function canManageChannels(role: string | null): boolean {
  return role === "owner" || role === "admin" || role === "moderator";
}

export const channelsRouter = Router();

channelsRouter.get("/channels/search", requireAuth, asyncHandler(async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;

  if (query.length < 1) {
    res.json([]);
    return;
  }

  if (workspaceId) {
    const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
    if (!role) {
      res.status(403).json({ error: "Not a workspace member" });
      return;
    }
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: req.auth!.userId },
    select: { workspaceId: true }
  });

  const allowedWorkspaceIds = memberships.map((membership) => membership.workspaceId);
  if (allowedWorkspaceIds.length === 0) {
    res.json([]);
    return;
  }

  const channels = await prisma.channel.findMany({
    where: {
      workspaceId: workspaceId ?? { in: allowedWorkspaceIds },
      name: { contains: query },
      OR: [
        { isPrivate: false },
        { members: { some: { userId: req.auth!.userId } } }
      ]
    },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true }
      }
    },
    orderBy: [{ workspaceId: "asc" }, { name: "asc" }],
    take: 30
  });

  res.json(
    channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      isPrivate: channel.isPrivate,
      workspace: channel.workspace
    }))
  );
}));

channelsRouter.get("/workspaces/:workspaceId/channels", requireAuth, asyncHandler(async (req, res) => {
  const { workspaceId } = req.params;

  const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (!role) {
    res.status(403).json({ error: "Not a workspace member" });
    return;
  }

  const channels = await prisma.channel.findMany({
    where: {
      workspaceId,
      OR: [
        { isPrivate: false },
        { members: { some: { userId: req.auth!.userId } } }
      ]
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, type: true, isPrivate: true }
  });

  res.json(channels);
}));

channelsRouter.post("/workspaces/:workspaceId/channels", requireAuth, asyncHandler(async (req, res) => {
  const { workspaceId } = req.params;
  const parsed = createChannelSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (!canManageChannels(role)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const channel = await prisma.channel.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      type: parsed.data.type,
      isPrivate: parsed.data.isPrivate,
      createdBy: req.auth!.userId,
      members: parsed.data.isPrivate
        ? {
            create: [{ userId: req.auth!.userId }]
          }
        : undefined
    },
    select: { id: true, name: true, type: true, isPrivate: true }
  });

  res.status(201).json(channel);
}));

channelsRouter.patch("/channels/:channelId", requireAuth, asyncHandler(async (req, res) => {
  const parsed = updateChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { channelId } = req.params;
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, workspaceId: true }
  });

  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const role = await getWorkspaceRole(channel.workspaceId, req.auth!.userId);
  if (!canManageChannels(role)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const updated = await prisma.channel.update({
    where: { id: channelId },
    data: { name: parsed.data.name },
    select: { id: true, name: true, type: true, isPrivate: true }
  });

  res.json(updated);
}));

channelsRouter.delete("/channels/:channelId", requireAuth, asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, workspaceId: true }
  });

  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const role = await getWorkspaceRole(channel.workspaceId, req.auth!.userId);
  if (!canManageChannels(role)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  await prisma.channel.delete({ where: { id: channelId } });
  res.json({ ok: true });
}));

channelsRouter.post("/channels/:channelId/invite", requireAuth, asyncHandler(async (req, res) => {
  const parsed = inviteToChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { channelId } = req.params;
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: {
      workspace: {
        select: { ownerId: true }
      }
    }
  });

  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const inviterMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: channel.workspaceId,
        userId: req.auth!.userId
      }
    },
    select: { role: true }
  });

  if (!inviterMembership) {
    res.status(403).json({ error: "Not a workspace member" });
    return;
  }

  const inviterIsPrivileged =
    inviterMembership.role === "owner" ||
    inviterMembership.role === "admin" ||
    inviterMembership.role === "moderator" ||
    channel.createdBy === req.auth!.userId ||
    channel.workspace.ownerId === req.auth!.userId;

  if (!inviterIsPrivileged) {
    res.status(403).json({ error: "Insufficient permissions to invite" });
    return;
  }

  const match = parsed.data.username.trim().match(/^([a-zA-Z0-9_]+)#(\d+)$/);
  let targetUser: { id: string; username: string } | null = null;

  if (match) {
    const [, username, numericIdRaw] = match;
    targetUser = await prisma.user.findFirst({
      where: { username, numericId: Number(numericIdRaw) },
      select: { id: true, username: true }
    });
  } else {
    const users = await prisma.user.findMany({
      where: { username: parsed.data.username },
      select: { id: true, username: true, numericId: true },
      take: 2
    });
    if (users.length > 1) {
      res.status(409).json({ error: "Username is ambiguous. Use format username#id" });
      return;
    }
    targetUser = users[0] ? { id: users[0].id, username: users[0].username } : null;
  }

  if (!targetUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const targetWorkspaceMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: channel.workspaceId,
        userId: targetUser.id
      }
    },
    select: { userId: true }
  });

  let addedToWorkspace = false;
  if (!targetWorkspaceMembership) {
    await prisma.workspaceMember.create({
      data: {
        workspaceId: channel.workspaceId,
        userId: targetUser.id,
        role: "member"
      }
    });
    addedToWorkspace = true;
  }

  await prisma.channelMember.upsert({
    where: {
      channelId_userId: {
        channelId,
        userId: targetUser.id
      }
    },
    update: {},
    create: {
      channelId,
      userId: targetUser.id
    }
  });

  res.json({
    ok: true,
    channelId,
    invitedUser: targetUser,
    addedToWorkspace
  });
}));

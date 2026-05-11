import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const createWorkspaceSchema = z.object({
  name: z.string().min(2).max(80),
  joinPolicy: z.enum(["open", "request"]).optional()
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  joinPolicy: z.enum(["open", "request"]).optional()
});

const updateMemberRoleSchema = z.object({
  role: z.enum(["admin", "moderator", "member"])
});

const joinRequestActionSchema = z.object({
  action: z.enum(["approve", "reject"])
});

const createInviteLinkSchema = z.object({
  expiresInDays: z.number().int().min(1).max(30).optional()
});

const joinByInviteSchema = z.object({
  token: z.string().min(10)
});

export const workspacesRouter = Router();

type WorkspaceInvitePayload = {
  typ: "workspace_invite";
  wid: string;
};

function signWorkspaceInviteToken(workspaceId: string, expiresInDays = 7): string {
  return jwt.sign({ typ: "workspace_invite", wid: workspaceId } satisfies WorkspaceInvitePayload, env.JWT_ACCESS_SECRET, {
    expiresIn: `${expiresInDays}d`
  });
}

function verifyWorkspaceInviteToken(token: string): WorkspaceInvitePayload {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as Partial<WorkspaceInvitePayload>;
  if (payload.typ !== "workspace_invite" || typeof payload.wid !== "string" || !payload.wid) {
    throw new Error("Invalid invite token");
  }
  return payload as WorkspaceInvitePayload;
}

async function allocateNextWorkspaceSlug(): Promise<string> {
  const items = await prisma.workspace.findMany({ select: { slug: true } });
  let maxNumeric = 0;
  for (const item of items) {
    if (/^\d+$/.test(item.slug)) {
      maxNumeric = Math.max(maxNumeric, Number(item.slug));
    }
  }
  return String(maxNumeric + 1);
}

async function isWorkspaceNameTaken(name: string, excludeWorkspaceId?: string): Promise<boolean> {
  const normalized = name.trim().toLowerCase();
  const items = await prisma.workspace.findMany({
    where: excludeWorkspaceId ? { id: { not: excludeWorkspaceId } } : undefined,
    select: { name: true }
  });
  return items.some((item) => item.name.trim().toLowerCase() === normalized);
}

async function getWorkspaceRole(workspaceId: string, userId: string): Promise<string | null> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true }
  });

  return membership?.role ?? null;
}

workspacesRouter.get("/", requireAuth, asyncHandler(async (req, res) => {
  const items = await prisma.workspaceMember.findMany({
    where: { userId: req.auth!.userId },
    include: { workspace: true },
    orderBy: { joinedAt: "desc" }
  });

  res.json(
    items.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      joinPolicy: m.workspace.joinPolicy,
      role: m.role
    }))
  );
}));

workspacesRouter.post("/", requireAuth, asyncHandler(async (req, res) => {
  const parsed = createWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { name, joinPolicy } = parsed.data;
  if (await isWorkspaceNameTaken(name)) {
    res.status(409).json({ error: "Workspace name already exists" });
    return;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const slug = await allocateNextWorkspaceSlug();
    try {
      const workspace = await prisma.workspace.create({
        data: {
          name,
          slug,
          joinPolicy: joinPolicy ?? "request",
          ownerId: req.auth!.userId,
          members: {
            create: {
              userId: req.auth!.userId,
              role: "owner"
            }
          },
          channels: {
            create: {
              name: "general",
              type: "text",
              isPrivate: false,
              createdBy: req.auth!.userId
            }
          }
        },
        select: { id: true, name: true, slug: true, joinPolicy: true }
      });

      res.status(201).json(workspace);
      return;
    } catch {
      // Retry if another concurrent request used the same numeric id.
    }
  }
  res.status(409).json({ error: "Failed to allocate workspace id" });
}));

workspacesRouter.patch("/:workspaceId", requireAuth, asyncHandler(async (req, res) => {
  const parsed = updateWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { workspaceId } = req.params;
  const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (!role || (role !== "owner" && role !== "admin")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  if (parsed.data.name && await isWorkspaceNameTaken(parsed.data.name, workspaceId)) {
    res.status(409).json({ error: "Workspace name already exists" });
    return;
  }

  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.joinPolicy ? { joinPolicy: parsed.data.joinPolicy } : {})
    },
    select: { id: true, name: true, slug: true, joinPolicy: true }
  });

  res.json(updated);
}));

workspacesRouter.delete("/:workspaceId", requireAuth, asyncHandler(async (req, res) => {
  const { workspaceId } = req.params;

  const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (role !== "owner") {
    res.status(403).json({ error: "Only workspace owner can delete workspace" });
    return;
  }

  await prisma.workspace.delete({ where: { id: workspaceId } });
  res.json({ ok: true });
}));

workspacesRouter.get("/search", requireAuth, asyncHandler(async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";

  if (query.length < 1) {
    res.json([]);
    return;
  }

  const found = await prisma.workspace.findMany({
    where: {
      OR: [
        { name: { contains: query } },
        { slug: { contains: query } }
      ]
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
      ownerUsername: workspace.owner.username,
      joinPolicy: workspace.joinPolicy,
      isMember: workspace.members.length > 0,
      joinRequestStatus: workspace.joinRequests[0]?.status ?? null
    }))
  );
}));

workspacesRouter.post("/:workspaceId/join-requests", requireAuth, asyncHandler(async (req, res) => {
  const { workspaceId } = req.params;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, joinPolicy: true }
  });

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  const currentRole = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (currentRole) {
    res.status(409).json({ error: "You are already a workspace member" });
    return;
  }

  if (workspace.joinPolicy === "open") {
    await prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId: req.auth!.userId,
        role: "member"
      }
    });
    res.status(201).json({ ok: true, status: "approved", autoJoined: true });
    return;
  }

  const existing = await prisma.workspaceJoinRequest.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId: req.auth!.userId
      }
    }
  });

  if (existing?.status === "pending") {
    res.status(200).json({ ok: true, requestId: existing.id, status: existing.status });
    return;
  }

  if (existing) {
    const updated = await prisma.workspaceJoinRequest.update({
      where: { id: existing.id },
      data: { status: "pending" },
      select: { id: true, status: true }
    });
    res.status(200).json({ ok: true, requestId: updated.id, status: updated.status });
    return;
  }

  const created = await prisma.workspaceJoinRequest.create({
    data: {
      workspaceId,
      userId: req.auth!.userId,
      status: "pending"
    },
    select: { id: true, status: true }
  });

  res.status(201).json({ ok: true, requestId: created.id, status: created.status });
}));

workspacesRouter.post("/:workspaceId/invite-link", requireAuth, asyncHandler(async (req, res) => {
  const parsed = createInviteLinkSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { workspaceId } = req.params;
  const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (role !== "owner") {
    res.status(403).json({ error: "Only workspace owner can create invite links" });
    return;
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true }
  });
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  const expiresInDays = parsed.data.expiresInDays ?? 7;
  const token = signWorkspaceInviteToken(workspaceId, expiresInDays);
  const base = env.FRONTEND_ORIGIN.replace(/\/+$/, "");
  const inviteUrl = `${base}/?wsInvite=${encodeURIComponent(token)}`;

  res.json({
    ok: true,
    inviteUrl,
    expiresInDays,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug
    }
  });
}));

workspacesRouter.post("/join-by-invite", requireAuth, asyncHandler(async (req, res) => {
  const parsed = joinByInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  let invite: WorkspaceInvitePayload;
  try {
    invite = verifyWorkspaceInviteToken(parsed.data.token);
  } catch {
    res.status(400).json({ error: "Invalid or expired invite token" });
    return;
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: invite.wid },
    select: { id: true, name: true, slug: true, joinPolicy: true }
  });
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  const currentRole = await getWorkspaceRole(workspace.id, req.auth!.userId);
  if (currentRole) {
    res.json({ ok: true, status: "already-member", workspace });
    return;
  }

  if (workspace.joinPolicy === "open") {
    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: req.auth!.userId,
        role: "member"
      }
    });
    res.status(201).json({ ok: true, status: "approved", autoJoined: true, workspace });
    return;
  }

  const existing = await prisma.workspaceJoinRequest.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: req.auth!.userId
      }
    }
  });
  if (existing?.status === "pending") {
    res.json({ ok: true, status: "pending", workspace });
    return;
  }
  if (existing) {
    await prisma.workspaceJoinRequest.update({
      where: { id: existing.id },
      data: { status: "pending" }
    });
    res.json({ ok: true, status: "pending", workspace });
    return;
  }
  await prisma.workspaceJoinRequest.create({
    data: {
      workspaceId: workspace.id,
      userId: req.auth!.userId,
      status: "pending"
    }
  });
  res.status(201).json({ ok: true, status: "pending", workspace });
}));

workspacesRouter.get("/:workspaceId/join-requests", requireAuth, asyncHandler(async (req, res) => {
  const { workspaceId } = req.params;

  const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (!role || (role !== "owner" && role !== "admin")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const requests = await prisma.workspaceJoinRequest.findMany({
    where: {
      workspaceId,
      status: "pending"
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          numericId: true,
          username: true,
          avatarUrl: true
        }
      }
    },
    orderBy: { createdAt: "asc" },
    take: 100
  });

  res.json(
    requests.map((request) => ({
      id: request.id,
      status: request.status,
      createdAt: request.createdAt,
      user: request.user
    }))
  );
}));

workspacesRouter.post("/:workspaceId/join-requests/:requestId", requireAuth, asyncHandler(async (req, res) => {
  const parsed = joinRequestActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { workspaceId, requestId } = req.params;
  const role = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (!role || (role !== "owner" && role !== "admin")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const request = await prisma.workspaceJoinRequest.findUnique({
    where: { id: requestId },
    select: { id: true, workspaceId: true, userId: true, status: true }
  });

  if (!request || request.workspaceId !== workspaceId) {
    res.status(404).json({ error: "Join request not found" });
    return;
  }

  if (request.status !== "pending") {
    res.status(409).json({ error: "Request already processed" });
    return;
  }

  if (parsed.data.action === "approve") {
    await prisma.$transaction(async (tx) => {
      await tx.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: request.userId
          }
        },
        update: {},
        create: {
          workspaceId,
          userId: request.userId,
          role: "member"
        }
      });

      await tx.workspaceJoinRequest.update({
        where: { id: request.id },
        data: { status: "approved" }
      });
    });

    res.json({ ok: true, requestId: request.id, status: "approved" });
    return;
  }

  await prisma.workspaceJoinRequest.update({
    where: { id: request.id },
    data: { status: "rejected" }
  });

  res.json({ ok: true, requestId: request.id, status: "rejected" });
}));

workspacesRouter.patch("/:workspaceId/members/:memberUserId/role", requireAuth, asyncHandler(async (req, res) => {
  const parsed = updateMemberRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { workspaceId, memberUserId } = req.params;
  const requesterRole = await getWorkspaceRole(workspaceId, req.auth!.userId);
  if (!requesterRole || (requesterRole !== "owner" && requesterRole !== "admin")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const target = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: memberUserId } },
    select: { userId: true, role: true }
  });

  if (!target) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  if (target.role === "owner") {
    res.status(403).json({ error: "Owner role cannot be changed" });
    return;
  }

  if (requesterRole === "admin") {
    if (target.role === "admin") {
      res.status(403).json({ error: "Admin cannot modify another admin" });
      return;
    }
    if (parsed.data.role === "admin") {
      res.status(403).json({ error: "Only owner can grant admin role" });
      return;
    }
  }

  if (memberUserId === req.auth!.userId) {
    res.status(403).json({ error: "Cannot change your own role" });
    return;
  }

  const updated = await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: memberUserId } },
    data: { role: parsed.data.role },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          numericId: true,
          username: true,
          avatarUrl: true
        }
      }
    }
  });

  res.json({
    id: updated.user.id,
    numericId: updated.user.numericId ?? null,
    username: updated.user.username,
    avatarUrl: updated.user.avatarUrl,
    role: updated.role
  });
}));

workspacesRouter.get("/:workspaceId/members", requireAuth, asyncHandler(async (req, res) => {
  const { workspaceId } = req.params;
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";

  const requesterMembership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: req.auth!.userId } },
    select: { userId: true }
  });

  if (!requesterMembership) {
    res.status(403).json({ error: "Not a workspace member" });
    return;
  }

  const members = await prisma.workspaceMember.findMany({
    where: {
      workspaceId,
      ...(query
        ? {
            user: {
              username: { contains: query }
            }
          }
        : {})
    },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          numericId: true,
          username: true,
          avatarUrl: true
        }
      }
    },
    orderBy: { joinedAt: "asc" },
    take: 50
  });

  res.json(
    members.map((member) => ({
      id: member.user.id,
      numericId: member.user.numericId ?? null,
      username: member.user.username,
      avatarUrl: member.user.avatarUrl,
      role: member.role
    }))
  );
}));

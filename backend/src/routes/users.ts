import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { prisma } from "../lib/prisma.js";
import { comparePassword, hashPassword } from "../lib/auth.js";
import { asyncHandler } from "../lib/async-handler.js";
import { requireAuth } from "../middleware/auth.js";

export const usersRouter = Router();

const avatarUploadsDir = path.join(process.cwd(), "backend", "uploads", "avatars");
fs.mkdirSync(avatarUploadsDir, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarUploadsDir),
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname).slice(0, 12);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

usersRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: {
      id: true,
      numericId: true,
      email: true,
      username: true,
      avatarUrl: true,
      createdAt: true
    }
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});

const updateProfileSchema = z.object({
  email: z.email().optional(),
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/).optional(),
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8).max(128).optional(),
  newPasswordConfirm: z.string().min(8).max(128).optional()
});

usersRouter.put("/me", requireAuth, asyncHandler(async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { email, username, currentPassword, newPassword, newPasswordConfirm } = parsed.data;

  if (!email && !username && !newPassword && !newPasswordConfirm && !currentPassword) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: {
      id: true,
      numericId: true,
      email: true,
      username: true,
      avatarUrl: true,
      createdAt: true,
      passwordHash: true
    }
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const updateData: { email?: string; username?: string; passwordHash?: string } = {};

  if (username && username !== user.username) {
    updateData.username = username;
  }

  const wantsEmailChange = Boolean(email && email !== user.email);
  const wantsPasswordChange = Boolean(newPassword || newPasswordConfirm);
  const needsCurrentPassword = wantsEmailChange || wantsPasswordChange;

  if (wantsEmailChange) {
    const existingEmail = await prisma.user.findFirst({
      where: { email, id: { not: user.id } },
      select: { id: true }
    });
    if (existingEmail) {
      res.status(409).json({ error: "Email already exists" });
      return;
    }
    updateData.email = email;
  }

  if (needsCurrentPassword && !currentPassword) {
    res.status(400).json({ error: "Current password is required for security changes" });
    return;
  }

  if (needsCurrentPassword && currentPassword) {
    const currentPasswordOk = await comparePassword(currentPassword, user.passwordHash);
    if (!currentPasswordOk) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
  }

  if (wantsPasswordChange) {
    if (!newPassword || !newPasswordConfirm) {
      res.status(400).json({ error: "newPassword and newPasswordConfirm are required" });
      return;
    }

    if (newPassword !== newPasswordConfirm) {
      res.status(400).json({ error: "New password confirmation does not match" });
      return;
    }

    updateData.passwordHash = await hashPassword(newPassword);
  }

  if (Object.keys(updateData).length === 0) {
    res.json({
      id: user.id,
      numericId: user.numericId ?? null,
      email: user.email,
      username: user.username,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt
    });
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: updateData,
    select: {
      id: true,
      numericId: true,
      email: true,
      username: true,
      avatarUrl: true,
      createdAt: true
    }
  });

  res.json(updated);
}));

usersRouter.post("/me/avatar", requireAuth, avatarUpload.single("avatar"), asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Avatar file is required" });
    return;
  }

  if (!file.mimetype.startsWith("image/")) {
    res.status(400).json({ error: "Only image files are allowed" });
    return;
  }

  const updated = await prisma.user.update({
    where: { id: req.auth!.userId },
    data: { avatarUrl: `/uploads/avatars/${file.filename}` },
    select: {
      id: true,
      numericId: true,
      email: true,
      username: true,
      avatarUrl: true,
      createdAt: true
    }
  });

  res.json(updated);
}));

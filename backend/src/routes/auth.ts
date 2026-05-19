import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../lib/async-handler.js";
import {
  REFRESH_COOKIE_NAME,
  comparePassword,
  compareToken,
  getClientIp,
  hashPassword,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken
} from "../lib/auth.js";
import { sendPasswordResetCodeEmail, sendRegistrationCodeEmail } from "../lib/mailer.js";
import { env } from "../config/env.js";

const registerSchema = z.object({
  email: z.email(),
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8).max(128)
});

const registerConfirmSchema = z.object({
  email: z.email(),
  code: z.string().min(4).max(8).regex(/^\d+$/)
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1)
});

const passwordResetRequestSchema = z.object({
  email: z.email()
});

const passwordResetConfirmSchema = z.object({
  email: z.email(),
  code: z.string().min(4).max(8).regex(/^\d+$/),
  newPassword: z.string().min(8).max(128)
});

const REFRESH_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_COOKIE_PATH = "/";
const MAX_VERIFICATION_ATTEMPTS = 5;
const VERIFICATION_PURPOSE = "register";
const PASSWORD_RESET_PURPOSE = "password_reset";
const PASSWORD_RESET_RATE_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_RESET_RATE_MAX_ATTEMPTS = 5;
const passwordResetRateLimit = new Map<string, { count: number; resetAt: number }>();
const REFRESH_COOKIE_SECURE = env.REFRESH_COOKIE_SECURE.toLowerCase() === "true";
const REFRESH_COOKIE_SAMESITE = env.REFRESH_COOKIE_SAMESITE;
const EMOJI_AVATARS = ["😀", "😎", "🤖", "🦊", "🐼", "🐱", "🐶", "🦁", "🐸", "🐵", "🐙", "🦄", "🐧", "🐯", "🐨", "🐺"];
const EMOJI_AVATAR_BACKGROUNDS = ["#1d4ed8", "#7c3aed", "#be185d", "#0f766e", "#b45309", "#374151", "#0e7490", "#4338ca"];

function getRefreshCookieOptions() {
  const cookieDomain = env.REFRESH_COOKIE_DOMAIN?.trim() || undefined;
  return {
    httpOnly: true,
    sameSite: REFRESH_COOKIE_SAMESITE,
    secure: REFRESH_COOKIE_SECURE,
    maxAge: REFRESH_TTL_MS,
    path: REFRESH_COOKIE_PATH,
    ...(cookieDomain ? { domain: cookieDomain } : {})
  } as const;
}

function setRefreshCookie(res: any, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, getRefreshCookieOptions());
}

function setAccessTokenHeader(res: any, token: string): void {
  res.setHeader("x-gvoice-access-token", token);
}

function isEmailVerificationEnabled(): boolean {
  return env.EMAIL_VERIFICATION_ENABLED.toLowerCase() !== "false";
}

function generateNumericCode(length: number): string {
  const max = 10 ** length;
  const value = Math.floor(Math.random() * max);
  return value.toString().padStart(length, "0");
}

function createRandomEmojiAvatarDataUrl(): string {
  const emoji = EMOJI_AVATARS[Math.floor(Math.random() * EMOJI_AVATARS.length)] ?? "🙂";
  const background = EMOJI_AVATAR_BACKGROUNDS[Math.floor(Math.random() * EMOJI_AVATAR_BACKGROUNDS.length)] ?? "#1d4ed8";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="64" fill="${background}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="128">${emoji}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function consumePasswordResetRateLimit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const entry = passwordResetRateLimit.get(key);

  if (!entry || entry.resetAt <= now) {
    passwordResetRateLimit.set(key, { count: 1, resetAt: now + PASSWORD_RESET_RATE_WINDOW_MS });
    return { ok: true };
  }

  if (entry.count >= PASSWORD_RESET_RATE_MAX_ATTEMPTS) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  entry.count += 1;
  passwordResetRateLimit.set(key, entry);
  return { ok: true };
}

async function issueSessionAndRespond(params: {
  req: any;
  res: any;
  user: { id: string; numericId: number | null; email: string; username: string; createdAt: Date };
  statusCode?: number;
}): Promise<void> {
  const { req, res, user, statusCode = 200 } = params;

  const sessionId = crypto.randomUUID();
  const refreshToken = signRefreshToken({ sub: user.id, sid: sessionId });
  const refreshHash = await hashToken(refreshToken);

  await prisma.refreshSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: refreshHash,
      userAgent: req.header("user-agent") ?? null,
      ipAddress: getClientIp(req),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS)
    }
  });

  const accessToken = signAccessToken({ sub: user.id, username: user.username });
  setRefreshCookie(res, refreshToken);
  setAccessTokenHeader(res, accessToken);

  res.status(statusCode).json({
    accessToken,
    user: {
      id: user.id,
      numericId: user.numericId,
      email: user.email,
      username: user.username,
      createdAt: user.createdAt
    }
  });
}

async function allocateNextNumericUserId(): Promise<number> {
  const last = await prisma.user.findFirst({
    where: { numericId: { not: null } },
    orderBy: { numericId: "desc" },
    select: { numericId: true }
  });
  return (last?.numericId ?? 0) + 1;
}

export const authRouter = Router();

authRouter.post("/register/request-code", asyncHandler(async (req, res) => {
  if (!isEmailVerificationEnabled()) {
    res.status(400).json({ error: "Email verification is disabled on server" });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { email, username, password } = parsed.data;

  const existingUser = await prisma.user.findFirst({
    where: {
      email
    },
    select: { id: true }
  });
  if (existingUser) {
    res.status(409).json({ error: "Email already exists" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const code = generateNumericCode(env.EMAIL_CODE_LENGTH);
  const codeHash = await hashToken(code);
  const expiresAt = new Date(Date.now() + env.EMAIL_CODE_TTL_MINUTES * 60 * 1000);

  const existingPending = await prisma.emailVerificationCode.findFirst({
    where: {
      email,
      purpose: VERIFICATION_PURPOSE,
      usedAt: null
    },
    select: { id: true }
  });

  if (existingPending) {
    await prisma.emailVerificationCode.update({
      where: { id: existingPending.id },
      data: {
        username,
        passwordHash,
        codeHash,
        attempts: 0,
        expiresAt
      }
    });
  } else {
    await prisma.emailVerificationCode.create({
      data: {
        email,
        username,
        passwordHash,
        codeHash,
        purpose: VERIFICATION_PURPOSE,
        expiresAt
      }
    });
  }

  try {
    await sendRegistrationCodeEmail({
      to: email,
      username,
      code,
      ttlMinutes: env.EMAIL_CODE_TTL_MINUTES
    });
  } catch (error) {
    console.error("register/request-code error:", error);
    const message = error instanceof Error ? error.message : "Unknown email error";
    res.status(500).json({ error: "Failed to send verification code email", details: message });
    return;
  }

  res.status(204).send();
}));

authRouter.post("/register/confirm", asyncHandler(async (req, res) => {
  if (!isEmailVerificationEnabled()) {
    res.status(400).json({ error: "Email verification is disabled on server" });
    return;
  }

  const parsed = registerConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { email, code } = parsed.data;
  const now = new Date();

  const pending = await prisma.emailVerificationCode.findFirst({
    where: {
      email,
      purpose: VERIFICATION_PURPOSE,
      usedAt: null
    },
    orderBy: { createdAt: "desc" }
  });

  if (!pending || pending.expiresAt < now) {
    res.status(400).json({ error: "Verification code expired or not found" });
    return;
  }

  if (pending.attempts >= MAX_VERIFICATION_ATTEMPTS) {
    res.status(429).json({ error: "Too many invalid attempts, request a new code" });
    return;
  }

  const validCode = await compareToken(code, pending.codeHash);
  if (!validCode) {
    await prisma.emailVerificationCode.update({
      where: { id: pending.id },
      data: { attempts: { increment: 1 } }
    });
    res.status(400).json({ error: "Invalid verification code" });
    return;
  }

  const userExists = await prisma.user.findFirst({
    where: {
      email: pending.email
    },
    select: { id: true }
  });
  if (userExists) {
    await prisma.emailVerificationCode.update({
      where: { id: pending.id },
      data: { usedAt: now }
    });
    res.status(409).json({ error: "Email already exists" });
    return;
  }

  const numericId = await allocateNextNumericUserId();
  const user = await prisma.user.create({
    data: {
      numericId,
      email: pending.email,
      username: pending.username,
      passwordHash: pending.passwordHash,
      avatarUrl: createRandomEmojiAvatarDataUrl()
    },
    select: { id: true, numericId: true, email: true, username: true, createdAt: true }
  });

  await prisma.emailVerificationCode.update({
    where: { id: pending.id },
    data: { usedAt: now }
  });

  await issueSessionAndRespond({ req, res, user, statusCode: 201 });
}));

authRouter.post("/password-reset/request-code", asyncHandler(async (req, res) => {
  if (!isEmailVerificationEnabled()) {
    res.status(400).json({ error: "Email verification is disabled on server" });
    return;
  }

  const parsed = passwordResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { email } = parsed.data;
  const ip = getClientIp(req) ?? "unknown-ip";
  const rateKey = `${email.toLowerCase()}|${ip}`;
  const rate = consumePasswordResetRateLimit(rateKey);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "Too many requests, try again later", retryAfterSec: rate.retryAfterSec });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { email: true, username: true, passwordHash: true }
  });

  if (!user) {
    res.status(204).send();
    return;
  }

  const code = generateNumericCode(env.EMAIL_CODE_LENGTH);
  const codeHash = await hashToken(code);
  const expiresAt = new Date(Date.now() + env.EMAIL_CODE_TTL_MINUTES * 60 * 1000);

  const existingPending = await prisma.emailVerificationCode.findFirst({
    where: {
      email,
      purpose: PASSWORD_RESET_PURPOSE,
      usedAt: null
    },
    select: { id: true }
  });

  if (existingPending) {
    await prisma.emailVerificationCode.update({
      where: { id: existingPending.id },
      data: {
        username: user.username,
        passwordHash: user.passwordHash,
        codeHash,
        attempts: 0,
        expiresAt
      }
    });
  } else {
    await prisma.emailVerificationCode.create({
      data: {
        email,
        username: user.username,
        passwordHash: user.passwordHash,
        codeHash,
        purpose: PASSWORD_RESET_PURPOSE,
        expiresAt
      }
    });
  }

  try {
    await sendPasswordResetCodeEmail({
      to: user.email,
      username: user.username,
      code,
      ttlMinutes: env.EMAIL_CODE_TTL_MINUTES
    });
  } catch (error) {
    console.error("password-reset/request-code error:", error);
    const message = error instanceof Error ? error.message : "Unknown email error";
    res.status(500).json({ error: "Failed to send password reset code email", details: message });
    return;
  }

  res.status(204).send();
}));

authRouter.post("/password-reset/confirm", asyncHandler(async (req, res) => {
  if (!isEmailVerificationEnabled()) {
    res.status(400).json({ error: "Email verification is disabled on server" });
    return;
  }

  const parsed = passwordResetConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { email, code, newPassword } = parsed.data;
  const now = new Date();

  const pending = await prisma.emailVerificationCode.findFirst({
    where: {
      email,
      purpose: PASSWORD_RESET_PURPOSE,
      usedAt: null
    },
    orderBy: { createdAt: "desc" }
  });

  if (!pending || pending.expiresAt < now) {
    res.status(400).json({ error: "Verification code expired or not found" });
    return;
  }

  if (pending.attempts >= MAX_VERIFICATION_ATTEMPTS) {
    res.status(429).json({ error: "Too many invalid attempts, request a new code" });
    return;
  }

  const validCode = await compareToken(code, pending.codeHash);
  if (!validCode) {
    await prisma.emailVerificationCode.update({
      where: { id: pending.id },
      data: { attempts: { increment: 1 } }
    });
    res.status(400).json({ error: "Invalid verification code" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true }
  });

  if (!user) {
    await prisma.emailVerificationCode.update({
      where: { id: pending.id },
      data: { usedAt: now }
    });
    res.status(400).json({ error: "User not found" });
    return;
  }

  const newPasswordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash }
    });

    await tx.emailVerificationCode.update({
      where: { id: pending.id },
      data: { usedAt: now }
    });

    await tx.refreshSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now }
    });
  });

  res.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    ...(env.REFRESH_COOKIE_DOMAIN?.trim() ? { domain: env.REFRESH_COOKIE_DOMAIN.trim() } : {})
  });
  res.status(204).send();
}));

// Legacy endpoint (kept for backward compatibility if email verification is disabled).
authRouter.post("/register", asyncHandler(async (req, res) => {
  if (isEmailVerificationEnabled()) {
    res.status(400).json({ error: "Use /auth/register/request-code and /auth/register/confirm" });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { email, username, password } = parsed.data;
  const existing = await prisma.user.findFirst({
    where: {
      email
    }
  });

  if (existing) {
    res.status(409).json({ error: "Email already exists" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const numericId = await allocateNextNumericUserId();
  const user = await prisma.user.create({
    data: {
      numericId,
      email,
      username,
      passwordHash,
      avatarUrl: createRandomEmojiAvatarDataUrl()
    },
    select: { id: true, numericId: true, email: true, username: true, createdAt: true }
  });

  await issueSessionAndRespond({ req, res, user, statusCode: 201 });
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const ok = await comparePassword(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  await issueSessionAndRespond({
    req,
    res,
    user: {
      id: user.id,
      numericId: user.numericId ?? null,
      email: user.email,
      username: user.username,
      createdAt: user.createdAt
    }
  });
}));

authRouter.post("/refresh", asyncHandler(async (req, res) => {
  const refreshToken = req.cookies[REFRESH_COOKIE_NAME] as string | undefined;

  if (!refreshToken) {
    res.status(401).json({ error: "Refresh token missing" });
    return;
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });

    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt < new Date()) {
      res.status(401).json({ error: "Refresh session invalid" });
      return;
    }

    const validToken = await compareToken(refreshToken, session.tokenHash);
    if (!validToken) {
      res.status(401).json({ error: "Refresh token invalid" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, username: true, email: true, createdAt: true }
    });

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const accessToken = signAccessToken({ sub: user.id, username: user.username });
    setRefreshCookie(res, refreshToken);
    res.json({ accessToken, user });
  } catch {
    res.status(401).json({ error: "Refresh token invalid" });
  }
}));

authRouter.post("/logout", asyncHandler(async (req, res) => {
  const refreshToken = req.cookies[REFRESH_COOKIE_NAME] as string | undefined;

  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      await prisma.refreshSession.updateMany({
        where: { id: payload.sid, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    } catch {
      // ignore invalid refresh token on logout
    }
  }

  res.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    ...(env.REFRESH_COOKIE_DOMAIN?.trim() ? { domain: env.REFRESH_COOKIE_DOMAIN.trim() } : {})
  });
  res.status(204).send();
}));



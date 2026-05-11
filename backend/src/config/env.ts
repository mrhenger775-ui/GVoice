import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const envPaths = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "backend/.env")];
for (const p of envPaths) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: false });
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("30d"),
  FRONTEND_ORIGIN: z.string().default("http://localhost:5173"),
  REFRESH_COOKIE_SECURE: z.string().default("false"),
  REFRESH_COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  REFRESH_COOKIE_DOMAIN: z.string().optional(),
  PORT: z.coerce.number().default(4000),
  VOICE_STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  VOICE_TURN_URLS: z.string().optional(),
  VOICE_TURN_USERNAME: z.string().optional(),
  VOICE_TURN_PASSWORD: z.string().optional(),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  EMAIL_VERIFICATION_ENABLED: z.string().default("true"),
  EMAIL_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  EMAIL_CODE_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  MEDIA_BOT_ENABLED: z.string().default("true"),
  MEDIA_BOT_OUTPUT_DIR: z.string().default("backend/uploads/media"),
  MEDIA_BOT_YTDLP_BIN: z.string().default("yt-dlp"),
  MEDIA_BOT_FFMPEG_BIN: z.string().default("ffmpeg")
});

export const env = envSchema.parse(process.env);

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

type MediaTranscodeJob = {
  channelId: string;
  ffmpeg: ChildProcess;
  startedAt: string;
  outputDir: string;
};

const jobs = new Map<string, MediaTranscodeJob>();

function isEnabled() {
  return String(env.MEDIA_BOT_ENABLED ?? "true").toLowerCase() !== "false";
}

function baseOutputDir() {
  return path.resolve(process.cwd(), env.MEDIA_BOT_OUTPUT_DIR);
}

function channelOutputDir(channelId: string) {
  return path.join(baseOutputDir(), channelId);
}

async function resolvePlayableUrl(inputUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.MEDIA_BOT_YTDLP_BIN, ["-g", "--no-warnings", inputUrl], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        return;
      }
      const line = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find(Boolean);
      if (!line) {
        reject(new Error("yt-dlp did not return a playable URL"));
        return;
      }
      resolve(line);
    });
  });
}

export function isMediaWorkerSource(url: string) {
  const lower = url.toLowerCase();
  return (
    lower.includes("twitch.tv/") ||
    lower.includes("clips.twitch.tv/") ||
    lower.includes("rutube.ru/") ||
    lower.includes("vkvideo.ru/") ||
    lower.includes("vk.com/video") ||
    lower.includes("m.vk.com/video")
  );
}

async function waitForFile(filePath: string, timeoutMs = 15000, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`Timeout waiting for file: ${filePath}`);
}

export async function stopMediaJob(channelId: string) {
  const existing = jobs.get(channelId);
  if (existing) {
    existing.ffmpeg.kill("SIGKILL");
    jobs.delete(channelId);
  }

  const outDir = channelOutputDir(channelId);
  await rm(outDir, { recursive: true, force: true });
}

export async function startMediaJob(channelId: string, sourceUrl: string) {
  if (!isEnabled()) {
    return { mediaUrl: sourceUrl, kind: "link" as const };
  }

  await stopMediaJob(channelId);

  const outDir = channelOutputDir(channelId);
  await mkdir(outDir, { recursive: true });

  const playableUrl = await resolvePlayableUrl(sourceUrl);
  const outputIndex = path.join(outDir, "index.m3u8");

  const ffmpegArgs = [
    "-y",
    "-loglevel",
    "warning",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "2",
    "-i",
    playableUrl,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "8",
    "-hls_flags",
    "delete_segments+append_list+independent_segments+omit_endlist",
    outputIndex
  ];

  const ffmpeg = spawn(env.MEDIA_BOT_FFMPEG_BIN, ffmpegArgs, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  ffmpeg.stdout.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      console.log(`[media-worker:${channelId}] ffmpeg stdout: ${line}`);
    }
  });
  ffmpeg.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      console.warn(`[media-worker:${channelId}] ffmpeg stderr: ${line}`);
    }
  });
  ffmpeg.on("error", (error) => {
    console.error(`[media-worker:${channelId}] ffmpeg process error:`, error);
  });
  ffmpeg.on("close", () => {
    const existing = jobs.get(channelId);
    if (existing?.ffmpeg.pid === ffmpeg.pid) {
      jobs.delete(channelId);
    }
  });

  jobs.set(channelId, {
    channelId,
    ffmpeg,
    startedAt: new Date().toISOString(),
    outputDir: outDir
  });

  await waitForFile(outputIndex);

  const frontendOrigin = env.FRONTEND_ORIGIN.replace(/\/+$/, "");
  return {
    mediaUrl: `${frontendOrigin}/media/${encodeURIComponent(channelId)}/index.m3u8?v=${Date.now()}`,
    kind: "video" as const
  };
}

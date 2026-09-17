import { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track, type LocalTrackPublication } from "livekit-client";
import Hls from "hls.js";
import type { Socket } from "socket.io-client";
import { io } from "socket.io-client";
import { useAuth } from "../auth/AuthContext";
import { ScreenSharePicker, type DesktopDisplaySource, type ShareSourceId } from "./ScreenSharePicker";
import { MiniGamesModal } from "./MiniGamesModal";
import { WorkspaceBans } from "./WorkspaceBans";
import { SupportPanel } from "./SupportPanel";
import {
  getAndroidVoiceDebugState,
  isAndroidAppRuntime,
  isAndroidVoicePluginAvailable,
  isAndroidNativePlatform,
  startAndroidVoiceCallService,
  stopAndroidVoiceCallService,
  updateAndroidVoiceCallService
} from "../native/voiceCall";

declare global {
  interface Window {
    YT?: {
      Player: new (element: string | HTMLElement, options: Record<string, unknown>) => YouTubePlayer;
      PlayerState: {
        PLAYING: number;
        PAUSED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
    gvoiceDesktop?: {
      platform: string;
      checkForUpdates?: () => Promise<{ ok: boolean; reason?: string }>;
      setGlobalHotkeys?: (bindings: Record<string, string>) => Promise<{ ok: boolean }>;
      onGlobalHotkey?: (handler: (payload: { action: "toggleMic" | "toggleDeafen" | "toggleScreenShare" }) => void) => (() => void) | void;
      onPushToTalkHold?: (handler: (payload: { down: boolean }) => void) => (() => void) | void;
      onUpdateStatus?: (
        handler: (payload: { stage: string; version?: string | null; percent?: number; message?: string }) => void
      ) => (() => void) | void;
      getDisplaySources?: () => Promise<{ ok: boolean; sources: DesktopDisplaySource[]; error?: string }>;
      setDisplaySource?: (sourceId: string) => Promise<{ ok: boolean }>;
    };
  }
}

type YouTubePlayer = {
  destroy: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
};

let youtubeApiReadyPromise: Promise<void> | null = null;

function ensureYoutubeIframeApiReady(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  if (window.YT?.Player) {
    return Promise.resolve();
  }
  if (youtubeApiReadyPromise) {
    return youtubeApiReadyPromise;
  }
  youtubeApiReadyPromise = new Promise<void>((resolve) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prevReady?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  });
  return youtubeApiReadyPromise;
}

const API_URL = import.meta.env.VITE_API_URL ?? "https://gvoice.online/api";
const SOCKET_URL = API_URL.replace(/\/api\/?$/, "");
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const DEFAULT_PARTICIPANT_VOLUME = 1;
const REMOTE_AUDIO_CONNECT_GRACE_MS = 450;
const REMOTE_AUDIO_FADE_MS = 900;
const SCREEN_SHARE_MAX_WIDTH = 1280;
const SCREEN_SHARE_MAX_HEIGHT = 720;
const SCREEN_SHARE_MAX_FPS = 30;
const SCREEN_SHARE_MAX_BITRATE = 3_500_000;
const SCREEN_SHARE_FALLBACK_BITRATE = 2_000_000;
const SCREEN_SHARE_FALLBACK_FPS = 15;
const SOLO_VOICE_AUTO_LEAVE_MS = 30 * 60 * 1000;
const MOBILE_MEDIA_QUERY = "(max-width: 900px), (pointer: coarse) and (max-width: 1200px)";
const MESSAGE_NOTIFICATION_SOUND_URL = "/sounds/notification%20GVoice.mp3";
const JOIN_NOTIFICATION_SOUND_URL = "/sounds/entering%20the%20call%20GVoice%201.0.mp3";
const LEAVE_NOTIFICATION_SOUND_URL = "/sounds/leave%20voice%20GVoice%201.0.mp3";
const SCREEN_SHARE_ON_SOUND_URL = "/sounds/Demonsteishon%20Ekrashion%20GVoice%201.0.mp3";
const SCREEN_SHARE_OFF_SOUND_URL = "/sounds/OFF%20Demonsteishon%20Ekrashion%20GVoice%201.0.mp3";
const MIC_ON_SOUND_URL = "/sounds/Un%20muth%20GVoice%201.0.mp3";
const MIC_OFF_SOUND_URL = "/sounds/Muth%20GVoice%201.0.mp3";
const APP_BUILD_VERSION = __APP_VERSION__;
const USE_LEGACY_WEBRTC_VOICE_MESH = false;
const VOICE_VOLUME_STORAGE_KEY = "gvoice.voiceVolumeBySocketOrUser";
const MIC_VOLUME_STORAGE_KEY = "gvoice.micInputVolume";
const NOISE_MODE_STORAGE_KEY = "gvoice.noiseMode";
const AUDIO_INPUT_DEVICE_STORAGE_KEY = "gvoice.audioInputDeviceId";
const AUDIO_OUTPUT_DEVICE_STORAGE_KEY = "gvoice.audioOutputDeviceId";
const VOICE_KEYBINDS_STORAGE_KEY = "gvoice.voiceKeybinds";
const RADIO_MODE_ENABLED_STORAGE_KEY = "gvoice.radioModeEnabled";
const NOTIFICATION_SETTINGS_STORAGE_KEY = "gvoice.notificationSettings";
const DM_LAST_SEEN_STORAGE_KEY = "gvoice.dmLastSeenByWorkspace";
const CHANNEL_LAST_SEEN_STORAGE_KEY = "gvoice.channelLastSeen";
type DashboardTab = "spaces" | "dm" | "news";
type NotificationSettings = {
  messageSounds: boolean;
  callSounds: boolean;
  desktopNotifications: boolean;
  directMessages: boolean;
  spaceMessages: boolean;
  showMessagePreview: boolean;
  onlyWhenUnfocused: boolean;
};
const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  messageSounds: true,
  callSounds: true,
  desktopNotifications: true,
  directMessages: true,
  spaceMessages: true,
  showMessagePreview: true,
  onlyWhenUnfocused: true
};

function loadNotificationSettings(): NotificationSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(NOTIFICATION_SETTINGS_STORAGE_KEY) ?? "{}") as Partial<NotificationSettings>;
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...stored };
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}
const emoji = (...points: number[]) => String.fromCodePoint(...points);
const BASIC_EMOJIS = [
  emoji(0x1f600),
  emoji(0x1f604),
  emoji(0x1f601),
  emoji(0x1f609),
  emoji(0x1f60a),
  emoji(0x1f60e),
  emoji(0x1f914),
  emoji(0x1f622),
  emoji(0x1f62d),
  emoji(0x1f621),
  emoji(0x1f525),
  emoji(0x1f44d),
  emoji(0x1f44f),
  emoji(0x1f64f),
  emoji(0x1f389),
  emoji(0x2764, 0xfe0f)
];
const GVOICE_LOGO_MAIN_URL = "/ui/gvoice-logo-main.png";
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
const SPACE_CHANNEL_NAME_MIN = 2;
const SPACE_CHANNEL_NAME_MAX = 40;
const SPACE_CHANNEL_NAME_REGEX = /^[\p{L}\p{N} _.-]+$/u;
const START_GREETING_PHRASES = [
  "Привет! Рад тебя видеть.",
  "Прекрасно выглядишь сегодня.",
  "Добро пожаловать в GVoice.",
  "Отличный день, чтобы пообщаться.",
  "Залетай в любое пространство, когда будешь готов.",
  "Пусть сегодня всё будет легко и по кайфу.",
  "Ты на месте, а значит будет интересно.",
  "Здесь тебя уже ждут хорошие разговоры."
];
const NEWS_ITEMS = [
  {
    date: "10 сентября 2026",
    label: "Интерфейс",
    title: "Новости теперь всегда под рукой",
    description: "В GVoice появилась отдельная лента с важными обновлениями, подсказками и заметками о новых возможностях сервиса.",
    accent: "#60a5fa"
  },
  {
    date: "8 сентября 2026",
    label: "Безопасность",
    title: "Условия и правила стали понятнее",
    description: "Правовая информация собрана в аккуратном разделе с удобной навигацией между документами и улучшенной читаемостью.",
    accent: "#a78bfa"
  },
  {
    date: "4 сентября 2026",
    label: "Общение",
    title: "Больше возможностей для встреч",
    description: "Используйте голосовые каналы, личные звонки, демонстрацию экрана и мини-игры — всё в одном пространстве.",
    accent: "#34d399"
  }
] as const;
type NoiseMode = "off" | "medium" | "aggressive";
const NOISE_MODE_LABEL: Record<NoiseMode, string> = {
  off: "Выкл",
  medium: "Средний",
  aggressive: "Агрессивный"
};
const ROLE_LABEL: Record<string, string> = {
  owner: "владелец",
  admin: "админ",
  moderator: "модератор",
  member: "участник"
};
const CHANNEL_TYPE_LABEL: Record<string, string> = {
  text: "текстовый",
  voice: "голосовой"
};
type VoiceKeybindAction = "toggleMic" | "toggleDeafen" | "toggleScreenShare" | "pushToTalk";
type VoiceKeybinds = Record<VoiceKeybindAction, string>;
const DEFAULT_VOICE_KEYBINDS: VoiceKeybinds = {
  toggleMic: "",
  toggleDeafen: "",
  toggleScreenShare: "",
  pushToTalk: ""
};
const LEGACY_DEFAULT_VOICE_KEYBINDS: VoiceKeybinds = {
  toggleMic: "Ctrl+M",
  toggleDeafen: "Ctrl+D",
  toggleScreenShare: "Ctrl+Shift+S",
  pushToTalk: "Alt+V"
};

function isValidDisplayName(value: string): boolean {
  return SPACE_CHANNEL_NAME_REGEX.test(value.trim());
}

function loadDmLastSeenMap(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(DM_LAST_SEEN_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) {
        result[workspaceId] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function getAudioConstraintsByNoiseMode(mode: NoiseMode): MediaTrackConstraints {
  if (mode === "off") {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
  }
  if (mode === "medium") {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false
    };
  }
  if (mode === "aggressive") {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1
    };
  }
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false
  };
}

function loadChannelLastSeenMap(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(CHANNEL_LAST_SEEN_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]))
    );
  } catch {
    return {};
  }
}

function getAudioConstraints(mode: NoiseMode, deviceId = ""): MediaTrackConstraints {
  return {
    ...getAudioConstraintsByNoiseMode(mode),
    ...(deviceId ? { deviceId: { exact: deviceId } } : {})
  };
}

function loadPersistedDeviceId(storageKey: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function roleLabel(role: string) {
  return ROLE_LABEL[role] ?? role;
}

function channelTypeLabel(type: string) {
  return CHANNEL_TYPE_LABEL[type] ?? type;
}

function mergeMessagesByIdAndTime(prev: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of prev) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function appendMessageOnce(prev: Message[], message: Message): Message[] {
  if (prev.some((item) => item.id === message.id)) {
    return prev;
  }
  return [...prev, message];
}

function loadPersistedVoiceVolumeMap(): Record<string, number> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(VOICE_VOLUME_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        result[key] = Math.min(1, Math.max(0, num));
      }
    }
    return result;
  } catch {
    return {};
  }
}

function normalizeAudioVolume(value: unknown, fallback = DEFAULT_PARTICIPANT_VOLUME): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, num));
}

function loadPersistedMicInputVolume(): number {
  if (typeof window === "undefined") {
    return 1;
  }
  try {
    const raw = window.localStorage.getItem(MIC_VOLUME_STORAGE_KEY);
    if (!raw) {
      return 1;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return 1;
    }
    return Math.min(1, Math.max(0, num));
  } catch {
    return 1;
  }
}

function loadPersistedNoiseMode(): NoiseMode {
  if (typeof window === "undefined") {
    return "medium";
  }
  try {
    const value = window.localStorage.getItem(NOISE_MODE_STORAGE_KEY);
    return value === "off" || value === "medium" || value === "aggressive" ? value : "medium";
  } catch {
    return "medium";
  }
}

function loadPersistedRadioModeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(RADIO_MODE_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function formatWorkspaceId(slug: string) {
  if (/^\d+$/.test(slug)) {
    return String(Number(slug));
  }
  return slug;
}

function getAttachmentExt(name?: string | null, url?: string | null): string {
  const source = (name ?? url ?? "").toLowerCase();
  const dotIdx = source.lastIndexOf(".");
  if (dotIdx === -1) {
    return "";
  }
  return source.slice(dotIdx + 1).split("?")[0];
}

function isImageAttachment(mime?: string | null, name?: string | null, url?: string | null): boolean {
  if (mime?.startsWith("image/")) {
    return true;
  }
  const ext = getAttachmentExt(name, url);
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"].includes(ext);
}

function isVideoAttachment(mime?: string | null, name?: string | null, url?: string | null): boolean {
  if (mime?.startsWith("video/")) {
    return true;
  }
  const ext = getAttachmentExt(name, url);
  return ["mp4", "webm", "mov", "m4v", "mkv", "avi"].includes(ext);
}

function isAudioAttachment(mime?: string | null, name?: string | null, url?: string | null): boolean {
  if (mime?.startsWith("audio/")) {
    return true;
  }
  const ext = getAttachmentExt(name, url);
  return ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "webm"].includes(ext);
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) {
    return `${size} Б`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} КБ`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function getClipboardAttachment(data: DataTransfer): File | null {
  const files = Array.from(data.files);
  return files.find((file) => file.type.startsWith("image/")) ?? files[0] ?? null;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Some desktop/webview environments expose the API but deny permission.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function SelectedAttachmentPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minWidth: 0,
        padding: 8,
        border: "1px solid #334155",
        borderRadius: 8,
        background: "#0b1222"
      }}
    >
      {previewUrl && isImageAttachment(file.type, file.name) ? (
        <img src={previewUrl} alt={file.name} style={{ width: 88, height: 60, objectFit: "cover", borderRadius: 6 }} />
      ) : previewUrl && isVideoAttachment(file.type, file.name) ? (
        <video src={previewUrl} muted preload="metadata" style={{ width: 88, height: 60, objectFit: "cover", borderRadius: 6 }} />
      ) : (
        <span style={{ width: 48, height: 48, display: "grid", placeItems: "center", fontSize: 26, flexShrink: 0 }}>
          {isAudioAttachment(file.type, file.name) ? "🎵" : "📎"}
        </span>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</b>
        <small style={{ color: "#94a3b8" }}>{formatAttachmentSize(file.size)}</small>
        {previewUrl && isAudioAttachment(file.type, file.name) ? (
          <audio controls preload="metadata" src={previewUrl} style={{ display: "block", width: "100%", maxWidth: 360, height: 32, marginTop: 5 }} />
        ) : null}
      </div>
      <button type="button" onClick={onRemove} title="Убрать вложение" style={{ flexShrink: 0 }}>
        ×
      </button>
    </div>
  );
}

type Workspace = {
  id: string;
  name: string;
  slug: string;
  joinPolicy: "open" | "request" | "private";
  role: string;
};

type Channel = {
  id: string;
  name: string;
  type: "text" | "voice";
  isPrivate: boolean;
};

type WorkspaceSearchResult = {
  id: string;
  name: string;
  slug: string;
  ownerUsername: string;
  joinPolicy: "open" | "request" | "private";
  isMember: boolean;
  joinRequestStatus?: "pending" | "approved" | "rejected" | null;
};

type DirectUserSearchResult = {
  id: string;
  numericId: number | null;
  username: string;
  avatarUrl?: string | null;
  isFriend: boolean;
  incomingRequest: boolean;
  outgoingRequest: boolean;
  isBlocked: boolean;
  blockedByUser: boolean;
};

type DirectIncomingRequest = {
  id: string;
  createdAt: string;
  sender: {
    id: string;
    numericId: number | null;
    username: string;
    avatarUrl?: string | null;
  };
};

type DirectDialog = {
  workspaceId: string;
  partner: {
    id: string;
    numericId: number | null;
    username: string;
    avatarUrl?: string | null;
  } | null;
  textChannelId: string | null;
  voiceChannelId: string | null;
  isFriend: boolean;
};

type DirectBlock = {
  createdAt: string;
  blocked: {
    id: string;
    numericId: number | null;
    username: string;
    avatarUrl?: string | null;
  };
};

type WorkspaceMember = {
  id: string;
  numericId?: number | null;
  username: string;
  avatarUrl?: string | null;
  role: string;
};

type WorkspaceJoinRequest = {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  user: {
    id: string;
    username: string;
    avatarUrl?: string | null;
  };
};

type VoiceParticipant = {
  socketId: string;
  userId: string;
  username: string;
};

type PresenceSnapshot = {
  onlineUserIds: string[];
};

type PresenceUpdate = {
  userId: string;
  isOnline: boolean;
};

type DmIncomingCall = {
  workspaceId: string;
  voiceChannelId: string;
  caller: {
    id: string;
    username: string;
  };
};

type VoiceSignalPayload = {
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type VoicePeer = {
  pc: RTCPeerConnection;
  audioByTrackId: Map<string, HTMLAudioElement>;
};

type Message = {
  id: string;
  channelId: string;
  workspaceId?: string;
  body: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentMime?: string | null;
  attachmentSize?: number | null;
  editedAt?: string | null;
  createdAt: string;
  author: {
    id: string;
    username: string;
    avatarUrl?: string | null;
  };
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

type MessageContextMenuState = {
  messageId: string;
  x: number;
  y: number;
  canEdit: boolean;
  canDelete: boolean;
  canReply: boolean;
};

type VoiceVolumeContextMenuState = {
  socketId: string;
  userId: string;
  username: string;
  isSelf?: boolean;
  canKickFromVoice?: boolean;
  x: number;
  y: number;
};

type MemberRoleContextMenuState = {
  memberUserId: string;
  memberUsername: string;
  memberNumericId: number | null;
  currentRole?: string;
  canEditRole: boolean;
  workspaceId?: string;
  canBanFromWorkspace?: boolean;
  x: number;
  y: number;
};

function canModerateWorkspaceMember(actorRole?: string, targetRole?: string): boolean {
  const rank: Record<string, number> = { member: 1, moderator: 2, admin: 3, owner: 4 };
  return Boolean(actorRole && targetRole && (rank[actorRole] ?? 0) >= 2 && (rank[actorRole] ?? 0) > (rank[targetRole] ?? 0));
}

type ChannelContextMenuState = {
  channelId: string;
  channelName: string;
  x: number;
  y: number;
};

type WorkspaceContextMenuState = {
  workspaceId: string;
  workspaceName: string;
  workspaceRole: string;
  joinPolicy: "open" | "request" | "private";
  x: number;
  y: number;
};

type DesktopUpdateStatus = {
  stage: "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  message: string;
};

function getEffectiveMediaPositionSec(state: MediaSessionState | null | undefined, nowMs = Date.now()): number {
  if (!state?.isActive) {
    return 0;
  }
  const syncedAtMs = Date.parse(state.syncedAt);
  const elapsed = state.isPaused || Number.isNaN(syncedAtMs) ? 0 : Math.max(0, (nowMs - syncedAtMs) / 1000);
  return Math.max(0, state.positionSec + elapsed);
}

function toYoutubeEmbedUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("youtu.be")) {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      if (id) {
        return `https://www.youtube.com/embed/${id}`;
      }
      const shorts = parsed.pathname.match(/^\/shorts\/([^/]+)/);
      if (shorts?.[1]) {
        return `https://www.youtube.com/embed/${shorts[1]}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function toYoutubeVideoId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("youtu.be")) {
      return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    }
    if (host.includes("youtube.com")) {
      const byQuery = parsed.searchParams.get("v");
      if (byQuery) {
        return byQuery;
      }
      const shorts = parsed.pathname.match(/^\/shorts\/([^/]+)/);
      if (shorts?.[1]) {
        return shorts[1];
      }
      const embed = parsed.pathname.match(/^\/embed\/([^/]+)/);
      if (embed?.[1]) {
        return embed[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function toRutubeEmbedUrl(rawUrl: string, options?: { autoplay?: boolean; positionSec?: number; reloadToken?: string }): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("rutube.ru")) {
      return null;
    }

    const embedMatch = parsed.pathname.match(/^\/play\/embed\/([^/]+)/);
    if (embedMatch?.[1]) {
      const url = new URL(`https://rutube.ru/play/embed/${embedMatch[1]}`);
      url.searchParams.set("autoplay", options?.autoplay ? "1" : "0");
      if (options?.positionSec && options.positionSec > 0) {
        url.searchParams.set("t", String(Math.floor(options.positionSec)));
        url.searchParams.set("start", String(Math.floor(options.positionSec)));
      }
      if (options?.reloadToken) {
        url.searchParams.set("_sync", options.reloadToken);
      }
      return url.toString();
    }

    const videoMatch = parsed.pathname.match(/^\/video\/([^/]+)/);
    if (videoMatch?.[1]) {
      const url = new URL(`https://rutube.ru/play/embed/${videoMatch[1]}`);
      url.searchParams.set("autoplay", options?.autoplay ? "1" : "0");
      if (options?.positionSec && options.positionSec > 0) {
        url.searchParams.set("t", String(Math.floor(options.positionSec)));
        url.searchParams.set("start", String(Math.floor(options.positionSec)));
      }
      if (options?.reloadToken) {
        url.searchParams.set("_sync", options.reloadToken);
      }
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function toVkVideoEmbedUrl(rawUrl: string, options?: { autoplay?: boolean; positionSec?: number; reloadToken?: string }): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const isVkHost = host.includes("vk.com") || host.includes("vkvideo.ru");
    if (!isVkHost) {
      return null;
    }

    if (parsed.pathname.includes("video_ext.php")) {
      const oid = parsed.searchParams.get("oid");
      const id = parsed.searchParams.get("id");
      if (oid && id) {
        const url = new URL("https://vk.com/video_ext.php");
        url.searchParams.set("oid", oid);
        url.searchParams.set("id", id);
        url.searchParams.set("hd", "2");
        url.searchParams.set("autoplay", options?.autoplay ? "1" : "0");
        if (options?.positionSec && options.positionSec > 0) {
          url.searchParams.set("t", String(Math.floor(options.positionSec)));
          url.searchParams.set("start", String(Math.floor(options.positionSec)));
        }
        if (options?.reloadToken) {
          url.searchParams.set("_sync", options.reloadToken);
        }
        return url.toString();
      }
    }

    const videoIdMatch = parsed.pathname.match(/\/video(-?\d+)_(-?\d+)/);
    if (videoIdMatch?.[1] && videoIdMatch?.[2]) {
      const url = new URL("https://vk.com/video_ext.php");
      url.searchParams.set("oid", videoIdMatch[1]);
      url.searchParams.set("id", videoIdMatch[2]);
      url.searchParams.set("hd", "2");
      url.searchParams.set("autoplay", options?.autoplay ? "1" : "0");
      if (options?.positionSec && options.positionSec > 0) {
        url.searchParams.set("t", String(Math.floor(options.positionSec)));
        url.searchParams.set("start", String(Math.floor(options.positionSec)));
      }
      if (options?.reloadToken) {
        url.searchParams.set("_sync", options.reloadToken);
      }
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function toTwitchEmbedUrl(rawUrl: string, options?: { autoplay?: boolean; positionSec?: number; reloadToken?: string }): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const channelMatch = parsed.pathname.match(/^\/([^/]+)$/);
    const videoMatch = parsed.pathname.match(/^\/videos\/(\d+)/);
    const clipMatch = parsed.pathname.match(/^\/[^/]+\/clip\/([^/?#]+)/);
    const isClipsHost = host.includes("clips.twitch.tv");
    const toTwitchTime = (seconds?: number): string | null => {
      if (!seconds || seconds <= 0) {
        return null;
      }
      const total = Math.floor(seconds);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (h > 0) {
        return `${h}h${m}m${s}s`;
      }
      if (m > 0) {
        return `${m}m${s}s`;
      }
      return `${s}s`;
    };

    const url = new URL("https://player.twitch.tv/");
    url.searchParams.append("parent", "gvoice.online");
    url.searchParams.append("parent", "www.gvoice.online");
    url.searchParams.set("autoplay", options?.autoplay ? "true" : "false");
    const time = toTwitchTime(options?.positionSec);
    if (time) {
      url.searchParams.set("time", time);
    }
    if (options?.reloadToken) {
      url.searchParams.set("_sync", options.reloadToken);
    }

    if (isClipsHost) {
      const slug = parsed.pathname.split("/").filter(Boolean)[0];
      if (!slug) {
        return null;
      }
      url.searchParams.set("clip", slug);
      return url.toString();
    }

    if (!host.includes("twitch.tv")) {
      return null;
    }

    if (videoMatch?.[1]) {
      url.searchParams.set("video", `v${videoMatch[1]}`);
      return url.toString();
    }

    if (clipMatch?.[1]) {
      url.searchParams.set("clip", clipMatch[1]);
      return url.toString();
    }

    const channel = channelMatch?.[1]?.toLowerCase();
    if (channel && !["videos", "directory", "p", "settings", "downloads"].includes(channel)) {
      url.searchParams.set("channel", channel);
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function parseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
const PINNED_WORKSPACES_STORAGE_KEY = "gvoice_pinned_workspaces_v1";
const PINNED_DM_STORAGE_KEY = "gvoice_pinned_dm_v1";

function mergeLatestSeenValues(
  current: Record<string, string>,
  incoming: Record<string, string>
): Record<string, string> {
  const next = { ...current };
  for (const [id, seenAt] of Object.entries(incoming)) {
    const currentSeenAt = next[id];
    if (!currentSeenAt || Date.parse(seenAt) > Date.parse(currentSeenAt)) {
      next[id] = seenAt;
    }
  }
  return next;
}

function loadPinnedIds(storageKey: string): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isHlsUrl(url: string | null | undefined) {
  return Boolean(url && /\.m3u8(\?|#|$)/i.test(url));
}

export function Dashboard() {
  const { user, logout, refreshProfile, authorizedFetch, getAccessToken } = useAuth();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelUnreadById, setChannelUnreadById] = useState<Record<string, number>>({});
  const [channelLastSeenById, setChannelLastSeenById] = useState<Record<string, string>>(() => loadChannelLastSeenMap());
  const [readStatesReady, setReadStatesReady] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [workspaceUnreadById, setWorkspaceUnreadById] = useState<Record<string, number>>({});
  const [workspaceActivityById, setWorkspaceActivityById] = useState<Record<string, string>>({});
  const [pinnedWorkspaceIds, setPinnedWorkspaceIds] = useState<string[]>(() => loadPinnedIds(`${PINNED_WORKSPACES_STORAGE_KEY}:${user?.id ?? "anon"}`));
  const [mediaSessionByChannelId, setMediaSessionByChannelId] = useState<Record<string, MediaSessionState>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [mobileSpacesPane, setMobileSpacesPane] = useState<"workspaces" | "channels" | "chat">("workspaces");
  const [mobileVoicePanelExpanded, setMobileVoicePanelExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>("spaces");
  const [showEntryWelcome, setShowEntryWelcome] = useState(true);
  const [dmDialogs, setDmDialogs] = useState<DirectDialog[]>([]);
  const [dmSelectedWorkspaceId, setDmSelectedWorkspaceId] = useState<string | null>(null);
  const [mobileDmPane, setMobileDmPane] = useState<"dialogs" | "chat">("dialogs");
  const [dmSelectedTextChannelId, setDmSelectedTextChannelId] = useState<string | null>(null);
  const [dmSelectedVoiceChannelId, setDmSelectedVoiceChannelId] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<Message[]>([]);
  const [dmMessageText, setDmMessageText] = useState("");
  const [dmMessageAttachment, setDmMessageAttachment] = useState<File | null>(null);
  const [dmLastSeenByWorkspace, setDmLastSeenByWorkspace] = useState<Record<string, string>>(() => loadDmLastSeenMap());
  const [dmUnreadByWorkspaceId, setDmUnreadByWorkspaceId] = useState<Record<string, number>>({});
  const [dmActivityByWorkspaceId, setDmActivityByWorkspaceId] = useState<Record<string, string>>({});
  const [pinnedDmWorkspaceIds, setPinnedDmWorkspaceIds] = useState<string[]>(() => loadPinnedIds(`${PINNED_DM_STORAGE_KEY}:${user?.id ?? "anon"}`));
  const [dmSearchId, setDmSearchId] = useState("");
  const [dmSearchResult, setDmSearchResult] = useState<DirectUserSearchResult | null>(null);
  const [dmIncomingRequests, setDmIncomingRequests] = useState<DirectIncomingRequest[]>([]);
  const [dmBlocks, setDmBlocks] = useState<DirectBlock[]>([]);
  const [isFriendsPanelOpen, setIsFriendsPanelOpen] = useState(false);
  const [isSupportPanelOpen, setIsSupportPanelOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [friendsPanelTab, setFriendsPanelTab] = useState<"friends" | "requests" | "blocked">("friends");
  const [dmIncomingCallByWorkspaceId, setDmIncomingCallByWorkspaceId] = useState<Record<string, DmIncomingCall>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [memberAvatarPreview, setMemberAvatarPreview] = useState<{
    url: string;
    username: string;
    left: number;
    top: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [inviteLinkToken, setInviteLinkToken] = useState<string | null>(null);

  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceJoinPolicy, setWorkspaceJoinPolicy] = useState<"open" | "request" | "private">("request");
  const [isCreateWorkspaceOpen, setIsCreateWorkspaceOpen] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingWorkspaceName, setEditingWorkspaceName] = useState("");
  const [channelName, setChannelName] = useState("");
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editingChannelName, setEditingChannelName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice">("text");
  const [channelIsPrivate, setChannelIsPrivate] = useState(false);
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false);
  const [workspaceBansWorkspaceId, setWorkspaceBansWorkspaceId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [messageAttachment, setMessageAttachment] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [editingMessageReplyPrefix, setEditingMessageReplyPrefix] = useState<string | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<MessageContextMenuState | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [messagesLoadingOlder, setMessagesLoadingOlder] = useState(false);
  const [messagesCursor, setMessagesCursor] = useState<string | null>(null);
  const [voiceVolumeMenu, setVoiceVolumeMenu] = useState<VoiceVolumeContextMenuState | null>(null);
  const [memberRoleMenu, setMemberRoleMenu] = useState<MemberRoleContextMenuState | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<ChannelContextMenuState | null>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<WorkspaceContextMenuState | null>(null);
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const [workspaceSearchResults, setWorkspaceSearchResults] = useState<WorkspaceSearchResult[]>([]);
  const [joinRequests, setJoinRequests] = useState<WorkspaceJoinRequest[]>([]);
  const [isWorkspaceInviteOpen, setIsWorkspaceInviteOpen] = useState(false);
  const [workspaceInviteNumericId, setWorkspaceInviteNumericId] = useState("");
  const [workspaceInviteBusy, setWorkspaceInviteBusy] = useState(false);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [workspaceEditName, setWorkspaceEditName] = useState("");
  const [isProfileEditorOpen, setIsProfileEditorOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"profile" | "security" | "audio" | "notifications" | "keybinds" | "updates">("profile");
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(() => loadNotificationSettings());
  const [profileEmail, setProfileEmail] = useState("");
  const [profileUsername, setProfileUsername] = useState("");
  const [profileCurrentPassword, setProfileCurrentPassword] = useState("");
  const [profileNewPassword, setProfileNewPassword] = useState("");
  const [profileNewPasswordConfirm, setProfileNewPasswordConfirm] = useState("");
  const [profileAvatarFile, setProfileAvatarFile] = useState<File | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [voiceJoinedChannelId, setVoiceJoinedChannelId] = useState<string | null>(null);
  const [voiceParticipants, setVoiceParticipants] = useState<VoiceParticipant[]>([]);
  const [voiceOccupancyByChannelId, setVoiceOccupancyByChannelId] = useState<Record<string, VoiceParticipant[]>>({});
  const [dmVoiceParticipants, setDmVoiceParticipants] = useState<VoiceParticipant[]>([]);
  const [speakingUserIds, setSpeakingUserIds] = useState<string[]>([]);
  const [localMicSpeaking, setLocalMicSpeaking] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [selfDeafened, setSelfDeafened] = useState(false);
  const [voiceKeybinds, setVoiceKeybinds] = useState<VoiceKeybinds>(() => loadPersistedVoiceKeybinds());
  const [radioModeEnabled, setRadioModeEnabled] = useState(() => loadPersistedRadioModeEnabled());
  const [pushToTalkHolding, setPushToTalkHolding] = useState(false);
  const [recordingKeybindAction, setRecordingKeybindAction] = useState<VoiceKeybindAction | null>(null);
  const [voiceVolumeBySocketId, setVoiceVolumeBySocketId] = useState<Record<string, number>>(() => loadPersistedVoiceVolumeMap());
  const [micInputVolume, setMicInputVolume] = useState<number>(() => loadPersistedMicInputVolume());
  const [screenShareVolumeByKey, setScreenShareVolumeByKey] = useState<Record<string, number>>({});
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isScreenSharePickerOpen, setIsScreenSharePickerOpen] = useState(false);
  const [isMiniGamesOpen, setIsMiniGamesOpen] = useState(false);
  const [pendingScreenShareSource, setPendingScreenShareSource] = useState<ShareSourceId>("screen");
  const [desktopDisplaySources, setDesktopDisplaySources] = useState<DesktopDisplaySource[]>([]);
  const [displaySourcesLoading, setDisplaySourcesLoading] = useState(false);
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Record<string, MediaStream>>({});
  const [expandedScreenShareKey, setExpandedScreenShareKey] = useState<string | null>(null);
  const [livekitRemoteAudioCount, setLivekitRemoteAudioCount] = useState(0);
  const [joinedScreenSharesByKey, setJoinedScreenSharesByKey] = useState<Record<string, boolean>>({});
  const [remoteScreenPresenterByKey, setRemoteScreenPresenterByKey] = useState<Record<string, string>>({});
  const [livekitStatus, setLivekitStatus] = useState<"idle" | "connecting" | "connected" | "failed">("idle");
  const [livekitError, setLivekitError] = useState<string | null>(null);
  const [nativeVoiceDebugText, setNativeVoiceDebugText] = useState<string | null>(null);
  const [platformDebugText, setPlatformDebugText] = useState<string>("");
  const [noiseMode, setNoiseMode] = useState<NoiseMode>(() => loadPersistedNoiseMode());
  const [settingsNoiseMode, setSettingsNoiseMode] = useState<NoiseMode>(() => loadPersistedNoiseMode());
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevicesBusy, setAudioDevicesBusy] = useState(false);
  const [audioInputDeviceId, setAudioInputDeviceId] = useState(() => loadPersistedDeviceId(AUDIO_INPUT_DEVICE_STORAGE_KEY));
  const [audioOutputDeviceId, setAudioOutputDeviceId] = useState(() => loadPersistedDeviceId(AUDIO_OUTPUT_DEVICE_STORAGE_KEY));
  const [settingsAudioInputDeviceId, setSettingsAudioInputDeviceId] = useState(() => loadPersistedDeviceId(AUDIO_INPUT_DEVICE_STORAGE_KEY));
  const [settingsAudioOutputDeviceId, setSettingsAudioOutputDeviceId] = useState(() => loadPersistedDeviceId(AUDIO_OUTPUT_DEVICE_STORAGE_KEY));
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateStatus>({
    stage: "idle",
    message: "Проверка обновлений не запускалась."
  });
  const [desktopUpdateBusy, setDesktopUpdateBusy] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  });

  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const mediaPlayerRef = useRef<HTMLMediaElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const youtubeHostRef = useRef<HTMLDivElement | null>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const youtubePlayerVideoIdRef = useRef<string | null>(null);
  const suppressMediaEventsRef = useRef(false);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const localScreenTrackRef = useRef<MediaStreamTrack | null>(null);
  const localLivekitScreenPublicationsRef = useRef<LocalTrackPublication[]>([]);
  const livekitRoomRef = useRef<Room | null>(null);
  const livekitRoomChannelIdRef = useRef<string | null>(null);
  const livekitConnectPromiseRef = useRef<Promise<Room> | null>(null);
  const livekitConnectChannelIdRef = useRef<string | null>(null);
  const livekitRemoteAudioReadyRef = useRef(false);
  const livekitRemoteAudioReadyTimerRef = useRef<number | null>(null);
  const livekitScreenAudioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const livekitVoiceAudioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const screenShareBusyRef = useRef(false);
  const localProcessedStreamRef = useRef<MediaStream | null>(null);
  const localAudioContextRef = useRef<AudioContext | null>(null);
  const localAudioNodesRef = useRef<{
    source: MediaStreamAudioSourceNode;
    highPass?: BiquadFilterNode;
    compressor?: DynamicsCompressorNode;
    output: MediaStreamAudioDestinationNode;
  } | null>(null);
  const localSpeechAudioContextRef = useRef<AudioContext | null>(null);
  const localSpeechSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const localSpeechAnimationFrameRef = useRef<number | null>(null);
  const voiceChannelIdRef = useRef<string | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const voiceVolumeBySocketIdRef = useRef<Record<string, number>>({});
  const micInputVolumeRef = useRef<number>(1);
  const audioInputDeviceIdRef = useRef("");
  const audioOutputDeviceIdRef = useRef("");
  const selfDeafenedRef = useRef(false);
  const muteBeforeDeafenRef = useRef(false);
  const pushToTalkHoldingRef = useRef(false);
  const screenShareVolumeByKeyRef = useRef<Record<string, number>>({});
  const joinedScreenSharesByKeyRef = useRef<Record<string, boolean>>({});
  const selectedWorkspaceIdRef = useRef<string | null>(null);
  const channelWorkspaceByIdRef = useRef<Record<string, string>>({});
  const selectedChannelIdRef = useRef<string | null>(null);
  const selectedChannelTypeRef = useRef<Channel["type"] | null>(null);
  const activeTabRef = useRef<DashboardTab>("spaces");
  const currentUserIdRef = useRef<string | null>(null);
  const voicePeersRef = useRef<Map<string, VoicePeer>>(new Map());
  const pendingCandidatesRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const makingOfferRef = useRef<Record<string, boolean>>({});
  const voiceRecoveringRef = useRef(false);
  const uiAudioCtxRef = useRef<AudioContext | null>(null);
  const messageSoundRef = useRef<HTMLAudioElement | null>(null);
  const notificationSettingsRef = useRef(notificationSettings);
  const joinSoundRef = useRef<HTMLAudioElement | null>(null);
  const leaveSoundRef = useRef<HTMLAudioElement | null>(null);
  const screenShareOnSoundRef = useRef<HTMLAudioElement | null>(null);
  const screenShareOffSoundRef = useRef<HTMLAudioElement | null>(null);
  const micOnSoundRef = useRef<HTMLAudioElement | null>(null);
  const micOffSoundRef = useRef<HTMLAudioElement | null>(null);
  const messagesListRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const messageJumpHighlightTimeoutRef = useRef<number | null>(null);
  const messagesStickToBottomByChannelRef = useRef<Record<string, boolean>>({});
  const messagesScrollTopByChannelRef = useRef<Record<string, number>>({});
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const hasInitialChatScrollRef = useRef(false);
  const handledInviteTokenRef = useRef<string | null>(null);
  const soloVoiceLeaveTimeoutRef = useRef<number | null>(null);
  const soloVoiceWarnTimeoutRef = useRef<number | null>(null);
  const dmLastSeenByWorkspaceRef = useRef<Record<string, string>>(dmLastSeenByWorkspace);
  const channelLastSeenByIdRef = useRef<Record<string, string>>(channelLastSeenById);
  const serverLastSeenByChannelIdRef = useRef<Record<string, string>>({});
  const dmDialogsRef = useRef<DirectDialog[]>([]);
  const dmSelectedWorkspaceIdRef = useRef<string | null>(null);
  const dmSelectedTextChannelIdRef = useRef<string | null>(null);
  const dmIncomingCallByWorkspaceIdRef = useRef<Record<string, DmIncomingCall>>({});
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  );

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  );
  const selectedDmDialog = useMemo(
    () => dmDialogs.find((dialog) => dialog.workspaceId === dmSelectedWorkspaceId) ?? null,
    [dmDialogs, dmSelectedWorkspaceId]
  );
  const workspaceIdsKey = useMemo(
    () => workspaces.map((workspace) => workspace.id).sort().join(","),
    [workspaces]
  );
  const onlineUserIdSet = useMemo(() => new Set(onlineUserIds), [onlineUserIds]);
  const blockedUserIdSet = useMemo(() => new Set(dmBlocks.map((item) => item.blocked.id)), [dmBlocks]);
  const friendUserIdSet = useMemo(
    () => new Set(dmDialogs.filter((dialog) => dialog.isFriend && dialog.partner).map((dialog) => dialog.partner!.id)),
    [dmDialogs]
  );
  const workspaceMemberUserIdSet = useMemo(
    () => new Set(workspaceMembers.map((member) => member.id)),
    [workspaceMembers]
  );
  const pinnedWorkspaceIdSet = useMemo(() => new Set(pinnedWorkspaceIds), [pinnedWorkspaceIds]);
  const pinnedDmWorkspaceIdSet = useMemo(() => new Set(pinnedDmWorkspaceIds), [pinnedDmWorkspaceIds]);
  const sortedWorkspaces = useMemo(() => {
    const originalIndex = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
    return [...workspaces].sort((left, right) => {
      const pinDifference = Number(pinnedWorkspaceIdSet.has(right.id)) - Number(pinnedWorkspaceIdSet.has(left.id));
      if (pinDifference !== 0) return pinDifference;
      const activityDifference = (Date.parse(workspaceActivityById[right.id] ?? "") || 0) - (Date.parse(workspaceActivityById[left.id] ?? "") || 0);
      if (activityDifference !== 0) return activityDifference;
      return (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0);
    });
  }, [pinnedWorkspaceIdSet, workspaceActivityById, workspaces]);
  const sortedDmDialogs = useMemo(() => {
    const originalIndex = new Map(dmDialogs.map((dialog, index) => [dialog.workspaceId, index]));
    return [...dmDialogs].sort((left, right) => {
      const pinDifference = Number(pinnedDmWorkspaceIdSet.has(right.workspaceId)) - Number(pinnedDmWorkspaceIdSet.has(left.workspaceId));
      if (pinDifference !== 0) return pinDifference;
      const activityDifference = (Date.parse(dmActivityByWorkspaceId[right.workspaceId] ?? "") || 0) - (Date.parse(dmActivityByWorkspaceId[left.workspaceId] ?? "") || 0);
      if (activityDifference !== 0) return activityDifference;
      return (originalIndex.get(left.workspaceId) ?? 0) - (originalIndex.get(right.workspaceId) ?? 0);
    });
  }, [dmActivityByWorkspaceId, dmDialogs, pinnedDmWorkspaceIdSet]);
  const invitableFriends = useMemo(
    () => sortedDmDialogs.filter(
      (dialog) => dialog.isFriend && dialog.partner && !workspaceMemberUserIdSet.has(dialog.partner.id)
    ),
    [sortedDmDialogs, workspaceMemberUserIdSet]
  );
  const speakingUserIdSet = useMemo(() => new Set(speakingUserIds), [speakingUserIds]);
  const isUserOnline = (userId?: string | null) => Boolean(userId && onlineUserIdSet.has(userId));
  const isUserSpeaking = (userId?: string | null) =>
    Boolean(userId && (speakingUserIdSet.has(userId) || (userId === user?.id && localMicSpeaking)));
  const presenceLabel = (userId?: string | null) => (isUserOnline(userId) ? "онлайн" : "не в сети");
  const presenceColor = (userId?: string | null) => (isUserOnline(userId) ? "#22c55e" : "#64748b");
  const activeVoiceChannelLabel = useMemo(() => {
    if (!voiceJoinedChannelId) {
      return null;
    }
    const known = channels.find((channel) => channel.id === voiceJoinedChannelId);
    if (known) {
      return `# ${known.name}`;
    }
    const dmDialog = dmDialogs.find((dialog) => dialog.voiceChannelId === voiceJoinedChannelId);
    if (dmDialog) {
      return dmDialog.partner?.username ? `ЛС с ${dmDialog.partner.username}` : "личные сообщения";
    }
    return "звонок";
  }, [channels, dmDialogs, voiceJoinedChannelId]);
  const canModerateWorkspace = selectedWorkspace?.role === "owner" || selectedWorkspace?.role === "admin";
  const isSelectedWorkspaceRequest = selectedWorkspace?.joinPolicy === "request";
  const canManageWorkspace = canModerateWorkspace;
  const canManageChannels = canManageWorkspace || selectedWorkspace?.role === "moderator";
  const canDeleteForeignMessages = selectedWorkspace?.role === "owner" || selectedWorkspace?.role === "admin" || selectedWorkspace?.role === "moderator";
  const spacesTabAlertCount = useMemo(
    () => Object.values(workspaceUnreadById).reduce((acc, count) => acc + (count > 0 ? count : 0), 0),
    [workspaceUnreadById]
  );
  const dmUnreadCount = useMemo(
    () => Object.values(dmUnreadByWorkspaceId).reduce((acc, count) => acc + (count > 0 ? count : 0), 0),
    [dmUnreadByWorkspaceId]
  );
  const dmTabAlertCount = dmIncomingRequests.length + dmUnreadCount;
  const isDesktopRuntime = Boolean(window.gvoiceDesktop);
  const isVoiceChannelSelected = selectedChannel?.type === "voice";
  const isVoiceCallStartedInSelectedChannel =
    Boolean(isVoiceChannelSelected && selectedChannelId && (voiceJoinedChannelId === selectedChannelId || voiceParticipants.length > 0));
  const remoteVoiceParticipantsCount = useMemo(
    () => voiceParticipants.filter((participant) => participant.userId !== user?.id).length,
    [voiceParticipants, user?.id]
  );
  const isRemoteVoiceSyncing =
    voiceJoinedChannelId === selectedChannelId &&
    livekitStatus === "connected" &&
    remoteVoiceParticipantsCount > 0 &&
    livekitRemoteAudioCount === 0;
  const selectedMediaSession = selectedChannelId ? mediaSessionByChannelId[selectedChannelId] ?? null : null;
  const showMediaBot: boolean = false;
  const startGreeting = useMemo(
    () => START_GREETING_PHRASES[Math.floor(Math.random() * START_GREETING_PHRASES.length)],
    []
  );
  const showSpacesWelcome = !selectedWorkspaceId;
  const selectedDmIncomingCall = dmSelectedWorkspaceId ? dmIncomingCallByWorkspaceId[dmSelectedWorkspaceId] ?? null : null;
  const dmIncomingCall = useMemo(() => {
    if (!dmSelectedVoiceChannelId) {
      return false;
    }
    if (voiceJoinedChannelId === dmSelectedVoiceChannelId) {
      return false;
    }
    return Boolean(selectedDmIncomingCall) || dmVoiceParticipants.some((participant) => participant.userId !== user?.id);
  }, [dmSelectedVoiceChannelId, dmVoiceParticipants, selectedDmIncomingCall, user?.id, voiceJoinedChannelId]);
  const isJoinedSelectedDmVoice =
    Boolean(dmSelectedVoiceChannelId && voiceJoinedChannelId && voiceJoinedChannelId === dmSelectedVoiceChannelId);
  const dmRemoteVoiceParticipants = useMemo(
    () => dmVoiceParticipants.filter((participant) => participant.userId !== user?.id),
    [dmVoiceParticipants, user?.id]
  );
  const showDmWelcome = !dmSelectedWorkspaceId;
  const isCurrentUserMediaMaster = selectedMediaSession?.masterUserId === user?.id;
  const effectiveSelectedMediaPositionSec = useMemo(
    () => getEffectiveMediaPositionSec(selectedMediaSession),
    [
      selectedMediaSession?.isActive,
      selectedMediaSession?.isPaused,
      selectedMediaSession?.positionSec,
      selectedMediaSession?.syncedAt
    ]
  );

  useEffect(() => {
    if (!imagePreview) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setImagePreview(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [imagePreview]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const token = params.get("wsInvite");
    if (!token) {
      return;
    }
    setInviteLinkToken(token);
  }, []);

  useEffect(() => {
    if (!selectedWorkspace) {
      setWorkspaceEditName("");
      return;
    }

    setWorkspaceEditName(selectedWorkspace.name);
  }, [selectedWorkspace]);

  useEffect(() => {
    const isJoinedThisChannel = Boolean(voiceJoinedChannelId && selectedChannelId && voiceJoinedChannelId === selectedChannelId);
    const myUserId = user?.id ?? null;
    const participantsInThisChannel = isJoinedThisChannel ? voiceParticipants : [];
    const isAloneInVoice =
      isJoinedThisChannel &&
      myUserId &&
      participantsInThisChannel.length === 1 &&
      participantsInThisChannel[0]?.userId === myUserId;

    if (soloVoiceLeaveTimeoutRef.current) {
      window.clearTimeout(soloVoiceLeaveTimeoutRef.current);
      soloVoiceLeaveTimeoutRef.current = null;
    }
    if (soloVoiceWarnTimeoutRef.current) {
      window.clearTimeout(soloVoiceWarnTimeoutRef.current);
      soloVoiceWarnTimeoutRef.current = null;
    }

    if (!isAloneInVoice) {
      return;
    }

    soloVoiceWarnTimeoutRef.current = window.setTimeout(() => {
      setInviteStatus("Ты один в звонке. Через 5 минут звонок будет автоматически завершён, если никто не подключится.");
    }, SOLO_VOICE_AUTO_LEAVE_MS - 5 * 60 * 1000);

    soloVoiceLeaveTimeoutRef.current = window.setTimeout(() => {
      setInviteStatus("Ты был один в звонке 30 минут, поэтому мы автоматически завершили звонок для экономии ресурсов.");
      leaveVoiceFromUi();
    }, SOLO_VOICE_AUTO_LEAVE_MS);

    return () => {
      if (soloVoiceLeaveTimeoutRef.current) {
        window.clearTimeout(soloVoiceLeaveTimeoutRef.current);
        soloVoiceLeaveTimeoutRef.current = null;
      }
      if (soloVoiceWarnTimeoutRef.current) {
        window.clearTimeout(soloVoiceWarnTimeoutRef.current);
        soloVoiceWarnTimeoutRef.current = null;
      }
    };
  }, [voiceJoinedChannelId, selectedChannelId, voiceParticipants, user?.id]);

  useEffect(() => {
    setProfileUsername(user?.username ?? "");
    setProfileEmail(user?.email ?? "");
  }, [user?.username, user?.email]);

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings;
  }, [notificationSettings]);

  useEffect(() => {
    if (!window.gvoiceDesktop?.onUpdateStatus) {
      return;
    }
    const unsubscribe = window.gvoiceDesktop.onUpdateStatus((payload) => {
      if (payload.stage === "checking") {
        setDesktopUpdateBusy(true);
        setDesktopUpdateStatus({ stage: "checking", message: "Проверяем наличие обновлений..." });
        return;
      }
      if (payload.stage === "available") {
        setDesktopUpdateBusy(true);
        setDesktopUpdateStatus({
          stage: "available",
          message: payload.version ? `Найдена версия ${payload.version}. Идет загрузка...` : "Найдено обновление. Идет загрузка..."
        });
        return;
      }
      if (payload.stage === "downloading") {
        setDesktopUpdateBusy(true);
        const percent = Number.isFinite(payload.percent) ? Math.round(payload.percent ?? 0) : 0;
        setDesktopUpdateStatus({ stage: "downloading", message: `Скачиваем обновление: ${percent}%` });
        return;
      }
      if (payload.stage === "downloaded") {
        setDesktopUpdateBusy(false);
        setDesktopUpdateStatus({
          stage: "downloaded",
          message: payload.version
            ? `Обновление ${payload.version} скачано. Подтверди перезапуск в системном окне.`
            : "Обновление скачано. Подтверди перезапуск в системном окне."
        });
        return;
      }
      if (payload.stage === "not-available") {
        setDesktopUpdateBusy(false);
        setDesktopUpdateStatus({
          stage: "not-available",
          message: payload.version ? `Новых версий нет (текущая: ${payload.version}).` : "Новых версий пока нет."
        });
        return;
      }
      if (payload.stage === "error") {
        setDesktopUpdateBusy(false);
        setDesktopUpdateStatus({
          stage: "error",
          message: payload.message ? `Ошибка проверки: ${payload.message}` : "Ошибка проверки обновлений."
        });
      }
    });
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, []);

  useEffect(() => {
    voiceVolumeBySocketIdRef.current = voiceVolumeBySocketId;
  }, [voiceVolumeBySocketId]);

  useEffect(() => {
    micInputVolumeRef.current = micInputVolume;
  }, [micInputVolume]);

  useEffect(() => {
    audioInputDeviceIdRef.current = audioInputDeviceId;
    try {
      window.localStorage.setItem(AUDIO_INPUT_DEVICE_STORAGE_KEY, audioInputDeviceId);
    } catch {
      // Ignore storage write errors.
    }
  }, [audioInputDeviceId]);

  useEffect(() => {
    audioOutputDeviceIdRef.current = audioOutputDeviceId;
    try {
      window.localStorage.setItem(AUDIO_OUTPUT_DEVICE_STORAGE_KEY, audioOutputDeviceId);
    } catch {
      // Ignore storage write errors.
    }
  }, [audioOutputDeviceId]);

  useEffect(() => {
    selfDeafenedRef.current = selfDeafened;
    setAllRemoteAudioMuted(selfDeafened);
  }, [selfDeafened]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(VOICE_VOLUME_STORAGE_KEY, JSON.stringify(voiceVolumeBySocketId));
    } catch {
      // Ignore storage write errors.
    }
  }, [voiceVolumeBySocketId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(MIC_VOLUME_STORAGE_KEY, String(micInputVolume));
    } catch {
      // Ignore storage write errors.
    }
  }, [micInputVolume]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(NOISE_MODE_STORAGE_KEY, noiseMode);
    } catch {
      // Ignore storage write errors.
    }
  }, [noiseMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(VOICE_KEYBINDS_STORAGE_KEY, JSON.stringify(voiceKeybinds));
    } catch {
      // ignore localStorage failures
    }
  }, [voiceKeybinds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`${PINNED_WORKSPACES_STORAGE_KEY}:${user?.id ?? "anon"}`, JSON.stringify(pinnedWorkspaceIds));
    } catch {
      // Ignore storage write errors.
    }
  }, [pinnedWorkspaceIds, user?.id]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`${PINNED_DM_STORAGE_KEY}:${user?.id ?? "anon"}`, JSON.stringify(pinnedDmWorkspaceIds));
    } catch {
      // Ignore storage write errors.
    }
  }, [pinnedDmWorkspaceIds, user?.id]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(RADIO_MODE_ENABLED_STORAGE_KEY, radioModeEnabled ? "true" : "false");
      } catch {
        // ignore localStorage failures
      }
    }
    if (!radioModeEnabled) {
      pushToTalkHoldingRef.current = false;
      setPushToTalkHolding(false);
      if (voiceJoinedChannelId && voiceMuted && !selfDeafenedRef.current) {
        applyVoiceMute(false);
      }
    }
  }, [radioModeEnabled]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const nextWorkspaceUnread: Record<string, number> = {};
    for (const [channelId, count] of Object.entries(channelUnreadById)) {
      const workspaceId = channelWorkspaceByIdRef.current[channelId];
      if (!workspaceId || count <= 0) continue;
      nextWorkspaceUnread[workspaceId] = Math.min(1000, (nextWorkspaceUnread[workspaceId] ?? 0) + count);
    }
    setWorkspaceUnreadById(nextWorkspaceUnread);
  }, [channelUnreadById]);

  useEffect(() => {
    if (!dmSelectedWorkspaceId) return;
    setDmUnreadByWorkspaceId((prev) => {
      if (!prev[dmSelectedWorkspaceId]) return prev;
      const next = { ...prev };
      delete next[dmSelectedWorkspaceId];
      return next;
    });
  }, [dmSelectedWorkspaceId]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    if (!isUserMenuOpen) {
      return;
    }
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest(".gvoice-profile-menu")) {
        setIsUserMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isUserMenuOpen]);

  useEffect(() => {
    if (!isDesktopRuntime || !isScreenSharePickerOpen || !window.gvoiceDesktop?.getDisplaySources) {
      setDesktopDisplaySources([]);
      setDisplaySourcesLoading(false);
      return;
    }
    let cancelled = false;
    setDisplaySourcesLoading(true);
    void window.gvoiceDesktop.getDisplaySources()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setDesktopDisplaySources(result.ok && Array.isArray(result.sources) ? result.sources : []);
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopDisplaySources([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDisplaySourcesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, isScreenSharePickerOpen]);

  useEffect(() => {
    if (activeTab !== "spaces" || !selectedChannelId) {
      return;
    }
    requestAnimationFrame(() => restoreMessagesScrollPosition(selectedChannelId));
  }, [activeTab, selectedChannelId]);

  useEffect(() => {
    const knownWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setWorkspaceUnreadById((prev) => {
      const next: Record<string, number> = {};
      let changed = false;
      for (const [workspaceId, count] of Object.entries(prev)) {
        if (knownWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = count;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [workspaces]);

  useEffect(() => {
    if (!inviteLinkToken) {
      return;
    }
    if (handledInviteTokenRef.current === inviteLinkToken) {
      return;
    }

    let cancelled = false;
    handledInviteTokenRef.current = inviteLinkToken;

    async function joinByInviteToken() {
      try {
        const response = await authorizedFetch("/workspaces/join-by-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: inviteLinkToken })
        });
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; status?: string; workspace?: { id: string; name: string } }
          | null;
        if (!response.ok) {
          throw new Error(payload?.error ?? "Не удалось вступить по ссылке");
        }
        if (cancelled) {
          return;
        }
        const status = payload?.status;
        const workspaceId = payload?.workspace?.id ?? null;
        if (workspaceId) {
          setSelectedWorkspaceId(workspaceId);
          const listResponse = await authorizedFetch("/workspaces");
          if (listResponse.ok) {
            const list = await parseJson<Workspace[]>(listResponse);
            if (!cancelled) {
              setWorkspaces(list);
            }
          }
        }
        if (status === "approved" || status === "already-member") {
          setInviteStatus("Вы вошли в пространство по ссылке.");
        } else {
          setInviteStatus("Заявка в пространство отправлена по ссылке.");
        }
        const url = new URL(window.location.href);
        url.searchParams.delete("wsInvite");
        window.history.replaceState({}, "", url.toString());
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Ошибка вступления по ссылке");
        }
      }
    }

    void joinByInviteToken();
    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, inviteLinkToken]);

  useEffect(() => {
    currentUserIdRef.current = user?.id ?? null;
  }, [user?.id]);

  useEffect(() => {
    dmIncomingCallByWorkspaceIdRef.current = dmIncomingCallByWorkspaceId;
  }, [dmIncomingCallByWorkspaceId]);

  useEffect(() => {
    dmDialogsRef.current = dmDialogs;
  }, [dmDialogs]);

  useEffect(() => {
    dmSelectedWorkspaceIdRef.current = dmSelectedWorkspaceId;
  }, [dmSelectedWorkspaceId]);

  useEffect(() => {
    dmSelectedTextChannelIdRef.current = dmSelectedTextChannelId;
  }, [dmSelectedTextChannelId]);

  useEffect(() => {
    let mounted = true;

    async function refreshPresence() {
      try {
        const response = await authorizedFetch("/presence");
        if (!response.ok) {
          return;
        }
        const payload = await parseJson<PresenceSnapshot>(response);
        if (!mounted) {
          return;
        }
        setOnlineUserIds(Array.isArray(payload.onlineUserIds) ? payload.onlineUserIds : []);
      } catch {
        // Keep the last known presence state if a poll fails.
      }
    }

    void refreshPresence();
    const intervalId = window.setInterval(() => {
      void refreshPresence();
    }, 3000);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, [authorizedFetch, user?.id]);

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
    selectedChannelTypeRef.current = selectedChannel?.type ?? null;
    if (selectedChannelId) {
      setChannelUnreadById((prev) => {
        if (!prev[selectedChannelId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[selectedChannelId];
        return next;
      });
    }
  }, [selectedChannelId, selectedChannel?.type]);

  useEffect(() => {
    channelLastSeenByIdRef.current = channelLastSeenById;
    try {
      window.localStorage.setItem(CHANNEL_LAST_SEEN_STORAGE_KEY, JSON.stringify(channelLastSeenById));
    } catch {
      // ignore localStorage failures
    }
  }, [channelLastSeenById]);

  useEffect(() => {
    let mounted = true;
    setReadStatesReady(false);

    async function syncReadStates() {
      try {
        const response = await authorizedFetch("/message-read-states");
        if (!response.ok) {
          throw new Error(`Read state sync failed: ${response.status}`);
        }
        const payload = await parseJson<{
          states: Array<{
            channelId: string;
            workspaceId: string;
            workspaceKind: string;
            lastReadAt: string;
          }>;
        }>(response);
        if (!mounted) {
          return;
        }

        const spaceSeen: Record<string, string> = {};
        const dmSeen: Record<string, string> = {};
        const serverSeen: Record<string, string> = {};
        for (const state of payload.states) {
          serverSeen[state.channelId] = state.lastReadAt;
          if (state.workspaceKind === "dm") {
            const existing = dmSeen[state.workspaceId];
            if (!existing || Date.parse(state.lastReadAt) > Date.parse(existing)) {
              dmSeen[state.workspaceId] = state.lastReadAt;
            }
          } else {
            spaceSeen[state.channelId] = state.lastReadAt;
          }
        }
        serverLastSeenByChannelIdRef.current = serverSeen;

        const nextChannelSeen = mergeLatestSeenValues(channelLastSeenByIdRef.current, spaceSeen);
        channelLastSeenByIdRef.current = nextChannelSeen;
        setChannelLastSeenById(nextChannelSeen);
        const nextDmSeen = mergeLatestSeenValues(dmLastSeenByWorkspaceRef.current, dmSeen);
        dmLastSeenByWorkspaceRef.current = nextDmSeen;
        setDmLastSeenByWorkspace(nextDmSeen);
      } catch (syncError) {
        console.error("read state sync failed", syncError);
      } finally {
        if (mounted) {
          setReadStatesReady(true);
        }
      }
    }

    void syncReadStates();
    const intervalId = window.setInterval(() => {
      void syncReadStates();
    }, 4000);
    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, [authorizedFetch, user?.id]);

  useEffect(() => {
    if (activeTab !== "spaces" || !selectedChannelId || messages.length === 0) {
      return;
    }
    const latest = messages[messages.length - 1];
    if (!latest?.createdAt) {
      return;
    }
    const localSeenAt = channelLastSeenByIdRef.current[selectedChannelId];
    if (!localSeenAt || Date.parse(localSeenAt) < Date.parse(latest.createdAt)) {
      const nextSeen = { ...channelLastSeenByIdRef.current, [selectedChannelId]: latest.createdAt };
      channelLastSeenByIdRef.current = nextSeen;
      setChannelLastSeenById(nextSeen);
    }
    const serverSeenAt = serverLastSeenByChannelIdRef.current[selectedChannelId];
    if (serverSeenAt && Date.parse(serverSeenAt) >= Date.parse(latest.createdAt)) {
      return;
    }
    serverLastSeenByChannelIdRef.current[selectedChannelId] = latest.createdAt;
    void authorizedFetch(`/channels/${selectedChannelId}/read-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seenAt: latest.createdAt })
    }).catch((markError) => console.error("channel read state update failed", markError));
  }, [activeTab, authorizedFetch, messages, selectedChannelId]);

  useEffect(() => {
    const knownChannelIds = new Set(channels.map((channel) => channel.id));
    setChannelUnreadById((prev) => {
      const next: Record<string, number> = {};
      let changed = false;
      for (const [channelId, count] of Object.entries(prev)) {
        if (knownChannelIds.has(channelId) || channelWorkspaceByIdRef.current[channelId]) {
          next[channelId] = count;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [channels]);

  useEffect(() => {
    if (isSettingsOpen) {
      setSettingsNoiseMode(noiseMode);
      setSettingsAudioInputDeviceId(audioInputDeviceId);
      setSettingsAudioOutputDeviceId(audioOutputDeviceId);
      void refreshAudioDevices(false);
    }
  }, [isSettingsOpen, noiseMode, audioInputDeviceId, audioOutputDeviceId]);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    const handleDeviceChange = () => void refreshAudioDevices(false);
    void refreshAudioDevices(false);
    navigator.mediaDevices.addEventListener?.("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", handleDeviceChange);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    if (!selectedWorkspaceId) {
      setMobileSpacesPane("workspaces");
    } else if (!selectedChannelId && mobileSpacesPane === "chat") {
      setMobileSpacesPane("channels");
    }
  }, [isMobile, mobileSpacesPane, selectedChannelId, selectedWorkspaceId]);

  useEffect(() => {
    if (isMobile && !dmSelectedWorkspaceId) {
      setMobileDmPane("dialogs");
    }
  }, [dmSelectedWorkspaceId, isMobile]);

  useEffect(() => {
    if (isMobile) setMobileVoicePanelExpanded(false);
  }, [dmSelectedWorkspaceId, isMobile, selectedChannelId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onResize = () => setIsMobile(window.matchMedia(MOBILE_MEDIA_QUERY).matches);
    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onMediaChange = () => setIsMobile(media.matches);
    window.addEventListener("resize", onResize);
    media.addEventListener("change", onMediaChange);
    return () => {
      window.removeEventListener("resize", onResize);
      media.removeEventListener("change", onMediaChange);
    };
  }, []);

  useEffect(() => {
    screenShareVolumeByKeyRef.current = screenShareVolumeByKey;
  }, [screenShareVolumeByKey]);

  useEffect(() => {
    joinedScreenSharesByKeyRef.current = joinedScreenSharesByKey;
  }, [joinedScreenSharesByKey]);

  function getScreenStreamKey(identity: string) {
    return `lk:${identity}`;
  }

  function getUserIdFromLivekitIdentity(identity?: string | null) {
    return String(identity ?? "").split(":")[0] || "";
  }

  function getDisplayNameByScreenKey(streamKey: string) {
    if (!streamKey.startsWith("lk:")) {
      return streamKey;
    }
    const identity = streamKey.slice(3);
    const participant = voiceParticipants.find((item) => item.socketId === identity || item.userId === identity);
    return participant?.username ?? identity;
  }

  function getWorkspaceMemberAvatarByUserId(userId: string): string | null {
    const member = workspaceMembers.find((item) => item.id === userId);
    return member?.avatarUrl ?? null;
  }

  function getUiAudioContext(): AudioContext | null {
    if (typeof window === "undefined") {
      return null;
    }
    const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      return null;
    }
    if (!uiAudioCtxRef.current) {
      uiAudioCtxRef.current = new Ctx();
    }
    if (uiAudioCtxRef.current.state === "suspended") {
      void uiAudioCtxRef.current.resume().catch(() => undefined);
    }
    return uiAudioCtxRef.current;
  }

  function supportsAudioOutputSelection() {
    return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  }

  async function setAudioElementOutputDevice(element: HTMLMediaElement, deviceId = audioOutputDeviceIdRef.current) {
    const mediaElement = element as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
    if (mediaElement.setSinkId) {
      await mediaElement.setSinkId(deviceId);
    }
  }

  async function applyOutputDeviceToAllAudio(deviceId: string) {
    const elements = new Set<HTMLMediaElement>();
    for (const audio of livekitVoiceAudioElsRef.current.values()) elements.add(audio);
    for (const audio of livekitScreenAudioElsRef.current.values()) elements.add(audio);
    for (const peer of voicePeersRef.current.values()) {
      for (const audio of peer.audioByTrackId.values()) elements.add(audio);
    }
    for (const ref of [messageSoundRef, joinSoundRef, leaveSoundRef, screenShareOnSoundRef, screenShareOffSoundRef, micOnSoundRef, micOffSoundRef]) {
      if (ref.current) elements.add(ref.current);
    }
    if (mediaPlayerRef.current) elements.add(mediaPlayerRef.current);
    await Promise.all(Array.from(elements, (element) => setAudioElementOutputDevice(element, deviceId).catch(() => undefined)));
  }

  async function refreshAudioDevices(requestPermission: boolean) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    setAudioDevicesBusy(true);
    try {
      if (requestPermission) {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        permissionStream.getTracks().forEach((track) => track.stop());
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput");
      const outputs = devices.filter((device) => device.kind === "audiooutput");
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);
      if (audioInputDeviceIdRef.current && !inputs.some((device) => device.deviceId === audioInputDeviceIdRef.current)) {
        setAudioInputDeviceId("");
        setSettingsAudioInputDeviceId("");
      }
      if (audioOutputDeviceIdRef.current && !outputs.some((device) => device.deviceId === audioOutputDeviceIdRef.current)) {
        setAudioOutputDeviceId("");
        setSettingsAudioOutputDeviceId("");
        void applyOutputDeviceToAllAudio("");
      }
    } catch (err) {
      if (requestPermission) {
        setError(err instanceof Error ? err.message : "Не удалось получить список аудиоустройств");
      }
    } finally {
      setAudioDevicesBusy(false);
    }
  }

  function playUiCue(type: "join" | "leave" | "message" | "screen-on" | "screen-off" | "mic-on" | "mic-off") {
    if (type === "message") {
      if (!notificationSettingsRef.current.messageSounds) {
        return;
      }
      if (!messageSoundRef.current) {
        messageSoundRef.current = new Audio(MESSAGE_NOTIFICATION_SOUND_URL);
        messageSoundRef.current.preload = "auto";
        void setAudioElementOutputDevice(messageSoundRef.current).catch(() => undefined);
      }
      const sound = messageSoundRef.current;
      sound.volume = normalizeAudioVolume(0.25);
      sound.currentTime = 0;
      void sound.play().catch(() => undefined);
      return;
    }

    const playAudioCue = (
      ref: { current: HTMLAudioElement | null },
      src: string,
      volume: number
    ): boolean => {
      if (!ref.current) {
        ref.current = new Audio(src);
        ref.current.preload = "auto";
        void setAudioElementOutputDevice(ref.current).catch(() => undefined);
      }
      const sound = ref.current;
      sound.volume = normalizeAudioVolume(volume);
      sound.currentTime = 0;
      void sound.play().catch(() => undefined);
      return true;
    };

    if (type === "join") {
      if (!notificationSettingsRef.current.callSounds) return;
      playAudioCue(joinSoundRef, JOIN_NOTIFICATION_SOUND_URL, 0.25);
      return;
    }

    if (type === "leave") {
      if (!notificationSettingsRef.current.callSounds) return;
      playAudioCue(leaveSoundRef, LEAVE_NOTIFICATION_SOUND_URL, 0.25);
      return;
    }

    if (type === "screen-on") {
      playAudioCue(screenShareOnSoundRef, SCREEN_SHARE_ON_SOUND_URL, 0.25);
      return;
    }

    if (type === "screen-off") {
      playAudioCue(screenShareOffSoundRef, SCREEN_SHARE_OFF_SOUND_URL, 0.25);
      return;
    }

    if (type === "mic-on") {
      playAudioCue(micOnSoundRef, MIC_ON_SOUND_URL, 0.25);
      return;
    }

    if (type === "mic-off") {
      playAudioCue(micOffSoundRef, MIC_OFF_SOUND_URL, 0.25);
      return;
    }

    const ctx = getUiAudioContext();
    if (!ctx) {
      return;
    }

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);

    const makeTone = (frequency: number, start: number, duration: number, kind: OscillatorType, volume = 0.05) => {
      const osc = ctx.createOscillator();
      osc.type = kind;
      osc.frequency.setValueAtTime(frequency, start);
      osc.connect(gain);
      gain.gain.linearRampToValueAtTime(volume, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.start(start);
      osc.stop(start + duration + 0.01);
    };

    if (type === "join") {
      makeTone(660, now, 0.09, "triangle", 0.045);
      makeTone(880, now + 0.08, 0.11, "triangle", 0.05);
      return;
    }

    if (type === "leave") {
      makeTone(700, now, 0.08, "sine", 0.04);
      makeTone(420, now + 0.07, 0.12, "sine", 0.045);
      return;
    }

    makeTone(1040, now, 0.05, "square", 0.03);
    makeTone(1280, now + 0.045, 0.05, "square", 0.028);
  }

function renderMessageBody(text: string) {
    const matches = Array.from(text.matchAll(URL_REGEX));
    if (matches.length === 0) {
      return text;
    }

    const nodes: Array<string | JSX.Element> = [];
    let lastIndex = 0;

    matches.forEach((match, idx) => {
      const raw = match[0];
      const start = match.index ?? 0;
      const end = start + raw.length;
      if (start > lastIndex) {
        nodes.push(text.slice(lastIndex, start));
      }

      const href = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
      nodes.push(
        <a key={`${href}-${idx}`} href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>
          {raw}
        </a>
      );
      lastIndex = end;
    });

    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex));
    }

  return nodes;
}

function loadPersistedVoiceKeybinds(): VoiceKeybinds {
  if (typeof window === "undefined") {
    return DEFAULT_VOICE_KEYBINDS;
  }
  try {
    const raw = window.localStorage.getItem(VOICE_KEYBINDS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_VOICE_KEYBINDS;
    }
    const parsed = JSON.parse(raw) as Partial<Record<VoiceKeybindAction, unknown>>;
    const readKeybind = (action: VoiceKeybindAction): string => {
      const value = typeof parsed[action] === "string" ? parsed[action].trim() : DEFAULT_VOICE_KEYBINDS[action];
      return value === LEGACY_DEFAULT_VOICE_KEYBINDS[action] ? "" : value;
    };
    return {
      toggleMic: readKeybind("toggleMic"),
      toggleDeafen: readKeybind("toggleDeafen"),
      toggleScreenShare: readKeybind("toggleScreenShare"),
      pushToTalk: readKeybind("pushToTalk")
    };
  } catch {
    return DEFAULT_VOICE_KEYBINDS;
  }
}

function formatKeyComboFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.repeat) {
    return null;
  }
  const key = event.key;
  if (!key || key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.metaKey) {
    parts.push("Meta");
  }
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key;
  parts.push(normalizedKey);
  return parts.join("+");
}

function parseReplyPayload(
  body: string
): { replyAuthor: string; replySnippet: string; replyMessageId: string | null; messageText: string } | null {
  const replyPattern = /^.*@([^:]+?)(?: \(id:([^)]+)\))?:\s*(.+?)\n([\s\S]*)$/;
  const match = body.match(replyPattern);
  if (!match) {
    return null;
  }
  const [, replyAuthorRaw, replyMessageIdRaw, replySnippetRaw, messageTextRaw] = match;
  const replyAuthor = replyAuthorRaw.trim();
  const replyMessageId = replyMessageIdRaw?.trim() || null;
  const replySnippet = replySnippetRaw.trim();
  const messageText = messageTextRaw.trim();
  if (!replyAuthor || !replySnippet || !messageText) {
    return null;
  }
  return { replyAuthor, replySnippet, replyMessageId, messageText };
}

function getFlatReplyMessageText(body: string): string {
  const parsed = parseReplyPayload(body);
  return parsed ? parsed.messageText : body;
}

function stripReplyIdFromPrefix(prefix: string): string {
  return prefix.replace(/\s*\(id:[^)]+\)/i, "");
}

function normalizeLegacyReplySnippet(snippet: string): string {
  const cleaned = snippet.replace(/\s*\(id:[^)]+\)/gi, "").trim();
  const nested = parseReplyPayload(cleaned);
  if (nested) {
    return nested.messageText.slice(0, 120).replace(/\s+/g, " ").trim();
  }
  return cleaned;
}

  function toAbsoluteAttachmentUrl(url: string) {
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    return new URL(url, API_URL).toString();
  }

  function renderMessageAttachment(message: Message) {
    if (!message.attachmentUrl) {
      return null;
    }
    const attachmentUrl = toAbsoluteAttachmentUrl(message.attachmentUrl);
    return (
      <div style={{ marginTop: 8 }}>
        {isImageAttachment(message.attachmentMime, message.attachmentName, message.attachmentUrl) ? (
          <button
            type="button"
            onClick={() => setImagePreview({ url: attachmentUrl, name: message.attachmentName ?? "Изображение" })}
            title="Открыть изображение"
            style={{ display: "block", padding: 0, border: 0, background: "transparent", cursor: "zoom-in" }}
          >
            <img
              src={attachmentUrl}
              alt={message.attachmentName ?? "image"}
              style={{ display: "block", maxWidth: "100%", maxHeight: 240, borderRadius: 8, border: "1px solid #334155" }}
            />
          </button>
        ) : isVideoAttachment(message.attachmentMime, message.attachmentName, message.attachmentUrl) ? (
          <video
            controls
            preload="metadata"
            src={attachmentUrl}
            style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, border: "1px solid #334155", background: "#000" }}
          />
        ) : isAudioAttachment(message.attachmentMime, message.attachmentName, message.attachmentUrl) ? (
          <audio controls preload="metadata" src={attachmentUrl} style={{ width: "100%", maxWidth: 420 }} />
        ) : (
          <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd" }}>
            📎 {message.attachmentName ?? "Скачать файл"}
            {message.attachmentSize ? ` · ${formatAttachmentSize(message.attachmentSize)}` : ""}
          </a>
        )}
      </div>
    );
  }

  function scrollMessagesToBottom() {
    const node = messagesListRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }

  function isMessagesNearBottom(threshold = 80) {
    const node = messagesListRef.current;
    if (!node) {
      return true;
    }
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    return distance <= threshold;
  }

  function rememberMessagesScrollPosition(channelId = selectedChannelIdRef.current) {
    const node = messagesListRef.current;
    if (!node || !channelId) {
      return;
    }
    messagesScrollTopByChannelRef.current[channelId] = node.scrollTop;
    messagesStickToBottomByChannelRef.current[channelId] = isMessagesNearBottom(96);
  }

  function shouldStickMessagesToBottom(channelId = selectedChannelIdRef.current) {
    if (!channelId) {
      return true;
    }
    return messagesStickToBottomByChannelRef.current[channelId] ?? true;
  }

  function restoreMessagesScrollPosition(channelId = selectedChannelIdRef.current) {
    const node = messagesListRef.current;
    if (!node || !channelId) {
      return;
    }
    if (shouldStickMessagesToBottom(channelId)) {
      scrollMessagesToBottom();
      return;
    }
    node.scrollTop = messagesScrollTopByChannelRef.current[channelId] ?? node.scrollTop;
  }

  function jumpToMessage(messageId: string) {
    const target = document.getElementById(`message-${messageId}`);
    if (!target) {
      setError("Исходное сообщение не найдено в загруженной истории.");
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(messageId);
    if (messageJumpHighlightTimeoutRef.current) {
      window.clearTimeout(messageJumpHighlightTimeoutRef.current);
    }
    messageJumpHighlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedMessageId((prev) => (prev === messageId ? null : prev));
      messageJumpHighlightTimeoutRef.current = null;
    }, 2200);
  }

  function resolveReplyTargetMessageId(
    payload: { replyAuthor: string; replySnippet: string; replyMessageId: string | null },
    currentMessageId: string
  ): string | null {
    if (payload.replyMessageId) {
      return payload.replyMessageId;
    }
    const currentIndex = messages.findIndex((item) => item.id === currentMessageId);
    if (currentIndex <= 0) {
      return null;
    }
    const normalizedSnippet = normalizeLegacyReplySnippet(payload.replySnippet).replace(/\s+/g, " ").trim().toLowerCase();
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.author.username !== payload.replyAuthor) {
        continue;
      }
      const candidateFlat = getFlatReplyMessageText(candidate.body).replace(/\s+/g, " ").trim().toLowerCase();
      if (!candidateFlat) {
        continue;
      }
      if (candidateFlat.startsWith(normalizedSnippet) || normalizedSnippet.startsWith(candidateFlat)) {
        return candidate.id;
      }
    }
    return null;
  }

  async function requestVideoFullscreenById(videoId: string): Promise<boolean> {
    const node = document.getElementById(videoId) as HTMLVideoElement | null;
    if (!node) {
      return false;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
      if (typeof node.requestFullscreen === "function") {
        await node.requestFullscreen();
        return true;
      }
      const legacyNode = node as HTMLVideoElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
        webkitEnterFullscreen?: () => Promise<void> | void;
      };
      if (typeof legacyNode.webkitRequestFullscreen === "function") {
        await legacyNode.webkitRequestFullscreen();
        return true;
      }
      if (typeof legacyNode.webkitEnterFullscreen === "function") {
        await legacyNode.webkitEnterFullscreen();
        return true;
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  async function openScreenShareFullscreen(streamKey: string) {
    if (isDesktopRuntime) {
      setExpandedScreenShareKey(streamKey);
      return;
    }
    const nativeFullscreenOpened = await requestVideoFullscreenById(`screen-share-video-${streamKey}`);
    if (!nativeFullscreenOpened) {
      setExpandedScreenShareKey(streamKey);
    }
  }

  function getLivekitVoiceTargetVolume(audioKey: string) {
    const userId = audioKey.split(":")[0] ?? audioKey;
    return normalizeAudioVolume(voiceVolumeBySocketIdRef.current[userId]);
  }

  function fadeInRemoteVoiceAudio(audio: HTMLAudioElement, targetVolume: number) {
    const normalizedTarget = Math.min(1, Math.max(0, targetVolume));
    const startedAt = performance.now();
    audio.volume = 0;
    audio.muted = selfDeafenedRef.current;
    void audio.play().catch(() => undefined);

    const tick = (now: number) => {
      if (!livekitRemoteAudioReadyRef.current || !livekitVoiceAudioElsRef.current || audio.srcObject === null) {
        return;
      }
      const progress = Math.min(1, Math.max(0, (now - startedAt) / REMOTE_AUDIO_FADE_MS));
      audio.muted = selfDeafenedRef.current;
      audio.volume = normalizeAudioVolume(normalizedTarget * progress, 0);
      if (progress < 1) {
        requestAnimationFrame(tick);
      }
    };

    requestAnimationFrame(tick);
  }

  function releaseLivekitRemoteAudio() {
    livekitRemoteAudioReadyRef.current = true;
    for (const [key, audio] of livekitVoiceAudioElsRef.current.entries()) {
      fadeInRemoteVoiceAudio(audio, getLivekitVoiceTargetVolume(key));
    }
  }

  function resetLivekitRemoteAudioGate() {
    livekitRemoteAudioReadyRef.current = false;
    if (livekitRemoteAudioReadyTimerRef.current) {
      window.clearTimeout(livekitRemoteAudioReadyTimerRef.current);
      livekitRemoteAudioReadyTimerRef.current = null;
    }
  }

  function shouldSubscribeLivekitPublication(publication: { source?: Track.Source }) {
    return (
      publication.source === Track.Source.Microphone ||
      publication.source === Track.Source.ScreenShare ||
      publication.source === Track.Source.ScreenShareAudio
    );
  }

  function attachLivekitRemoteMicrophoneTrack(
    participant: { identity: string },
    publication: {
      source?: Track.Source;
      trackSid?: string;
      track?: { mediaStreamTrack?: MediaStreamTrack; attach?: () => HTMLMediaElement } | null;
    },
    livekitTrack?: { mediaStreamTrack?: MediaStreamTrack; attach?: () => HTMLMediaElement }
  ) {
    if (publication.source !== Track.Source.Microphone) {
      return false;
    }
    const remoteTrack = livekitTrack ?? publication.track;
    const track = remoteTrack?.mediaStreamTrack;
    if (!track || track.readyState !== "live") {
      return false;
    }
    const key = `${participant.identity}:${publication.trackSid || track.id}`;
    const existingAudio = livekitVoiceAudioElsRef.current.get(key);
    if (existingAudio) {
      if (!existingAudio.srcObject) {
        existingAudio.srcObject = new MediaStream([track]);
      }
      existingAudio.muted = selfDeafenedRef.current;
      existingAudio.volume = selfDeafenedRef.current ? 0 : getLivekitVoiceTargetVolume(key);
      void setAudioElementOutputDevice(existingAudio).catch(() => undefined);
      void existingAudio.play().catch(() => undefined);
      return true;
    }

    const attachedElement = remoteTrack?.attach?.();
    const audio = attachedElement instanceof HTMLAudioElement ? attachedElement : new Audio();
    audio.autoplay = false;
    audio.volume = 0;
    audio.muted = true;
    if (!audio.srcObject) {
      audio.srcObject = new MediaStream([track]);
    }
    void setAudioElementOutputDevice(audio).catch(() => undefined);
    void audio.play().catch(() => undefined);
    livekitVoiceAudioElsRef.current.set(key, audio);
    setLivekitRemoteAudioCount(livekitVoiceAudioElsRef.current.size);
    if (livekitRemoteAudioReadyRef.current) {
      fadeInRemoteVoiceAudio(audio, getLivekitVoiceTargetVolume(key));
    }
    return true;
  }

  function syncLivekitRemoteAudio(room: Room) {
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (!shouldSubscribeLivekitPublication(publication)) {
          return;
        }
        publication.setSubscribed(true);
        attachLivekitRemoteMicrophoneTrack(participant, publication);
      });
    });
  }

  async function ensureLivekitAudioPlayback(room: Room) {
    try {
      await room.startAudio();
      if (room.canPlaybackAudio) {
        setLivekitError(null);
      }
    } catch {
      setLivekitError("Браузер заблокировал воспроизведение звука. Нажми кнопку звонка/страницу ещё раз.");
    }
  }

  function bindLivekitRoomHandlers(room: Room) {
    room.on(RoomEvent.TrackPublished, (publication) => {
      if (shouldSubscribeLivekitPublication(publication)) {
        publication.setSubscribed(true);
        window.setTimeout(() => syncLivekitRemoteAudio(room), 100);
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio && publication.source === Track.Source.Microphone) {
        attachLivekitRemoteMicrophoneTrack(participant, publication, track);
        return;
      }

      if (track.kind === Track.Kind.Audio && publication.source === Track.Source.ScreenShareAudio) {
        const key = getScreenStreamKey(participant.identity);
        setRemoteScreenPresenterByKey((prev) => ({ ...prev, [key]: participant.name || participant.identity }));
        const audio = new Audio();
        audio.autoplay = false;
        audio.volume = normalizeAudioVolume(screenShareVolumeByKeyRef.current[key]);
        audio.muted = selfDeafenedRef.current;
        audio.srcObject = new MediaStream([track.mediaStreamTrack]);
        void setAudioElementOutputDevice(audio).catch(() => undefined);
        livekitScreenAudioElsRef.current.set(key, audio);
        if (joinedScreenSharesByKeyRef.current[key]) {
          void audio.play().catch(() => undefined);
        }
        return;
      }

      if (track.kind !== Track.Kind.Video || publication.source !== Track.Source.ScreenShare) {
        return;
      }
      const key = getScreenStreamKey(participant.identity);
      setRemoteScreenPresenterByKey((prev) => ({ ...prev, [key]: participant.name || participant.identity }));
      const stream = new MediaStream([track.mediaStreamTrack]);
      setRemoteScreenStreams((prev) => ({ ...prev, [key]: stream }));
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      const key = getScreenStreamKey(participant.identity);
      if (publication.source === Track.Source.Microphone) {
        const voiceKey = `${participant.identity}:${publication.trackSid}`;
        const audio = livekitVoiceAudioElsRef.current.get(voiceKey);
        if (audio) {
          (track as { detach?: (element: HTMLMediaElement) => HTMLMediaElement }).detach?.(audio);
          audio.pause();
          audio.srcObject = null;
          livekitVoiceAudioElsRef.current.delete(voiceKey);
          setLivekitRemoteAudioCount(livekitVoiceAudioElsRef.current.size);
        }
      }
      if (publication.source === Track.Source.ScreenShareAudio) {
        const audio = livekitScreenAudioElsRef.current.get(key);
        if (audio) {
          audio.pause();
          audio.srcObject = null;
          livekitScreenAudioElsRef.current.delete(key);
        }
      }
    });

    room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
      if (publication.source !== Track.Source.ScreenShare) {
        return;
      }
      const key = getScreenStreamKey(participant.identity);
      removeRemoteScreenStream(key);
      setRemoteScreenPresenterByKey((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    });

    room.on(RoomEvent.Disconnected, () => {
      if (livekitRoomRef.current !== room) return;
      leaveVoice(true);
      setInviteStatus("Соединение с голосовым каналом завершено.");
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const key = getScreenStreamKey(participant.identity);
      for (const [audioKey, audio] of livekitVoiceAudioElsRef.current.entries()) {
        if (audioKey.startsWith(`${participant.identity}:`)) {
          audio.pause();
          audio.srcObject = null;
          livekitVoiceAudioElsRef.current.delete(audioKey);
        }
      }
      setLivekitRemoteAudioCount(livekitVoiceAudioElsRef.current.size);
      removeRemoteScreenStream(key);
      const audio = livekitScreenAudioElsRef.current.get(key);
      if (audio) {
        audio.pause();
        audio.srcObject = null;
        livekitScreenAudioElsRef.current.delete(key);
      }
      setScreenShareVolumeByKey((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setRemoteScreenPresenterByKey((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    });

    room.on(RoomEvent.ParticipantConnected, () => {
      window.setTimeout(() => syncLivekitRemoteAudio(room), 250);
    });

    room.on(RoomEvent.TrackSubscriptionFailed, () => {
      window.setTimeout(() => syncLivekitRemoteAudio(room), 250);
    });

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) {
        setLivekitError("Браузер заблокировал воспроизведение звука. Нажми по странице, чтобы включить звук.");
        return;
      }
      setLivekitError(null);
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      setSpeakingUserIds(
        speakers
          .map((participant) => getUserIdFromLivekitIdentity(participant.identity))
          .filter(Boolean)
      );
    });
  }

  function resolveLivekitTokenPath(channelId: string) {
    const isDmChannel = dmSelectedVoiceChannelId === channelId || dmDialogs.some((dialog) => dialog.voiceChannelId === channelId);
    return isDmChannel ? `/dm/channels/${channelId}/livekit-token` : "/voice/livekit-token";
  }

  async function connectLivekitRoom(channelId: string) {
    const existingRoom = livekitRoomRef.current;
    const existingRoomState = String((existingRoom as { state?: unknown } | null)?.state ?? "");
    const existingRoomUsable = existingRoom && existingRoomState !== "disconnected" && existingRoomState !== "closed";
    if (existingRoomUsable && livekitRoomChannelIdRef.current === channelId) {
      setLivekitStatus("connected");
      if (!livekitRemoteAudioReadyRef.current) {
        releaseLivekitRemoteAudio();
      }
      return existingRoom;
    }
    if (livekitRoomRef.current) {
      await disconnectLivekitRoom();
    }
    if (livekitConnectPromiseRef.current && livekitConnectChannelIdRef.current === channelId) {
      return livekitConnectPromiseRef.current;
    }
    if (livekitConnectPromiseRef.current) {
      await livekitConnectPromiseRef.current.catch(() => undefined);
      if (livekitRoomRef.current) {
        await disconnectLivekitRoom();
      }
    }

    const connectPromise = (async () => {
    resetLivekitRemoteAudioGate();
    setLivekitStatus("connecting");
    setLivekitError(null);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await authorizedFetch(resolveLivekitTokenPath(channelId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId })
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Не удалось получить LiveKit токен");
        }
        const payload = await parseJson<{ url: string; token: string }>(response);
        const room = new Room({
          adaptiveStream: false,
          dynacast: false
        });
        bindLivekitRoomHandlers(room);
        await room.connect(payload.url, payload.token, {
          autoSubscribe: true
        });
        await ensureLivekitAudioPlayback(room);
        syncLivekitRemoteAudio(room);
        livekitRoomRef.current = room;
        livekitRoomChannelIdRef.current = channelId;
        setLivekitStatus("connected");
        setLivekitError(null);
        livekitRemoteAudioReadyTimerRef.current = window.setTimeout(() => {
          livekitRemoteAudioReadyTimerRef.current = null;
          releaseLivekitRemoteAudio();
        }, REMOTE_AUDIO_CONNECT_GRACE_MS);
        return room;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error("LiveKit connection failed");
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        }
      }
    }

    setLivekitStatus("failed");
    resetLivekitRemoteAudioGate();
    setLivekitError(lastError?.message ?? "LiveKit connection failed");
    throw lastError ?? new Error("LiveKit connection failed");
    })();
    livekitConnectPromiseRef.current = connectPromise;
    livekitConnectChannelIdRef.current = channelId;
    try {
      return await connectPromise;
    } finally {
      livekitConnectPromiseRef.current = null;
      livekitConnectChannelIdRef.current = null;
    }
  }

  async function disconnectLivekitRoom() {
    resetLivekitRemoteAudioGate();
    for (const publication of localLivekitScreenPublicationsRef.current) {
      publication.track?.stop();
    }
    localLivekitScreenPublicationsRef.current = [];

    const room = livekitRoomRef.current;
    if (!room) {
      livekitRoomChannelIdRef.current = null;
      return;
    }
    (room as { removeAllListeners?: () => void }).removeAllListeners?.();
    room.disconnect();
    livekitRoomRef.current = null;
    livekitRoomChannelIdRef.current = null;
    livekitConnectPromiseRef.current = null;
    livekitConnectChannelIdRef.current = null;
    setLivekitStatus("idle");
    setLivekitError(null);
    stopLocalSpeechMeter();
    for (const audio of livekitScreenAudioElsRef.current.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    livekitScreenAudioElsRef.current.clear();
    for (const audio of livekitVoiceAudioElsRef.current.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    livekitVoiceAudioElsRef.current.clear();
    setLivekitRemoteAudioCount(0);
    setSpeakingUserIds([]);
    setRemoteScreenStreams({});
    setJoinedScreenSharesByKey({});
    setScreenShareVolumeByKey({});
    setRemoteScreenPresenterByKey({});
  }

  function stopLocalAudioProcessing() {
    if (localProcessedStreamRef.current) {
      for (const track of localProcessedStreamRef.current.getTracks()) {
        track.stop();
      }
      localProcessedStreamRef.current = null;
    }

    if (localAudioNodesRef.current) {
      try {
        localAudioNodesRef.current.source.disconnect();
      } catch {}
      try {
        localAudioNodesRef.current.highPass?.disconnect();
      } catch {}
      try {
        localAudioNodesRef.current.compressor?.disconnect();
      } catch {}
      try {
        localAudioNodesRef.current.output.disconnect();
      } catch {}
      localAudioNodesRef.current = null;
    }

    if (localAudioContextRef.current) {
      void localAudioContextRef.current.close().catch(() => undefined);
      localAudioContextRef.current = null;
    }
  }

  function stopLocalSpeechMeter() {
    if (localSpeechAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(localSpeechAnimationFrameRef.current);
      localSpeechAnimationFrameRef.current = null;
    }
    if (localSpeechSourceRef.current) {
      try {
        localSpeechSourceRef.current.disconnect();
      } catch {}
      localSpeechSourceRef.current = null;
    }
    if (localSpeechAudioContextRef.current) {
      void localSpeechAudioContextRef.current.close().catch(() => undefined);
      localSpeechAudioContextRef.current = null;
    }
    setLocalMicSpeaking(false);
  }

  function startLocalSpeechMeter(track: MediaStreamTrack) {
    stopLocalSpeechMeter();
    if (track.readyState !== "live") {
      return;
    }

    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      let lastSpeakingAt = 0;
      localSpeechAudioContextRef.current = context;
      localSpeechSourceRef.current = source;

      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / samples.length);
        const now = performance.now();
        if (rms > 0.035 && track.enabled && !voiceMuted && !selfDeafenedRef.current) {
          lastSpeakingAt = now;
        }
        setLocalMicSpeaking(now - lastSpeakingAt < 260);
        if (track.readyState === "live") {
          localSpeechAnimationFrameRef.current = window.requestAnimationFrame(tick);
        } else {
          stopLocalSpeechMeter();
        }
      };

      tick();
    } catch {
      stopLocalSpeechMeter();
    }
  }

  function buildStreamForPeers(input: MediaStream): MediaStream {
    if (noiseMode !== "aggressive") {
      return input;
    }

    stopLocalAudioProcessing();
    const context = new AudioContext();
    const source = context.createMediaStreamSource(input);
    const highPass = context.createBiquadFilter();
    highPass.type = "highpass";
    highPass.frequency.value = 140;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -48;
    compressor.knee.value = 24;
    compressor.ratio.value = 10;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    const output = context.createMediaStreamDestination();
    source.connect(highPass);
    highPass.connect(compressor);
    compressor.connect(output);

    localAudioContextRef.current = context;
    localAudioNodesRef.current = { source, highPass, compressor, output };
    localProcessedStreamRef.current = output.stream;
    return output.stream;
  }

  function getStreamForPeers(): MediaStream | null {
    if (!localStreamRef.current) {
      return null;
    }
    return noiseMode === "aggressive" ? localProcessedStreamRef.current ?? localStreamRef.current : localStreamRef.current;
  }

  function removeRemoteScreenStream(socketId: string) {
    setRemoteScreenStreams((prev) => {
      if (!(socketId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[socketId];
      return next;
    });
    setJoinedScreenSharesByKey((prev) => {
      if (!(socketId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[socketId];
      return next;
    });
  }

  function applyVideoSenderTuning(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== "video") {
        continue;
      }
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{}];
      params.encodings[0].maxBitrate = SCREEN_SHARE_MAX_BITRATE;
      params.degradationPreference = "maintain-framerate";
      void sender.setParameters(params).catch(() => undefined);
    }
  }

  function destroyPeer(socketId: string) {
    const peer = voicePeersRef.current.get(socketId);
    if (!peer) {
      removeRemoteScreenStream(socketId);
      return;
    }

    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    for (const audio of peer.audioByTrackId.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    peer.audioByTrackId.clear();
    voicePeersRef.current.delete(socketId);
    delete makingOfferRef.current[socketId];
    delete pendingCandidatesRef.current[socketId];
    removeRemoteScreenStream(socketId);
    setVoiceVolumeBySocketId((prev) => {
      if (!(socketId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[socketId];
      return next;
    });
  }

  function leaveVoice(callServer = true) {
    const channelId = voiceChannelIdRef.current;
    if (callServer && channelId && socketRef.current?.connected) {
      socketRef.current.emit("voice:leave", { channelId });
    }

    for (const socketId of voicePeersRef.current.keys()) {
      destroyPeer(socketId);
    }

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    if (localScreenStreamRef.current) {
      for (const track of localScreenStreamRef.current.getTracks()) {
        track.stop();
      }
      localScreenStreamRef.current = null;
    }
    localScreenTrackRef.current = null;
    void disconnectLivekitRoom();
    stopLocalAudioProcessing();
    stopLocalSpeechMeter();

    voiceChannelIdRef.current = null;
    setVoiceJoinedChannelId(null);
    setVoiceParticipants([]);
    setSpeakingUserIds([]);
    setVoiceBusy(false);
    setVoiceMuted(false);
    pushToTalkHoldingRef.current = false;
    setPushToTalkHolding(false);
    setSelfDeafened(false);
    setAllRemoteAudioMuted(false);
    setIsScreenSharing(false);
    setRemoteScreenStreams({});
    setVoiceVolumeBySocketId({});
    void stopAndroidVoiceCallService();
  }

  async function fetchLivekitCredentials(channelId: string): Promise<{ url: string; token: string }> {
    const response = await authorizedFetch(resolveLivekitTokenPath(channelId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? "Не удалось получить LiveKit токен");
    }
    return parseJson<{ url: string; token: string }>(response);
  }

  function getLocalMicrophoneTrack(room: Room): MediaStreamTrack | null {
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = publication?.track as { mediaStreamTrack?: MediaStreamTrack } | undefined;
    return track?.mediaStreamTrack ?? null;
  }

  async function waitForLocalMicrophoneTrack(room: Room, timeoutMs = 1500): Promise<MediaStreamTrack | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const track = getLocalMicrophoneTrack(room);
      if (track?.readyState === "live") {
        return track;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    return getLocalMicrophoneTrack(room);
  }

  async function setLocalMicrophoneMuted(room: Room, muted: boolean) {
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const publicationWithMute = publication as
      | (LocalTrackPublication & {
          mute?: () => Promise<void> | void;
          unmute?: () => Promise<void> | void;
          track?: {
            mediaStreamTrack?: MediaStreamTrack;
            mute?: () => Promise<void> | void;
            unmute?: () => Promise<void> | void;
          } | null;
        })
      | undefined;
    const mediaTrack = publicationWithMute?.track?.mediaStreamTrack;
    if (mediaTrack) {
      mediaTrack.enabled = !muted;
    }
    if (muted) {
      await publicationWithMute?.track?.mute?.();
      await publicationWithMute?.mute?.();
    } else {
      await publicationWithMute?.track?.unmute?.();
      await publicationWithMute?.unmute?.();
    }
  }

  async function stopPublishedLocalMicrophones(room: Room) {
    const localParticipant = room.localParticipant as typeof room.localParticipant & {
      audioTrackPublications?: Map<string, LocalTrackPublication>;
      unpublishTrack?: (track: MediaStreamTrack, stopOnUnpublish?: boolean) => Promise<unknown> | unknown;
    };
    const publications = [
      room.localParticipant.getTrackPublication(Track.Source.Microphone),
      ...Array.from(localParticipant.audioTrackPublications?.values() ?? [])
    ].filter(Boolean) as LocalTrackPublication[];

    for (const publication of publications) {
      const publicationWithTrack = publication as LocalTrackPublication & {
        track?: {
          mediaStreamTrack?: MediaStreamTrack;
          stop?: () => void;
          mute?: () => Promise<void> | void;
        } | null;
        mute?: () => Promise<void> | void;
      };
      const mediaTrack = publicationWithTrack.track?.mediaStreamTrack;
      if (mediaTrack) {
        mediaTrack.enabled = false;
        try {
          await localParticipant.unpublishTrack?.(mediaTrack, true);
        } catch {
          // LiveKit may already have unpublished it through setMicrophoneEnabled(false).
        }
        try {
          mediaTrack.stop();
        } catch {
          // Ignore tracks already stopped by LiveKit.
        }
      }
      await publicationWithTrack.track?.mute?.();
      await publicationWithTrack.mute?.();
      publicationWithTrack.track?.stop?.();
    }
  }

  async function publishLocalMicrophone(
    room: Room,
    enabled: boolean,
    options: { hardStop?: boolean; deviceId?: string; noiseMode?: NoiseMode } = {}
  ) {
    const constraints = getAudioConstraints(options.noiseMode ?? noiseMode, options.deviceId ?? audioInputDeviceIdRef.current);
    if (!enabled) {
      await setLocalMicrophoneMuted(room, true);
    }
    await room.localParticipant.setMicrophoneEnabled(enabled, enabled ? constraints : undefined);
    if (!enabled) {
      await setLocalMicrophoneMuted(room, true);
      stopLocalSpeechMeter();
      if (options.hardStop) {
        await stopPublishedLocalMicrophones(room);
      }
      return;
    }

    let track = await waitForLocalMicrophoneTrack(room);
    if (!track || track.readyState !== "live") {
      await room.localParticipant.setMicrophoneEnabled(false);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      await room.localParticipant.setMicrophoneEnabled(true, constraints);
      track = await waitForLocalMicrophoneTrack(room);
    }
    if (!track || track.readyState !== "live") {
      throw new Error("Микрофон подключён, но LiveKit не опубликовал аудиотрек.");
    }
    track.enabled = true;
    await setLocalMicrophoneMuted(room, false);
    startLocalSpeechMeter(track);
    await setLocalMicInputVolume(micInputVolumeRef.current);
  }

  async function connectLivekitMicWeb(channelId: string): Promise<void> {
    const audioConstraints = getAudioConstraints(noiseMode, audioInputDeviceIdRef.current);
    const probe = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
    for (const track of probe.getTracks()) {
      track.stop();
    }

    const room = await connectLivekitRoom(channelId);
    await publishLocalMicrophone(room, true);
    setLivekitStatus("connected");
    setLivekitError(null);
  }

  function shouldInitiateVoiceOffer(remoteSocketId: string) {
    const localSocketId = socketRef.current?.id;
    if (!localSocketId) {
      return false;
    }
    return localSocketId.localeCompare(remoteSocketId) > 0;
  }

  function ensureVoicePeer(target: VoiceParticipant) {
    const existing = voicePeersRef.current.get(target.socketId);
    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current
    });

    const streamForPeers = getStreamForPeers();
    if (streamForPeers) {
      for (const track of streamForPeers.getTracks()) {
        pc.addTrack(track, streamForPeers);
      }
    }
    applyVideoSenderTuning(pc);

    pc.onicecandidate = (event) => {
      if (!event.candidate || !socketRef.current?.connected || !voiceChannelIdRef.current) {
        return;
      }
      socketRef.current.emit("voice:signal", {
        channelId: voiceChannelIdRef.current,
        targetSocketId: target.socketId,
        data: { candidate: event.candidate }
      });
    };

    pc.ontrack = (event) => {
      if (event.track.kind === "video") return;
      const currentPeer = voicePeersRef.current.get(target.socketId);
      if (!currentPeer) {
        return;
      }
      const trackId = event.track.id;
      let audio = currentPeer.audioByTrackId.get(trackId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.muted = selfDeafenedRef.current;
        void setAudioElementOutputDevice(audio).catch(() => undefined);
        currentPeer.audioByTrackId.set(trackId, audio);
      }
      const trackStream = new MediaStream([event.track]);
      audio.volume = normalizeAudioVolume(voiceVolumeBySocketIdRef.current[target.socketId]);
      audio.muted = selfDeafenedRef.current;
      audio.srcObject = trackStream;
      void audio.play().catch(() => {
        // Autoplay can be blocked by browser policy; user can interact again to resume.
      });
      event.track.onended = () => {
        const endedAudio = currentPeer.audioByTrackId.get(trackId);
        if (endedAudio) {
          endedAudio.pause();
          endedAudio.srcObject = null;
          currentPeer.audioByTrackId.delete(trackId);
        }
      };
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        destroyPeer(target.socketId);
        setVoiceParticipants((prev) => prev.filter((participant) => participant.socketId !== target.socketId));
      }
    };

    const peer: VoicePeer = { pc, audioByTrackId: new Map<string, HTMLAudioElement>() };
    voicePeersRef.current.set(target.socketId, peer);
    return peer;
  }

  async function syncScreenTrackToPeers(track: MediaStreamTrack | null) {
    void track;
  }

  async function stopScreenShare() {
    if (screenShareBusyRef.current) {
      return;
    }
    screenShareBusyRef.current = true;

    try {
      const hadScreenSharing = isScreenSharing || Boolean(localScreenTrackRef.current) || Boolean(localScreenStreamRef.current);
      const room = livekitRoomRef.current;
      if (room) {
        await room.localParticipant.setScreenShareEnabled(false);
      }
      localLivekitScreenPublicationsRef.current = [];

      if (localScreenStreamRef.current) {
        for (const track of localScreenStreamRef.current.getTracks()) {
          track.stop();
        }
      }
      localScreenStreamRef.current = null;
      localScreenTrackRef.current = null;
      setIsScreenSharing(false);
      if (hadScreenSharing && socketRef.current?.connected && voiceChannelIdRef.current) {
        socketRef.current.emit("voice:screen-share-state", {
          channelId: voiceChannelIdRef.current,
          isSharing: false
        });
      }
    } finally {
      screenShareBusyRef.current = false;
    }
  }

  async function startScreenShare(source: ShareSourceId = pendingScreenShareSource) {
    if (isAndroidNativePlatform()) {
      setError("Демонстрация экрана в Android native-режиме пока отключена.");
      return;
    }
    if (!voiceJoinedChannelId || voiceJoinedChannelId !== selectedChannelId) {
      setError("Сначала войди в голосовой канал");
      return;
    }
    setError(null);
    setPendingScreenShareSource(source);

    try {
      await stopScreenShare();
      if (screenShareBusyRef.current) {
        return;
      }
      screenShareBusyRef.current = true;
      const room = await connectLivekitRoom(voiceJoinedChannelId);
      try {
        await room.localParticipant.setScreenShareEnabled(
          true,
          {
            audio: true,
            resolution: {
              width: SCREEN_SHARE_MAX_WIDTH,
              height: SCREEN_SHARE_MAX_HEIGHT,
              frameRate: SCREEN_SHARE_MAX_FPS
            },
            contentHint: "detail"
          },
          {
            screenShareEncoding: { maxBitrate: SCREEN_SHARE_MAX_BITRATE, maxFramerate: SCREEN_SHARE_MAX_FPS },
            videoEncoding: { maxBitrate: SCREEN_SHARE_MAX_BITRATE, maxFramerate: SCREEN_SHARE_MAX_FPS },
            degradationPreference: "maintain-resolution",
            simulcast: false
          }
        );
      } catch (publishErr) {
        const message = publishErr instanceof Error ? publishErr.message.toLowerCase() : "";
        const isTimeout = message.includes("timed out") || message.includes("no response from server");
        if (!isTimeout) {
          throw publishErr;
        }
        await room.localParticipant.setScreenShareEnabled(
          true,
          {
            audio: true,
            resolution: {
              width: SCREEN_SHARE_MAX_WIDTH,
              height: SCREEN_SHARE_MAX_HEIGHT,
              frameRate: SCREEN_SHARE_FALLBACK_FPS
            },
            contentHint: "motion"
          },
          {
            screenShareEncoding: {
              maxBitrate: SCREEN_SHARE_FALLBACK_BITRATE,
              maxFramerate: SCREEN_SHARE_FALLBACK_FPS
            },
            videoEncoding: {
              maxBitrate: SCREEN_SHARE_FALLBACK_BITRATE,
              maxFramerate: SCREEN_SHARE_FALLBACK_FPS
            },
            degradationPreference: "maintain-framerate",
            simulcast: false
          }
        );
      }

      const publishedScreen = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const publishedScreenAudio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      localLivekitScreenPublicationsRef.current = [publishedScreen, publishedScreenAudio].filter(
        (publication): publication is LocalTrackPublication => Boolean(publication)
      );

      const localTracks = localLivekitScreenPublicationsRef.current
        .map((publication) => publication.track?.mediaStreamTrack)
        .filter((track): track is MediaStreamTrack => Boolean(track));
      localScreenStreamRef.current = new MediaStream(localTracks);
      const localVideoTrack = localLivekitScreenPublicationsRef.current.find(
        (publication) => publication.source === Track.Source.ScreenShare
      )?.track?.mediaStreamTrack ?? null;
      localScreenTrackRef.current = localVideoTrack;
      if (localVideoTrack) {
        localVideoTrack.onended = () => {
          void stopScreenShare();
        };
      }
      setIsScreenSharing(true);
      if (socketRef.current?.connected && voiceChannelIdRef.current) {
        socketRef.current.emit("voice:screen-share-state", {
          channelId: voiceChannelIdRef.current,
          isSharing: true
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось начать демонстрацию экрана";
      if (!message.toLowerCase().includes("cancelled publication by calling unpublish")) {
        setError(message);
      }
    } finally {
      screenShareBusyRef.current = false;
    }
  }

  async function createVoiceOffer(target: VoiceParticipant) {
    const channelId = voiceChannelIdRef.current;
    const socket = socketRef.current;
    if (!channelId || !socket?.connected) {
      return;
    }

    const peer = ensureVoicePeer(target);
    if (makingOfferRef.current[target.socketId] || peer.pc.signalingState !== "stable") {
      return;
    }

    try {
      makingOfferRef.current[target.socketId] = true;
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);

      socket.emit("voice:signal", {
        channelId,
        targetSocketId: target.socketId,
        data: { offer: peer.pc.localDescription }
      });
    } finally {
      makingOfferRef.current[target.socketId] = false;
    }
  }

  async function handleVoiceSignal(payload: {
    channelId: string;
    fromSocketId: string;
    fromUserId: string;
    fromUsername: string;
    data: VoiceSignalPayload;
  }) {
    if (!voiceChannelIdRef.current || payload.channelId !== voiceChannelIdRef.current || !socketRef.current?.connected) {
      return;
    }

    let peer = voicePeersRef.current.get(payload.fromSocketId);
    if (!peer) {
      const participant: VoiceParticipant = {
        socketId: payload.fromSocketId,
        userId: payload.fromUserId,
        username: payload.fromUsername
      };
      setVoiceParticipants((prev) => (prev.some((item) => item.socketId === participant.socketId) ? prev : [...prev, participant]));
      peer = ensureVoicePeer(participant);
    }

    if (!peer) {
      return;
    }

    const pc = peer.pc;
    const { offer, answer, candidate } = payload.data;

    try {
      if (offer) {
        const offerCollision = makingOfferRef.current[payload.fromSocketId] || pc.signalingState !== "stable";
        const ignoreOffer = !shouldInitiateVoiceOffer(payload.fromSocketId) && offerCollision;

        if (ignoreOffer) {
          return;
        }

        if (offerCollision && pc.signalingState === "have-local-offer") {
          await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        const queuedCandidates = pendingCandidatesRef.current[payload.fromSocketId] ?? [];
        for (const queued of queuedCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(queued));
        }
        pendingCandidatesRef.current[payload.fromSocketId] = [];

        const localAnswer = await pc.createAnswer();
        await pc.setLocalDescription(localAnswer);

        socketRef.current.emit("voice:signal", {
          channelId: payload.channelId,
          targetSocketId: payload.fromSocketId,
          data: { answer: pc.localDescription }
        });
        return;
      }

      if (answer) {
        if (pc.signalingState !== "have-local-offer") {
          return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(answer));

        const queuedCandidates = pendingCandidatesRef.current[payload.fromSocketId] ?? [];
        for (const queued of queuedCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(queued));
        }
        pendingCandidatesRef.current[payload.fromSocketId] = [];
        return;
      }

      if (candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          (pendingCandidatesRef.current[payload.fromSocketId] ??= []).push(candidate);
        }
      }
    } catch (err) {
      console.error("voice:signal error", err);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function loadWorkspaces(options?: { silent?: boolean }) {
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoading(true);
      }
      setError(null);

      try {
        const response = await authorizedFetch("/workspaces");
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Не удалось загрузить пространства");
        }

        const data = await parseJson<Workspace[]>(response);
        if (!mounted) {
          return;
        }

        setWorkspaces(data);
        setSelectedWorkspaceId((current) => {
          if (!current) {
            return null;
          }

          const stillExists = data.some((workspace) => workspace.id === current);
          return stillExists ? current : null;
        });

        // Keep search cards in sync after approval/rejection without hard refresh.
        setWorkspaceSearchResults((prev) =>
          prev.map((item) => {
            const membership = data.find((workspace) => workspace.id === item.id);
            if (!membership) {
              return item;
            }

            return {
              ...item,
              isMember: true,
              joinRequestStatus: "approved"
            };
          })
        );
      } catch (err) {
        if (!mounted) {
          return;
        }

        setError(err instanceof Error ? err.message : "Ошибка загрузки пространств");
      } finally {
        if (mounted && !silent) {
          setLoading(false);
        }
      }
    }

    void loadWorkspaces();
    const intervalId = setInterval(() => {
      void loadWorkspaces({ silent: true });
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [authorizedFetch]);

  useEffect(() => {
    if (!readStatesReady) {
      return;
    }
    if (workspaces.length === 0) {
      setChannelUnreadById({});
      setWorkspaceUnreadById({});
      return;
    }

    let mounted = true;
    async function refreshSpaceUnreadIndicators() {
      try {
        const openChannelId = !showEntryWelcome && activeTab === "spaces" ? selectedChannelId : null;
        const response = await authorizedFetch("/spaces/unread-snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seenByChannelId: channelLastSeenByIdRef.current,
            openChannelId
          })
        });
        if (!response.ok) {
          throw new Error(`Unread snapshot failed: ${response.status}`);
        }
        const snapshot = await parseJson<{
          channelUnreadById: Record<string, number>;
          workspaceUnreadById: Record<string, number>;
          latestCreatedAtByChannelId: Record<string, string>;
          channelWorkspaceById: Record<string, string>;
          seenByChannelId: Record<string, string>;
        }>(response);
        if (!mounted) {
          return;
        }
        channelWorkspaceByIdRef.current = {
          ...channelWorkspaceByIdRef.current,
          ...snapshot.channelWorkspaceById
        };
        const syncedSeen = mergeLatestSeenValues(channelLastSeenByIdRef.current, snapshot.seenByChannelId);
        let effectiveSeen = syncedSeen;
        channelLastSeenByIdRef.current = syncedSeen;
        setChannelLastSeenById(syncedSeen);
        setWorkspaceActivityById((prev) => {
          const next = { ...prev };
          for (const [channelId, createdAt] of Object.entries(snapshot.latestCreatedAtByChannelId)) {
            const workspaceId = snapshot.channelWorkspaceById[channelId] ?? channelWorkspaceByIdRef.current[channelId];
            if (!workspaceId) continue;
            if (!next[workspaceId] || Date.parse(createdAt) > Date.parse(next[workspaceId])) {
              next[workspaceId] = createdAt;
            }
          }
          return next;
        });
        if (openChannelId && snapshot.latestCreatedAtByChannelId[openChannelId]) {
          const nextSeen = {
            ...channelLastSeenByIdRef.current,
            [openChannelId]: snapshot.latestCreatedAtByChannelId[openChannelId]
          };
          effectiveSeen = nextSeen;
          channelLastSeenByIdRef.current = nextSeen;
          setChannelLastSeenById(nextSeen);
        }
        const nextChannelUnreadById = Object.fromEntries(
          Object.entries(snapshot.channelUnreadById).filter(([channelId, count]) => {
            if (count <= 0) return false;
            const seenAt = effectiveSeen[channelId];
            const latestAt = snapshot.latestCreatedAtByChannelId[channelId];
            return !seenAt || !latestAt || Date.parse(latestAt) > Date.parse(seenAt);
          })
        );
        const nextWorkspaceUnreadById: Record<string, number> = {};
        for (const [channelId, count] of Object.entries(nextChannelUnreadById)) {
          const workspaceId = snapshot.channelWorkspaceById[channelId] ?? channelWorkspaceByIdRef.current[channelId];
          if (!workspaceId) continue;
          nextWorkspaceUnreadById[workspaceId] = Math.min(1000, (nextWorkspaceUnreadById[workspaceId] ?? 0) + count);
        }
        setChannelUnreadById(nextChannelUnreadById);
        setWorkspaceUnreadById(nextWorkspaceUnreadById);
      } catch (error) {
        console.error("space unread snapshot failed", error);
      }
    }

    void refreshSpaceUnreadIndicators();
    const timer = window.setInterval(() => {
      void refreshSpaceUnreadIndicators();
    }, 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [activeTab, authorizedFetch, readStatesReady, selectedChannelId, showEntryWelcome, user?.id, workspaceIdsKey]);

  useEffect(() => {
    if (!readStatesReady) {
      return;
    }
    let mounted = true;

    async function loadChannels(options?: { silent?: boolean }) {
      const silent = options?.silent ?? false;
      if (!selectedWorkspaceId) {
        setChannels([]);
        setSelectedChannelId(null);
        return;
      }

      if (!silent) {
        setError(null);
      }
      try {
        const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/channels`);
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Не удалось загрузить каналы");
        }

        const data = await parseJson<Channel[]>(response);
        if (!mounted) {
          return;
        }

        setChannels(data);
        if (selectedWorkspaceId) {
          for (const channel of data) {
            channelWorkspaceByIdRef.current[channel.id] = selectedWorkspaceId;
          }
        }
        setSelectedChannelId((current) => {
          if (current && data.some((channel) => channel.id === current)) {
            return current;
          }
          return null;
        });
      } catch (err) {
        if (!mounted || silent) {
          return;
        }

        setError(err instanceof Error ? err.message : "Ошибка загрузки каналов");
      }
    }

    void loadChannels();
    const intervalId = setInterval(() => {
      void loadChannels({ silent: true });
    }, 4000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [authorizedFetch, selectedWorkspaceId]);

  useEffect(() => {
    let mounted = true;
    hasInitialChatScrollRef.current = false;
    const pageSize = 100;

    async function loadMessages(options?: { silent?: boolean }) {
      const silent = options?.silent ?? false;
      if (!selectedChannelId) {
        setMessages([]);
        setMessagesCursor(null);
        setMessagesHasMore(false);
        return;
      }

      if (!silent) {
        setError(null);
      }
      try {
        const response = await authorizedFetch(`/channels/${selectedChannelId}/messages?limit=${pageSize}`);
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Не удалось загрузить сообщения");
        }

        const data = await parseJson<Message[]>(response);
        if (!mounted) {
          return;
        }

        const fetchedAsc = [...data].reverse();
        const shouldStickAfterRender =
          !hasInitialChatScrollRef.current || (silent ? shouldStickMessagesToBottom(selectedChannelId) : true);
        if (silent) {
          rememberMessagesScrollPosition(selectedChannelId);
        } else {
          messagesStickToBottomByChannelRef.current[selectedChannelId] = true;
        }
        if (silent) {
          setMessages((prev) => mergeMessagesByIdAndTime(prev, fetchedAsc));
        } else {
          setMessages(fetchedAsc);
          const oldest = fetchedAsc[0]?.createdAt ?? null;
          setMessagesCursor(oldest);
          setMessagesHasMore(data.length === pageSize);
        }
        requestAnimationFrame(() => {
          if (shouldStickAfterRender) {
            scrollMessagesToBottom();
          } else {
            restoreMessagesScrollPosition(selectedChannelId);
          }
        });
        hasInitialChatScrollRef.current = true;
      } catch (err) {
        if (!mounted || silent) {
          return;
        }

        setError(err instanceof Error ? err.message : "Ошибка загрузки сообщений");
      }
    }

    void loadMessages();
    const intervalId = setInterval(() => {
      void loadMessages({ silent: true });
    }, 4000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [authorizedFetch, selectedChannelId]);

  async function loadOlderMessages() {
    if (!selectedChannelId || !messagesCursor || messagesLoadingOlder || !messagesHasMore) {
      return;
    }
    setMessagesLoadingOlder(true);
    setError(null);
    const pageSize = 100;
    try {
      const prevScrollNode = messagesListRef.current;
      const prevScrollHeight = prevScrollNode?.scrollHeight ?? 0;
      const prevScrollTop = prevScrollNode?.scrollTop ?? 0;

      const response = await authorizedFetch(
        `/channels/${selectedChannelId}/messages?limit=${pageSize}&cursor=${encodeURIComponent(messagesCursor)}`
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось загрузить старые сообщения");
      }
      const data = await parseJson<Message[]>(response);
      const fetchedAsc = [...data].reverse();
      setMessages((prev) => mergeMessagesByIdAndTime(fetchedAsc, prev));
      const oldest = fetchedAsc[0]?.createdAt ?? null;
      if (oldest) {
        setMessagesCursor(oldest);
      } else {
        setMessagesHasMore(false);
      }
      if (data.length < pageSize) {
        setMessagesHasMore(false);
      }

      requestAnimationFrame(() => {
        const node = messagesListRef.current;
        if (!node) {
          return;
        }
        const nextScrollHeight = node.scrollHeight;
        node.scrollTop = prevScrollTop + (nextScrollHeight - prevScrollHeight);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки истории");
    } finally {
      setMessagesLoadingOlder(false);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function connectSocket() {
      const token = await getAccessToken();
      if (!mounted || !token) {
        return;
      }

      if (socketRef.current) {
        socketRef.current.disconnect();
      }

      const socket = io(SOCKET_URL, {
        path: "/socket.io",
        auth: { token: `Bearer ${token}` }
      });

      socket.on("connect", () => {
        socket.emit("presence:get");
        if (selectedWorkspaceIdRef.current) {
          socket.emit("workspace:join", { workspaceId: selectedWorkspaceIdRef.current });
        }
        if (selectedChannelIdRef.current) {
          socket.emit("channel:join", { channelId: selectedChannelIdRef.current });
        }
        if (voiceChannelIdRef.current) {
          socket.emit("voice:join", { channelId: voiceChannelIdRef.current });
          if (!isAndroidNativePlatform()) {
            setTimeout(() => {
              void recoverVoiceAfterForeground();
            }, 120);
          }
        }
      });

      socket.on("disconnect", () => {
        setOnlineUserIds([]);
        if (voiceChannelIdRef.current) {
          setInviteStatus("Связь с сервером прервана. Восстанавливаем голос при возврате...");
        }
      });

      socket.on("presence:snapshot", (payload: PresenceSnapshot) => {
        setOnlineUserIds(Array.isArray(payload.onlineUserIds) ? payload.onlineUserIds : []);
      });

      socket.on("presence:update", (payload: PresenceUpdate) => {
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          if (payload.isOnline) {
            next.add(payload.userId);
          } else {
            next.delete(payload.userId);
          }
          return [...next];
        });
      });

      socket.on("dm:incoming-call", (payload: DmIncomingCall) => {
        if (payload.caller.id === currentUserIdRef.current) {
          return;
        }
        setDmIncomingCallByWorkspaceId((prev) => ({ ...prev, [payload.workspaceId]: payload }));
        setActiveTab("dm");
        setDmSelectedWorkspaceId(payload.workspaceId);
        setInviteStatus(`${payload.caller.username} звонит вам в личных сообщениях.`);
        playUiCue("join");
      });

      socket.on("dm:call-ended", (payload: { workspaceId: string; voiceChannelId: string }) => {
        setDmIncomingCallByWorkspaceId((prev) => {
          if (!prev[payload.workspaceId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[payload.workspaceId];
          return next;
        });
      });

      socket.on("chat:message", (message: Message) => {
        const shouldAutoScroll =
          message.channelId === selectedChannelIdRef.current
            ? shouldStickMessagesToBottom(message.channelId)
            : false;
        const isSpacesTabActive = activeTabRef.current === "spaces";
        const isDmTabActive = activeTabRef.current === "dm";
        const isCallAnnouncement = message.body.trimStart().startsWith("📞");
        const shouldPlaySound =
          message.author.id !== currentUserIdRef.current &&
          !isCallAnnouncement;
        const messageWorkspaceId =
          message.workspaceId ?? channelWorkspaceByIdRef.current[message.channelId] ?? null;
        const matchingDmDialog = dmDialogsRef.current.find((dialog) => dialog.textChannelId === message.channelId) ?? null;
        if (matchingDmDialog) {
          setDmActivityByWorkspaceId((prev) => ({ ...prev, [matchingDmDialog.workspaceId]: message.createdAt }));
        } else if (messageWorkspaceId) {
          setWorkspaceActivityById((prev) => ({ ...prev, [messageWorkspaceId]: message.createdAt }));
        }
        setMessages((prev) => {
          if (message.channelId !== selectedChannelIdRef.current) {
            return prev;
          }
          return appendMessageOnce(prev, message);
        });
        if (matchingDmDialog && message.channelId === dmSelectedTextChannelIdRef.current) {
          setDmMessages((prev) => appendMessageOnce(prev, message));
        }
        if (shouldAutoScroll) {
          requestAnimationFrame(scrollMessagesToBottom);
        }
        if (shouldPlaySound) {
          playUiCue("message");
        }
        const notificationPreferences = notificationSettingsRef.current;
        const notificationCategoryEnabled = matchingDmDialog
          ? notificationPreferences.directMessages
          : notificationPreferences.spaceMessages;
        const appIsFocused = document.visibilityState === "visible" && document.hasFocus();
        if (
          shouldPlaySound &&
          notificationPreferences.desktopNotifications &&
          notificationCategoryEnabled &&
          (!notificationPreferences.onlyWhenUnfocused || !appIsFocused) &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          const title = matchingDmDialog
            ? `Личное сообщение от ${message.author.username}`
            : `Новое сообщение от ${message.author.username}`;
          const notification = new Notification(title, {
            body: notificationPreferences.showMessagePreview
              ? message.body.slice(0, 180)
              : "Откройте GVoice, чтобы прочитать сообщение.",
            icon: GVOICE_LOGO_MAIN_URL,
            tag: `gvoice-message-${message.channelId}`
          });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }
        if (
          !matchingDmDialog &&
          message.author.id !== currentUserIdRef.current &&
          messageWorkspaceId &&
          (!isSpacesTabActive || messageWorkspaceId !== selectedWorkspaceIdRef.current)
        ) {
          setWorkspaceUnreadById((prev) => {
            const current = prev[messageWorkspaceId] ?? 0;
            const nextValue = Math.min(1000, current + 1);
            return { ...prev, [messageWorkspaceId]: nextValue };
          });
        }
        if (
          matchingDmDialog &&
          message.author.id !== currentUserIdRef.current &&
          (!isDmTabActive || matchingDmDialog.workspaceId !== dmSelectedWorkspaceIdRef.current)
        ) {
          setDmUnreadByWorkspaceId((prev) => ({
            ...prev,
            [matchingDmDialog.workspaceId]: Math.min(1000, (prev[matchingDmDialog.workspaceId] ?? 0) + 1)
          }));
        }
        if (
          !matchingDmDialog &&
          message.author.id !== currentUserIdRef.current &&
          (!isSpacesTabActive || message.channelId !== selectedChannelIdRef.current)
        ) {
          setChannelUnreadById((prev) => {
            const current = prev[message.channelId] ?? 0;
            const nextValue = Math.min(1000, current + 1);
            return { ...prev, [message.channelId]: nextValue };
          });
        }
      });

      socket.on("media:state", (payload: MediaSessionState) => {
        setMediaSessionByChannelId((prev) => ({ ...prev, [payload.channelId]: payload }));
      });

      socket.on("user:profile-updated", (payload: { userId: string; username: string; avatarUrl?: string | null }) => {
        setWorkspaceMembers((prev) =>
          prev.map((member) =>
            member.id === payload.userId
              ? { ...member, username: payload.username, avatarUrl: payload.avatarUrl ?? null }
              : member
          )
        );
        setMessages((prev) =>
          prev.map((message) =>
            message.author.id === payload.userId
              ? { ...message, author: { ...message.author, username: payload.username, avatarUrl: payload.avatarUrl ?? null } }
              : message
          )
        );
        setVoiceParticipants((prev) =>
          prev.map((participant) =>
            participant.userId === payload.userId ? { ...participant, username: payload.username } : participant
          )
        );
      });

      socket.on("voice:participants", (payload: { channelId: string; participants: VoiceParticipant[] }) => {
        const dmDialog = dmDialogsRef.current.find((dialog) => dialog.voiceChannelId === payload.channelId) ?? null;
        if (dmDialog) {
          setDmVoiceParticipants(payload.participants);
          const caller = payload.participants.find((participant) => participant.userId !== currentUserIdRef.current) ?? null;
          setDmIncomingCallByWorkspaceId((prev) => {
            if (!caller || voiceChannelIdRef.current === payload.channelId) {
              if (!prev[dmDialog.workspaceId]) {
                return prev;
              }
              const next = { ...prev };
              delete next[dmDialog.workspaceId];
              return next;
            }
            return {
              ...prev,
              [dmDialog.workspaceId]: {
                workspaceId: dmDialog.workspaceId,
                voiceChannelId: payload.channelId,
                caller: {
                  id: caller.userId,
                  username: caller.username
                }
              }
            };
          });
        }
        if (payload.channelId !== selectedChannelIdRef.current) {
          return;
        }
        setVoiceParticipants(payload.participants);
        if (payload.channelId !== voiceChannelIdRef.current) {
          return;
        }
        if (isAndroidNativePlatform() || !USE_LEGACY_WEBRTC_VOICE_MESH) {
          return;
        }
        for (const participant of payload.participants) {
          if (participant.socketId === socket.id) {
            continue;
          }
          if (!voicePeersRef.current.has(participant.socketId) && shouldInitiateVoiceOffer(participant.socketId)) {
            void createVoiceOffer(participant);
          }
        }
      });

      socket.on("voice:user-joined", (payload: { channelId: string; participant: VoiceParticipant }) => {
        const dmDialog = dmDialogsRef.current.find((dialog) => dialog.voiceChannelId === payload.channelId) ?? null;
        if (dmDialog) {
          setDmVoiceParticipants((prev) => {
            if (prev.some((item) => item.socketId === payload.participant.socketId)) {
              return prev;
            }
            return [...prev, payload.participant];
          });
        }
        if (payload.channelId !== selectedChannelIdRef.current) {
          return;
        }
        if (payload.channelId === voiceChannelIdRef.current && payload.participant.socketId !== socket.id) {
          playUiCue("join");
        }
        setVoiceParticipants((prev) => {
          if (prev.some((item) => item.socketId === payload.participant.socketId)) {
            return prev;
          }
          return [...prev, payload.participant];
        });

        if (
          payload.channelId === voiceChannelIdRef.current &&
          payload.participant.socketId !== socket.id &&
          USE_LEGACY_WEBRTC_VOICE_MESH &&
          !isAndroidNativePlatform() &&
          !voicePeersRef.current.has(payload.participant.socketId) &&
          shouldInitiateVoiceOffer(payload.participant.socketId)
        ) {
          void createVoiceOffer(payload.participant);
        }
      });

      socket.on("voice:user-left", (payload: { channelId: string; socketId: string }) => {
        const dmDialog = dmDialogsRef.current.find((dialog) => dialog.voiceChannelId === payload.channelId) ?? null;
        if (dmDialog) {
          setDmVoiceParticipants((prev) => prev.filter((item) => item.socketId !== payload.socketId));
        }
        if (payload.channelId !== selectedChannelIdRef.current) {
          return;
        }
        if (payload.channelId === voiceChannelIdRef.current && payload.socketId !== socket.id) {
          playUiCue("leave");
        }
        if (payload.channelId === voiceChannelIdRef.current && !isAndroidNativePlatform() && USE_LEGACY_WEBRTC_VOICE_MESH) {
          destroyPeer(payload.socketId);
        }
        setVoiceParticipants((prev) => prev.filter((item) => item.socketId !== payload.socketId));
      });

      socket.on("voice:kicked", (payload: { channelId: string; reason: "kick" | "ban" }) => {
        if (payload.channelId === voiceChannelIdRef.current) {
          leaveVoice(false);
          setInviteStatus(payload.reason === "ban" ? "Вы заблокированы в пространстве и отключены от звонка." : "Модератор отключил вас от голосового канала.");
        }
      });

      socket.on("voice:session-replaced", (payload: { channelId: string; replacementChannelId: string }) => {
        if (payload.channelId === voiceChannelIdRef.current) {
          leaveVoice(false);
          setInviteStatus("Голосовой сеанс перенесён в другую вкладку или на другое устройство.");
        }
      });

      socket.on("voice:workspace-occupancy", (payload: {
        workspaceId: string;
        occupancy: Array<{ channelId: string; participants: VoiceParticipant[] }>;
      }) => {
        if (payload.workspaceId !== selectedWorkspaceIdRef.current) {
          return;
        }
        setVoiceOccupancyByChannelId(
          Object.fromEntries(payload.occupancy.map((item) => [item.channelId, item.participants]))
        );
      });

      socket.on("workspace:member-banned", (payload: { workspaceId: string; userId: string }) => {
        if (payload.workspaceId === selectedWorkspaceIdRef.current) {
          setWorkspaceMembers((prev) => prev.filter((member) => member.id !== payload.userId));
        }
      });

      socket.on("workspace:member-role-updated", (payload: { workspaceId: string; member: WorkspaceMember }) => {
        if (payload.workspaceId === selectedWorkspaceIdRef.current) {
          setWorkspaceMembers((prev) =>
            prev.map((member) => (member.id === payload.member.id ? payload.member : member))
          );
        }

        if (payload.member.id === currentUserIdRef.current) {
          setWorkspaces((prev) =>
            prev.map((workspace) =>
              workspace.id === payload.workspaceId ? { ...workspace, role: payload.member.role } : workspace
            )
          );
        }
      });

      socket.on("workspace:banned", (payload: { workspaceId: string }) => {
        setWorkspaces((prev) => prev.filter((workspace) => workspace.id !== payload.workspaceId));
        if (payload.workspaceId === selectedWorkspaceIdRef.current) {
          setSelectedWorkspaceId(null);
          setSelectedChannelId(null);
          setChannels([]);
          setMessages([]);
          setWorkspaceMembers([]);
          setInviteStatus("Вы заблокированы в этом пространстве.");
        }
      });

      socket.on("voice:screen-share-state", (payload: { channelId: string; socketId: string; isSharing: boolean }) => {
        if (payload.channelId !== voiceChannelIdRef.current) {
          return;
        }
        if (payload.socketId === socket.id) {
          return;
        }
        playUiCue(payload.isSharing ? "screen-on" : "screen-off");
      });

      socket.on("voice:mic-state", (payload: { channelId: string; socketId: string; isMuted: boolean }) => {
        if (payload.channelId !== voiceChannelIdRef.current) {
          return;
        }
        if (payload.socketId === socket.id) {
          return;
        }
        playUiCue(payload.isMuted ? "mic-off" : "mic-on");
      });

      socket.on("voice:signal", (payload: {
        channelId: string;
        fromSocketId: string;
        fromUserId: string;
        fromUsername: string;
        data: VoiceSignalPayload;
      }) => {
        if (isAndroidNativePlatform() || !USE_LEGACY_WEBRTC_VOICE_MESH) {
          return;
        }
        void handleVoiceSignal(payload);
      });

      socket.on("error", (payload: { message?: string }) => {
        if (payload?.message) {
          setError(payload.message);
          if (payload.message.toLowerCase().includes("no voice access")) {
            leaveVoice(false);
          }
        }
      });

      if (selectedChannelIdRef.current && selectedChannelTypeRef.current === "voice") {
        socket.emit("voice:get-participants", { channelId: selectedChannelIdRef.current });
      }
      if (selectedChannelIdRef.current) {
        socket.emit("media:get", { channelId: selectedChannelIdRef.current });
      }

      socketRef.current = socket;
    }

    void connectSocket();

    return () => {
      mounted = false;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [getAccessToken, user?.id]);

  useEffect(() => {
    if (selectedWorkspaceId && socketRef.current?.connected) {
      socketRef.current.emit("workspace:join", { workspaceId: selectedWorkspaceId });
    }
  }, [selectedWorkspaceId]);

  useEffect(() => {
    setVoiceOccupancyByChannelId({});
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (dmSelectedWorkspaceId && socketRef.current?.connected) {
      socketRef.current.emit("workspace:join", { workspaceId: dmSelectedWorkspaceId });
      socketRef.current.emit("presence:get");
    }
  }, [dmSelectedWorkspaceId]);

  useEffect(() => {
    if (selectedChannelId && socketRef.current?.connected) {
      socketRef.current.emit("channel:join", { channelId: selectedChannelId });
      socketRef.current.emit("media:get", { channelId: selectedChannelId });
    }
  }, [selectedChannelId]);

  useEffect(() => {
    if (!selectedChannelId || selectedChannel?.type !== "voice") {
      if (!voiceJoinedChannelId) {
        setVoiceParticipants([]);
      }
      return;
    }

    if (socketRef.current?.connected) {
      socketRef.current.emit("voice:get-participants", { channelId: selectedChannelId });
    }
  }, [selectedChannelId, selectedChannel?.type, voiceJoinedChannelId]);

  useEffect(() => {
    let mounted = true;

    async function loadVoiceParticipants() {
      if (!selectedChannelId || selectedChannel?.type !== "voice") {
        if (mounted) {
          setVoiceParticipants([]);
        }
        return;
      }

      try {
        const response = await authorizedFetch(`/channels/${selectedChannelId}/voice-participants`);
        if (!response.ok) {
          return;
        }
        const data = await parseJson<VoiceParticipant[]>(response);
        if (!mounted) {
          return;
        }
        setVoiceParticipants(data);
      } catch {
        // Socket events are primary; polling is a fallback and should stay silent on transient failures.
      }
    }

    void loadVoiceParticipants();
    const intervalId = setInterval(() => {
      void loadVoiceParticipants();
    }, 3000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [authorizedFetch, selectedChannelId, selectedChannel?.type]);

  useEffect(() => {
    let mounted = true;

    async function searchWorkspaces() {
      const query = workspaceSearchQuery.trim();
      if (query.length < 1) {
        setWorkspaceSearchResults([]);
        return;
      }

      try {
        const response = await authorizedFetch(`/workspaces/search?q=${encodeURIComponent(query)}`);
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Не удалось выполнить поиск пространств");
        }

        const data = await parseJson<WorkspaceSearchResult[]>(response);
        if (!mounted) {
          return;
        }
        setWorkspaceSearchResults(data);
      } catch (err) {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : "Ошибка поиска пространств");
      }
    }

    void searchWorkspaces();

    return () => {
      mounted = false;
    };
  }, [authorizedFetch, workspaceSearchQuery]);

  useEffect(() => {
    let mounted = true;

    async function loadJoinRequests(options?: { silent?: boolean }) {
      const silent = options?.silent ?? false;
      if (!selectedWorkspaceId || !canModerateWorkspace || !isSelectedWorkspaceRequest) {
        setJoinRequests([]);
        return;
      }

      try {
        const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/join-requests`);
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Не удалось загрузить заявки");
        }

        const data = await parseJson<WorkspaceJoinRequest[]>(response);
        if (!mounted) {
          return;
        }
        setJoinRequests(data);
      } catch (err) {
        if (!mounted) {
          return;
        }
        if (!silent) {
          setError(err instanceof Error ? err.message : "Ошибка загрузки заявок");
        }
      }
    }

    void loadJoinRequests();
    const intervalId = setInterval(() => {
      void loadJoinRequests({ silent: true });
    }, 4000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [authorizedFetch, selectedWorkspaceId, canModerateWorkspace, isSelectedWorkspaceRequest]);

  useEffect(() => {
    let mounted = true;

    async function loadWorkspaceMembers() {
      if (!selectedWorkspaceId) {
        setWorkspaceMembers([]);
        return;
      }

      try {
        const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/members`);
        if (!response.ok) {
          return;
        }

        const data = await parseJson<WorkspaceMember[]>(response);
        if (!mounted) {
          return;
        }

        setWorkspaceMembers(data);
      } catch {
        if (mounted) {
          setWorkspaceMembers([]);
        }
      }
    }

    void loadWorkspaceMembers();
    return () => {
      mounted = false;
    };
  }, [authorizedFetch, selectedWorkspaceId]);

  useEffect(() => {
    let mounted = true;
    async function refreshDmIndicators() {
      try {
        const [dialogsResponse, requestsResponse, blocksResponse] = await Promise.all([
          authorizedFetch("/dm/dialogs"),
          authorizedFetch("/dm/friend-requests/incoming"),
          authorizedFetch("/dm/blocks")
        ]);
        if (!dialogsResponse.ok || !requestsResponse.ok || !blocksResponse.ok || !mounted) {
          return;
        }

        const dialogs = await parseJson<DirectDialog[]>(dialogsResponse);
        const incomingRequests = await parseJson<DirectIncomingRequest[]>(requestsResponse);
        const blocks = await parseJson<DirectBlock[]>(blocksResponse);
        if (!mounted) {
          return;
        }

        setDmDialogs(dialogs);
        setDmIncomingRequests(incomingRequests);
        setDmBlocks(blocks);
        if (activeTab === "dm") {
          setDmSelectedWorkspaceId((current) => {
            if (current && dialogs.some((item) => item.workspaceId === current)) {
              return current;
            }
            return null;
          });
        }

        const messagesByWorkspace = await Promise.all(
          dialogs
            .filter((dialog) => Boolean(dialog.textChannelId))
            .map(async (dialog) => {
              try {
                const response = await authorizedFetch(`/dm/channels/${dialog.textChannelId}/messages?limit=200`);
                if (!response.ok) {
                  return { workspaceId: dialog.workspaceId, messages: [] as Message[] };
                }
                const messages = await parseJson<Message[]>(response);
                return { workspaceId: dialog.workspaceId, messages };
              } catch {
                return { workspaceId: dialog.workspaceId, messages: [] as Message[] };
              }
            })
        );
        if (!mounted) {
          return;
        }

        setDmActivityByWorkspaceId((prev) => {
          const next = { ...prev };
          for (const item of messagesByWorkspace) {
            const latestCreatedAt = item.messages[0]?.createdAt;
            if (latestCreatedAt) {
              next[item.workspaceId] = latestCreatedAt;
            }
          }
          return next;
        });

        const baseSeen = dmLastSeenByWorkspaceRef.current;
        const validWorkspaceIds = new Set(dialogs.map((dialog) => dialog.workspaceId));
        const nextSeen = Object.fromEntries(
          Object.entries(baseSeen).filter(([workspaceId]) => validWorkspaceIds.has(workspaceId))
        ) as Record<string, string>;
        const nextUnreadByWorkspace: Record<string, number> = {};
        for (const item of messagesByWorkspace) {
          const latestMessage = item.messages[0];
          if (!latestMessage?.createdAt) {
            continue;
          }
          const isCurrentOpenDialog = activeTab === "dm" && dmSelectedWorkspaceId === item.workspaceId;
          if (isCurrentOpenDialog) {
            nextSeen[item.workspaceId] = latestMessage.createdAt;
            continue;
          }
          const seenAt = nextSeen[item.workspaceId];
          if (!seenAt) {
            if (latestMessage.author.id !== user?.id) {
              nextUnreadByWorkspace[item.workspaceId] = 1;
            } else {
              nextSeen[item.workspaceId] = latestMessage.createdAt;
            }
            continue;
          }
          const unreadCount = item.messages.filter(
            (message) => message.author.id !== user?.id && Date.parse(message.createdAt) > Date.parse(seenAt)
          ).length;
          if (unreadCount > 0) {
            nextUnreadByWorkspace[item.workspaceId] = unreadCount;
          }
        }
        setDmUnreadByWorkspaceId(nextUnreadByWorkspace);
        if (JSON.stringify(nextSeen) !== JSON.stringify(baseSeen)) {
          dmLastSeenByWorkspaceRef.current = nextSeen;
          setDmLastSeenByWorkspace(nextSeen);
        }
      } catch {
        // silent
      }
    }

    void refreshDmIndicators();
    const id = setInterval(() => {
      void refreshDmIndicators();
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [activeTab, authorizedFetch, dmSelectedWorkspaceId, readStatesReady, user?.id]);

  useEffect(() => {
    const dialog = dmDialogs.find((item) => item.workspaceId === dmSelectedWorkspaceId) ?? null;
    setDmSelectedTextChannelId(dialog?.textChannelId ?? null);
    setDmSelectedVoiceChannelId(dialog?.voiceChannelId ?? null);
  }, [dmDialogs, dmSelectedWorkspaceId]);

  useEffect(() => {
    let mounted = true;

    async function refreshDmVoiceCalls() {
      const dialogsWithVoice = dmDialogs.filter((dialog) => Boolean(dialog.voiceChannelId));
      if (dialogsWithVoice.length === 0) {
        setDmVoiceParticipants([]);
        setDmIncomingCallByWorkspaceId({});
        return;
      }

      const results = await Promise.all(
        dialogsWithVoice.map(async (dialog) => {
          try {
            const response = await authorizedFetch(`/channels/${dialog.voiceChannelId}/voice-participants`);
            if (!response.ok) {
              return { dialog, participants: [] as VoiceParticipant[] };
            }
            const participants = await parseJson<VoiceParticipant[]>(response);
            return { dialog, participants };
          } catch {
            return { dialog, participants: [] as VoiceParticipant[] };
          }
        })
      );

      if (!mounted) {
        return;
      }

      const selectedVoice = results.find((item) => item.dialog.voiceChannelId === dmSelectedVoiceChannelId);
      setDmVoiceParticipants(selectedVoice?.participants ?? []);

      const nextCalls: Record<string, DmIncomingCall> = {};
      let firstNewCall: DmIncomingCall | null = null;
      for (const { dialog, participants } of results) {
        if (!dialog.voiceChannelId || voiceChannelIdRef.current === dialog.voiceChannelId) {
          continue;
        }
        const caller = participants.find((participant) => participant.userId !== currentUserIdRef.current);
        if (!caller) {
          continue;
        }
        const call: DmIncomingCall = {
          workspaceId: dialog.workspaceId,
          voiceChannelId: dialog.voiceChannelId,
          caller: {
            id: caller.userId,
            username: caller.username
          }
        };
        if (!dmIncomingCallByWorkspaceIdRef.current[dialog.workspaceId]) {
          firstNewCall = firstNewCall ?? call;
        }
        nextCalls[dialog.workspaceId] = call;
      }

      if (JSON.stringify(nextCalls) !== JSON.stringify(dmIncomingCallByWorkspaceIdRef.current)) {
        setDmIncomingCallByWorkspaceId(nextCalls);
      }

      if (firstNewCall) {
        setActiveTab("dm");
        setDmSelectedWorkspaceId(firstNewCall.workspaceId);
        setInviteStatus(`${firstNewCall.caller.username} звонит вам в личных сообщениях.`);
        playUiCue("join");
      }
    }

    void refreshDmVoiceCalls();
    const intervalId = window.setInterval(() => {
      void refreshDmVoiceCalls();
    }, 2000);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, [authorizedFetch, dmDialogs, dmSelectedVoiceChannelId]);

  useEffect(() => {
    let mounted = true;
    async function loadDmMessages() {
      if (!dmSelectedTextChannelId) {
        setDmMessages([]);
        return;
      }
      try {
        const response = await authorizedFetch(`/dm/channels/${dmSelectedTextChannelId}/messages?limit=100`);
        if (!response.ok) {
          return;
        }
        const data = await parseJson<Message[]>(response);
        if (!mounted) {
          return;
        }
        setDmMessages([...data].reverse());
      } catch {
        // silent
      }
    }
    void loadDmMessages();
    const id = setInterval(() => {
      void loadDmMessages();
    }, 4000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [authorizedFetch, dmSelectedTextChannelId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(DM_LAST_SEEN_STORAGE_KEY, JSON.stringify(dmLastSeenByWorkspace));
    } catch {
      // ignore
    }
  }, [dmLastSeenByWorkspace]);

  useEffect(() => {
    if (activeTab !== "dm" || !dmSelectedWorkspaceId || dmMessages.length === 0) {
      return;
    }
    const latest = dmMessages[dmMessages.length - 1];
    if (!latest?.createdAt) {
      return;
    }
    const localSeenAt = dmLastSeenByWorkspaceRef.current[dmSelectedWorkspaceId];
    if (!localSeenAt || Date.parse(localSeenAt) < Date.parse(latest.createdAt)) {
      const next = { ...dmLastSeenByWorkspaceRef.current, [dmSelectedWorkspaceId]: latest.createdAt };
      dmLastSeenByWorkspaceRef.current = next;
      setDmLastSeenByWorkspace(next);
    }
    if (dmSelectedTextChannelId) {
      const serverSeenAt = serverLastSeenByChannelIdRef.current[dmSelectedTextChannelId];
      if (serverSeenAt && Date.parse(serverSeenAt) >= Date.parse(latest.createdAt)) {
        return;
      }
      serverLastSeenByChannelIdRef.current[dmSelectedTextChannelId] = latest.createdAt;
      void authorizedFetch(`/channels/${dmSelectedTextChannelId}/read-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seenAt: latest.createdAt })
      }).catch((markError) => console.error("dm read state update failed", markError));
    }
  }, [activeTab, authorizedFetch, dmMessages, dmSelectedTextChannelId, dmSelectedWorkspaceId]);

  useEffect(() => {
    const query = dmSearchId.trim();
    if (!query) {
      setDmSearchResult(null);
      return;
    }
    const numericId = Number(query);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      setDmSearchResult(null);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const response = await authorizedFetch(`/dm/search?numericId=${numericId}`);
        const payload = (await response.json().catch(() => null)) as DirectUserSearchResult | { error?: string } | null;
        if (!response.ok) {
          setDmSearchResult(null);
          return;
        }
        setDmSearchResult(payload as DirectUserSearchResult);
      } catch {
        setDmSearchResult(null);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [authorizedFetch, dmSearchId]);

  useEffect(() => {
    if (!inviteStatus) {
      return;
    }
    const timer = window.setTimeout(() => setInviteStatus(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [inviteStatus]);

  useEffect(() => {
    if (!error) {
      return;
    }
    const timer = window.setTimeout(() => setError(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  async function sendFriendRequest(targetNumericId?: number | null) {
    const numericId = targetNumericId ?? Number(dmSearchId.trim());
    if (!Number.isFinite(numericId) || numericId <= 0) {
      setError("Введите корректный ID пользователя.");
      return;
    }
    setError(null);
    try {
      const response = await authorizedFetch("/dm/friend-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numericId })
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Не удалось отправить заявку");
      }
      setInviteStatus("Заявка в друзья отправлена.");
      if (dmSearchResult?.numericId === numericId) {
        setDmSearchResult({ ...dmSearchResult, outgoingRequest: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка отправки заявки");
    }
  }

  async function processIncomingDmRequest(requestId: string, action: "approve" | "reject") {
    setError(null);
    try {
      const response = await authorizedFetch(`/dm/friend-requests/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Не удалось обработать заявку");
      }
      setDmIncomingRequests((prev) => prev.filter((item) => item.id !== requestId));
      if (action === "approve") {
        const dialogsResponse = await authorizedFetch("/dm/dialogs");
        if (dialogsResponse.ok) {
          const dialogs = await parseJson<DirectDialog[]>(dialogsResponse);
          setDmDialogs(dialogs);
          setDmSelectedWorkspaceId(null);
        }
        setInviteStatus("Заявка принята. Диалог создан.");
      } else {
        setInviteStatus("Заявка отклонена.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обработки заявки");
    }
  }

  async function reloadDmLists() {
    const [dialogsResponse, blocksResponse] = await Promise.all([
      authorizedFetch("/dm/dialogs"),
      authorizedFetch("/dm/blocks")
    ]);
    if (dialogsResponse.ok) {
      setDmDialogs(await parseJson<DirectDialog[]>(dialogsResponse));
    }
    if (blocksResponse.ok) {
      setDmBlocks(await parseJson<DirectBlock[]>(blocksResponse));
    }
  }

  async function removeDmFriend(targetUserId: string) {
    if (!window.confirm("Удалить пользователя из друзей? История переписки останется.")) {
      return;
    }
    setError(null);
    try {
      const response = await authorizedFetch(`/dm/friends/${targetUserId}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Не удалось удалить пользователя из друзей");
      }
      setDmDialogs((prev) => prev.map((dialog) => dialog.partner?.id === targetUserId ? { ...dialog, isFriend: false } : dialog));
      setDmSearchResult((prev) => prev?.id === targetUserId ? { ...prev, isFriend: false } : prev);
      setInviteStatus("Пользователь удалён из друзей.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка удаления из друзей");
    }
  }

  async function blockDmUser(targetUserId: string) {
    if (!window.confirm("Заблокировать пользователя? Он не сможет писать и звонить вам, дружба будет удалена.")) {
      return;
    }
    setError(null);
    try {
      const response = await authorizedFetch(`/dm/blocks/${targetUserId}`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Не удалось заблокировать пользователя");
      }
      if (selectedDmDialog?.partner?.id === targetUserId) {
        setDmSelectedWorkspaceId(null);
        setDmSelectedTextChannelId(null);
        setDmSelectedVoiceChannelId(null);
        setDmMessages([]);
      }
      setDmSearchResult((prev) => prev?.id === targetUserId ? { ...prev, isBlocked: true, isFriend: false } : prev);
      await reloadDmLists();
      setInviteStatus("Пользователь добавлен в чёрный список.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка блокировки");
    }
  }

  async function unblockDmUser(targetUserId: string) {
    setError(null);
    try {
      const response = await authorizedFetch(`/dm/blocks/${targetUserId}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Не удалось разблокировать пользователя");
      }
      setDmSearchResult((prev) => prev?.id === targetUserId ? { ...prev, isBlocked: false } : prev);
      await reloadDmLists();
      setInviteStatus("Пользователь разблокирован.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка разблокировки");
    }
  }

  async function sendDmMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dmSelectedTextChannelId) {
      return;
    }
    const body = dmMessageText.trim();
    const attachment = dmMessageAttachment;
    if (!body && !attachment) {
      return;
    }
    setError(null);
    try {
      const request = attachment
        ? (() => {
            const form = new FormData();
            form.append("body", body);
            form.append("attachment", attachment);
            return { method: "POST", body: form };
          })()
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body })
          };
      const response = await authorizedFetch(`/dm/channels/${dmSelectedTextChannelId}/messages`, request);
      const payload = (await response.json().catch(() => null)) as Message | { error?: string } | null;
      if (!response.ok) {
        throw new Error((payload as { error?: string } | null)?.error ?? "Не удалось отправить сообщение");
      }
      const sentMessage = payload as Message;
      setDmMessages((prev) => appendMessageOnce(prev, sentMessage));
      if (dmSelectedWorkspaceId) {
        setDmActivityByWorkspaceId((prev) => ({ ...prev, [dmSelectedWorkspaceId]: sentMessage.createdAt }));
      }
      setDmMessageText("");
      setDmMessageAttachment(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка отправки сообщения");
    }
  }

  async function createWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const trimmedName = workspaceName.trim();
    if (
      trimmedName.length < SPACE_CHANNEL_NAME_MIN ||
      trimmedName.length > SPACE_CHANNEL_NAME_MAX ||
      !isValidDisplayName(trimmedName)
    ) {
      setError("Имя пространства: 2-40 символов, только буквы/цифры/пробел/._-");
      return;
    }

    try {
      const response = await authorizedFetch("/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, joinPolicy: workspaceJoinPolicy })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось создать пространство");
      }

      const workspace = await parseJson<Workspace>(response);
      setWorkspaces((prev) => [workspace, ...prev]);
      setWorkspaceName("");
      setWorkspaceJoinPolicy("request");
      setIsCreateWorkspaceOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка создания пространства");
    }
  }

  async function submitProfileUpdate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setInviteStatus(null);
    setProfileBusy(true);
    try {
      if (settingsTab === "audio") {
        const inputChanged = settingsAudioInputDeviceId !== audioInputDeviceId;
        const outputChanged = settingsAudioOutputDeviceId !== audioOutputDeviceId;
        const noiseChanged = settingsNoiseMode !== noiseMode;

        if (outputChanged) {
          if (!supportsAudioOutputSelection() && settingsAudioOutputDeviceId) {
            throw new Error("Выбор устройства воспроизведения не поддерживается этим браузером.");
          }
          const outputProbe = document.createElement("audio");
          await setAudioElementOutputDevice(outputProbe, settingsAudioOutputDeviceId);
          audioOutputDeviceIdRef.current = settingsAudioOutputDeviceId;
          await applyOutputDeviceToAllAudio(settingsAudioOutputDeviceId);
          setAudioOutputDeviceId(settingsAudioOutputDeviceId);
        }

        if (inputChanged) {
          audioInputDeviceIdRef.current = settingsAudioInputDeviceId;
          setAudioInputDeviceId(settingsAudioInputDeviceId);
          const room = livekitRoomRef.current;
          if (room && voiceJoinedChannelId && !isAndroidNativePlatform()) {
            const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
            const localTrack = publication?.track as { restartTrack?: (constraints?: MediaTrackConstraints) => Promise<void> } | undefined;
            const constraints = getAudioConstraints(settingsNoiseMode, settingsAudioInputDeviceId);
            if (localTrack?.restartTrack) {
              await localTrack.restartTrack(constraints);
              const restartedTrack = getLocalMicrophoneTrack(room);
              if (restartedTrack) {
                startLocalSpeechMeter(restartedTrack);
              }
              await setLocalMicrophoneMuted(room, voiceMuted || selfDeafenedRef.current);
            } else if (!voiceMuted && !selfDeafenedRef.current) {
              await publishLocalMicrophone(room, true, { deviceId: settingsAudioInputDeviceId });
            }
          }
        }

        if (noiseChanged) {
          await updateNoiseMode(settingsNoiseMode);
        }
        setInviteStatus(inputChanged || outputChanged || noiseChanged ? "Настройки звука сохранены." : "Настройки звука уже применены.");
        return;
      }
      if (settingsTab === "updates") {
        setInviteStatus("Раздел обновлений: используйте кнопку проверки обновлений.");
        return;
      }
      if (settingsTab === "keybinds") {
        setInviteStatus("Бинды сохранены.");
        return;
      }
      if (settingsTab === "notifications") {
        window.localStorage.setItem(NOTIFICATION_SETTINGS_STORAGE_KEY, JSON.stringify(notificationSettings));
        notificationSettingsRef.current = notificationSettings;
        setInviteStatus("Настройки уведомлений сохранены.");
        return;
      }

      const nextUsername = profileUsername.trim();
      const nextEmail = profileEmail.trim();
      const wantsPasswordChange = Boolean(profileNewPassword.trim() || profileNewPasswordConfirm.trim());
      const wantsEmailChange = Boolean(nextEmail && nextEmail !== (user?.email ?? ""));
      const needsCurrentPassword = wantsPasswordChange || wantsEmailChange;

      const payload: {
        email?: string;
        username?: string;
        currentPassword?: string;
        newPassword?: string;
        newPasswordConfirm?: string;
      } = {};

      if (nextUsername && nextUsername !== (user?.username ?? "")) {
        if (
          nextUsername.length < USERNAME_MIN ||
          nextUsername.length > USERNAME_MAX ||
          !USERNAME_REGEX.test(nextUsername)
        ) {
          setError("Имя пользователя: 3-20 символов, только латиница/цифры/_");
          return;
        }
        payload.username = nextUsername;
      }

      if (wantsEmailChange) {
        payload.email = nextEmail;
      }

      if (needsCurrentPassword) {
        payload.currentPassword = profileCurrentPassword;
      }

      if (wantsPasswordChange) {
        payload.newPassword = profileNewPassword;
        payload.newPasswordConfirm = profileNewPasswordConfirm;
      }

      if (Object.keys(payload).length === 0) {
        setError("Нет изменений для сохранения.");
        return;
      }

      const response = await authorizedFetch("/users/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const apiErr = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(apiErr?.error ?? "Не удалось обновить профиль");
      }
      const updatedUser = await parseJson<{
        id: string;
        email: string;
        username: string;
        avatarUrl?: string | null;
      }>(response);

      setWorkspaceMembers((prev) =>
        prev.map((member) =>
          member.id === updatedUser.id
            ? { ...member, username: updatedUser.username, avatarUrl: updatedUser.avatarUrl ?? null }
            : member
        )
      );
      setMessages((prev) =>
        prev.map((message) =>
          message.author.id === updatedUser.id
            ? { ...message, author: { ...message.author, username: updatedUser.username, avatarUrl: updatedUser.avatarUrl ?? null } }
            : message
        )
      );
      setVoiceParticipants((prev) =>
        prev.map((participant) =>
          participant.userId === updatedUser.id ? { ...participant, username: updatedUser.username } : participant
        )
      );

      await refreshProfile();
      if (socketRef.current?.connected) {
        socketRef.current.emit("profile:refresh");
      }
      setProfileCurrentPassword("");
      setProfileNewPassword("");
      setProfileNewPasswordConfirm("");
      setProfileEmail(updatedUser.email);
      setProfileAvatarFile(null);
      setIsProfileEditorOpen(false);
      setInviteStatus("Профиль успешно обновлён.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обновления профиля");
    } finally {
      setProfileBusy(false);
    }
  }

  async function checkDesktopUpdatesManually() {
    if (!window.gvoiceDesktop?.checkForUpdates) {
      setError("Проверка обновлений доступна только в десктоп-приложении.");
      return;
    }
    setError(null);
    setDesktopUpdateBusy(true);
    setDesktopUpdateStatus({ stage: "checking", message: "Проверяем наличие обновлений..." });
    try {
      const result = await window.gvoiceDesktop.checkForUpdates();
      if (!result?.ok) {
        setDesktopUpdateBusy(false);
        setDesktopUpdateStatus({
          stage: "error",
          message: result?.reason ? `Ошибка проверки: ${result.reason}` : "Не удалось запустить проверку обновлений."
        });
      }
    } catch (err) {
      setDesktopUpdateBusy(false);
      setDesktopUpdateStatus({
        stage: "error",
        message: err instanceof Error ? `Ошибка проверки: ${err.message}` : "Ошибка проверки обновлений."
      });
    }
  }

  async function uploadAvatar() {
    if (!profileAvatarFile) {
      setError("Выбери файл аватарки.");
      return;
    }
    setError(null);
    setProfileBusy(true);
    try {
      const form = new FormData();
      form.append("avatar", profileAvatarFile);
      const response = await authorizedFetch("/users/me/avatar", {
        method: "POST",
        body: form
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось загрузить аватарку");
      }
      const updatedUser = await parseJson<{
        id: string;
        username: string;
        avatarUrl?: string | null;
      }>(response);

      setWorkspaceMembers((prev) =>
        prev.map((member) =>
          member.id === updatedUser.id
            ? { ...member, username: updatedUser.username, avatarUrl: updatedUser.avatarUrl ?? null }
            : member
        )
      );
      setMessages((prev) =>
        prev.map((message) =>
          message.author.id === updatedUser.id
            ? { ...message, author: { ...message.author, username: updatedUser.username, avatarUrl: updatedUser.avatarUrl ?? null } }
            : message
        )
      );

      await refreshProfile();
      if (socketRef.current?.connected) {
        socketRef.current.emit("profile:refresh");
      }
      setProfileAvatarFile(null);
      setInviteStatus("Аватарка обновлена.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки аватарки");
    } finally {
      setProfileBusy(false);
    }
  }

  async function updateWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWorkspaceId || !canManageWorkspace) {
      setError("Редактировать пространство может только владелец или админ.");
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: workspaceEditName.trim() })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось обновить пространство");
      }

      const updated = await parseJson<Workspace>(response);
      setWorkspaces((prev) =>
        prev.map((workspace) =>
          workspace.id === updated.id ? { ...workspace, name: updated.name, slug: updated.slug } : workspace
        )
      );
      setInviteStatus("Пространство обновлено.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обновления пространства");
    }
  }

  async function deleteWorkspace(targetWorkspaceId: string, targetWorkspaceName: string, targetWorkspaceRole: string) {
    if (!targetWorkspaceId || targetWorkspaceRole !== "owner") {
      setError("Удалить пространство может только владелец.");
      return;
    }

    const ok = window.confirm(
      `Удалить пространство "${targetWorkspaceName}"?\n\nВсе его каналы и сообщения будут удалены. Это действие необратимо.`
    );
    if (!ok) {
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/workspaces/${targetWorkspaceId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось удалить пространство");
      }

      setWorkspaces((prev) => prev.filter((workspace) => workspace.id !== targetWorkspaceId));
      if (selectedWorkspaceId === targetWorkspaceId) {
        setSelectedWorkspaceId(null);
        setChannels([]);
        setSelectedChannelId(null);
        setMessages([]);
      }
      setInviteStatus("Пространство удалено.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка удаления пространства");
    }
  }

  async function createChannel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWorkspaceId || !canManageChannels) {
      setError("Создавать каналы может только владелец, админ или модератор пространства.");
      return;
    }

    setError(null);
    const trimmedName = channelName.trim();
    if (
      trimmedName.length < SPACE_CHANNEL_NAME_MIN ||
      trimmedName.length > SPACE_CHANNEL_NAME_MAX ||
      !isValidDisplayName(trimmedName)
    ) {
      setError("Имя канала: 2-40 символов, только буквы/цифры/пробел/._-");
      return;
    }

    try {
      const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, type: channelType, isPrivate: channelIsPrivate })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось создать канал");
      }

      const channel = await parseJson<Channel>(response);
      setChannels((prev) => [...prev, channel]);
      channelWorkspaceByIdRef.current[channel.id] = selectedWorkspaceId;
      setSelectedChannelId(channel.id);
      if (isMobile) setMobileSpacesPane("chat");
      setChannelName("");
      setChannelType("text");
      setChannelIsPrivate(false);
      setIsCreateChannelOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка создания канала");
    }
  }

  async function updateChannelName(targetChannelId?: string, rawName?: string) {
    const channelId = targetChannelId ?? selectedChannelId;
    const sourceName = rawName ?? channelName;
    if (!channelId || !selectedWorkspaceId || !canManageChannels) {
      setError("Недостаточно прав для редактирования канала.");
      return;
    }

    const name = sourceName.trim();
    if (!name) {
      setError("Введите новое имя канала.");
      return;
    }
    if (
      name.length < SPACE_CHANNEL_NAME_MIN ||
      name.length > SPACE_CHANNEL_NAME_MAX ||
      !isValidDisplayName(name)
    ) {
      setError("Имя канала: 2-40 символов, только буквы/цифры/пробел/._-");
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/channels/${channelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось обновить канал");
      }

      const updated = await parseJson<Channel>(response);
      setChannels((prev) => prev.map((channel) => (channel.id === updated.id ? updated : channel)));
      setEditingChannelId(null);
      setEditingChannelName("");
      setInviteStatus("Канал обновлён.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обновления канала");
    }
  }

  async function deleteChannel(targetChannelId: string, targetChannelName: string) {
    if (!targetChannelId || !selectedWorkspaceId || !canManageChannels) {
      setError("Недостаточно прав для удаления канала.");
      return;
    }

    const target = channels.find((channel) => channel.id === targetChannelId);
    if (!target) {
      return;
    }

    const ok = window.confirm(
      `Удалить канал "${targetChannelName || target.name}"?\n\nВсе сообщения этого канала будут удалены. Это действие необратимо.`
    );
    if (!ok) {
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/channels/${targetChannelId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось удалить канал");
      }

      setChannels((prev) => {
        const next = prev.filter((channel) => channel.id !== targetChannelId);
        if (selectedChannelId === targetChannelId) {
          setSelectedChannelId(next[0]?.id ?? null);
        }
        return next;
      });
      if (selectedChannelId === targetChannelId) {
        setMessages([]);
      }
      setInviteStatus("Канал удалён.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка удаления канала");
    }
  }

  async function updateMemberRole(memberUserId: string, role: "admin" | "moderator" | "member") {
    if (!selectedWorkspaceId || !canManageWorkspace) {
      setError("Недостаточно прав для изменения ролей.");
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/members/${memberUserId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось обновить роль");
      }

      const updated = await parseJson<WorkspaceMember>(response);
      setWorkspaceMembers((prev) => prev.map((member) => (member.id === updated.id ? updated : member)));
      setInviteStatus(`Роль пользователя ${updated.username} обновлена.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обновления роли");
    }
  }

  function sendMediaCommand(command: "play" | "pause" | "resume" | "seek" | "stop", url?: string, positionSec?: number) {
    if (!selectedChannelId || !socketRef.current?.connected) {
      setError("Media-бот недоступен: нет подключения к сокету.");
      return;
    }
    socketRef.current.emit("media:command", { channelId: selectedChannelId, command, url, positionSec });
  }

  function getCurrentPlaybackPositionSec(): number {
    if (selectedMediaSession?.mediaKind === "youtube") {
      const yt = youtubePlayerRef.current;
      if (yt) {
        const current = yt.getCurrentTime();
        if (Number.isFinite(current)) {
          return Math.max(0, current);
        }
      }
    }
    if (
      selectedMediaSession?.mediaKind === "rutube" ||
      selectedMediaSession?.mediaKind === "vkvideo" ||
      selectedMediaSession?.mediaKind === "twitch"
    ) {
      return getEffectiveMediaPositionSec(selectedMediaSession);
    }
    const current = mediaPlayerRef.current?.currentTime;
    if (typeof current === "number" && Number.isFinite(current)) {
      return Math.max(0, current);
    }
    return Math.max(0, selectedMediaSession?.positionSec ?? 0);
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedChannelId || (!messageText.trim() && !messageAttachment)) {
      return;
    }

    const cleanBody = messageText.trim();
    const replyPrefix = replyToMessage
      ? `↪ Ответ для @${replyToMessage.author.username}: ${getFlatReplyMessageText(replyToMessage.body)
          .slice(0, 120)
          .replace(/\s+/g, " ")
          .trim()}`
      : "";
    const body = replyPrefix ? `${replyPrefix}\n${cleanBody}` : cleanBody;
    setMessageText("");
    const attachment = messageAttachment;
    setMessageAttachment(null);
    setReplyToMessage(null);

    if (socketRef.current && socketRef.current.connected && !attachment) {
      messagesStickToBottomByChannelRef.current[selectedChannelId] = true;
      socketRef.current.emit("chat:send", {
        channelId: selectedChannelId,
        body,
        clientMsgId: crypto.randomUUID()
      });
      return;
    }

    try {
      let response: Response;
      if (attachment) {
        const form = new FormData();
        form.append("body", body);
        form.append("attachment", attachment);
        response = await authorizedFetch(`/channels/${selectedChannelId}/messages`, {
          method: "POST",
          body: form
        });
      } else {
        response = await authorizedFetch(`/channels/${selectedChannelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body })
        });
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось отправить сообщение");
      }

      const message = await parseJson<Message>(response);
      if (selectedWorkspaceId) {
        setWorkspaceActivityById((prev) => ({ ...prev, [selectedWorkspaceId]: message.createdAt }));
      }
      messagesStickToBottomByChannelRef.current[selectedChannelId] = true;
      setMessages((prev) => [...prev, message]);
      requestAnimationFrame(scrollMessagesToBottom);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка отправки сообщения");
      setMessageText(cleanBody);
      setMessageAttachment(attachment ?? null);
      setReplyToMessage(replyToMessage);
    }
  }

  function handleMessageComposerKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  useEffect(() => {
    const state = selectedMediaSession;
    const htmlPlayer = mediaPlayerRef.current;
    if (!state?.isActive || state.mediaKind !== "video" || !state.mediaUrl || !htmlPlayer) {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      return;
    }
    if (!isHlsUrl(state.mediaUrl)) {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      return;
    }

    hlsRef.current?.destroy();
    hlsRef.current = null;

    if (htmlPlayer.canPlayType("application/vnd.apple.mpegurl")) {
      htmlPlayer.src = state.mediaUrl;
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true
      });
      hls.loadSource(state.mediaUrl);
      hls.attachMedia(htmlPlayer);
      hlsRef.current = hls;
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [selectedMediaSession?.isActive, selectedMediaSession?.mediaKind, selectedMediaSession?.mediaUrl]);

  useEffect(() => {
    let cancelled = false;
    const state = selectedMediaSession;
    if (!state?.isActive || state.mediaKind !== "youtube" || !state.mediaUrl) {
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      youtubePlayerVideoIdRef.current = null;
      return;
    }
    const videoId = toYoutubeVideoId(state.mediaUrl);
    if (!videoId) {
      return;
    }
    void ensureYoutubeIframeApiReady().then(() => {
      if (cancelled || !youtubeHostRef.current || !window.YT?.Player) {
        return;
      }
      if (youtubePlayerRef.current && youtubePlayerVideoIdRef.current === videoId) {
        return;
      }
      youtubePlayerRef.current?.destroy();
      youtubePlayerVideoIdRef.current = videoId;
      youtubePlayerRef.current = new window.YT.Player(youtubeHostRef.current, {
        videoId,
        playerVars: {
          playsinline: 1,
          rel: 0
        },
        events: {
          onStateChange: (event: { data: number }) => {
            if (suppressMediaEventsRef.current || !isCurrentUserMediaMaster) {
              return;
            }
            if (!window.YT?.PlayerState) {
              return;
            }
            if (event.data === window.YT.PlayerState.PLAYING) {
              sendMediaCommand("resume", undefined, getCurrentPlaybackPositionSec());
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              sendMediaCommand("pause", undefined, getCurrentPlaybackPositionSec());
            }
          }
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedMediaSession?.isActive, selectedMediaSession?.mediaKind, selectedMediaSession?.mediaUrl, isCurrentUserMediaMaster]);

  useEffect(() => {
    const state = selectedMediaSession;
    if (!state || !state.isActive || !state.mediaUrl) {
      return;
    }
    const htmlPlayer = mediaPlayerRef.current;
    const ytPlayer = youtubePlayerRef.current;
    if (state.mediaKind !== "video" && state.mediaKind !== "audio" && state.mediaKind !== "youtube") {
      return;
    }
    const syncedAtMs = Date.parse(state.syncedAt);
    const elapsed = state.isPaused || Number.isNaN(syncedAtMs) ? 0 : Math.max(0, (Date.now() - syncedAtMs) / 1000);
    const targetTime = Math.max(0, state.positionSec + elapsed);
    suppressMediaEventsRef.current = true;
    try {
      if ((state.mediaKind === "video" || state.mediaKind === "audio") && htmlPlayer) {
        if (Math.abs((htmlPlayer.currentTime || 0) - targetTime) > 1.25) {
          htmlPlayer.currentTime = targetTime;
        }
        if (state.isPaused) {
          htmlPlayer.pause();
        } else {
          void htmlPlayer.play().catch(() => undefined);
        }
      } else if (state.mediaKind === "youtube" && ytPlayer) {
        if (Math.abs((ytPlayer.getCurrentTime?.() ?? 0) - targetTime) > 1.25) {
          ytPlayer.seekTo(targetTime, true);
        }
        if (state.isPaused) {
          ytPlayer.pauseVideo();
        } else {
          ytPlayer.playVideo();
        }
      }
    } finally {
      setTimeout(() => {
        suppressMediaEventsRef.current = false;
      }, 200);
    }
  }, [selectedMediaSession]);

  useEffect(() => {
    if (!selectedMediaSession?.isActive || selectedMediaSession.isPaused) {
      return;
    }
    if (!isCurrentUserMediaMaster) {
      return;
    }
    if (selectedMediaSession.mediaKind !== "video" && selectedMediaSession.mediaKind !== "audio" && selectedMediaSession.mediaKind !== "youtube") {
      return;
    }
    const intervalId = setInterval(() => {
      const current = getCurrentPlaybackPositionSec();
      if (Number.isFinite(current)) {
        sendMediaCommand("seek", undefined, current);
      }
    }, 1200);
    return () => clearInterval(intervalId);
  }, [selectedMediaSession?.isActive, selectedMediaSession?.isPaused, selectedMediaSession?.mediaKind, isCurrentUserMediaMaster]);

  useEffect(() => {
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      youtubePlayerVideoIdRef.current = null;
    };
  }, []);

  async function saveEditedMessage(messageId: string) {
    if (!selectedChannelId) {
      return;
    }
    const editedText = editingMessageText.trim();
    if (!editedText) {
      setError("Сообщение не может быть пустым.");
      return;
    }
    const normalizedReplyPrefix = editingMessageReplyPrefix ? stripReplyIdFromPrefix(editingMessageReplyPrefix) : null;
    const body = normalizedReplyPrefix ? `${normalizedReplyPrefix}\n${editedText}` : editedText;
    setError(null);
    try {
      const response = await authorizedFetch(`/channels/${selectedChannelId}/messages/${messageId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось отредактировать сообщение");
      }
      const updated = await parseJson<Message>(response);
      setMessages((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditingMessageId(null);
      setEditingMessageText("");
      setEditingMessageReplyPrefix(null);
      setMessageContextMenu(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка редактирования сообщения");
    }
  }

  async function deleteMessage(messageId: string) {
    if (!selectedChannelId) {
      return;
    }
    const ok = window.confirm("Удалить это сообщение?");
    if (!ok) {
      return;
    }
    setError(null);
    try {
      const response = await authorizedFetch(`/channels/${selectedChannelId}/messages/${messageId}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось удалить сообщение");
      }
      setMessages((prev) => prev.filter((item) => item.id !== messageId));
      setMessageContextMenu(null);
      if (editingMessageId === messageId) {
        setEditingMessageId(null);
        setEditingMessageText("");
        setEditingMessageReplyPrefix(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка удаления сообщения");
    }
  }

  async function inviteUserToWorkspace(target: { userId?: string; numericId?: number }) {
    if (!selectedWorkspaceId || workspaceInviteBusy) {
      return;
    }

    setError(null);
    setInviteStatus(null);
    setWorkspaceInviteBusy(true);

    try {
      const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/invite-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target)
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось пригласить пользователя");
      }

      const payload = await parseJson<{ invitedUser: WorkspaceMember }>(response);
      setInviteStatus(`${payload.invitedUser.username} добавлен в пространство.`);
      setWorkspaceInviteNumericId("");
      setWorkspaceMembers((previous) => previous.some((member) => member.id === payload.invitedUser.id)
        ? previous
        : [...previous, payload.invitedUser]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка приглашения");
    } finally {
      setWorkspaceInviteBusy(false);
    }
  }

  async function submitJoinRequest(workspaceId: string) {
    setError(null);
    setInviteStatus(null);

    try {
      const response = await authorizedFetch(`/workspaces/${workspaceId}/join-requests`, {
        method: "POST"
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось отправить заявку");
      }

      const payload = (await response.json().catch(() => null)) as { status?: string; autoJoined?: boolean } | null;
      const autoJoined = payload?.autoJoined === true || payload?.status === "approved";
      setWorkspaceSearchResults((prev) =>
        prev.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                isMember: autoJoined ? true : item.isMember,
                joinRequestStatus: autoJoined ? "approved" : "pending"
              }
            : item
        )
      );
      setInviteStatus(autoJoined ? "Вы сразу вступили в пространство." : "Заявка на вступление отправлена.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка отправки заявки");
    }
  }

  async function updateWorkspaceJoinPolicy(workspaceId: string, joinPolicy: "open" | "request" | "private") {
    setError(null);
    setInviteStatus(null);
    try {
      const response = await authorizedFetch(`/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ joinPolicy })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось обновить режим вступления");
      }

      const updated = await parseJson<Workspace>(response);
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? { ...workspace, joinPolicy: updated.joinPolicy } : workspace)));
      setWorkspaceSearchResults((prev) =>
        prev.map((item) => (item.id === updated.id ? { ...item, joinPolicy: updated.joinPolicy } : item))
      );
      setWorkspaceContextMenu((prev) => (prev ? { ...prev, joinPolicy: updated.joinPolicy } : prev));
      setInviteStatus(
        updated.joinPolicy === "open"
          ? "Пространство открыто: вступление без подтверждения."
          : updated.joinPolicy === "private"
            ? "Пространство закрыто и скрыто из поиска. Вступление доступно только по приглашению."
            : "Пространство переведено в режим заявок."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обновления режима вступления");
    }
  }

  async function createWorkspaceInviteLink(workspaceId: string) {
    setError(null);
    setInviteStatus(null);
    try {
      const response = await authorizedFetch(`/workspaces/${workspaceId}/invite-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays: 7 })
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; inviteUrl?: string } | null;
      if (!response.ok || !payload?.inviteUrl) {
        throw new Error(payload?.error ?? "Не удалось создать ссылку приглашения");
      }
      const copied = await copyTextToClipboard(payload.inviteUrl);
      setInviteStatus(
        copied
          ? "Ссылка приглашения создана и скопирована."
          : `Ссылка приглашения создана. Скопируй её вручную: ${payload.inviteUrl}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка создания ссылки");
    }
  }

  async function processJoinRequest(requestId: string, action: "approve" | "reject") {
    if (!selectedWorkspaceId) {
      return;
    }

    setError(null);
    setInviteStatus(null);

    try {
      const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/join-requests/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось обработать заявку");
      }

      setJoinRequests((prev) => prev.filter((request) => request.id !== requestId));
      setInviteStatus(action === "approve" ? "Заявка принята." : "Заявка отклонена.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обработки заявки");
    }
  }

  async function joinVoice(options?: { channelId?: string; channelName?: string }) {
    const targetChannelId = options?.channelId ?? selectedChannelId;
    const targetChannelName = options?.channelName ?? selectedChannel?.name ?? "Голосовой";
    const isDirectOverride = Boolean(options?.channelId);
    if (!targetChannelId || (!isDirectOverride && selectedChannel?.type !== "voice") || !socketRef.current?.connected || voiceBusy) {
      return;
    }

    if (voiceChannelIdRef.current && voiceChannelIdRef.current !== targetChannelId) {
      // Cleanly switch between calls/channels to avoid stale "joined" state.
      leaveVoice(true);
    }

    setError(null);
    setInviteStatus(null);
    setVoiceBusy(true);

    try {
      const iceResponse = await authorizedFetch("/voice/ice");
      if (iceResponse.ok) {
        const icePayload = (await parseJson<{ iceServers?: RTCIceServer[] }>(iceResponse));
        if (Array.isArray(icePayload.iceServers) && icePayload.iceServers.length > 0) {
          iceServersRef.current = icePayload.iceServers;
        } else {
          iceServersRef.current = DEFAULT_ICE_SERVERS;
        }
      } else {
        iceServersRef.current = DEFAULT_ICE_SERVERS;
      }

      voiceChannelIdRef.current = targetChannelId;
      setVoiceJoinedChannelId(targetChannelId);
      setVoiceParticipants([]);
      setVoiceMuted(false);
      setSelfDeafened(false);
      setAllRemoteAudioMuted(false);
      socketRef.current.emit("voice:join", { channelId: targetChannelId });
      setDmIncomingCallByWorkspaceId((prev) => {
        const matchedDialog = dmDialogs.find((dialog) => dialog.voiceChannelId === targetChannelId);
        if (!matchedDialog || !prev[matchedDialog.workspaceId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[matchedDialog.workspaceId];
        return next;
      });
      if (isAndroidNativePlatform() && isAndroidVoicePluginAvailable()) {
        if (localStreamRef.current) {
          for (const track of localStreamRef.current.getTracks()) {
            track.stop();
          }
          localStreamRef.current = null;
        }
        try {
          const creds = await fetchLivekitCredentials(targetChannelId);
          await startAndroidVoiceCallService({
            channelName: targetChannelName,
            muted: false,
            screenSharing: false,
            livekitUrl: creds.url,
            livekitToken: creds.token
          });
          setLivekitStatus("connected");
          setLivekitError(null);
        } catch {
          await connectLivekitMicWeb(targetChannelId);
          setInviteStatus("Native voice недоступен, включён совместимый режим звонка.");
        }
      } else if (isAndroidNativePlatform() && !isAndroidVoicePluginAvailable()) {
        await connectLivekitMicWeb(targetChannelId);
        setInviteStatus("Установлен APK без native voice plugin, включён совместимый режим звонка.");
      } else {
        try {
          await connectLivekitMicWeb(targetChannelId);
        } catch (voiceErr) {
          if (isAndroidAppRuntime()) {
            await connectLivekitRoom(targetChannelId);
            setVoiceMuted(true);
            setInviteStatus("Вход в звонок выполнен без микрофона. Разреши доступ к микрофону в настройках Android.");
          } else {
            throw voiceErr;
          }
        }
      }
    } catch (err) {
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
        localStreamRef.current = null;
      }
      voiceChannelIdRef.current = null;
      setVoiceJoinedChannelId(null);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Браузер заблокировал микрофон. Разреши доступ к микрофону для gvoice.online.");
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        setError("Микрофон не найден. Проверь, подключен ли он в системе.");
      } else {
        setError(err instanceof Error ? err.message : "Не удалось подключиться к голосу");
      }
    } finally {
      setVoiceBusy(false);
    }
  }

  function leaveVoiceFromUi() {
    if (voiceJoinedChannelId) {
      socketRef.current?.emit("game:leave", { channelId: voiceJoinedChannelId });
    }
    setIsMiniGamesOpen(false);
    leaveVoice(true);
  }

  function kickVoiceParticipant(targetUserId: string, username: string) {
    if (!selectedChannelId || !socketRef.current?.connected) {
      setError("Нет подключения к голосовому каналу.");
      return;
    }
    if (!window.confirm(`Отключить ${username} от голосового канала?`)) {
      return;
    }
    socketRef.current.emit(
      "voice:kick-user",
      { channelId: selectedChannelId, targetUserId },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          setError(result?.error ?? "Не удалось отключить участника");
          return;
        }
        setVoiceParticipants((prev) => prev.filter((participant) => participant.userId !== targetUserId));
        setInviteStatus(`${username} отключён от голосового канала.`);
      }
    );
  }

  function banWorkspaceMember(workspaceId: string, targetUserId: string, username: string) {
    if (!socketRef.current?.connected) {
      setError("Нет подключения к серверу.");
      return;
    }
    if (!window.confirm(`Заблокировать ${username} в пространстве? Пользователь будет удалён и не сможет войти снова.`)) {
      return;
    }
    socketRef.current.emit(
      "workspace:ban-user",
      { workspaceId, targetUserId },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          setError(result?.error ?? "Не удалось заблокировать участника");
          return;
        }
        setWorkspaceMembers((prev) => prev.filter((member) => member.id !== targetUserId));
        setVoiceParticipants((prev) => prev.filter((participant) => participant.userId !== targetUserId));
        setInviteStatus(`${username} заблокирован и удалён из пространства.`);
      }
    );
  }

  async function updateNoiseMode(mode: NoiseMode) {
    setNoiseMode(mode);
    if (isAndroidNativePlatform()) {
      return;
    }
    if (!voiceJoinedChannelId) {
      return;
    }

    const room = livekitRoomRef.current;
    if (room) {
      try {
        const shouldBeEnabled = !voiceMuted;
        const currentPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const currentTrack = currentPublication?.track as
          | { restartTrack?: (constraints?: MediaTrackConstraints) => Promise<void>; mediaStreamTrack?: MediaStreamTrack }
          | undefined;
        const audioConstraints = getAudioConstraints(mode, audioInputDeviceIdRef.current);
        if (currentTrack?.restartTrack) {
          await currentTrack.restartTrack(audioConstraints);
        } else if (currentTrack?.mediaStreamTrack?.applyConstraints) {
          await currentTrack.mediaStreamTrack.applyConstraints(audioConstraints);
        }
        if (shouldBeEnabled) {
          await publishLocalMicrophone(room, true, { noiseMode: mode });
        } else {
          await publishLocalMicrophone(room, false, { noiseMode: mode });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Не удалось применить режим шумоподавления");
      }
      return;
    }

    if (!localStreamRef.current) {
      return;
    }

    const prevMuted = voiceMuted;
    leaveVoice(true);
    setTimeout(() => {
      void joinVoice().then(() => {
        if (prevMuted && localStreamRef.current) {
          for (const track of localStreamRef.current.getAudioTracks()) {
            track.enabled = false;
          }
          setVoiceMuted(true);
        }
      });
    }, 120);
  }

  function setAllRemoteAudioMuted(muted: boolean) {
    for (const [key, audio] of livekitVoiceAudioElsRef.current.entries()) {
      audio.muted = muted;
      if (muted) {
        audio.volume = 0;
      } else {
        audio.volume = getLivekitVoiceTargetVolume(key);
      }
    }
    for (const [key, audio] of livekitScreenAudioElsRef.current.entries()) {
      audio.muted = muted;
      if (muted) {
        audio.volume = 0;
      } else {
        audio.volume = normalizeAudioVolume(screenShareVolumeByKeyRef.current[key]);
      }
    }
    for (const [socketId, peer] of voicePeersRef.current.entries()) {
      for (const audio of peer.audioByTrackId.values()) {
        audio.muted = muted;
        if (muted) {
          audio.volume = 0;
        } else {
          audio.volume = normalizeAudioVolume(voiceVolumeBySocketIdRef.current[socketId]);
        }
      }
    }
    const screenVideos = document.querySelectorAll<HTMLVideoElement>('video[data-screen-share-video="1"]');
    screenVideos.forEach((video) => {
      video.muted = muted;
      if (muted) {
        video.volume = 0;
      } else {
        video.volume = 1;
      }
    });
  }

  function applyVoiceMute(nextMuted: boolean, options: { hardStop?: boolean } = {}) {
    const effectiveMuted = nextMuted || selfDeafenedRef.current;
    if (isAndroidNativePlatform()) {
      setVoiceMuted(effectiveMuted);
      void updateAndroidVoiceCallService({
        channelName: selectedChannel?.name,
        muted: effectiveMuted,
        screenSharing: isScreenSharing
      });
      if (socketRef.current?.connected && voiceChannelIdRef.current) {
        socketRef.current.emit("voice:mic-state", {
          channelId: voiceChannelIdRef.current,
          isMuted: effectiveMuted
        });
      }
      return;
    }

    const stream = localStreamRef.current;
    const room = livekitRoomRef.current;
    if (room) {
      void setLocalMicrophoneMuted(room, effectiveMuted).catch(() => undefined);
      void publishLocalMicrophone(room, !effectiveMuted, { hardStop: options.hardStop || selfDeafenedRef.current }).catch((err) => {
        const message = err instanceof Error ? err.message : "Не удалось переключить микрофон";
        setError(message);
      });
    } else if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !effectiveMuted;
      }
    }
    setVoiceMuted(effectiveMuted);
    void updateAndroidVoiceCallService({
      channelName: selectedChannel?.name,
      muted: effectiveMuted,
      screenSharing: isScreenSharing
    });
    if (socketRef.current?.connected && voiceChannelIdRef.current) {
      socketRef.current.emit("voice:mic-state", {
        channelId: voiceChannelIdRef.current,
        isMuted: effectiveMuted
      });
    }
  }

  function toggleVoiceMute() {
    applyVoiceMute(!voiceMuted);
  }

  function toggleSelfDeafen() {
    const next = !selfDeafenedRef.current;
    selfDeafenedRef.current = next;
    if (next) {
      muteBeforeDeafenRef.current = voiceMuted;
      applyVoiceMute(true, { hardStop: true });
    } else {
      applyVoiceMute(muteBeforeDeafenRef.current);
    }
    setSelfDeafened(next);
    setAllRemoteAudioMuted(next);
  }

  function runVoiceKeybindAction(action: VoiceKeybindAction) {
    if (!voiceJoinedChannelId) {
      return;
    }
    if (!voiceKeybinds[action]?.trim()) {
      return;
    }
    if (action === "toggleMic") {
      toggleVoiceMute();
      return;
    }
    if (action === "toggleDeafen") {
      toggleSelfDeafen();
      return;
    }
    if (action === "toggleScreenShare") {
      if (!isScreenSharing && livekitStatus !== "connected") {
        return;
      }
      void toggleScreenShare();
      return;
    }
    // pushToTalk is handled by keydown/keyup hold logic.
  }

  const isRadioModeEnabled = radioModeEnabled && Boolean(voiceKeybinds.pushToTalk.trim());

  function startPushToTalk() {
    if (!voiceJoinedChannelId || !isRadioModeEnabled || pushToTalkHoldingRef.current || selfDeafenedRef.current) {
      return;
    }
    pushToTalkHoldingRef.current = true;
    setPushToTalkHolding(true);
    applyVoiceMute(false);
  }

  function stopPushToTalk() {
    if (!pushToTalkHoldingRef.current) {
      return;
    }
    pushToTalkHoldingRef.current = false;
    setPushToTalkHolding(false);
    applyVoiceMute(true);
  }

  useEffect(() => {
    if (!voiceJoinedChannelId || !isRadioModeEnabled || pushToTalkHoldingRef.current) {
      return;
    }
    if (!voiceMuted) {
      applyVoiceMute(true);
    }
  }, [voiceJoinedChannelId, isRadioModeEnabled, voiceMuted]);

  useEffect(() => {
    if (!voiceJoinedChannelId) {
      return;
    }
    void updateAndroidVoiceCallService({
      channelName: selectedChannel?.name,
      muted: voiceMuted,
      screenSharing: isScreenSharing
    });
  }, [voiceJoinedChannelId, selectedChannel?.name, voiceMuted, isScreenSharing]);

  useEffect(() => {
    if (!expandedScreenShareKey) {
      return;
    }
    if (!remoteScreenStreams[expandedScreenShareKey]) {
      setExpandedScreenShareKey(null);
    }
  }, [expandedScreenShareKey, remoteScreenStreams]);

  useEffect(() => {
    if (!recordingKeybindAction) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const combo = formatKeyComboFromKeyboardEvent(event);
      if (!combo) {
        return;
      }
      setVoiceKeybinds((prev) => ({ ...prev, [recordingKeybindAction]: combo }));
      setRecordingKeybindAction(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [recordingKeybindAction]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (recordingKeybindAction) {
        return;
      }
      const combo = formatKeyComboFromKeyboardEvent(event);
      if (!combo) {
        return;
      }
      const matched = (Object.entries(voiceKeybinds) as Array<[VoiceKeybindAction, string]>).find(
        ([, value]) => value.trim() && value === combo
      );
      if (!matched) {
        return;
      }
      event.preventDefault();
      if (matched[0] === "pushToTalk") {
        if (!isRadioModeEnabled) {
          return;
        }
        startPushToTalk();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable) {
          return;
        }
      }
      runVoiceKeybindAction(matched[0]);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (recordingKeybindAction) {
        return;
      }
      if (!isRadioModeEnabled || !pushToTalkHoldingRef.current) {
        return;
      }
      const combo = formatKeyComboFromKeyboardEvent(event);
      if (!combo) {
        return;
      }
      if (combo !== voiceKeybinds.pushToTalk) {
        return;
      }
      event.preventDefault();
      stopPushToTalk();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [voiceKeybinds, voiceJoinedChannelId, recordingKeybindAction, selfDeafened, isScreenSharing, livekitStatus, isDesktopRuntime, isRadioModeEnabled]);

  useEffect(() => {
    if (!isDesktopRuntime || !window.gvoiceDesktop?.setGlobalHotkeys) {
      return;
    }
    void window.gvoiceDesktop.setGlobalHotkeys({
      toggleMic: voiceKeybinds.toggleMic,
      toggleDeafen: voiceKeybinds.toggleDeafen,
      toggleScreenShare: voiceKeybinds.toggleScreenShare,
      pushToTalk: radioModeEnabled ? voiceKeybinds.pushToTalk : ""
    });
  }, [isDesktopRuntime, voiceKeybinds, radioModeEnabled]);

  useEffect(() => {
    if (!isDesktopRuntime || !window.gvoiceDesktop?.onGlobalHotkey) {
      return;
    }
    const unsub = window.gvoiceDesktop.onGlobalHotkey((payload) => {
      if (!payload?.action) {
        return;
      }
      runVoiceKeybindAction(payload.action);
    });
    return () => {
      if (typeof unsub === "function") {
        unsub();
      }
    };
  }, [isDesktopRuntime, voiceJoinedChannelId, voiceMuted, selfDeafened, isScreenSharing, livekitStatus]);

  useEffect(() => {
    if (!isDesktopRuntime || !window.gvoiceDesktop?.onPushToTalkHold) {
      return;
    }
    const unsub = window.gvoiceDesktop.onPushToTalkHold((payload) => {
      if (!voiceJoinedChannelId || !isRadioModeEnabled) {
        return;
      }
      if (payload?.down) {
        startPushToTalk();
        return;
      }
      stopPushToTalk();
    });
    return () => {
      if (typeof unsub === "function") {
        unsub();
      }
    };
  }, [isDesktopRuntime, voiceJoinedChannelId, isRadioModeEnabled]);

  useEffect(() => {
    const mode = isAndroidNativePlatform() ? "android-native" : isAndroidAppRuntime() ? "android-web-fallback" : "web";
    setPlatformDebugText(`platform=${mode}`);
  }, []);

  useEffect(() => {
    if (!isAndroidNativePlatform() || !voiceJoinedChannelId) {
      setNativeVoiceDebugText(null);
      return;
    }

    let mounted = true;
    const tick = async () => {
      try {
        const state = await getAndroidVoiceDebugState();
        if (!mounted || !state) {
          return;
        }
        const serviceAlive = String(state.serviceAlive ?? "n/a");
        const roomConnected = String(state.roomConnected ?? "n/a");
        const muted = String(state.muted ?? "n/a");
        const ticks = String(state.keepAliveTicks ?? "0");
        const lastEvent = String(state.lastEvent ?? "-");
        const lastError = state.lastError ? String(state.lastError) : "";
        setNativeVoiceDebugText(
          `Native voice: alive=${serviceAlive}, room=${roomConnected}, muted=${muted}, keepAliveTicks=${ticks}, event=${lastEvent}${lastError ? `, err=${lastError}` : ""}`
        );
      } catch (err) {
        if (!mounted) {
          return;
        }
        setNativeVoiceDebugText(`Native voice debug error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 2000);

    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [voiceJoinedChannelId]);

  useEffect(() => {
    if (USE_LEGACY_WEBRTC_VOICE_MESH || !voiceJoinedChannelId || livekitStatus !== "connected") {
      return;
    }

    const syncTimer = window.setInterval(() => {
      const room = livekitRoomRef.current;
      if (room) {
        syncLivekitRemoteAudio(room);
      }
    }, 1500);

    return () => {
      window.clearInterval(syncTimer);
    };
  }, [voiceJoinedChannelId, livekitStatus]);

  useEffect(() => {
    if (USE_LEGACY_WEBRTC_VOICE_MESH || !voiceJoinedChannelId || livekitStatus !== "connected") {
      return;
    }

    const resumePlayback = () => {
      const room = livekitRoomRef.current;
      if (room) {
        void ensureLivekitAudioPlayback(room);
      }
    };

    window.addEventListener("click", resumePlayback);
    window.addEventListener("keydown", resumePlayback);
    return () => {
      window.removeEventListener("click", resumePlayback);
      window.removeEventListener("keydown", resumePlayback);
    };
  }, [voiceJoinedChannelId, livekitStatus]);

  async function recoverVoiceAfterForeground() {
    if (isAndroidNativePlatform()) {
      return;
    }
    if (!USE_LEGACY_WEBRTC_VOICE_MESH) {
      if (!voiceJoinedChannelId || voiceBusy) {
        return;
      }
      try {
        const room = await connectLivekitRoom(voiceJoinedChannelId);
        await publishLocalMicrophone(room, !(voiceMuted || selfDeafenedRef.current));
      } catch (err) {
        const message = err instanceof Error ? err.message : "LiveKit reconnect failed";
        setLivekitStatus("failed");
        setLivekitError(message);
      }
      return;
    }
    if (!voiceJoinedChannelId || voiceBusy || voiceRecoveringRef.current) {
      return;
    }
    const stream = localStreamRef.current;
    const tracks = stream?.getAudioTracks() ?? [];
    const hasBrokenTrack = tracks.length === 0 || tracks.some((track) => track.readyState !== "live");
    if (!hasBrokenTrack && livekitStatus !== "failed") {
      if (!voiceMuted) {
        for (const track of tracks) {
          track.enabled = true;
        }
      }
      return;
    }

    voiceRecoveringRef.current = true;
    const shouldRestoreMute = voiceMuted;
    try {
      leaveVoice(true);
      await new Promise((resolve) => setTimeout(resolve, 180));
      await joinVoice();
      if (shouldRestoreMute && localStreamRef.current) {
        for (const track of localStreamRef.current.getAudioTracks()) {
          track.enabled = false;
        }
        setVoiceMuted(true);
      }
      setInviteStatus("Микрофон восстановлен после возврата в приложение.");
    } finally {
      voiceRecoveringRef.current = false;
    }
  }

  function setParticipantVolume(socketId: string, volume: number) {
    const normalized = normalizeAudioVolume(volume);
    const participant =
      voiceParticipants.find((item) => item.socketId === socketId) ??
      dmVoiceParticipants.find((item) => item.socketId === socketId);
    setVoiceVolumeBySocketId((prev) => {
      const next = { ...prev, [socketId]: normalized };
      if (participant?.userId) {
        next[participant.userId] = normalized;
      }
      return next;
    });
    const peer = voicePeersRef.current.get(socketId);
    if (peer) {
      for (const audio of peer.audioByTrackId.values()) {
        audio.volume = normalized;
      }
    }
    if (participant?.userId) {
      for (const [key, audio] of livekitVoiceAudioElsRef.current.entries()) {
        if (key.startsWith(`${participant.userId}:`)) {
          audio.volume = normalized;
        }
      }
    }
  }

  async function setLocalMicInputVolume(volume: number) {
    const normalized = normalizeAudioVolume(volume);
    setMicInputVolume(normalized);
    const publication = livekitRoomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const mediaTrack = (publication?.track as { mediaStreamTrack?: MediaStreamTrack } | undefined)?.mediaStreamTrack;
    if (!mediaTrack) {
      return;
    }
    try {
      await mediaTrack.applyConstraints({ volume: normalized } as MediaTrackConstraints);
    } catch {
      // Not every browser/device supports runtime microphone volume constraint updates.
    }
  }

  function setScreenShareVolume(streamKey: string, volume: number) {
    const normalized = normalizeAudioVolume(volume);
    setScreenShareVolumeByKey((prev) => ({ ...prev, [streamKey]: normalized }));
    const audio = livekitScreenAudioElsRef.current.get(streamKey);
    if (audio) {
      audio.volume = normalized;
    }
  }

  function joinScreenShareStream(streamKey: string) {
    setJoinedScreenSharesByKey((prev) => ({ ...prev, [streamKey]: true }));
    const audio = livekitScreenAudioElsRef.current.get(streamKey);
    if (audio) {
      audio.volume = normalizeAudioVolume(screenShareVolumeByKeyRef.current[streamKey]);
      audio.muted = selfDeafenedRef.current;
      void audio.play().catch(() => undefined);
    }
  }

  function leaveScreenShareStream(streamKey: string) {
    setJoinedScreenSharesByKey((prev) => ({ ...prev, [streamKey]: false }));
    const audio = livekitScreenAudioElsRef.current.get(streamKey);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  async function toggleScreenShare() {
    if (isScreenSharing) {
      await stopScreenShare();
      return;
    }
    if (isAndroidNativePlatform()) {
      setError("Демонстрация экрана в Android native-режиме пока отключена.");
      return;
    }
    if (!voiceJoinedChannelId || voiceJoinedChannelId !== selectedChannelId) {
      setError("Сначала войди в голосовой канал");
      return;
    }
    if (isDesktopRuntime) {
      setIsScreenSharePickerOpen(true);
      return;
    }
    await startScreenShare("screen");
  }

  function openMessageContextMenu(event: React.MouseEvent, message: Message) {
    const canEdit = message.author.id === user?.id;
    const canDelete = message.author.id === user?.id || canDeleteForeignMessages;
    const canReply = Boolean(selectedChannelId);
    if (!canEdit && !canDelete && !canReply) {
      return;
    }
    event.preventDefault();
    const menuWidth = 180;
    const actionsCount = Number(canReply) + Number(canEdit) + Number(canDelete);
    const menuHeight = 12 + actionsCount * 34;
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8));
    setMessageContextMenu({
      messageId: message.id,
      x,
      y,
      canEdit,
      canDelete,
      canReply
    });
  }

  function openVoiceVolumeMenu(event: React.MouseEvent, participant: VoiceParticipant) {
    event.preventDefault();
    const menuWidth = 240;
    const menuHeight = 92;
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8));
    const targetRole = workspaceMembers.find((member) => member.id === participant.userId)?.role;
    setVoiceVolumeMenu({
      socketId: participant.socketId,
      userId: participant.userId,
      username: participant.username,
      canKickFromVoice: canModerateWorkspaceMember(selectedWorkspace?.role, targetRole),
      x,
      y
    });
  }

  function openSelfMicVolumeMenu(event: React.MouseEvent) {
    event.preventDefault();
    const menuWidth = 260;
    const menuHeight = 92;
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8));
    setVoiceVolumeMenu({
      socketId: "__self__",
      userId: user?.id ?? "__self__",
      username: user?.username ?? "Вы",
      isSelf: true,
      x,
      y
    });
  }

  function openUserContextMenu(
    event: React.MouseEvent,
    member: { id: string; username: string; numericId?: number | null; role?: string },
    allowRoleEditing = false
  ) {
    const isSelf = member.id === user?.id;
    if (isSelf) {
      return;
    }
    event.preventDefault();
    const canEditRole = allowRoleEditing && canManageWorkspace && member.role !== "owner";
    const canBanFromWorkspace = allowRoleEditing && canModerateWorkspaceMember(selectedWorkspace?.role, member.role);
    const menuWidth = 280;
    const menuHeight = canEditRole ? 380 : 220;
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8));
    setMemberRoleMenu({
      memberUserId: member.id,
      memberUsername: member.username,
      memberNumericId: member.numericId ?? null,
      currentRole: member.role,
      canEditRole,
      workspaceId: allowRoleEditing ? selectedWorkspaceId ?? undefined : undefined,
      canBanFromWorkspace,
      x,
      y
    });
  }

  function toggleWorkspacePin(workspaceId: string) {
    setPinnedWorkspaceIds((prev) => prev.includes(workspaceId) ? prev.filter((id) => id !== workspaceId) : [...prev, workspaceId]);
  }

  function toggleDmPin(workspaceId: string) {
    setPinnedDmWorkspaceIds((prev) => prev.includes(workspaceId) ? prev.filter((id) => id !== workspaceId) : [...prev, workspaceId]);
  }

  function openChannelContextMenu(event: React.MouseEvent, channel: Channel) {
    if (!canManageChannels) {
      return;
    }
    event.preventDefault();
    const menuWidth = 190;
    const menuHeight = 86;
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8));
    setChannelContextMenu({
      channelId: channel.id,
      channelName: channel.name,
      x,
      y
    });
  }

  function beginInlineChannelRename(channelId: string, currentName: string) {
    setEditingChannelId(channelId);
    setEditingChannelName(currentName);
  }

  function canManageWorkspaceItem(role: string) {
    return role === "owner" || role === "admin";
  }

  function beginInlineWorkspaceRename(workspaceId: string, currentName: string) {
    setEditingWorkspaceId(workspaceId);
    setEditingWorkspaceName(currentName);
  }

  function openWorkspaceContextMenu(event: React.MouseEvent, workspace: Workspace) {
    if (!canManageWorkspaceItem(workspace.role) && workspace.role !== "moderator") {
      return;
    }
    event.preventDefault();
    const menuWidth = 210;
    const menuHeight = workspace.role === "owner" ? 310 : workspace.role === "admin" ? 250 : 120;
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8));
    setWorkspaceContextMenu({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRole: workspace.role,
      joinPolicy: workspace.joinPolicy,
      x,
      y
    });
  }

  async function updateWorkspaceNameInline(workspaceId: string, rawName: string) {
    const target = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!target || !canManageWorkspaceItem(target.role)) {
      setError("Недостаточно прав для редактирования пространства.");
      return;
    }
    const name = rawName.trim();
    if (!name) {
      setError("Введите новое имя пространства.");
      return;
    }
    if (
      name.length < SPACE_CHANNEL_NAME_MIN ||
      name.length > SPACE_CHANNEL_NAME_MAX ||
      !isValidDisplayName(name)
    ) {
      setError("Имя пространства: 2-40 символов, только буквы/цифры/пробел/._-");
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось обновить пространство");
      }
      const updated = await parseJson<Workspace>(response);
      setWorkspaces((prev) =>
        prev.map((workspace) =>
          workspace.id === updated.id ? { ...workspace, name: updated.name, slug: updated.slug } : workspace
        )
      );
      setEditingWorkspaceId(null);
      setEditingWorkspaceName("");
      setInviteStatus("Пространство обновлено.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка обновления пространства");
    }
  }

  function openWorkspaceFromSearch(item: WorkspaceSearchResult) {
    setSelectedWorkspaceId(item.id);
    if (isMobile) setMobileSpacesPane("channels");
    setWorkspaceSearchResults([]);
    setWorkspaceSearchQuery("");
  }

  function appendEmojiToMessage(emoji: string) {
    setMessageText((prev) => `${prev}${emoji}`);
    setIsEmojiPickerOpen(false);
    requestAnimationFrame(() => {
      const input = messageInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      const pos = input.value.length;
      input.setSelectionRange(pos, pos);
    });
  }

  useEffect(() => {
    if (!voiceJoinedChannelId || selectedChannel?.type !== "voice") {
      return;
    }
    if (isAndroidNativePlatform()) {
      return;
    }
    void connectLivekitRoom(voiceJoinedChannelId).catch((err) => {
      const message = err instanceof Error ? err.message : "LiveKit connection failed";
      setLivekitStatus("failed");
      setLivekitError(message);
    });
  }, [voiceJoinedChannelId, selectedChannel?.type]);

  useEffect(() => {
    const onReturnToForeground = () => {
      if (document.visibilityState === "visible") {
        void recoverVoiceAfterForeground();
      }
    };
    const onFocus = () => {
      void recoverVoiceAfterForeground();
    };

    document.addEventListener("visibilitychange", onReturnToForeground);
    window.addEventListener("pageshow", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onReturnToForeground);
      window.removeEventListener("pageshow", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [voiceJoinedChannelId, voiceBusy, livekitStatus, voiceMuted]);

  useEffect(() => {
    return () => {
      leaveVoice(false);
    };
  }, []);

  useEffect(() => {
    if (!messageContextMenu) {
      return;
    }
    const closeMenu = () => setMessageContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [messageContextMenu]);

  useEffect(() => {
    if (!voiceVolumeMenu) {
      return;
    }
    const closeMenu = () => setVoiceVolumeMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [voiceVolumeMenu]);

  useEffect(() => {
    if (!memberRoleMenu) {
      return;
    }
    const closeMenu = () => setMemberRoleMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [memberRoleMenu]);

  useEffect(() => {
    if (!channelContextMenu) {
      return;
    }
    const closeMenu = () => setChannelContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [channelContextMenu]);

  function renderUserContextMenu() {
    if (!memberRoleMenu) {
      return null;
    }
    return (
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          top: memberRoleMenu.y,
          left: memberRoleMenu.x,
          width: 280,
          maxWidth: "calc(100vw - 16px)",
          boxSizing: "border-box",
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 8,
          boxShadow: "0 10px 24px rgba(0, 0, 0, 0.45)",
          padding: 6,
          zIndex: 4000
        }}
      >
        <div style={{ marginBottom: 6, fontSize: 13, color: "#cbd5e1" }}>
          <b>{memberRoleMenu.memberUsername}</b>
          <small style={{ display: "block", color: "#64748b", marginTop: 2 }}>
            ID: {memberRoleMenu.memberNumericId ?? "—"}
          </small>
        </div>
        {blockedUserIdSet.has(memberRoleMenu.memberUserId) ? (
          <button
            type="button"
            style={{ width: "100%", textAlign: "left" }}
            onClick={() => {
              void unblockDmUser(memberRoleMenu.memberUserId);
              setMemberRoleMenu(null);
            }}
          >
            Разблокировать
          </button>
        ) : (
          <>
            {friendUserIdSet.has(memberRoleMenu.memberUserId) ? (
              <button
                type="button"
                style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                onClick={() => {
                  void removeDmFriend(memberRoleMenu.memberUserId);
                  setMemberRoleMenu(null);
                }}
              >
                Удалить из друзей
              </button>
            ) : (
              <button
                type="button"
                disabled={!memberRoleMenu.memberNumericId}
                style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                onClick={() => {
                  void sendFriendRequest(memberRoleMenu.memberNumericId);
                  setMemberRoleMenu(null);
                }}
              >
                Добавить в друзья
              </button>
            )}
            {friendUserIdSet.has(memberRoleMenu.memberUserId) ? (
              <button
                type="button"
                style={{ width: "100%", textAlign: "left", color: "#fca5a5" }}
                onClick={() => {
                  void blockDmUser(memberRoleMenu.memberUserId);
                  setMemberRoleMenu(null);
                }}
              >
                Заблокировать
              </button>
            ) : null}
          </>
        )}
        {memberRoleMenu.canEditRole ? (
          <div style={{ borderTop: "1px solid #334155", marginTop: 6, paddingTop: 6 }}>
            <small style={{ display: "block", color: "#94a3b8", marginBottom: 5 }}>Роль в пространстве</small>
            {(["member", "moderator", "admin"] as const).map((role) => (
              <button
                key={role}
                type="button"
                style={{ width: "100%", textAlign: "left", marginBottom: role === "admin" ? 0 : 4 }}
                disabled={memberRoleMenu.currentRole === role}
                onClick={() => {
                  void updateMemberRole(memberRoleMenu.memberUserId, role);
                  setMemberRoleMenu(null);
                }}
              >
                {role === "member" ? "Участник" : role === "moderator" ? "Модератор" : "Админ"}
              </button>
            ))}
          </div>
        ) : null}
        {memberRoleMenu.canBanFromWorkspace && memberRoleMenu.workspaceId ? (
          <div style={{ borderTop: "1px solid #334155", marginTop: 6, paddingTop: 6 }}>
            <button
              type="button"
              style={{
                width: "100%",
                minHeight: 36,
                padding: "7px 10px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                textAlign: "left",
                whiteSpace: "nowrap",
                fontSize: 13,
                lineHeight: 1.2,
                color: "#f87171"
              }}
              onClick={() => {
                banWorkspaceMember(
                  memberRoleMenu.workspaceId as string,
                  memberRoleMenu.memberUserId,
                  memberRoleMenu.memberUsername
                );
                setMemberRoleMenu(null);
              }}
            >
              <span aria-hidden="true">⛔</span>
              <span>Заблокировать в пространстве</span>
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  useEffect(() => {
    if (!workspaceContextMenu) {
      return;
    }
    const closeMenu = () => setWorkspaceContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [workspaceContextMenu]);

  function getDmVoiceStatus() {
    if (!dmSelectedVoiceChannelId) {
      return { text: "Выбери диалог, чтобы начать звонок.", color: "#94a3b8" };
    }
    if (voiceBusy && voiceChannelIdRef.current === dmSelectedVoiceChannelId) {
      return { text: "Подключаемся к звонку…", color: "#fbbf24" };
    }
    if (isJoinedSelectedDmVoice) {
      if (livekitStatus === "connected") {
        return { text: "Вы подключены к звонку.", color: "#22c55e" };
      }
      if (livekitStatus === "failed") {
        return { text: "Звонок открыт, но звук не подключился.", color: "#fca5a5" };
      }
      return { text: "Звонок открыт, настраиваем звук…", color: "#fbbf24" };
    }
    if (dmIncomingCall) {
      return { text: "Вам звонят. Можно присоединиться.", color: "#fbbf24" };
    }
    if (dmVoiceParticipants.length > 0) {
      return { text: "В этом диалоге уже идёт звонок.", color: "#93c5fd" };
    }
    return { text: "Звонок ещё не начат.", color: "#94a3b8" };
  }

  function getDmParticipantAvatar(participant: VoiceParticipant): string | null {
    if (participant.userId === user?.id) {
      return user.avatarUrl ?? null;
    }
    if (participant.userId === selectedDmDialog?.partner?.id) {
      return selectedDmDialog.partner.avatarUrl ?? null;
    }
    return getWorkspaceMemberAvatarByUserId(participant.userId);
  }

  function getParticipantVolume(participant: VoiceParticipant): number {
    return voiceVolumeBySocketId[participant.userId] ?? voiceVolumeBySocketId[participant.socketId] ?? DEFAULT_PARTICIPANT_VOLUME;
  }

  function toggleParticipantMuted(participant: VoiceParticipant) {
    const current = getParticipantVolume(participant);
    setParticipantVolume(participant.socketId, current > 0 ? 0 : DEFAULT_PARTICIPANT_VOLUME);
  }

  function renderDmVoicePanel() {
    const status = getDmVoiceStatus();
    const selfParticipant: VoiceParticipant | null = user
      ? dmVoiceParticipants.find((participant) => participant.userId === user.id) ?? {
          socketId: "__self__",
          userId: user.id,
          username: user.username
        }
      : null;
    const hasParticipants = dmVoiceParticipants.length > 0 || isJoinedSelectedDmVoice;

    if (isMobile && !mobileVoicePanelExpanded) {
      return (
        <div style={{ border: "1px solid #334155", borderRadius: 8, padding: 9, background: "#0f172a", display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <b style={{ display: "block" }}>Голосовой звонок</b>
              <small style={{ color: status.color }}>{status.text}</small>
            </div>
            <button type="button" onClick={() => setMobileVoicePanelExpanded(true)}>Подробнее</button>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {isJoinedSelectedDmVoice ? (
              <>
                <button type="button" onClick={toggleVoiceMute}>{voiceMuted ? "Включить микрофон" : "Выключить микрофон"}</button>
                <button type="button" onClick={leaveVoiceFromUi}>Выйти</button>
              </>
            ) : (
              <button
                type="button"
                disabled={!dmSelectedVoiceChannelId || voiceBusy}
                onClick={() => void joinVoice({ channelId: dmSelectedVoiceChannelId ?? undefined, channelName: selectedDmDialog?.partner?.username ? `ЛС с ${selectedDmDialog.partner.username}` : "Личные сообщения" })}
              >
                {voiceBusy ? "Подключение..." : dmIncomingCall ? "Присоединиться" : "Позвонить"}
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div style={{ border: "1px solid #334155", borderRadius: 8, padding: 10, background: "#0f172a", display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 2 }}>
            <b>Голосовой звонок</b>
            <small style={{ color: status.color }}>{status.text}</small>
            {isJoinedSelectedDmVoice ? (
              <small style={{ color: livekitStatus === "failed" ? "#fca5a5" : "#94a3b8" }}>
                Звук: {livekitStatus}{livekitError ? ` (${livekitError})` : ""}
              </small>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isMobile ? <button type="button" onClick={() => setMobileVoicePanelExpanded(false)}>Свернуть</button> : null}
            {isJoinedSelectedDmVoice ? (
              <>
                <button type="button" onClick={toggleVoiceMute}>
                  {voiceMuted ? "Включить микрофон" : "Выключить микрофон"}
                </button>
                <button type="button" onClick={toggleSelfDeafen}>
                  {selfDeafened ? "Слышать всех" : "Заглушить всё"}
                </button>
                <button type="button" onClick={leaveVoiceFromUi}>Выйти</button>
              </>
            ) : (
              <button
                type="button"
                disabled={!dmSelectedVoiceChannelId || voiceBusy}
                title="Голос в ЛС"
                onClick={() => void joinVoice({ channelId: dmSelectedVoiceChannelId ?? undefined, channelName: selectedDmDialog?.partner?.username ? `ЛС с ${selectedDmDialog.partner.username}` : "Личные сообщения" })}
              >
                {voiceBusy ? "Подключение..." : dmIncomingCall ? "Присоединиться к звонку" : "Позвонить"}
              </button>
            )}
          </div>
        </div>

        {hasParticipants ? (
          <div style={{ display: "grid", gap: 8 }}>
            {selfParticipant ? (
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(160px, 240px) 1fr", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  title="Вы (ПКМ: громкость микрофона)"
                  onContextMenu={openSelfMicVolumeMenu}
                  style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", border: "1px solid #2563eb", borderRadius: 8, background: "#111827", padding: 8, cursor: "context-menu" }}
                >
                  <span
                    className={isUserSpeaking(selfParticipant.userId) ? "gvoice-speaking-avatar" : undefined}
                    style={{ width: 34, height: 34, borderRadius: "50%", border: "1px solid #2563eb", overflow: "hidden", display: "grid", placeItems: "center", background: "#0b1222", flexShrink: 0 }}
                  >
                    {getDmParticipantAvatar(selfParticipant) ? (
                      <img src={toAbsoluteAttachmentUrl(getDmParticipantAvatar(selfParticipant) as string)} alt={selfParticipant.username} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <b style={{ color: "#93c5fd" }}>{selfParticipant.username.slice(0, 1).toUpperCase()}</b>
                    )}
                  </span>
                  <span>
                    <b>{selfParticipant.username}</b>
                    <small style={{ display: "block", color: voiceMuted ? "#fca5a5" : "#94a3b8" }}>
                      {voiceMuted ? "микрофон выключен" : "микрофон включён"}
                    </small>
                  </span>
                </button>
                <label style={{ display: "grid", gridTemplateColumns: "minmax(120px, 180px) 1fr 44px", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <span style={{ color: "#94a3b8" }}>Мой микрофон</span>
                  <input type="range" min={0} max={100} value={Math.round(micInputVolume * 100)} onChange={(event) => void setLocalMicInputVolume(Number(event.target.value) / 100)} />
                  <span style={{ color: "#94a3b8", textAlign: "right" }}>{Math.round(micInputVolume * 100)}%</span>
                </label>
              </div>
            ) : null}

            {dmRemoteVoiceParticipants.length === 0 ? (
              <small style={{ color: "#94a3b8" }}>Собеседник пока не подключился к голосу.</small>
            ) : null}
            {dmRemoteVoiceParticipants.map((participant) => {
              const volume = getParticipantVolume(participant);
              const volumePercent = Math.round(volume * 100);
              const avatarUrl = getDmParticipantAvatar(participant);
              return (
                <div key={participant.socketId} style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(160px, 240px) 1fr auto", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    title={`${participant.username} (ПКМ: громкость)`}
                    onContextMenu={(event) => openVoiceVolumeMenu(event, participant)}
                    style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", border: "1px solid #334155", borderRadius: 8, background: "#111827", padding: 8, cursor: "context-menu" }}
                  >
                    <span
                      className={isUserSpeaking(participant.userId) ? "gvoice-speaking-avatar" : undefined}
                      style={{ width: 34, height: 34, borderRadius: "50%", border: "1px solid #334155", overflow: "hidden", display: "grid", placeItems: "center", background: "#0b1222", flexShrink: 0 }}
                    >
                      {avatarUrl ? (
                        <img src={toAbsoluteAttachmentUrl(avatarUrl)} alt={participant.username} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <b style={{ color: "#cbd5e1" }}>{participant.username.slice(0, 1).toUpperCase()}</b>
                      )}
                    </span>
                    <span>
                      <b>{participant.username}</b>
                      <small style={{ display: "block", color: volume === 0 ? "#fca5a5" : "#94a3b8" }}>
                        {volume === 0 ? "заглушен у вас" : "слышно у вас"}
                      </small>
                    </span>
                  </button>
                  <label style={{ display: "grid", gridTemplateColumns: "minmax(90px, 140px) 1fr 44px", gap: 8, alignItems: "center", fontSize: 13 }}>
                    <span style={{ color: "#94a3b8" }}>Громкость</span>
                    <input type="range" min={0} max={100} value={volumePercent} onChange={(event) => setParticipantVolume(participant.socketId, Number(event.target.value) / 100)} />
                    <span style={{ color: "#94a3b8", textAlign: "right" }}>{volumePercent}%</span>
                  </label>
                  <button type="button" onClick={() => toggleParticipantMuted(participant)}>
                    {volume === 0 ? "Включить" : "Заглушить"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <main
      className="gvoice-dark"
      style={{
        margin: 0,
        fontFamily: "Segoe UI, sans-serif",
        background: "#0b1020",
        color: "#e5e7eb",
        height: isMobile ? "100dvh" : "100vh",
        padding: isMobile ? "0.6rem" : "0.75rem",
        borderRadius: 0,
        boxSizing: "border-box",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column"
      }}
    >
      <style>{`
        .gvoice-dark input, .gvoice-dark select, .gvoice-dark button {
          background: #0f172a;
          color: #e5e7eb;
          border: 1px solid #34527d;
          border-radius: 9px;
          font: inherit;
        }
        .gvoice-dark input, .gvoice-dark select {
          min-height: 35px;
          box-sizing: border-box;
          padding: 7px 10px;
          font-size: 13.5px;
          transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        }
        .gvoice-dark input:focus, .gvoice-dark select:focus {
          border-color: #4f83c5;
          outline: none;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.16);
        }
        .gvoice-dark input::placeholder {
          color: #94a3b8;
        }
        .gvoice-dark button {
          min-height: 34px;
          padding: 6px 10px;
          font-size: 13.5px;
          line-height: 1.2;
          font-weight: 700;
          letter-spacing: 0.01em;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(2, 8, 23, 0.16);
          transition: border-color 160ms ease, background 160ms ease, color 160ms ease, box-shadow 160ms ease, transform 160ms ease, opacity 160ms ease;
        }
        .gvoice-dark button:hover:not(:disabled) {
          border-color: #4f83c5;
          background: #152744;
          color: #ffffff;
          box-shadow: 0 7px 20px rgba(2, 8, 23, 0.25);
          transform: translateY(-1px);
        }
        .gvoice-dark button:active:not(:disabled) {
          transform: translateY(0);
          box-shadow: 0 2px 8px rgba(2, 8, 23, 0.2);
        }
        .gvoice-dark button:focus-visible {
          outline: 3px solid rgba(96, 165, 250, 0.34);
          outline-offset: 2px;
        }
        .gvoice-dark button:disabled {
          opacity: 0.48;
          cursor: not-allowed;
          box-shadow: none;
        }
        .gvoice-dark h3 {
          font-size: 16px;
          line-height: 1.25;
          font-weight: 750;
        }
        .gvoice-panel-heading {
          min-width: 0;
          white-space: nowrap;
        }
        .gvoice-panel-toolbar {
          display: flex;
          min-height: 34px;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }
        .gvoice-panel-toolbar-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          flex-wrap: nowrap;
        }
        .gvoice-call-pill {
          display: inline-flex;
          min-height: 32px;
          box-sizing: border-box;
          align-items: center;
          gap: 7px;
          padding: 6px 10px;
          border: 1px solid #197044;
          border-radius: 9px;
          background: linear-gradient(145deg, #073b25, #052e1c);
          color: #8ff0b8;
          box-shadow: 0 5px 16px rgba(5, 46, 22, 0.25);
          font-size: 12px;
          font-weight: 750;
          white-space: nowrap;
        }
        .gvoice-call-pill::before {
          content: "";
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #4ade80;
          box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.13);
        }
        .gvoice-header-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 7px;
          flex-wrap: wrap;
        }
        .gvoice-profile-menu {
          position: relative;
        }
        .gvoice-profile-trigger {
          display: flex;
          min-width: 190px;
          align-items: center;
          justify-content: space-between;
          gap: 9px;
          padding: 6px 9px !important;
          text-align: left;
          background: linear-gradient(145deg, #101d32, #0c172a) !important;
        }
        .gvoice-profile-avatar {
          display: grid;
          width: 25px;
          height: 25px;
          flex: 0 0 auto;
          place-items: center;
          overflow: hidden;
          border: 1px solid #4f83c5;
          border-radius: 50%;
          background: #14233b;
          color: #bfdbfe;
          font-size: 12px;
          font-weight: 800;
        }
        .gvoice-profile-dropdown {
          position: absolute;
          top: calc(100% + 7px);
          right: 0;
          z-index: 5000;
          width: min(260px, calc(100vw - 24px));
          padding: 8px;
          border: 1px solid #34527d;
          border-radius: 12px;
          background: linear-gradient(145deg, #0d192c, #091322);
          box-shadow: 0 20px 48px rgba(0, 0, 0, 0.48);
        }
        .gvoice-profile-dropdown button {
          width: 100%;
          justify-content: flex-start;
          margin-top: 5px;
          text-align: left;
          box-shadow: none;
        }
        .gvoice-profile-dropdown button:first-of-type {
          margin-top: 0;
        }
        .gvoice-profile-menu-danger {
          border-color: rgba(248, 113, 113, 0.42) !important;
          color: #fca5a5 !important;
        }
        .gvoice-chat-copy {
          color: #e8eef8;
          font-size: 15.5px;
          font-weight: 550;
          line-height: 1.5;
        }
        .gvoice-chat-message {
          display: grid;
          grid-template-columns: 42px minmax(0, 1fr);
          column-gap: 10px;
          align-items: start;
        }
        .gvoice-chat-message-main {
          min-width: 0;
        }
        .gvoice-chat-message-header {
          display: flex;
          min-height: 22px;
          align-items: baseline;
          gap: 8px;
          flex-wrap: wrap;
        }
        .gvoice-chat-message-author {
          color: #f1f5f9;
          font-size: 15px;
          font-weight: 750;
        }
        .gvoice-chat-message-time {
          color: #94a3b8;
          font-size: 11.5px;
        }
        .gvoice-chat-avatar-large {
          display: grid;
          width: 40px;
          height: 40px;
          box-sizing: border-box;
          place-items: center;
          overflow: hidden !important;
          border: 1px solid #34527d;
          border-radius: 50% !important;
          background: linear-gradient(145deg, #182a46, #0c172a);
          color: #bfdbfe;
          font-size: 15px;
          font-weight: 800;
        }
        .gvoice-chat-avatar-large .gvoice-avatar {
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: 50%;
        }
        .gvoice-composer-icon-control {
          display: grid !important;
          width: 40px !important;
          height: 34px !important;
          min-height: 34px !important;
          box-sizing: border-box;
          padding: 0 !important;
          place-items: center;
          font-size: 19px !important;
          line-height: 1 !important;
        }
        .gvoice-tabbar {
          display: flex;
          gap: 8px;
          margin-bottom: 10px;
          padding: 3px 3px 10px;
          border-bottom: 1px solid #263750;
          overflow-x: auto;
          scrollbar-width: thin;
        }
        .gvoice-tab-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          flex: 0 0 auto;
          white-space: nowrap;
          background: #0f1b2e !important;
        }
        .gvoice-tab-button[aria-selected="true"] {
          border-color: #3b82f6;
          background: #2563eb !important;
          color: #ffffff;
          box-shadow: 0 6px 20px rgba(37, 99, 235, 0.24);
        }
        .gvoice-tab-button[aria-selected="true"]:hover:not(:disabled) {
          background: #2d6ff0 !important;
        }
        .gvoice-tab-button:hover:not(:disabled),
        .gvoice-tab-button:active:not(:disabled) {
          transform: none;
        }
        .gvoice-tab-button:focus-visible {
          outline-width: 2px;
          outline-offset: -2px;
        }
        .gvoice-tab-icon {
          display: inline-grid;
          width: 20px;
          height: 20px;
          place-items: center;
          border-radius: 6px;
          background: rgba(148, 163, 184, 0.12);
          font-size: 13px;
          line-height: 1;
        }
        .gvoice-alert-badge {
          min-width: 21px;
          box-sizing: border-box;
          border-radius: 999px;
          padding: 1px 6px;
          background: #f59e0b;
          color: #111827;
          font-size: 11px;
          font-weight: 800;
          line-height: 17px;
          text-align: center;
        }
        .gvoice-alert-badge-danger {
          background: #ef4444;
          color: #ffffff;
        }
        .gvoice-unread-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #fb7185;
          box-shadow: 0 0 0 3px rgba(251, 113, 133, 0.16), 0 0 12px rgba(251, 113, 133, 0.55);
          flex: 0 0 auto;
        }
        .gvoice-unread-dot-warning {
          background: #fbbf24;
          box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.14), 0 0 12px rgba(251, 191, 36, 0.45);
        }
        .gvoice-welcome-action {
          min-height: 88px !important;
          padding: 14px 15px !important;
          text-align: left;
          display: grid;
          align-content: center;
          gap: 5px;
          background: linear-gradient(145deg, #101d32, #0c172a) !important;
        }
        .gvoice-welcome-action:hover:not(:disabled) {
          background: linear-gradient(145deg, #152744, #10213a) !important;
        }
        .gvoice-news-shell {
          min-height: 0;
          overflow-y: auto;
          padding: clamp(16px, 3vw, 34px);
          border: 1px solid #263b5d;
          border-radius: 18px;
          background: radial-gradient(circle at 16% 0%, rgba(37, 99, 235, 0.14), transparent 34%), linear-gradient(145deg, #0c172a, #081222);
          box-shadow: 0 22px 62px rgba(0, 0, 0, 0.28);
        }
        .gvoice-news-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
          gap: 14px;
          margin-top: 24px;
        }
        .gvoice-news-card {
          position: relative;
          overflow: hidden;
          min-height: 180px;
          padding: 20px;
          border: 1px solid #29486f;
          border-radius: 14px;
          background: rgba(16, 31, 54, 0.78);
          box-shadow: 0 12px 32px rgba(2, 8, 23, 0.22);
        }
        .gvoice-news-card::before {
          content: "";
          position: absolute;
          inset: 0 auto 0 0;
          width: 3px;
          background: var(--news-accent);
        }
        .gvoice-news-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          color: #8da7c8;
          font-size: 12px;
        }
        .gvoice-news-label {
          border-radius: 999px;
          padding: 4px 8px;
          background: rgba(96, 165, 250, 0.1);
          color: var(--news-accent);
          font-weight: 750;
        }
        @media (max-width: 640px) {
          .gvoice-app-header {
            flex-direction: row !important;
            align-items: center !important;
            gap: 10px !important;
          }
          .gvoice-app-logo {
            height: 48px !important;
            max-width: 132px !important;
          }
          .gvoice-header-actions {
            flex-wrap: nowrap;
          }
          .gvoice-profile-trigger {
            width: min(190px, 52vw);
            min-width: 0;
          }
          .gvoice-profile-dropdown {
            right: 0;
            left: auto;
          }
          .gvoice-tabbar {
            gap: 5px;
            padding: 3px 2px 10px;
            overflow: visible;
          }
          .gvoice-tab-button {
            min-width: 0;
            min-height: 42px;
            flex: 1 1 0;
            gap: 5px;
            padding: 6px 7px;
            font-size: 12px;
          }
          .gvoice-tab-button > span:nth-child(2) {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .gvoice-tab-icon {
            width: 18px;
            height: 18px;
            flex: 0 0 auto;
          }
          .gvoice-chat-copy {
            font-size: 16.5px;
            line-height: 1.52;
          }
          .gvoice-chat-message-author {
            font-size: 16px;
          }
          .gvoice-news-shell {
            border-radius: 13px;
          }
        }
        .gvoice-avatar {
          transition: transform 0.16s ease;
          transform-origin: center center;
          position: relative;
          z-index: 1;
        }
        .gvoice-speaking-avatar {
          animation: gvoice-speaking-pulse 0.92s ease-in-out infinite;
          border-color: #22c55e !important;
          box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.24), 0 0 22px rgba(34, 197, 94, 0.34);
        }
        @keyframes gvoice-speaking-pulse {
          0% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.09);
          }
          100% {
            transform: scale(1);
          }
        }
        .gvoice-member-avatar:hover {
          border-color: #60a5fa !important;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
          cursor: zoom-in;
        }
        .gvoice-chat-avatar-host {
          position: relative;
          z-index: 1;
          overflow: visible;
        }
        .gvoice-chat-avatar-host:hover {
          z-index: 9999;
        }
        .gvoice-chat-avatar-host .gvoice-avatar {
          transform-origin: left center;
        }
      `}</style>
      {memberAvatarPreview ? (
        <div
          style={{
            position: "fixed",
            left: memberAvatarPreview.left,
            top: memberAvatarPreview.top,
            zIndex: 10000,
            width: 132,
            padding: 8,
            border: "1px solid #475569",
            borderRadius: 10,
            background: "rgba(15, 23, 42, 0.98)",
            boxShadow: "0 18px 48px rgba(0, 0, 0, 0.5)",
            pointerEvents: "none"
          }}
        >
          <img
            src={memberAvatarPreview.url}
            alt={memberAvatarPreview.username}
            style={{ display: "block", width: 116, height: 116, borderRadius: 8, objectFit: "cover" }}
          />
          <div style={{ marginTop: 7, color: "#e2e8f0", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center" }}>
            {memberAvatarPreview.username}
          </div>
        </div>
      ) : null}
      {imagePreview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={imagePreview.name}
          onClick={() => setImagePreview(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 12000,
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr)",
            gap: 12,
            padding: 16,
            background: "rgba(2, 6, 23, 0.9)",
            backdropFilter: "blur(8px)"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div style={{ color: "#dbeafe", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{imagePreview.name}</div>
            <button
              type="button"
              onClick={() => setImagePreview(null)}
              style={{ flex: "0 0 auto", padding: "8px 12px", border: "1px solid #49698f", borderRadius: 8, background: "#111f35", color: "#e2e8f0" }}
            >
              Закрыть
            </button>
          </div>
          <div onClick={(event) => event.stopPropagation()} style={{ minHeight: 0, display: "grid", placeItems: "center", overflow: "hidden" }}>
            <img
              src={imagePreview.url}
              alt={imagePreview.name}
              style={{ display: "block", maxWidth: "96vw", maxHeight: "calc(100vh - 82px)", objectFit: "contain", borderRadius: 10, boxShadow: "0 24px 80px rgba(0, 0, 0, 0.65)" }}
            />
          </div>
        </div>
      ) : null}
      {isDesktopRuntime ? (
        <ScreenSharePicker
          open={isScreenSharePickerOpen}
          displaySources={desktopDisplaySources}
          displaySourcesLoading={displaySourcesLoading}
          onClose={() => setIsScreenSharePickerOpen(false)}
          onConfirm={(source, sourceId) => {
            setIsScreenSharePickerOpen(false);
            void (async () => {
              if (sourceId && window.gvoiceDesktop?.setDisplaySource) {
                await window.gvoiceDesktop.setDisplaySource(sourceId);
              }
              await startScreenShare(source);
            })();
          }}
        />
      ) : null}
      <MiniGamesModal
        open={isMiniGamesOpen}
        socket={socketRef.current}
        channelId={voiceJoinedChannelId}
        currentUser={user ? { id: user.id, username: user.username } : null}
        onClose={() => setIsMiniGamesOpen(false)}
      />
      {renderUserContextMenu()}
      <header
        className="gvoice-app-header"
        style={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: isMobile ? 8 : 10,
          marginBottom: 8
        }}
      >
        <div>
          <img
            className="gvoice-app-logo"
            src={GVOICE_LOGO_MAIN_URL}
            alt="GVoice"
            style={{ display: "block", height: isMobile ? 58 : 88, width: "auto", maxWidth: "100%", objectFit: "contain" }}
          />
        </div>
        <div style={{ display: "grid", justifyItems: isMobile ? "stretch" : "end", gap: 6 }}>
          <div className="gvoice-header-actions" style={{ justifyContent: isMobile ? "flex-start" : "flex-end" }}>
            {voiceJoinedChannelId && !isMobile ? (
              <span className="gvoice-call-pill">
                В звонке: {activeVoiceChannelLabel}
              </span>
            ) : null}
            <div className="gvoice-profile-menu">
              <button
                className="gvoice-profile-trigger"
                type="button"
                aria-haspopup="menu"
                aria-expanded={isUserMenuOpen}
                onClick={() => setIsUserMenuOpen((previous) => !previous)}
              >
                <span className="gvoice-profile-avatar">
                  {user?.avatarUrl ? (
                    <img
                      src={toAbsoluteAttachmentUrl(user.avatarUrl)}
                      alt=""
                      className="gvoice-avatar"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    user?.username?.slice(0, 1).toUpperCase() ?? "G"
                  )}
                </span>
                <span style={{ display: "grid", minWidth: 0, flex: 1 }}>
                  <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.username ?? "Профиль"}</strong>
                  <small style={{ color: "#8da7c8", fontSize: 10.5 }}>
                    {typeof user?.numericId === "number" ? `ID: ${user.numericId}` : "Открыть профиль"}
                  </small>
                </span>
                <span aria-hidden="true" style={{ color: "#8da7c8", fontSize: 11 }}>{isUserMenuOpen ? "▲" : "▼"}</span>
              </button>
              {isUserMenuOpen ? (
                <div className="gvoice-profile-dropdown" role="menu">
                  <div style={{ padding: "5px 7px 9px", borderBottom: "1px solid #263750" }}>
                    <b style={{ display: "block", fontSize: 13.5 }}>{user?.username}</b>
                    <small style={{ color: "#7898c2", fontSize: 10.5 }}>Версия {APP_BUILD_VERSION}</small>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      setFriendsPanelTab("friends");
                      setIsFriendsPanelOpen(true);
                      void reloadDmLists();
                    }}
                  >
                    ♟ Друзья{friendUserIdSet.size > 0 ? ` (${friendUserIdSet.size})` : ""}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      setIsSupportPanelOpen(true);
                    }}
                  >
                    ◇ Поддержка
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      setSettingsTab("audio");
                      setNotificationSettings(loadNotificationSettings());
                      setIsProfileEditorOpen(false);
                      setIsSettingsOpen(true);
                    }}
                  >
                    ⚙ Настройки
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      setSettingsTab("profile");
                      setIsSettingsOpen(false);
                      setIsProfileEditorOpen(true);
                    }}
                  >
                    ✎ Редактировать профиль
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      window.open("https://gvoice.online/#legal", "_blank", "noopener,noreferrer");
                    }}
                  >
                    ↗ Условия использования
                  </button>
                  <button
                    className="gvoice-profile-menu-danger"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      void logout();
                    }}
                  >
                    ↪ Выйти из аккаунта
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      {!showEntryWelcome ? (
        <div className="gvoice-tabbar" role="tablist" aria-label="Основные разделы">
          <button className="gvoice-tab-button" type="button" role="tab" aria-selected={activeTab === "spaces"} onClick={() => { setActiveTab("spaces"); setShowEntryWelcome(false); }}>
            <span className="gvoice-tab-icon" aria-hidden="true">⌂</span>
            <span>Пространства</span>
            {spacesTabAlertCount > 0 ? (
              <span className="gvoice-unread-dot" title="Есть непрочитанные сообщения" aria-label="Есть непрочитанные сообщения" />
            ) : null}
          </button>
          <button className="gvoice-tab-button" type="button" role="tab" aria-selected={activeTab === "dm"} onClick={() => { setActiveTab("dm"); setShowEntryWelcome(false); }}>
            <span className="gvoice-tab-icon" aria-hidden="true">✉</span>
            <span>{isMobile ? "Сообщения" : "Личные сообщения"}</span>
            {dmTabAlertCount > 0 ? (
              <span className="gvoice-unread-dot gvoice-unread-dot-warning" title="Есть новые события" aria-label="Есть новые события" />
            ) : null}
          </button>
          <button className="gvoice-tab-button" type="button" role="tab" aria-selected={activeTab === "news"} onClick={() => { setActiveTab("news"); setShowEntryWelcome(false); }}>
            <span className="gvoice-tab-icon" aria-hidden="true">✦</span>
            <span>Новости</span>
          </button>
        </div>
      ) : null}

      {error ? <p style={{ color: "#f87171" }}>{error}</p> : null}
      {inviteStatus ? <p style={{ color: "#4ade80" }}>{inviteStatus}</p> : null}
      {isCreateWorkspaceOpen ? (
        <div onClick={() => setIsCreateWorkspaceOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 3150, display: "grid", placeItems: "center", padding: 12, background: "rgba(2, 6, 23, 0.72)", backdropFilter: "blur(5px)" }}>
          <section onClick={(event) => event.stopPropagation()} style={{ width: "min(460px, 100%)", padding: 16, border: "1px solid #334155", borderRadius: 12, background: "#0f172a" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0 }}>Создать пространство</h3>
                <small style={{ color: "#94a3b8" }}>Название и способ вступления можно изменить позже.</small>
              </div>
              <button type="button" onClick={() => setIsCreateWorkspaceOpen(false)}>Закрыть</button>
            </div>
            {error ? <p style={{ color: "#f87171", marginTop: 0 }}>{error}</p> : null}
            <form onSubmit={createWorkspace} style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 5, color: "#cbd5e1", fontSize: 13 }}>
                Название
                <input autoFocus placeholder="Например, Игровая команда" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} minLength={SPACE_CHANNEL_NAME_MIN} maxLength={SPACE_CHANNEL_NAME_MAX} required />
              </label>
              <label style={{ display: "grid", gap: 5, color: "#cbd5e1", fontSize: 13 }}>
                Доступ к пространству
                <select value={workspaceJoinPolicy} onChange={(event) => setWorkspaceJoinPolicy(event.target.value as "open" | "request" | "private")}>
                  <option value="open">Открытое — любой может вступить</option>
                  <option value="request">По заявке — требуется одобрение</option>
                  <option value="private">Закрытое — только по приглашению</option>
                </select>
              </label>
              <small style={{ color: "#94a3b8" }}>
                {workspaceJoinPolicy === "private" ? "Закрытое пространство не отображается в поиске." : workspaceJoinPolicy === "request" ? "Новые участники появятся в списке заявок." : "Пользователи смогут вступить сразу."}
              </small>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" onClick={() => setIsCreateWorkspaceOpen(false)}>Отмена</button>
                <button type="submit">Создать пространство</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      {isCreateChannelOpen ? (
        <div onClick={() => setIsCreateChannelOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 3150, display: "grid", placeItems: "center", padding: 12, background: "rgba(2, 6, 23, 0.72)", backdropFilter: "blur(5px)" }}>
          <section onClick={(event) => event.stopPropagation()} style={{ width: "min(460px, 100%)", padding: 16, border: "1px solid #334155", borderRadius: 12, background: "#0f172a" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0 }}>Создать канал</h3>
                <small style={{ color: "#94a3b8" }}>{selectedWorkspace?.name}</small>
              </div>
              <button type="button" onClick={() => setIsCreateChannelOpen(false)}>Закрыть</button>
            </div>
            {error ? <p style={{ color: "#f87171", marginTop: 0 }}>{error}</p> : null}
            <form onSubmit={createChannel} style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 5, color: "#cbd5e1", fontSize: 13 }}>
                Название канала
                <input autoFocus placeholder="Название канала" value={channelName} onChange={(event) => setChannelName(event.target.value)} minLength={SPACE_CHANNEL_NAME_MIN} maxLength={SPACE_CHANNEL_NAME_MAX} required />
              </label>
              <label style={{ display: "grid", gap: 5, color: "#cbd5e1", fontSize: 13 }}>
                Тип канала
                <select value={channelType} onChange={(event) => setChannelType(event.target.value as "text" | "voice")}>
                  <option value="text">Текстовый</option>
                  <option value="voice">Голосовой</option>
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1", fontSize: 13 }}>
                <input type="checkbox" checked={channelIsPrivate} onChange={(event) => setChannelIsPrivate(event.target.checked)} />
                Приватный канал — доступ только по приглашению
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" onClick={() => setIsCreateChannelOpen(false)}>Отмена</button>
                <button type="submit">Создать канал</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      {isWorkspaceInviteOpen && selectedWorkspaceId ? (
        <div
          onClick={() => setIsWorkspaceInviteOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 3160, display: "grid", placeItems: "center", padding: 12, background: "rgba(2, 6, 23, 0.72)", backdropFilter: "blur(5px)" }}
        >
          <section
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(520px, 100%)", maxHeight: "min(720px, 90vh)", overflowY: "auto", padding: 16, border: "1px solid #334155", borderRadius: 12, background: "#0f172a" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0 }}>Добавить участника</h3>
                <small style={{ color: "#94a3b8" }}>В пространство «{selectedWorkspace?.name}»</small>
              </div>
              <button type="button" onClick={() => setIsWorkspaceInviteOpen(false)}>Закрыть</button>
            </div>

            {error ? <p style={{ color: "#f87171", marginTop: 0 }}>{error}</p> : null}
            {inviteStatus ? <p style={{ color: "#4ade80", marginTop: 0 }}>{inviteStatus}</p> : null}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                const numericId = Number(workspaceInviteNumericId.trim());
                if (Number.isInteger(numericId) && numericId > 0) {
                  void inviteUserToWorkspace({ numericId });
                } else {
                  setError("Введите корректный числовой ID пользователя");
                }
              }}
              style={{ display: "grid", gap: 8, paddingBottom: 14, borderBottom: "1px solid #334155" }}
            >
              <label style={{ display: "grid", gap: 5, color: "#cbd5e1", fontSize: 13 }}>
                Добавить по ID
                <input
                  autoFocus
                  inputMode="numeric"
                  placeholder="Например, 27"
                  value={workspaceInviteNumericId}
                  onChange={(event) => setWorkspaceInviteNumericId(event.target.value.replace(/\D/g, ""))}
                />
              </label>
              <button type="submit" disabled={workspaceInviteBusy || !workspaceInviteNumericId.trim()}>
                {workspaceInviteBusy ? "Добавляем..." : "Добавить в пространство"}
              </button>
            </form>

            <h4 style={{ margin: "14px 0 8px" }}>Выбрать из друзей</h4>
            {invitableFriends.length === 0 ? (
              <div style={{ padding: "20px 12px", textAlign: "center", border: "1px dashed #334155", borderRadius: 8, color: "#94a3b8" }}>
                Все ваши друзья уже добавлены или список друзей пуст.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {invitableFriends.map((dialog) => {
                  const friend = dialog.partner!;
                  return (
                    <div
                      key={friend.id}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 10, border: "1px solid #334155", borderRadius: 8, background: "#111827" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                        {friend.avatarUrl ? (
                          <img src={toAbsoluteAttachmentUrl(friend.avatarUrl)} alt={friend.username} style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                        ) : (
                          <span style={{ width: 38, height: 38, borderRadius: "50%", display: "grid", placeItems: "center", background: "#1e293b", color: "#93c5fd", fontWeight: 800, flexShrink: 0 }}>
                            {friend.username.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{friend.username}</b>
                          <small style={{ color: "#94a3b8" }}>ID: {friend.numericId ?? "—"}</small>
                        </div>
                      </div>
                      <button type="button" disabled={workspaceInviteBusy} onClick={() => void inviteUserToWorkspace({ userId: friend.id })}>
                        Добавить
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}
      {workspaceBansWorkspaceId ? (
        <WorkspaceBans workspaceId={workspaceBansWorkspaceId} onClose={() => setWorkspaceBansWorkspaceId(null)} />
      ) : null}
      {isFriendsPanelOpen ? (
        <div
          onClick={() => setIsFriendsPanelOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(2, 6, 23, 0.72)",
            backdropFilter: "blur(5px)",
            zIndex: 3100,
            display: "grid",
            placeItems: "center",
            padding: 12
          }}
        >
          <section
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(620px, 100%)",
              height: "min(720px, calc(100dvh - 24px))",
              overflow: "hidden",
              border: "1px solid #334155",
              borderRadius: 14,
              background: "linear-gradient(145deg, #111c33, #0b1222)",
              boxShadow: "0 24px 70px rgba(0, 0, 0, 0.55)",
              display: "grid",
              gridTemplateRows: "auto auto minmax(0, 1fr)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid #263552" }}>
              <div>
                <h3 style={{ margin: 0 }}>Друзья</h3>
                <small style={{ color: "#94a3b8" }}>Поиск людей, заявки, друзья и чёрный список.</small>
              </div>
              <button type="button" onClick={() => setIsFriendsPanelOpen(false)}>Закрыть</button>
            </div>
            <div style={{ display: "flex", gap: 8, padding: "12px 14px 0", flexWrap: "wrap" }}>
              <button type="button" onClick={() => setFriendsPanelTab("friends")} style={{ background: friendsPanelTab === "friends" ? "#1d4ed8" : "#0f172a" }}>
                Друзья ({friendUserIdSet.size})
              </button>
              <button type="button" onClick={() => setFriendsPanelTab("requests")} style={{ background: friendsPanelTab === "requests" ? "#1d4ed8" : "#0f172a" }}>
                Добавить и заявки ({dmIncomingRequests.length})
              </button>
              <button type="button" onClick={() => setFriendsPanelTab("blocked")} style={{ background: friendsPanelTab === "blocked" ? "#1d4ed8" : "#0f172a" }}>
                Чёрный список ({dmBlocks.length})
              </button>
            </div>
            <div style={{ display: "grid", alignContent: "start", gap: 8, padding: 14, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
              {friendsPanelTab === "requests" ? (
                <>
                  <div style={{ display: "grid", gap: 8, padding: 12, background: "#0f172a", border: "1px solid #334155", borderRadius: 10 }}>
                    <b>Добавить друга по ID</b>
                    <input placeholder="ID пользователя" value={dmSearchId} onChange={(event) => setDmSearchId(event.target.value)} inputMode="numeric" />
                    {dmSearchResult ? (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 10, border: "1px solid #334155", borderRadius: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <b>{dmSearchResult.username}</b>
                          <small style={{ display: "block", color: "#94a3b8" }}>
                            ID: {dmSearchResult.numericId ?? "—"} • {dmSearchResult.isBlocked ? "в чёрном списке" : dmSearchResult.blockedByUser ? "недоступен" : dmSearchResult.isFriend ? "уже в друзьях" : dmSearchResult.outgoingRequest ? "заявка отправлена" : dmSearchResult.incomingRequest ? "прислал заявку" : "можно добавить"}
                          </small>
                        </div>
                        {!dmSearchResult.isBlocked && !dmSearchResult.blockedByUser && !dmSearchResult.isFriend && !dmSearchResult.outgoingRequest ? (
                          <button type="button" onClick={() => void sendFriendRequest()}>Добавить</button>
                        ) : null}
                      </div>
                    ) : dmSearchId.trim() ? <small style={{ color: "#94a3b8" }}>Введите корректный ID пользователя.</small> : null}
                  </div>
                  <h4 style={{ margin: "8px 0 0" }}>Входящие заявки</h4>
                  {dmIncomingRequests.length === 0 ? (
                    <div style={{ padding: "24px 16px", textAlign: "center", border: "1px dashed #334155", borderRadius: 10, color: "#94a3b8" }}>Новых заявок нет.</div>
                  ) : dmIncomingRequests.map((request) => (
                    <div key={request.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, background: "#0f172a", border: "1px solid #334155", borderRadius: 10 }}>
                      <div>
                        <b>{request.sender.username}</b>
                        <small style={{ display: "block", color: "#94a3b8" }}>ID: {request.sender.numericId ?? "—"}</small>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => void processIncomingDmRequest(request.id, "approve")}>Принять</button>
                        <button type="button" onClick={() => void processIncomingDmRequest(request.id, "reject")}>Отклонить</button>
                      </div>
                    </div>
                  ))}
                </>
              ) : null}
              {friendsPanelTab === "friends" && friendUserIdSet.size === 0 ? (
                <div style={{ padding: "30px 16px", textAlign: "center", border: "1px dashed #334155", borderRadius: 10, color: "#94a3b8" }}>
                  В списке друзей пока никого нет.
                </div>
              ) : null}
              {friendsPanelTab === "friends" ? sortedDmDialogs.filter((dialog) => dialog.isFriend && dialog.partner).map((dialog) => (
                <div
                  key={dialog.workspaceId}
                  onContextMenu={(event) => dialog.partner && openUserContextMenu(event, dialog.partner)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, background: "#0f172a", border: "1px solid #334155", borderRadius: 10 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    {dialog.partner?.avatarUrl ? (
                      <img src={toAbsoluteAttachmentUrl(dialog.partner.avatarUrl)} alt={dialog.partner.username} style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover", border: "1px solid #475569" }} />
                    ) : (
                      <span style={{ width: 42, height: 42, borderRadius: "50%", display: "grid", placeItems: "center", background: "#1e293b", color: "#93c5fd", fontWeight: 800 }}>
                        {dialog.partner?.username.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dialog.partner?.username}</b>
                      <small style={{ color: presenceColor(dialog.partner?.id) }}>{presenceLabel(dialog.partner?.id)}</small>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("dm");
                      setShowEntryWelcome(false);
                      setDmSelectedWorkspaceId(dialog.workspaceId);
                      if (isMobile) setMobileDmPane("chat");
                      setIsFriendsPanelOpen(false);
                    }}
                    style={{ flexShrink: 0 }}
                  >
                    Открыть диалог
                  </button>
                </div>
              )) : null}
              {friendsPanelTab === "blocked" && dmBlocks.length === 0 ? (
                <div style={{ padding: "30px 16px", textAlign: "center", border: "1px dashed #334155", borderRadius: 10, color: "#94a3b8" }}>
                  Чёрный список пока пуст.
                </div>
              ) : null}
              {friendsPanelTab === "blocked" ? dmBlocks.map((item) => (
                <div
                  key={item.blocked.id}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, background: "#0f172a", border: "1px solid #334155", borderRadius: 10 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    {item.blocked.avatarUrl ? (
                      <img src={toAbsoluteAttachmentUrl(item.blocked.avatarUrl)} alt={item.blocked.username} style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover", border: "1px solid #475569" }} />
                    ) : (
                      <span style={{ width: 42, height: 42, borderRadius: "50%", display: "grid", placeItems: "center", background: "#1e293b", color: "#93c5fd", fontWeight: 800 }}>
                        {item.blocked.username.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.blocked.username}</b>
                      <small style={{ color: "#94a3b8" }}>ID: {item.blocked.numericId ?? "—"}</small>
                    </div>
                  </div>
                  <button type="button" onClick={() => void unblockDmUser(item.blocked.id)} style={{ flexShrink: 0 }}>
                    Разблокировать
                  </button>
                </div>
              )) : null}
            </div>
          </section>
        </div>
      ) : null}
      {isSupportPanelOpen && user?.id ? (
        <SupportPanel authorizedFetch={authorizedFetch} currentUserId={user.id} onClose={() => setIsSupportPanelOpen(false)} />
      ) : null}
      {isProfileEditorOpen || isSettingsOpen ? (
        <div
          onClick={() => {
            setIsProfileEditorOpen(false);
            setIsSettingsOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(2, 6, 23, 0.65)",
            zIndex: 3000,
            display: "grid",
            placeItems: "center",
            padding: 12
          }}
        >
          <section
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(760px, 100%)",
              maxHeight: "88vh",
              overflowY: "auto",
              border: "1px solid #334155",
              borderRadius: 10,
              padding: 12,
              background: "#0f172a"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{isProfileEditorOpen ? "Редактирование профиля" : "Настройки"}</h3>
              <button type="button" onClick={() => { setIsProfileEditorOpen(false); setIsSettingsOpen(false); }}>Закрыть</button>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              {isProfileEditorOpen ? (
                <>
                  <button type="button" onClick={() => setSettingsTab("profile")} style={{ background: settingsTab === "profile" ? "#1d4ed8" : "#0f172a" }}>Профиль</button>
                  <button type="button" onClick={() => setSettingsTab("security")} style={{ background: settingsTab === "security" ? "#1d4ed8" : "#0f172a" }}>Безопасность</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => setSettingsTab("audio")} style={{ background: settingsTab === "audio" ? "#1d4ed8" : "#0f172a" }}>Звук и микрофон</button>
                  <button type="button" onClick={() => setSettingsTab("notifications")} style={{ background: settingsTab === "notifications" ? "#1d4ed8" : "#0f172a" }}>Уведомления</button>
                  <button type="button" onClick={() => setSettingsTab("keybinds")} style={{ background: settingsTab === "keybinds" ? "#1d4ed8" : "#0f172a" }}>Бинды</button>
                  {isDesktopRuntime ? (
                    <button type="button" onClick={() => setSettingsTab("updates")} style={{ background: settingsTab === "updates" ? "#1d4ed8" : "#0f172a" }}>Обновления</button>
                  ) : null}
                </>
              )}
            </div>

            <form onSubmit={submitProfileUpdate} style={{ display: "grid", gap: 8 }}>
              {settingsTab === "profile" ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {user?.avatarUrl ? (
                      <img
                        src={toAbsoluteAttachmentUrl(user.avatarUrl)}
                        alt="avatar"
                        className="gvoice-avatar"
                        style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", border: "1px solid #334155" }}
                      />
                    ) : null}
                    <input type="file" accept="image/*" onChange={(event) => setProfileAvatarFile(event.target.files?.[0] ?? null)} />
                    <button type="button" onClick={() => void uploadAvatar()} disabled={profileBusy || !profileAvatarFile}>
                      Загрузить аватарку
                    </button>
                  </div>
                  <input
                    placeholder="Имя (username)"
                    value={profileUsername}
                    onChange={(event) => setProfileUsername(event.target.value)}
                    minLength={USERNAME_MIN}
                    maxLength={USERNAME_MAX}
                    pattern="[A-Za-z0-9_]+"
                    title="3-20 символов: латиница, цифры, _"
                    required
                  />
                </>
              ) : settingsTab === "security" ? (
                <>
                  <input type="email" placeholder="Почта" value={profileEmail} onChange={(event) => setProfileEmail(event.target.value)} required />
                  <input
                    type="password"
                    placeholder="Текущий пароль (обязательно для смены почты/пароля)"
                    value={profileCurrentPassword}
                    onChange={(event) => setProfileCurrentPassword(event.target.value)}
                  />
                  <input type="password" placeholder="Новый пароль" value={profileNewPassword} onChange={(event) => setProfileNewPassword(event.target.value)} />
                  <input
                    type="password"
                    placeholder="Подтверждение нового пароля"
                    value={profileNewPasswordConfirm}
                    onChange={(event) => setProfileNewPasswordConfirm(event.target.value)}
                  />
                </>
              ) : settingsTab === "audio" ? (
                <>
                  <label style={{ color: "#cbd5e1", fontSize: 13 }}>Микрофон</label>
                  <select
                    value={settingsAudioInputDeviceId}
                    onChange={(event) => setSettingsAudioInputDeviceId(event.target.value)}
                    disabled={voiceBusy || isAndroidNativePlatform()}
                  >
                    <option value="">Системный микрофон по умолчанию</option>
                    {audioInputDevices.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Микрофон ${index + 1}`}
                      </option>
                    ))}
                  </select>

                  <label style={{ color: "#cbd5e1", fontSize: 13 }}>Устройство воспроизведения</label>
                  <select
                    value={settingsAudioOutputDeviceId}
                    onChange={(event) => setSettingsAudioOutputDeviceId(event.target.value)}
                    disabled={voiceBusy || !supportsAudioOutputSelection()}
                  >
                    <option value="">Системное устройство по умолчанию</option>
                    {audioOutputDevices.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Устройство воспроизведения ${index + 1}`}
                      </option>
                    ))}
                  </select>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" onClick={() => void refreshAudioDevices(true)} disabled={audioDevicesBusy}>
                      {audioDevicesBusy ? "Обновляем..." : "Обновить список устройств"}
                    </button>
                    {!supportsAudioOutputSelection() ? (
                      <small style={{ color: "#fbbf24" }}>Этот браузер не поддерживает выбор наушников или динамиков.</small>
                    ) : null}
                  </div>
                  <small style={{ color: "#94a3b8" }}>
                    Если названия скрыты, обновите список и разрешите доступ к микрофону.
                  </small>

                  <label style={{ color: "#cbd5e1", fontSize: 13 }}>Шумоподавление</label>
                  <select value={settingsNoiseMode} onChange={(event) => setSettingsNoiseMode(event.target.value as NoiseMode)} disabled={voiceBusy}>
                    <option value="off">Выкл</option>
                    <option value="medium">Средний</option>
                    <option value="aggressive">Агрессивный</option>
                  </select>
                  <small style={{ color: "#94a3b8" }}>
                    Текущий режим: {NOISE_MODE_LABEL[noiseMode]} • Выбран: {NOISE_MODE_LABEL[settingsNoiseMode]}
                  </small>
                </>
              ) : settingsTab === "notifications" ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <small style={{ color: "#94a3b8" }}>Выберите, какие события должны привлекать ваше внимание.</small>
                  {([
                    ["messageSounds", "Звук новых сообщений"],
                    ["callSounds", "Звуки входящих звонков и участников"],
                    ["desktopNotifications", "Системные уведомления на рабочем столе"],
                    ["directMessages", "Уведомления о личных сообщениях"],
                    ["spaceMessages", "Уведомления о сообщениях в пространствах"],
                    ["showMessagePreview", "Показывать текст сообщения в уведомлении"],
                    ["onlyWhenUnfocused", "Показывать системные уведомления только когда GVoice неактивен"]
                  ] as Array<[keyof NotificationSettings, string]>).map(([key, label]) => (
                    <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={notificationSettings[key]}
                        onChange={(event) => setNotificationSettings((previous) => ({ ...previous, [key]: event.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button
                      type="button"
                      disabled={!notificationSettings.desktopNotifications || !("Notification" in window) || Notification.permission === "granted"}
                      onClick={() => void Notification.requestPermission().then(() => setNotificationSettings((previous) => ({ ...previous })))}
                    >
                      {!("Notification" in window)
                        ? "Системные уведомления не поддерживаются"
                        : Notification.permission === "granted"
                          ? "Разрешение выдано"
                          : "Разрешить системные уведомления"}
                    </button>
                    {"Notification" in window && Notification.permission === "denied" ? (
                      <small style={{ color: "#fbbf24" }}>Уведомления запрещены в браузере. Разрешите их в настройках сайта.</small>
                    ) : null}
                  </div>
                </div>
              ) : settingsTab === "keybinds" ? (
                <>
                  <small style={{ color: "#94a3b8" }}>
                    По умолчанию бинды отключены. Нажмите «Изменить», затем желаемое сочетание клавиш.
                  </small>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={radioModeEnabled}
                      onChange={(event) => setRadioModeEnabled(event.target.checked)}
                    />
                    Включить режим рации
                  </label>
                  <small style={{ color: radioModeEnabled ? "#fbbf24" : "#94a3b8" }}>
                    {radioModeEnabled
                      ? `Микрофон будет выключен и включится только пока удерживается клавиша режима рации.${pushToTalkHolding ? " Сейчас клавиша удерживается — микрофон открыт." : ""}`
                      : "Режим рации выключен: клавиша может быть назначена, но микрофон не будет автоматически глушиться."}
                  </small>
                  {(["toggleMic", "toggleDeafen", "toggleScreenShare", "pushToTalk"] as VoiceKeybindAction[]).map((action) => {
                    const label =
                      action === "toggleMic"
                        ? "Микрофон вкл/выкл"
                        : action === "toggleDeafen"
                          ? "Оглушить себя (микрофон + наушники)"
                          : action === "toggleScreenShare"
                            ? "Показ экрана вкл/выкл"
                            : "Режим рации (удерживать)";
                    return (
                      <div
                        key={action}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(180px, 1fr) minmax(120px, 160px) auto auto",
                          gap: 8,
                          alignItems: "center"
                        }}
                      >
                        <span style={{ color: "#cbd5e1", fontSize: 13 }}>{label}</span>
                        <input
                          value={recordingKeybindAction === action ? "Нажмите клавиши..." : voiceKeybinds[action] || "Отключено"}
                          readOnly
                          style={{ textAlign: "center" }}
                        />
                        <button
                          type="button"
                          onClick={() => setRecordingKeybindAction((prev) => (prev === action ? null : action))}
                        >
                          {recordingKeybindAction === action ? "Отмена" : "Изменить"}
                        </button>
                        <button
                          type="button"
                          disabled={!voiceKeybinds[action]}
                          onClick={() => {
                            setVoiceKeybinds((prev) => ({ ...prev, [action]: "" }));
                            setRecordingKeybindAction((prev) => (prev === action ? null : prev));
                          }}
                        >
                          Очистить
                        </button>
                      </div>
                    );
                  })}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setVoiceKeybinds(DEFAULT_VOICE_KEYBINDS);
                        setRadioModeEnabled(false);
                        setRecordingKeybindAction(null);
                      }}
                    >
                      Сбросить по умолчанию
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => void checkDesktopUpdatesManually()}
                    disabled={desktopUpdateBusy}
                    style={{ justifySelf: "start" }}
                  >
                    {desktopUpdateBusy ? "Проверяем..." : "Проверить обновления"}
                  </button>
                  <small style={{ color: desktopUpdateStatus.stage === "error" ? "#f87171" : "#94a3b8" }}>
                    {desktopUpdateStatus.message}
                  </small>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="submit" disabled={profileBusy}>
                  {profileBusy ? "Сохранение..." : "Сохранить"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsProfileEditorOpen(false);
                    setIsSettingsOpen(false);
                    setNotificationSettings(loadNotificationSettings());
                    setProfileCurrentPassword("");
                    setProfileNewPassword("");
                    setProfileNewPasswordConfirm("");
                    setProfileUsername(user?.username ?? "");
                    setProfileEmail(user?.email ?? "");
                  }}
                  disabled={profileBusy}
                >
                  Отмена
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      {expandedScreenShareKey && remoteScreenStreams[expandedScreenShareKey] ? (
        <div
          onClick={() => setExpandedScreenShareKey(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 3500,
            background: "rgba(2, 6, 23, 0.96)",
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr)",
            gap: 8,
            padding: 12
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <b style={{ color: "#e5e7eb" }}>Демонстрация экрана</b>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setExpandedScreenShareKey(null);
              }}
            >
              Закрыть
            </button>
          </div>
          <video
            autoPlay
            playsInline
            controls
            muted={selfDeafened}
            style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000", borderRadius: 8 }}
            onClick={(event) => event.stopPropagation()}
            ref={(node) => {
              const stream = remoteScreenStreams[expandedScreenShareKey];
              if (node && stream && node.srcObject !== stream) {
                node.srcObject = stream;
              }
            }}
          />
        </div>
      ) : null}
      {showEntryWelcome ? (
        <section
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            display: "grid"
          }}
        >
          <section
            style={{
              background: "#111827",
              border: "1px solid #1f2937",
              borderRadius: 8,
              padding: 16,
              minHeight: 0,
              overflow: "auto",
              display: "grid",
              alignContent: "start",
              gap: 10
            }}
          >
            <h3 style={{ margin: 0 }}>Добро пожаловать</h3>
            <div style={{ border: "1px solid #334155", borderRadius: 10, padding: 16, background: "#0f172a", color: "#cbd5e1", display: "grid", gap: 10 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>Пустой интерфейс</div>
              <div style={{ color: "#93c5fd" }}>{startGreeting}</div>
              <small style={{ color: "#94a3b8" }}>Выбери, куда хочешь зайти прямо сейчас.</small>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <button
                  className="gvoice-welcome-action"
                  type="button"
                  onClick={() => {
                    setActiveTab("spaces");
                    setShowEntryWelcome(false);
                    setSelectedWorkspaceId(null);
                    setSelectedChannelId(null);
                  }}
                >
                  <b>Пространства</b>
                  <small style={{ color: "#94a3b8" }}>Каналы, встречи и ваши сообщества</small>
                  <small style={{ color: "#fca5a5", fontWeight: 700 }}>{spacesTabAlertCount > 0 ? "● Есть новое" : "Всё прочитано"}</small>
                </button>
                <button
                  className="gvoice-welcome-action"
                  type="button"
                  onClick={() => {
                    setActiveTab("dm");
                    setShowEntryWelcome(false);
                    setDmSelectedWorkspaceId(null);
                  }}
                >
                  <b>Личные сообщения</b>
                  <small style={{ color: "#94a3b8" }}>Диалоги, друзья и личные звонки</small>
                  <small style={{ color: "#fcd34d", fontWeight: 700 }}>{dmTabAlertCount > 0 ? "● Есть новое" : "Всё прочитано"}</small>
                </button>
                <button
                  className="gvoice-welcome-action"
                  type="button"
                  onClick={() => {
                    setActiveTab("news");
                    setShowEntryWelcome(false);
                  }}
                >
                  <b>Новости</b>
                  <small style={{ color: "#94a3b8" }}>Обновления, возможности и важные заметки</small>
                  <small style={{ color: "#93c5fd", fontWeight: 700 }}>Узнать, что нового</small>
                </button>
              </div>
            </div>
          </section>
        </section>
      ) : activeTab === "spaces" ? (
      <section
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "260px 300px minmax(320px, 1fr)",
          gap: 12,
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
          overflow: "hidden"
        }}
      >
        <aside style={{ background: "#111827", borderRadius: 8, padding: 10, border: "1px solid #1f2937", overflowY: isMobile ? "auto" : "visible", minHeight: 0, display: isMobile && mobileSpacesPane !== "workspaces" ? "none" : "block" }}>
          <div className="gvoice-panel-toolbar">
            <h3 className="gvoice-panel-heading" style={{ margin: 0 }}>Пространства</h3>
            <button type="button" onClick={() => { setError(null); setIsCreateWorkspaceOpen(true); }}>+ Создать</button>
          </div>

          <input
            placeholder="Найти пространство..."
            value={workspaceSearchQuery}
            onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />

          {workspaceSearchResults.length > 0 ? (
            <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
              {workspaceSearchResults.map((item) => (
                <div
                  key={item.id}
                  style={{
                    textAlign: "left",
                    background: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    padding: "6px 8px",
                    overflow: "hidden"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</b>
                    {item.isMember ? (
                      <button type="button" onClick={() => openWorkspaceFromSearch(item)}>
                        Открыть
                      </button>
                    ) : item.joinPolicy === "open" ? (
                      <button type="button" onClick={() => void submitJoinRequest(item.id)}>
                        Вступить
                      </button>
                    ) : item.joinRequestStatus === "pending" ? (
                      <button type="button" disabled>
                        Заявка отправлена
                      </button>
                    ) : (
                      <button type="button" onClick={() => void submitJoinRequest(item.id)}>
                        Подать заявку
                      </button>
                    )}
                  </div>
                  <small style={{ color: "#94a3b8", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    ID: {formatWorkspaceId(item.slug)} • владелец: {item.ownerUsername} {item.isMember ? "" : "• нет доступа"}
                  </small>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Режим вступления: {item.joinPolicy === "open" ? "открытое" : "по заявке"}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {loading ? <p>Загрузка...</p> : null}

          <div style={{ display: "grid", gap: 6 }}>
            {sortedWorkspaces.map((workspace) => {
              const isEditing = editingWorkspaceId === workspace.id;
              const canEditThisWorkspace = canManageWorkspaceItem(workspace.role);
              const canOpenWorkspaceMenu = canEditThisWorkspace || workspace.role === "moderator";
              const unreadCount = workspaceUnreadById[workspace.id] ?? 0;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => {
                    setSelectedWorkspaceId(workspace.id);
                    if (isMobile) setMobileSpacesPane("channels");
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 2) {
                      event.preventDefault();
                    }
                  }}
                  onContextMenu={(event) => {
                    if (!canOpenWorkspaceMenu) {
                      return;
                    }
                    openWorkspaceContextMenu(event, workspace);
                  }}
                  style={{
                    textAlign: "left",
                    background: workspace.id === selectedWorkspaceId ? "#1d4ed8" : "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    padding: "8px 10px",
                    overflow: "hidden"
                  }}
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingWorkspaceName}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setEditingWorkspaceName(event.target.value)}
                      maxLength={SPACE_CHANNEL_NAME_MAX}
                      onBlur={() => {
                        setEditingWorkspaceId(null);
                        setEditingWorkspaceName("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void updateWorkspaceNameInline(workspace.id, editingWorkspaceName);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingWorkspaceId(null);
                          setEditingWorkspaceName("");
                        }
                      }}
                      style={{ width: "100%", marginBottom: 2 }}
                    />
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {workspace.name}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <span
                        role="button"
                        tabIndex={0}
                        title={pinnedWorkspaceIdSet.has(workspace.id) ? "Открепить пространство" : "Закрепить пространство"}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleWorkspacePin(workspace.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleWorkspacePin(workspace.id);
                          }
                        }}
                        style={{ color: pinnedWorkspaceIdSet.has(workspace.id) ? "#fbbf24" : "#64748b", cursor: "pointer", fontSize: 15 }}
                      >
                        {pinnedWorkspaceIdSet.has(workspace.id) ? "📌" : "○"}
                      </span>
                      {unreadCount > 0 ? (
                        <span
                          className="gvoice-unread-dot"
                          title="Есть непрочитанные сообщения"
                          aria-label="Есть непрочитанные сообщения"
                        />
                      ) : null}
                      </span>
                    </div>
                  )}
                  <small style={{ color: "#94a3b8", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    ID: {formatWorkspaceId(workspace.slug)} • {roleLabel(workspace.role)} •{" "}
                    {workspace.joinPolicy === "open" ? "Открытое" : workspace.joinPolicy === "private" ? "Закрытое" : "По заявке"}
                  </small>
                </button>
              );
            })}
          </div>

        </aside>

        <aside style={{ background: "#111827", borderRadius: 8, padding: 10, border: "1px solid #1f2937", overflowY: "auto", minHeight: 0, display: isMobile && mobileSpacesPane !== "channels" ? "none" : "block" }}>
          {selectedWorkspaceId ? (
            <>
          {isMobile ? (
            <button
              type="button"
              onClick={() => setMobileSpacesPane("workspaces")}
              style={{ marginBottom: 8, paddingInline: 10 }}
            >
              ← Пространства
            </button>
          ) : null}
          <div className="gvoice-panel-toolbar">
            <h3 className="gvoice-panel-heading" style={{ margin: 0 }}>Каналы</h3>
            {selectedWorkspaceId && canManageChannels ? (
              <div className="gvoice-panel-toolbar-actions">
                <button type="button" onClick={() => { setError(null); setInviteStatus(null); setIsWorkspaceInviteOpen(true); }}>+ Участник</button>
                <button type="button" onClick={() => { setError(null); setIsCreateChannelOpen(true); }}>+ Канал</button>
              </div>
            ) : null}
          </div>
          <p style={{ margin: "0 0 8px", color: "#94a3b8", fontSize: 13 }}>{selectedWorkspace?.name ?? "Выбери пространство"}</p>
          {!canManageChannels && selectedWorkspaceId ? (
            <small style={{ color: "#94a3b8", display: "block", marginBottom: 10 }}>
              Каналы может создавать только владелец, админ или модератор пространства.
            </small>
          ) : null}

          <div
            style={{
              display: "grid",
              gap: 6,
              maxHeight: channels.length > 5 ? 278 : "none",
              overflowY: channels.length > 5 ? "auto" : "visible",
              overscrollBehavior: "contain",
              scrollbarGutter: channels.length > 5 ? "stable" : "auto",
              paddingRight: channels.length > 5 ? 3 : 0
            }}
          >
            {channels.map((channel) => {
              const isEditing = editingChannelId === channel.id;
              const unreadCount = channelUnreadById[channel.id] ?? 0;
              const channelOccupants = channel.type === "voice" ? voiceOccupancyByChannelId[channel.id] ?? [] : [];
              return (
              <button
                key={channel.id}
                type="button"
                onClick={() => {
                  setSelectedChannelId(channel.id);
                  if (isMobile) setMobileSpacesPane("chat");
                }}
                onMouseDown={(event) => {
                  if (event.button === 2) {
                    event.preventDefault();
                  }
                }}
                onContextMenu={(event) => openChannelContextMenu(event, channel)}
                style={{
                  textAlign: "left",
                  background: channel.id === selectedChannelId ? "#1d4ed8" : "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: "8px 10px"
                }}
              >
                {isEditing ? (
                  <input
                    autoFocus
                    value={editingChannelName}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setEditingChannelName(event.target.value)}
                    maxLength={SPACE_CHANNEL_NAME_MAX}
                    onBlur={() => {
                      setEditingChannelId(null);
                      setEditingChannelName("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void updateChannelName(channel.id, editingChannelName);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingChannelId(null);
                        setEditingChannelName("");
                      }
                    }}
                    style={{ width: "100%", marginBottom: 2 }}
                  />
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      # {channel.name}
                    </span>
                    {unreadCount > 0 ? (
                      <span
                        style={{
                          padding: "1px 7px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 700,
                          color: "#fff",
                          background: "#ef4444",
                          flexShrink: 0
                        }}
                      >
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </span>
                    ) : null}
                  </div>
                )}
                <small style={{ color: "#94a3b8", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{channelTypeLabel(channel.type)}{channel.isPrivate ? " • приватный" : ""}</small>
                {channelOccupants.length > 0 ? (
                  <div
                    title={channelOccupants.map((participant) => participant.username).join(", ")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      minWidth: 0,
                      marginTop: 6,
                      paddingTop: 6,
                      borderTop: "1px solid rgba(148, 163, 184, 0.2)"
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", paddingLeft: 4, flexShrink: 0 }}>
                      {channelOccupants.slice(0, 3).map((participant, index) => {
                        const avatarUrl = getWorkspaceMemberAvatarByUserId(participant.userId);
                        return avatarUrl ? (
                          <img
                            key={participant.userId}
                            src={toAbsoluteAttachmentUrl(avatarUrl)}
                            alt={participant.username}
                            style={{
                              width: 20,
                              height: 20,
                              borderRadius: "50%",
                              objectFit: "cover",
                              border: "2px solid #0f172a",
                              marginLeft: index === 0 ? 0 : -6
                            }}
                          />
                        ) : (
                          <span
                            key={participant.userId}
                            style={{
                              width: 20,
                              height: 20,
                              borderRadius: "50%",
                              display: "inline-grid",
                              placeItems: "center",
                              color: "#dcfce7",
                              background: "#15803d",
                              border: "2px solid #0f172a",
                              marginLeft: index === 0 ? 0 : -6,
                              fontSize: 10,
                              fontWeight: 700
                            }}
                          >
                            {participant.username.slice(0, 1).toUpperCase()}
                          </span>
                        );
                      })}
                    </span>
                    <small
                      style={{
                        color: channel.id === selectedChannelId ? "#dbeafe" : "#86efac",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {channelOccupants.slice(0, 2).map((participant) => participant.username).join(", ")}
                      {channelOccupants.length > 2 ? ` +${channelOccupants.length - 2}` : ""}
                    </small>
                  </div>
                ) : null}
              </button>
              );
            })}
          </div>

          {canModerateWorkspace && isSelectedWorkspaceRequest ? (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: "6px 0" }}>Заявки на вступление</h4>
              {joinRequests.length === 0 ? (
                <small style={{ color: "#94a3b8" }}>Новых заявок нет.</small>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {joinRequests.map((request) => (
                    <div
                      key={request.id}
                      style={{
                        background: "#0f172a",
                        border: "1px solid #334155",
                        borderRadius: 6,
                        padding: "8px 10px"
                      }}
                    >
                      <div style={{ marginBottom: 6 }}>
                        <b>{request.user.username}</b>
                        <small style={{ color: "#94a3b8", marginLeft: 8 }}>
                          {new Date(request.createdAt).toLocaleString()}
                        </small>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => void processJoinRequest(request.id, "approve")}>
                          Принять
                        </button>
                        <button type="button" onClick={() => void processJoinRequest(request.id, "reject")}>
                          Отклонить
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {selectedWorkspace ? (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: "6px 0" }}>Участники пространства</h4>
              {workspaceMembers.length === 0 ? (
                <small style={{ color: "#94a3b8" }}>Участников пока нет.</small>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gap: 6,
                    maxHeight: workspaceMembers.length > 4 ? (isMobile ? 360 : 414) : "none",
                    overflowY: workspaceMembers.length > 4 ? "auto" : "visible",
                    overscrollBehavior: "contain",
                    scrollbarGutter: workspaceMembers.length > 4 ? "stable" : "auto",
                    paddingRight: workspaceMembers.length > 4 ? 3 : 0
                  }}
                >
                  {workspaceMembers.map((member) => {
                    const isSelf = member.id === user?.id;
                    const memberIsOnline = isUserOnline(member.id);
                    return (
                      <div
                        key={member.id}
                        onContextMenu={(event) => openUserContextMenu(event, member, true)}
                        style={{
                          background: "#0f172a",
                          border: "1px solid #334155",
                          borderRadius: 6,
                          padding: "8px 10px",
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) auto",
                          alignItems: "center",
                          gap: 8
                        }}
                      >
                        <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <span
                              title={memberIsOnline ? "Онлайн" : "Не в сети"}
                              style={{
                                width: 9,
                                height: 9,
                                borderRadius: "50%",
                                background: presenceColor(member.id),
                                boxShadow: memberIsOnline ? "0 0 0 3px rgba(34, 197, 94, 0.16)" : "none",
                                flexShrink: 0
                              }}
                            />
                            {member.avatarUrl ? (
                              <img
                                src={toAbsoluteAttachmentUrl(member.avatarUrl)}
                                alt={member.username}
                                className="gvoice-avatar gvoice-member-avatar"
                                onMouseEnter={(event) => {
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  const previewWidth = 132;
                                  const previewHeight = 158;
                                  const gap = 12;
                                  const left = rect.right + gap + previewWidth <= window.innerWidth
                                    ? rect.right + gap
                                    : Math.max(8, rect.left - previewWidth - gap);
                                  const top = Math.min(
                                    Math.max(8, rect.top - (previewHeight - rect.height) / 2),
                                    window.innerHeight - previewHeight - 8
                                  );
                                  setMemberAvatarPreview({
                                    url: event.currentTarget.src,
                                    username: member.username,
                                    left,
                                    top
                                  });
                                }}
                                onMouseLeave={() => setMemberAvatarPreview(null)}
                                style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", border: "1px solid #334155" }}
                              />
                            ) : null}
                            <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.username}</b>
                          </div>
                          <small style={{ color: "#64748b" }}>ID: {typeof member.numericId === "number" ? member.numericId : "—"}</small>
                          <small style={{ color: "#94a3b8", display: "block", whiteSpace: "nowrap" }}>
                            {roleLabel(member.role)}
                          </small>
                          <small style={{ color: presenceColor(member.id), display: "block", whiteSpace: "nowrap" }}>
                            {presenceLabel(member.id)}
                          </small>
                        </div>
                        {isSelf ? (
                          <small style={{ color: "#94a3b8", textAlign: "right", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            Вы
                          </small>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
            </>
          ) : null}
        </aside>

        <section
          style={{
            background: "#111827",
            border: "1px solid #1f2937",
            borderRadius: 8,
            padding: 10,
            minHeight: 0,
            overflow: "hidden",
            flexDirection: "column",
            display: isMobile && mobileSpacesPane !== "chat" ? "none" : "flex"
          }}
        >
          {selectedWorkspaceId ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, marginBottom: 8 }}>
              {isMobile ? (
                <button
                  type="button"
                  onClick={() => setMobileSpacesPane("channels")}
                  style={{ flex: "0 0 auto", paddingInline: 10 }}
                >
                  ← Каналы
                </button>
              ) : null}
              <h3 style={{ margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedChannel ? `# ${selectedChannel.name}` : "Выбери канал"}
              </h3>
            </div>
          ) : null}
          {selectedWorkspaceId ? (
            <>

          {isVoiceChannelSelected ? (
            <>
          {isMobile ? (
            <div style={{ border: "1px solid #334155", borderRadius: 8, padding: 9, marginBottom: 8, background: "#0f172a", display: "grid", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <b style={{ display: "block" }}>Голосовой звонок</b>
                  <small style={{ color: voiceJoinedChannelId === selectedChannelId ? "#4ade80" : "#94a3b8" }}>
                    {voiceJoinedChannelId === selectedChannelId
                      ? "Вы подключены"
                      : isVoiceCallStartedInSelectedChannel
                        ? `В эфире: ${voiceParticipants.length}`
                        : "Звонок не запущен"}
                  </small>
                </div>
                <button type="button" onClick={() => setMobileVoicePanelExpanded((value) => !value)}>
                  {mobileVoicePanelExpanded ? "Свернуть" : "Подробнее"}
                </button>
              </div>
              {!mobileVoicePanelExpanded ? (
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  {voiceJoinedChannelId === selectedChannelId ? (
                    <>
                      <button type="button" onClick={toggleVoiceMute}>{voiceMuted ? "Включить микрофон" : "Выключить микрофон"}</button>
                      <button type="button" onClick={leaveVoiceFromUi}>Выйти</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => void joinVoice()} disabled={voiceBusy}>
                      {voiceBusy ? "Подключение..." : isVoiceCallStartedInSelectedChannel ? "Войти в звонок" : "Зажечь эфир"}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {(!isMobile || mobileVoicePanelExpanded) ? (
            !isVoiceCallStartedInSelectedChannel ? (
              <div style={{ border: "1px solid #334155", borderRadius: 6, padding: 12, marginBottom: 10, background: "#0f172a" }}>
                <div style={{ display: "grid", gap: 8 }}>
                  <b>Голосовой канал готов</b>
                  <small style={{ color: "#94a3b8" }}>
                    Звонок ещё не запущен. Нажми кнопку ниже, чтобы зажечь эфир и открыть голосовой интерфейс.
                  </small>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" onClick={() => void joinVoice()} disabled={voiceBusy}>
                      {voiceBusy ? "Запускаем..." : "Зажечь эфир"}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
            <div style={{ border: "1px solid #334155", borderRadius: 6, padding: 8, marginBottom: 10, background: "#0f172a" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <b>Голосовой звонок</b>
                  <div style={{ color: "#94a3b8", fontSize: 13 }}>
                    {voiceJoinedChannelId === selectedChannelId
                      ? voiceBusy || livekitStatus === "connecting"
                        ? "Подключаемся к звонку…"
                        : livekitStatus === "connected"
                          ? "Вы подключены к звонку"
                          : "Звонок открыт, настраиваем звук…"
                      : "Вы не в звонке"}
                  </div>
                <div style={{ color: livekitStatus === "failed" ? "#fca5a5" : "#94a3b8", fontSize: 12 }}>
                  LiveKit: {livekitStatus}
                  {livekitError ? ` (${livekitError})` : ""}
                </div>
                {voiceJoinedChannelId === selectedChannelId && (voiceBusy || livekitStatus === "connecting") ? (
                  <div style={{ color: "#fbbf24", fontSize: 12, marginTop: 2 }}>
                    Подключаем микрофон и звук собеседников. Звук включится плавно после готовности.
                  </div>
                ) : null}
                {isRemoteVoiceSyncing ? (
                  <div style={{ color: "#fbbf24", fontSize: 12, marginTop: 2 }}>
                    Подключено. Синхронизируем звук собеседников, это может занять несколько секунд.
                  </div>
                ) : null}
                <div style={{ color: "#93c5fd", fontSize: 11, marginTop: 4 }}>{platformDebugText}</div>
                {nativeVoiceDebugText ? (
                  <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>{nativeVoiceDebugText}</div>
                ) : null}
                </div>
                {voiceJoinedChannelId === selectedChannelId ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" onClick={toggleVoiceMute}>
                      {voiceMuted ? "Включить микрофон" : "Выключить микрофон"}
                    </button>
                    <button type="button" onClick={toggleSelfDeafen}>
                      {selfDeafened ? "Снять оглушение" : "Оглушить себя"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleScreenShare()}
                      disabled={!isScreenSharing && livekitStatus !== "connected"}
                    >
                      {isScreenSharing ? "Остановить показ" : "Показать экран"}
                    </button>
                    <button type="button" onClick={() => setIsMiniGamesOpen(true)}>Мини-игры</button>
                    <button type="button" onClick={leaveVoiceFromUi}>Выйти из звонка</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => void joinVoice()} disabled={voiceBusy}>
                    {voiceBusy ? "Подключение..." : "Войти в звонок"}
                  </button>
                )}
              </div>

              <div style={{ marginTop: 8, color: "#cbd5e1", fontSize: 13 }}>
                Участники: {voiceParticipants.length === 0 ? "пока никого" : voiceParticipants.map((p) => p.username).join(", ")}
              </div>
              {voiceParticipants.length > 0 ? (
                <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {user?.id ? (
                    <button
                      type="button"
                      title="Вы (ПКМ: громкость микрофона)"
                      className={isUserSpeaking(user.id) ? "gvoice-speaking-avatar" : undefined}
                      onContextMenu={openSelfMicVolumeMenu}
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: "50%",
                        border: "1px solid #3b82f6",
                        padding: 0,
                        overflow: "hidden",
                        display: "grid",
                        placeItems: "center",
                        background: "#0b1222",
                        cursor: "context-menu"
                      }}
                    >
                      {getWorkspaceMemberAvatarByUserId(user.id) ? (
                        <img
                          src={toAbsoluteAttachmentUrl(getWorkspaceMemberAvatarByUserId(user.id) as string)}
                          alt={user.username}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <span style={{ color: "#93c5fd", fontWeight: 700, fontSize: 14 }}>{user.username.slice(0, 1).toUpperCase()}</span>
                      )}
                    </button>
                  ) : null}
                  {voiceParticipants
                    .filter((participant) => participant.userId !== user?.id)
                    .map((participant) => {
                      const avatarUrl = getWorkspaceMemberAvatarByUserId(participant.userId);
                      return (
                        <button
                          key={participant.socketId}
                          type="button"
                          title={`${participant.username} (ПКМ: громкость)`}
                          className={isUserSpeaking(participant.userId) ? "gvoice-speaking-avatar" : undefined}
                          onContextMenu={(event) => openVoiceVolumeMenu(event, participant)}
                          style={{
                            width: 42,
                            height: 42,
                            borderRadius: "50%",
                            border: "1px solid #334155",
                            padding: 0,
                            overflow: "hidden",
                            display: "grid",
                            placeItems: "center",
                            background: "#0b1222",
                            cursor: "context-menu"
                          }}
                        >
                          {avatarUrl ? (
                            <img
                              src={toAbsoluteAttachmentUrl(avatarUrl)}
                              alt={participant.username}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : (
                            <span style={{ color: "#cbd5e1", fontWeight: 700, fontSize: 14 }}>
                              {participant.username.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
              ) : null}

              {Object.keys(remoteScreenStreams).length > 0 ? (
                <div style={{ marginTop: 12, display: "grid", gap: 10, maxHeight: isMobile ? 160 : 220, overflowY: "auto", paddingRight: 2 }}>
                  <b>Демонстрация экрана</b>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))",
                      gap: 10
                    }}
                  >
                    {Object.entries(remoteScreenStreams).map(([socketId, stream]) => {
                    const presenterName = remoteScreenPresenterByKey[socketId] ?? getDisplayNameByScreenKey(socketId);
                    const volume = Math.round((screenShareVolumeByKey[socketId] ?? DEFAULT_PARTICIPANT_VOLUME) * 100);
                    const joined = Boolean(joinedScreenSharesByKey[socketId]);
                    return (
                      <div
                        key={socketId}
                        style={{
                          display: "grid",
                          gap: 6,
                          background: "#0b1222",
                          border: "1px solid #1e293b",
                          borderRadius: 10,
                          padding: 8
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ color: "#e5e7eb", minWidth: 0, overflowWrap: "anywhere" }}>{presenterName}</span>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                            {!joined ? (
                              <button type="button" onClick={() => joinScreenShareStream(socketId)}>
                                Присоединиться
                              </button>
                            ) : (
                              <>
                                <button type="button" onClick={() => leaveScreenShareStream(socketId)}>
                                  Отсоединиться
                                </button>
                                <button type="button" onClick={() => void openScreenShareFullscreen(socketId)}>
                                  Во весь экран
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {joined ? (
                          <>
                            <label
                              style={{
                                display: "grid",
                                gridTemplateColumns: "minmax(90px, 34%) minmax(0, 1fr) 48px",
                                alignItems: "center",
                                gap: 8,
                                fontSize: 13
                              }}
                            >
                              <span style={{ color: "#94a3b8", minWidth: 0, overflowWrap: "anywhere" }}>Громкость</span>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={volume}
                                style={{ width: "100%", minWidth: 0 }}
                                onChange={(event) => setScreenShareVolume(socketId, Number(event.target.value) / 100)}
                              />
                              <span style={{ color: "#94a3b8", textAlign: "right" }}>{volume}%</span>
                            </label>
                            <video
                              id={`screen-share-video-${socketId}`}
                              data-screen-share-video="1"
                              autoPlay
                              playsInline
                              controls
                              muted={selfDeafened}
                              style={{
                                width: "100%",
                                maxHeight: isMobile ? 90 : 130,
                                aspectRatio: "16 / 9",
                                objectFit: "contain",
                                borderRadius: 8,
                                border: "none",
                                background: "#000"
                              }}
                              ref={(node) => {
                                if (node && node.srcObject !== stream) {
                                  node.srcObject = stream;
                                }
                              }}
                            />
                          </>
                        ) : (
                          <div
                            style={{
                              height: isMobile ? 92 : 120,
                              borderRadius: 8,
                              border: "1px dashed #334155",
                              background: "#020617",
                              display: "grid",
                              placeItems: "center",
                              color: "#94a3b8",
                              fontSize: 13
                            }}
                          >
                            Демонстрация скрыта до подключения
                          </div>
                        )}
                      </div>
                    );
                  })}
                  </div>
                </div>
              ) : null}
            </div>
            )
          ) : null}
            </>
          ) : null}

          {messageAttachment ? (
            <div style={{ marginBottom: 8 }}>
              <SelectedAttachmentPreview file={messageAttachment} onRemove={() => setMessageAttachment(null)} />
            </div>
          ) : null}
          {selectedMediaSession && showMediaBot ? (
          <div style={{ border: "1px solid #334155", borderRadius: 6, padding: 8, marginBottom: 10, background: "#0f172a" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <b>Media-бот</b>
              <small style={{ color: "#94a3b8" }}>
                Команды: <code>/play ссылка</code> <code>/pause</code> <code>/resume</code> <code>/stop</code>
              </small>
            </div>
            {selectedMediaSession?.isActive && selectedMediaSession.mediaUrl ? (
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                <small style={{ color: "#94a3b8" }}>
                  Запустил: {selectedMediaSession.updatedByUsername ?? "неизвестно"} •{" "}
                  {new Date(selectedMediaSession.updatedAt).toLocaleString()}
                </small>
                <small style={{ color: "#93c5fd" }}>
                  Мастер: {selectedMediaSession.masterUsername ?? "не назначен"}
                </small>
                {selectedMediaSession.mediaKind === "youtube" ? (
                  toYoutubeEmbedUrl(selectedMediaSession.mediaUrl) ? (
                    <div
                      ref={youtubeHostRef}
                      style={{ width: "100%", minHeight: isMobile ? 200 : 320, border: "1px solid #334155", borderRadius: 8, overflow: "hidden" }}
                    />
                  ) : (
                    <a href={selectedMediaSession.mediaUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd" }}>
                      Открыть YouTube
                    </a>
                  )
                ) : selectedMediaSession.mediaKind === "rutube" ? (
                  toRutubeEmbedUrl(selectedMediaSession.mediaUrl, {
                    autoplay: !selectedMediaSession.isPaused,
                    positionSec: effectiveSelectedMediaPositionSec,
                    reloadToken: selectedMediaSession.syncedAt
                  }) ? (
                    <iframe
                      key={`rutube-${selectedMediaSession.syncedAt}-${selectedMediaSession.updatedAt}-${selectedMediaSession.positionSec}-${selectedMediaSession.isPaused ? "p" : "r"}`}
                      src={toRutubeEmbedUrl(selectedMediaSession.mediaUrl, {
                        autoplay: !selectedMediaSession.isPaused,
                        positionSec: effectiveSelectedMediaPositionSec,
                        reloadToken: selectedMediaSession.syncedAt
                      })!}
                      title="Rutube Player"
                      allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                      allowFullScreen
                      style={{ width: "100%", minHeight: isMobile ? 200 : 320, border: "1px solid #334155", borderRadius: 8, background: "#000" }}
                    />
                  ) : (
                    <a href={selectedMediaSession.mediaUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd" }}>
                      Открыть Rutube
                    </a>
                  )
                ) : selectedMediaSession.mediaKind === "vkvideo" ? (
                  toVkVideoEmbedUrl(selectedMediaSession.mediaUrl, {
                    autoplay: !selectedMediaSession.isPaused,
                    positionSec: effectiveSelectedMediaPositionSec,
                    reloadToken: selectedMediaSession.syncedAt
                  }) ? (
                    <iframe
                      key={`vkvideo-${selectedMediaSession.syncedAt}-${selectedMediaSession.updatedAt}-${selectedMediaSession.positionSec}-${selectedMediaSession.isPaused ? "p" : "r"}`}
                      src={toVkVideoEmbedUrl(selectedMediaSession.mediaUrl, {
                        autoplay: !selectedMediaSession.isPaused,
                        positionSec: effectiveSelectedMediaPositionSec,
                        reloadToken: selectedMediaSession.syncedAt
                      })!}
                      title="VK Video Player"
                      allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                      allowFullScreen
                      style={{ width: "100%", minHeight: isMobile ? 200 : 320, border: "1px solid #334155", borderRadius: 8, background: "#000" }}
                    />
                  ) : (
                    <a href={selectedMediaSession.mediaUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd" }}>
                      Открыть VK Видео
                    </a>
                  )
                ) : selectedMediaSession.mediaKind === "twitch" ? (
                  toTwitchEmbedUrl(selectedMediaSession.mediaUrl, {
                    autoplay: !selectedMediaSession.isPaused,
                    positionSec: effectiveSelectedMediaPositionSec,
                    reloadToken: selectedMediaSession.syncedAt
                  }) ? (
                    <iframe
                      key={`twitch-${selectedMediaSession.syncedAt}-${selectedMediaSession.positionSec}-${selectedMediaSession.isPaused ? "p" : "r"}`}
                      src={toTwitchEmbedUrl(selectedMediaSession.mediaUrl, {
                        autoplay: !selectedMediaSession.isPaused,
                        positionSec: effectiveSelectedMediaPositionSec,
                        reloadToken: selectedMediaSession.syncedAt
                      })!}
                      title="Twitch Player"
                      allow="autoplay; fullscreen; picture-in-picture"
                      allowFullScreen
                      style={{ width: "100%", minHeight: isMobile ? 200 : 320, border: "1px solid #334155", borderRadius: 8, background: "#000" }}
                    />
                  ) : (
                    <a href={selectedMediaSession.mediaUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd" }}>
                      Открыть Twitch
                    </a>
                  )
                ) : selectedMediaSession.mediaKind === "video" ? (
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    ref={(node) => {
                      mediaPlayerRef.current = node;
                      if (node) void setAudioElementOutputDevice(node).catch(() => undefined);
                    }}
                    onPlay={(event) => {
                      if (suppressMediaEventsRef.current) {
                        return;
                      }
                      if (!isCurrentUserMediaMaster) {
                        event.currentTarget.pause();
                        return;
                      }
                      sendMediaCommand("resume", undefined, event.currentTarget.currentTime || 0);
                    }}
                    onPause={(event) => {
                      if (suppressMediaEventsRef.current) {
                        return;
                      }
                      if (!isCurrentUserMediaMaster) {
                        return;
                      }
                      sendMediaCommand("pause", undefined, event.currentTarget.currentTime || 0);
                    }}
                    onSeeked={(event) => {
                      if (suppressMediaEventsRef.current) {
                        return;
                      }
                      if (!isCurrentUserMediaMaster) {
                        return;
                      }
                      sendMediaCommand("seek", undefined, event.currentTarget.currentTime || 0);
                    }}
                    src={isHlsUrl(selectedMediaSession.mediaUrl) ? undefined : selectedMediaSession.mediaUrl ?? undefined}
                    style={{ width: "100%", maxHeight: 360, border: "1px solid #334155", borderRadius: 8, background: "#000" }}
                  />
                ) : selectedMediaSession.mediaKind === "audio" ? (
                  <audio
                    controls
                    preload="metadata"
                    ref={(node) => {
                      mediaPlayerRef.current = node;
                      if (node) void setAudioElementOutputDevice(node).catch(() => undefined);
                    }}
                    onPlay={(event) => {
                      if (suppressMediaEventsRef.current) {
                        return;
                      }
                      if (!isCurrentUserMediaMaster) {
                        event.currentTarget.pause();
                        return;
                      }
                      sendMediaCommand("resume", undefined, event.currentTarget.currentTime || 0);
                    }}
                    onPause={(event) => {
                      if (suppressMediaEventsRef.current) {
                        return;
                      }
                      if (!isCurrentUserMediaMaster) {
                        return;
                      }
                      sendMediaCommand("pause", undefined, event.currentTarget.currentTime || 0);
                    }}
                    onSeeked={(event) => {
                      if (suppressMediaEventsRef.current) {
                        return;
                      }
                      if (!isCurrentUserMediaMaster) {
                        return;
                      }
                      sendMediaCommand("seek", undefined, event.currentTarget.currentTime || 0);
                    }}
                    src={selectedMediaSession.mediaUrl}
                    style={{ width: "100%" }}
                  />
                ) : (
                  <a href={selectedMediaSession.mediaUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd" }}>
                    Открыть медиа-ссылку
                  </a>
                )}
                <a href={selectedMediaSession.mediaUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd", fontSize: 13 }}>
                  Если плеер черный, открой медиа в новой вкладке
                </a>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => sendMediaCommand("pause", undefined, getCurrentPlaybackPositionSec())}
                    disabled={!isCurrentUserMediaMaster}
                  >
                    Пауза
                  </button>
                  <button
                    type="button"
                    onClick={() => sendMediaCommand("resume", undefined, getCurrentPlaybackPositionSec())}
                    disabled={!isCurrentUserMediaMaster}
                  >
                    Продолжить
                  </button>
                  <button type="button" onClick={() => sendMediaCommand("stop")} disabled={!isCurrentUserMediaMaster}>Остановить</button>
                </div>
                {!isCurrentUserMediaMaster ? (
                  <small style={{ color: "#94a3b8" }}>
                    Только мастер управляет плеером. У тебя режим просмотра.
                  </small>
                ) : null}
                {selectedMediaSession.mediaKind === "youtube" || selectedMediaSession.mediaKind === "rutube" || selectedMediaSession.mediaKind === "vkvideo" || selectedMediaSession.mediaKind === "twitch" ? (
                  <small style={{ color: "#94a3b8" }}>
                          Для YouTube / Rutube / VK Видео / Twitch синхронизация ограничена политикой iframe. Для идеального sync используй прямые mp4/mp3 ссылки.
                  </small>
                ) : null}
              </div>
            ) : (
              <small style={{ color: "#94a3b8", display: "block", marginTop: 8 }}>
                Сейчас ничего не воспроизводится.
              </small>
            )}
          </div>
          ) : null}

          <div
            ref={messagesListRef}
            onScroll={() => rememberMessagesScrollPosition()}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: 8,
              paddingBottom: 8,
              marginBottom: 10
            }}
          >
            {messagesHasMore ? (
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                <button type="button" onClick={() => void loadOlderMessages()} disabled={messagesLoadingOlder}>
                  {messagesLoadingOlder ? "Загрузка..." : "Загрузить старые"}
                </button>
              </div>
            ) : null}
            {messages.length === 0 ? <p style={{ color: "#94a3b8" }}>Сообщений пока нет.</p> : null}
            {messages.map((message) => (
              <article
                className="gvoice-chat-message"
                key={message.id}
                id={`message-${message.id}`}
                onContextMenu={(event) => openMessageContextMenu(event, message)}
                style={{
                  marginBottom: 10,
                  paddingBottom: 8,
                  borderBottom: "1px solid #1f2937",
                  background: highlightedMessageId === message.id ? "rgba(59, 130, 246, 0.14)" : "transparent",
                  borderRadius: 8,
                  transition: "background-color 220ms ease"
                }}
              >
                <span className="gvoice-chat-avatar-host gvoice-chat-avatar-large">
                  {message.author.avatarUrl ? (
                    <img
                      src={toAbsoluteAttachmentUrl(message.author.avatarUrl)}
                      alt={message.author.username}
                      className="gvoice-avatar"
                    />
                  ) : (
                    message.author.username.slice(0, 1).toUpperCase()
                  )}
                </span>
                <div className="gvoice-chat-message-main">
                  <div className="gvoice-chat-message-header">
                    <b className="gvoice-chat-message-author">{message.author.username}</b>
                    <small className="gvoice-chat-message-time">{new Date(message.createdAt).toLocaleString()}</small>
                    {message.editedAt ? <small className="gvoice-chat-message-time">(изменено)</small> : null}
                  </div>
                {editingMessageId === message.id ? (
                  <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                    <input
                      value={editingMessageText}
                      onChange={(event) => setEditingMessageText(event.target.value)}
                      maxLength={4000}
                    />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => void saveEditedMessage(message.id)}>Сохранить</button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMessageId(null);
                          setEditingMessageText("");
                          setEditingMessageReplyPrefix(null);
                        }}
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {(() => {
                      const replyPayload = parseReplyPayload(message.body);
                      if (!replyPayload) {
                        return <div className="gvoice-chat-copy" style={{ overflowWrap: "anywhere" }}>{renderMessageBody(message.body)}</div>;
                      }
                      const replyTargetMessageId = resolveReplyTargetMessageId(replyPayload, message.id);
                      return (
                        <div style={{ display: "grid", gap: 6 }}>
                          <div
                            onClick={() => {
                              if (replyTargetMessageId) {
                                jumpToMessage(replyTargetMessageId);
                              }
                            }}
                            title={
                              replyTargetMessageId
                                ? "Перейти к исходному сообщению"
                                : "Для этого ответа переход недоступен"
                            }
                            style={{
                              position: "relative",
                              border: "1px solid #1d4ed8",
                              borderRadius: 10,
                              background:
                                "linear-gradient(135deg, rgba(29, 78, 216, 0.18) 0%, rgba(15, 23, 42, 0.96) 100%)",
                              padding: "8px 10px 8px 14px",
                              cursor: replyTargetMessageId ? "pointer" : "default"
                            }}
                          >
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                top: 0,
                                bottom: 0,
                                width: 4,
                                borderRadius: "10px 0 0 10px",
                                background: "linear-gradient(180deg, #60a5fa 0%, #a78bfa 100%)"
                              }}
                            />
                            <small style={{ color: "#93c5fd", display: "block", fontWeight: 600 }}>
                              ↪ Ответ для @{replyPayload.replyAuthor}
                            </small>
                            <small style={{ color: "#cbd5e1", display: "block", marginTop: 2, opacity: 0.92 }}>
                              {normalizeLegacyReplySnippet(replyPayload.replySnippet)}
                            </small>
                            {!replyTargetMessageId ? (
                              <small style={{ color: "#f59e0b", display: "block", marginTop: 4 }}>
                                ↪ Оригинал не найден в загруженной истории
                              </small>
                            ) : null}
                          </div>
                          <div className="gvoice-chat-copy" style={{ overflowWrap: "anywhere" }}>{renderMessageBody(replyPayload.messageText)}</div>
                        </div>
                      );
                    })()}
                    {renderMessageAttachment(message)}
                  </>
                )}
                </div>
              </article>
            ))}
          </div>
          {messageContextMenu ? (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "fixed",
                top: messageContextMenu.y,
                left: messageContextMenu.x,
                minWidth: 160,
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 8,
                boxShadow: "0 10px 24px rgba(0, 0, 0, 0.45)",
                padding: 6,
                zIndex: 2000
              }}
            >
              {messageContextMenu.canReply ? (
                <button
                  type="button"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    marginBottom: messageContextMenu.canEdit || messageContextMenu.canDelete ? 4 : 0
                  }}
                  onClick={() => {
                    const target = messages.find((message) => message.id === messageContextMenu.messageId);
                    if (!target) {
                      setMessageContextMenu(null);
                      return;
                    }
                    setReplyToMessage(target);
                    setMessageContextMenu(null);
                  }}
                >
                  Ответить
                </button>
              ) : null}
              {messageContextMenu.canEdit ? (
                <button
                  type="button"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    marginBottom: messageContextMenu.canDelete ? 4 : 0
                  }}
                  onClick={() => {
                    const target = messages.find((message) => message.id === messageContextMenu.messageId);
                    if (!target) {
                      setMessageContextMenu(null);
                      return;
                    }
                    const replyPayload = parseReplyPayload(target.body);
                    setEditingMessageId(target.id);
                    if (replyPayload) {
                      const newlineIndex = target.body.indexOf("\n");
                      setEditingMessageReplyPrefix(
                        newlineIndex >= 0 ? stripReplyIdFromPrefix(target.body.slice(0, newlineIndex)) : null
                      );
                      setEditingMessageText(replyPayload.messageText);
                    } else {
                      setEditingMessageReplyPrefix(null);
                      setEditingMessageText(target.body);
                    }
                    setMessageContextMenu(null);
                  }}
                >
                  Редактировать
                </button>
              ) : null}
              {messageContextMenu.canDelete ? (
                <button
                  type="button"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => void deleteMessage(messageContextMenu.messageId)}
                >
                  Удалить
                </button>
              ) : null}
            </div>
          ) : null}
          {voiceVolumeMenu ? (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "fixed",
                top: voiceVolumeMenu.y,
                left: voiceVolumeMenu.x,
                minWidth: 220,
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 8,
                boxShadow: "0 10px 24px rgba(0, 0, 0, 0.45)",
                padding: 8,
                zIndex: 2000
              }}
            >
              <div style={{ marginBottom: 6, fontSize: 13, color: "#cbd5e1" }}>
                {voiceVolumeMenu.isSelf ? (
                  <>Громкость микрофона: <b>{voiceVolumeMenu.username}</b></>
                ) : (
                  <>Громкость: <b>{voiceVolumeMenu.username}</b></>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 8 }}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={
                    voiceVolumeMenu.isSelf
                      ? Math.round(micInputVolume * 100)
                      : Math.round((voiceVolumeBySocketId[voiceVolumeMenu.userId] ?? voiceVolumeBySocketId[voiceVolumeMenu.socketId] ?? DEFAULT_PARTICIPANT_VOLUME) * 100)
                  }
                  onChange={(event) => {
                    const value = Number(event.target.value) / 100;
                    if (voiceVolumeMenu.isSelf) {
                      void setLocalMicInputVolume(value);
                    } else {
                      setParticipantVolume(voiceVolumeMenu.socketId, value);
                    }
                  }}
                />
                <span style={{ color: "#94a3b8", minWidth: 38, textAlign: "right" }}>
                  {voiceVolumeMenu.isSelf
                    ? `${Math.round(micInputVolume * 100)}%`
                    : `${Math.round((voiceVolumeBySocketId[voiceVolumeMenu.userId] ?? voiceVolumeBySocketId[voiceVolumeMenu.socketId] ?? DEFAULT_PARTICIPANT_VOLUME) * 100)}%`}
                </span>
              </div>
              {!voiceVolumeMenu.isSelf && voiceVolumeMenu.canKickFromVoice ? (
                <button
                  type="button"
                  style={{ width: "100%", textAlign: "left", color: "#fca5a5", marginTop: 8 }}
                  onClick={() => {
                    kickVoiceParticipant(voiceVolumeMenu.userId, voiceVolumeMenu.username);
                    setVoiceVolumeMenu(null);
                  }}
                >
                  Отключить от голосового канала
                </button>
              ) : null}
            </div>
          ) : null}
          {workspaceContextMenu ? (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "fixed",
                top: workspaceContextMenu.y,
                left: workspaceContextMenu.x,
                minWidth: 200,
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 8,
                boxShadow: "0 10px 24px rgba(0, 0, 0, 0.45)",
                padding: 6,
                zIndex: 2000
              }}
            >
              <div style={{ marginBottom: 6, fontSize: 13, color: "#cbd5e1" }}>
                Пространство: <b>{workspaceContextMenu.workspaceName}</b>
              </div>
              {canManageWorkspaceItem(workspaceContextMenu.workspaceRole) ? (
                <button
                  type="button"
                  style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                  onClick={() => {
                    beginInlineWorkspaceRename(workspaceContextMenu.workspaceId, workspaceContextMenu.workspaceName);
                    setWorkspaceContextMenu(null);
                  }}
                >
                  Переименовать пространство
                </button>
              ) : null}
              {workspaceContextMenu.workspaceRole === "owner" ? (
                <button
                  type="button"
                  style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                  onClick={() => {
                    void createWorkspaceInviteLink(workspaceContextMenu.workspaceId);
                    setWorkspaceContextMenu(null);
                  }}
                >
                  Создать ссылку вступления
                </button>
              ) : null}
              {canManageWorkspaceItem(workspaceContextMenu.workspaceRole) ? (
                <>
                  {(["open", "request", "private"] as const).filter((policy) => policy !== workspaceContextMenu.joinPolicy).map((policy) => (
                    <button
                      key={policy}
                      type="button"
                      style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                      onClick={() => {
                        void updateWorkspaceJoinPolicy(workspaceContextMenu.workspaceId, policy);
                        setWorkspaceContextMenu(null);
                      }}
                    >
                      {policy === "open" ? "Сделать открытым" : policy === "request" ? "Сделать по заявке" : "Сделать закрытым"}
                    </button>
                  ))}
                </>
              ) : null}
              <button
                type="button"
                style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                onClick={() => {
                  setWorkspaceBansWorkspaceId(workspaceContextMenu.workspaceId);
                  setWorkspaceContextMenu(null);
                }}
              >
                Чёрный список пространства
              </button>
              {workspaceContextMenu.workspaceRole === "owner" ? (
                <button
                  type="button"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => {
                    void deleteWorkspace(
                      workspaceContextMenu.workspaceId,
                      workspaceContextMenu.workspaceName,
                      workspaceContextMenu.workspaceRole
                    );
                    setWorkspaceContextMenu(null);
                  }}
                >
                  Удалить пространство
                </button>
              ) : null}
            </div>
          ) : null}
          {channelContextMenu ? (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "fixed",
                top: channelContextMenu.y,
                left: channelContextMenu.x,
                minWidth: 180,
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 8,
                boxShadow: "0 10px 24px rgba(0, 0, 0, 0.45)",
                padding: 6,
                zIndex: 2000
              }}
            >
              <div style={{ marginBottom: 6, fontSize: 13, color: "#cbd5e1" }}>
                Канал: <b>{channelContextMenu.channelName}</b>
              </div>
              <button
                type="button"
                style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                onClick={() => {
                  beginInlineChannelRename(channelContextMenu.channelId, channelContextMenu.channelName);
                  setChannelContextMenu(null);
                }}
              >
                Переименовать канал
              </button>
              <button
                type="button"
                style={{ width: "100%", textAlign: "left" }}
                onClick={() => {
                  void deleteChannel(channelContextMenu.channelId, channelContextMenu.channelName);
                  setChannelContextMenu(null);
                }}
              >
                Удалить канал
              </button>
            </div>
          ) : null}

          {replyToMessage ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 8,
                padding: "6px 8px",
                border: "1px solid #334155",
                borderRadius: 6,
                background: "#0b1222"
              }}
            >
              <small style={{ color: "#93c5fd", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Ответ: @{replyToMessage.author.username} —{" "}
                    {getFlatReplyMessageText(replyToMessage.body).slice(0, 90).replace(/\s+/g, " ").trim()}
              </small>
              <button type="button" onClick={() => setReplyToMessage(null)}>
                Отменить
              </button>
            </div>
          ) : null}

          <form
            onSubmit={sendMessage}
            style={{
              display: isMobile ? "grid" : "flex",
              gridTemplateColumns: isMobile ? "40px 40px minmax(0, 1fr)" : undefined,
              gap: 8,
              position: "relative"
            }}
          >
            {isEmojiPickerOpen ? (
              <div
                style={{
                  position: "absolute",
                  bottom: isMobile ? 92 : 42,
                  left: 0,
                  width: 280,
                  maxWidth: "calc(100vw - 24px)",
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  boxShadow: "0 10px 24px rgba(0, 0, 0, 0.45)",
                  padding: 8,
                  zIndex: 2001,
                  display: "grid",
                  gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
                  gap: 6
                }}
              >
                {BASIC_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => appendEmojiToMessage(emoji)}
                    style={{ padding: "4px 0", lineHeight: 1.2, fontSize: 18 }}
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              ref={messageInputRef}
              style={{ flex: 1, minWidth: 0, gridColumn: isMobile ? "1 / -1" : undefined }}
              placeholder={selectedChannelId ? "Напиши сообщение..." : "Сначала выбери канал"}
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
              onPaste={(event) => {
                const attachment = getClipboardAttachment(event.clipboardData);
                if (attachment) {
                  event.preventDefault();
                  setMessageAttachment(attachment);
                }
              }}
              onKeyDown={handleMessageComposerKeyDown}
              disabled={!selectedChannelId}
            />
            <button
              className="gvoice-composer-icon-control"
              type="button"
              onClick={() => setIsEmojiPickerOpen((prev) => !prev)}
              disabled={!selectedChannelId}
              title="Смайлики"
            >
              {emoji(0x1f600)}
            </button>
            <input
              id="message-attachment-input"
              type="file"
              accept="image/*,video/*,audio/*,.pdf,.zip,.rar,.7z,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
              onChange={(event) => setMessageAttachment(event.target.files?.[0] ?? null)}
              disabled={!selectedChannelId}
              style={{ display: "none" }}
            />
            <label
              className="gvoice-composer-icon-control"
              htmlFor="message-attachment-input"
              style={{
                width: 40,
                height: 32,
                borderRadius: 8,
                border: "1px solid #334155",
                display: "grid",
                placeItems: "center",
                background: "#0f172a",
                cursor: selectedChannelId ? "pointer" : "not-allowed",
                opacity: selectedChannelId ? 1 : 0.6
              }}
              title={messageAttachment?.name ? `Файл: ${messageAttachment.name}` : "Прикрепить файл"}
            >
              <span
                aria-hidden="true"
                style={{
                  fontSize: 20,
                  lineHeight: 1,
                  color: messageAttachment ? "#93c5fd" : "#cbd5e1",
                  transform: "translateY(-1px)"
                }}
              >
                {emoji(0x1f4ce)}
              </span>
            </label>
            <button type="submit" disabled={!selectedChannelId || (!messageText.trim() && !messageAttachment)}>
              Отправить
            </button>
          </form>
            </>
          ) : null}
        </section>
      </section>
      ) : activeTab === "dm" ? (
      <section
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "320px minmax(320px, 1fr)",
          gap: 12,
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
          overflow: "hidden"
        }}
      >
        <aside style={{ background: "#111827", borderRadius: 8, padding: 10, border: "1px solid #1f2937", overflowY: "auto", minHeight: 0, display: isMobile && mobileDmPane !== "dialogs" ? "none" : "block" }}>
          <h3 style={{ marginTop: 0 }}>Диалоги</h3>
          <div style={{ display: "grid", gap: 6 }}>
            {sortedDmDialogs.map((dialog) => {
              const partnerIsOnline = isUserOnline(dialog.partner?.id);
              const incomingCall = dmIncomingCallByWorkspaceId[dialog.workspaceId] ?? null;
              const unreadCount = dmUnreadByWorkspaceId[dialog.workspaceId] ?? 0;
              return (
                <button
                  key={dialog.workspaceId}
                  type="button"
                  onClick={() => {
                    setDmSelectedWorkspaceId(dialog.workspaceId);
                    if (isMobile) setMobileDmPane("chat");
                  }}
                  onContextMenu={(event) => {
                    if (dialog.partner) {
                      openUserContextMenu(event, dialog.partner);
                    }
                  }}
                  style={{
                    textAlign: "left",
                    background: dialog.workspaceId === dmSelectedWorkspaceId ? "#1d4ed8" : "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    padding: "8px 10px"
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span
                        title={partnerIsOnline ? "Онлайн" : "Не в сети"}
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: presenceColor(dialog.partner?.id),
                          boxShadow: partnerIsOnline ? "0 0 0 3px rgba(34, 197, 94, 0.16)" : "none",
                          flexShrink: 0
                        }}
                      />
                      <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {dialog.partner?.username ?? "Диалог"}
                      </b>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span
                      role="button"
                      tabIndex={0}
                      title={pinnedDmWorkspaceIdSet.has(dialog.workspaceId) ? "Открепить диалог" : "Закрепить диалог"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleDmPin(dialog.workspaceId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleDmPin(dialog.workspaceId);
                        }
                      }}
                      style={{ color: pinnedDmWorkspaceIdSet.has(dialog.workspaceId) ? "#fbbf24" : "#64748b", cursor: "pointer", fontSize: 15 }}
                    >
                      {pinnedDmWorkspaceIdSet.has(dialog.workspaceId) ? "📌" : "○"}
                    </span>
                    {unreadCount > 0 ? (
                      <span
                        className="gvoice-unread-dot gvoice-unread-dot-warning"
                        title="Есть непрочитанные сообщения"
                        aria-label="Есть непрочитанные сообщения"
                      />
                    ) : null}
                    </span>
                  </span>
                  <small style={{ display: "block", color: "#94a3b8", marginTop: 3 }}>
                    ID: {dialog.partner?.numericId ?? "—"} • {presenceLabel(dialog.partner?.id)}
                  </small>
                  {incomingCall ? (
                    <small style={{ display: "block", color: "#fbbf24", marginTop: 3, fontWeight: 700 }}>
                      Звонит сейчас
                    </small>
                  ) : null}
                </button>
              );
            })}
          </div>
        </aside>

        <section style={{ background: "#111827", borderRadius: 8, padding: 10, border: "1px solid #1f2937", minHeight: 0, display: isMobile && mobileDmPane !== "chat" ? "none" : "grid", gridTemplateRows: isMobile ? "auto auto auto 1fr auto" : "auto auto 1fr auto", gap: 8 }}>
          {dmSelectedWorkspaceId ? (
            <>
          {isMobile ? (
            <button type="button" onClick={() => setMobileDmPane("dialogs")} style={{ justifySelf: "start", paddingInline: 10 }}>
              ← Диалоги
            </button>
          ) : null}
          <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>{selectedDmDialog?.partner?.username ? `ЛС с ${selectedDmDialog.partner.username}` : "Личные сообщения"}</span>
            {selectedDmDialog?.partner ? (
              <small style={{ color: presenceColor(selectedDmDialog.partner.id), fontSize: 12 }}>
                ● {presenceLabel(selectedDmDialog.partner.id)}
              </small>
            ) : null}
          </h3>
          {renderDmVoicePanel()}
          <div style={{ minHeight: 0, overflowY: "auto", border: "1px solid #334155", borderRadius: 8, padding: 8, background: "#0f172a" }}>
            {dmMessages.length === 0 ? <p style={{ color: "#94a3b8" }}>Сообщений пока нет.</p> : null}
            {dmMessages.map((message) => (
              <article className="gvoice-chat-message" key={message.id} style={{ borderBottom: "1px solid #1e293b", padding: "8px 0" }}>
                <span className="gvoice-chat-avatar-host gvoice-chat-avatar-large">
                  {message.author.avatarUrl ? (
                    <img
                      src={toAbsoluteAttachmentUrl(message.author.avatarUrl)}
                      alt={message.author.username}
                      className="gvoice-avatar"
                    />
                  ) : (
                    message.author.username.slice(0, 1).toUpperCase()
                  )}
                </span>
                <div className="gvoice-chat-message-main">
                  <div className="gvoice-chat-message-header">
                    <b className="gvoice-chat-message-author">{message.author.username}</b>
                    <small className="gvoice-chat-message-time">{new Date(message.createdAt).toLocaleString()}</small>
                  </div>
                  <div className="gvoice-chat-copy" style={{ overflowWrap: "anywhere" }}>{renderMessageBody(message.body)}</div>
                  {renderMessageAttachment(message)}
                </div>
              </article>
            ))}
          </div>
          <form onSubmit={sendDmMessage} style={{ display: "grid", gap: 6, minWidth: 0 }}>
            {dmMessageAttachment ? (
              <SelectedAttachmentPreview file={dmMessageAttachment} onRemove={() => setDmMessageAttachment(null)} />
            ) : null}
            <div style={{ display: isMobile ? "grid" : "flex", gridTemplateColumns: isMobile ? "40px 40px minmax(0, 1fr)" : undefined, gap: 8, minWidth: 0 }}>
              <input
                style={{ flex: 1, minWidth: 0, gridColumn: isMobile ? "1 / -1" : undefined }}
                placeholder={dmSelectedTextChannelId ? "Напиши личное сообщение..." : "Сначала выбери диалог"}
                value={dmMessageText}
                onChange={(event) => setDmMessageText(event.target.value)}
                onPaste={(event) => {
                  const attachment = getClipboardAttachment(event.clipboardData);
                  if (attachment) {
                    event.preventDefault();
                    setDmMessageAttachment(attachment);
                  }
                }}
                disabled={!dmSelectedTextChannelId}
              />
              <button className="gvoice-composer-icon-control" type="button" onClick={() => setIsEmojiPickerOpen((prev) => !prev)} disabled={!dmSelectedTextChannelId}>
                {emoji(0x1f600)}
              </button>
              <input
                id="dm-message-attachment-input"
                type="file"
                accept="image/*,video/*,audio/*,.pdf,.zip,.rar,.7z,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                onChange={(event) => setDmMessageAttachment(event.target.files?.[0] ?? null)}
                disabled={!dmSelectedTextChannelId}
                style={{ display: "none" }}
              />
              <label
                className="gvoice-composer-icon-control"
                htmlFor="dm-message-attachment-input"
                title={dmMessageAttachment?.name ? `Файл: ${dmMessageAttachment.name}` : "Прикрепить файл"}
                style={{
                  width: 40,
                  height: 32,
                  borderRadius: 8,
                  border: "1px solid #334155",
                  display: "grid",
                  placeItems: "center",
                  background: "#0f172a",
                  cursor: dmSelectedTextChannelId ? "pointer" : "not-allowed",
                  opacity: dmSelectedTextChannelId ? 1 : 0.6
                }}
              >
                {emoji(0x1f4ce)}
              </label>
              <button type="submit" disabled={!dmSelectedTextChannelId || (!dmMessageText.trim() && !dmMessageAttachment)}>Отправить</button>
            </div>
            {isEmojiPickerOpen ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 10px", border: "1px solid #334155", borderRadius: 8, background: "#0f172a" }}>
                {BASIC_EMOJIS.map((emoji) => (
                  <button
                    key={`dm-${emoji}`}
                    type="button"
                    onClick={() => setDmMessageText((prev) => `${prev}${emoji}`)}
                    style={{ fontSize: 18, lineHeight: 1, padding: "4px 6px", borderRadius: 6, border: "1px solid #334155", background: "#111827" }}
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
          </form>
            </>
          ) : null}
        </section>
      </section>
      ) : (
        <section className="gvoice-news-shell" aria-labelledby="gvoice-news-title" role="tabpanel">
          <p style={{ margin: 0, color: "#60a5fa", letterSpacing: 2, fontSize: 12, fontWeight: 800 }}>ЧТО НОВОГО</p>
          <h2 id="gvoice-news-title" style={{ margin: "10px 0 8px", fontSize: "clamp(28px, 4vw, 42px)", lineHeight: 1.12 }}>Новости GVoice</h2>
          <p style={{ margin: 0, maxWidth: 680, color: "#9fb1ca", lineHeight: 1.65 }}>
            Здесь собраны заметные обновления сервиса и короткие подсказки о возможностях, которые уже доступны в приложении.
          </p>
          <div className="gvoice-news-grid">
            {NEWS_ITEMS.map((item) => (
              <article key={item.title} className="gvoice-news-card" style={{ "--news-accent": item.accent } as import("react").CSSProperties}>
                <div className="gvoice-news-meta">
                  <span className="gvoice-news-label">{item.label}</span>
                  <time>{item.date}</time>
                </div>
                <h3 style={{ margin: "18px 0 9px", color: "#f1f5f9", fontSize: 19 }}>{item.title}</h3>
                <p style={{ margin: 0, color: "#b6c4d8", lineHeight: 1.62 }}>{item.description}</p>
              </article>
            ))}
          </div>
          <div style={{ marginTop: 20, paddingTop: 17, borderTop: "1px solid #263750", color: "#7898c2", fontSize: 12 }}>
            Установленная версия: {APP_BUILD_VERSION}
          </div>
        </section>
      )}
    </main>
  );
}

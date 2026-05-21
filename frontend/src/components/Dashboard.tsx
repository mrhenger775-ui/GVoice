import { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track, type LocalTrackPublication } from "livekit-client";
import Hls from "hls.js";
import type { Socket } from "socket.io-client";
import { io } from "socket.io-client";
import { useAuth } from "../auth/AuthContext";
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
const SCREEN_SHARE_MAX_WIDTH = 1280;
const SCREEN_SHARE_MAX_HEIGHT = 720;
const SCREEN_SHARE_MAX_FPS = 30;
const SCREEN_SHARE_MAX_BITRATE = 3_500_000;
const SCREEN_SHARE_FALLBACK_BITRATE = 2_000_000;
const SCREEN_SHARE_FALLBACK_FPS = 15;
const MOBILE_MEDIA_QUERY = "(max-width: 900px), (pointer: coarse) and (max-width: 1200px)";
const MESSAGE_NOTIFICATION_SOUND_URL = "/sounds/notification%20GVoice.mp3";
const MESSAGE_NOTIFICATION_SOUND_FALLBACK_URL = "/sounds/pressing-a-button-with-sound.mp3";
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
const VOICE_KEYBINDS_STORAGE_KEY = "gvoice.voiceKeybinds";
const BASIC_EMOJIS = ["😀", "😂", "🤣", "😊", "😍", "😎", "🤔", "😭", "😡", "👍", "🙏", "🔥", "❤️", "🎉", "✅", "❌"];
const GVOICE_LOGO_MAIN_URL = "/ui/gvoice-logo-main.png";
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
  toggleMic: "Ctrl+M",
  toggleDeafen: "Ctrl+D",
  toggleScreenShare: "Ctrl+Shift+S",
  pushToTalk: "Alt+V"
};

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

type Workspace = {
  id: string;
  name: string;
  slug: string;
  joinPolicy: "open" | "request";
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
  joinPolicy: "open" | "request";
  isMember: boolean;
  joinRequestStatus?: "pending" | "approved" | "rejected" | null;
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
  x: number;
  y: number;
};

type MemberRoleContextMenuState = {
  memberUserId: string;
  memberUsername: string;
  currentRole: string;
  x: number;
  y: number;
};

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
  joinPolicy: "open" | "request";
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

function isHlsUrl(url: string | null | undefined) {
  return Boolean(url && /\.m3u8(\?|#|$)/i.test(url));
}

export function Dashboard() {
  const { user, logout, refreshProfile, authorizedFetch, getAccessToken } = useAuth();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [mediaSessionByChannelId, setMediaSessionByChannelId] = useState<Record<string, MediaSessionState>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [inviteLinkToken, setInviteLinkToken] = useState<string | null>(null);

  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceJoinPolicy, setWorkspaceJoinPolicy] = useState<"open" | "request">("request");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingWorkspaceName, setEditingWorkspaceName] = useState("");
  const [channelName, setChannelName] = useState("");
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editingChannelName, setEditingChannelName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice">("text");
  const [channelIsPrivate, setChannelIsPrivate] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [messageAttachment, setMessageAttachment] = useState<File | null>(null);
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
  const [memberSearchQuery, setMemberSearchQuery] = useState("");
  const [memberOptions, setMemberOptions] = useState<WorkspaceMember[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [workspaceEditName, setWorkspaceEditName] = useState("");
  const [isProfileEditorOpen, setIsProfileEditorOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"profile" | "security" | "audio" | "keybinds" | "updates">("profile");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileUsername, setProfileUsername] = useState("");
  const [profileCurrentPassword, setProfileCurrentPassword] = useState("");
  const [profileNewPassword, setProfileNewPassword] = useState("");
  const [profileNewPasswordConfirm, setProfileNewPasswordConfirm] = useState("");
  const [profileAvatarFile, setProfileAvatarFile] = useState<File | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [voiceJoinedChannelId, setVoiceJoinedChannelId] = useState<string | null>(null);
  const [voiceParticipants, setVoiceParticipants] = useState<VoiceParticipant[]>([]);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [selfDeafened, setSelfDeafened] = useState(false);
  const [voiceKeybinds, setVoiceKeybinds] = useState<VoiceKeybinds>(() => loadPersistedVoiceKeybinds());
  const [recordingKeybindAction, setRecordingKeybindAction] = useState<VoiceKeybindAction | null>(null);
  const [voiceVolumeBySocketId, setVoiceVolumeBySocketId] = useState<Record<string, number>>(() => loadPersistedVoiceVolumeMap());
  const [micInputVolume, setMicInputVolume] = useState<number>(() => loadPersistedMicInputVolume());
  const [screenShareVolumeByKey, setScreenShareVolumeByKey] = useState<Record<string, number>>({});
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Record<string, MediaStream>>({});
  const [expandedScreenShareKey, setExpandedScreenShareKey] = useState<string | null>(null);
  const [livekitRemoteAudioCount, setLivekitRemoteAudioCount] = useState(0);
  const [joinedScreenSharesByKey, setJoinedScreenSharesByKey] = useState<Record<string, boolean>>({});
  const [remoteScreenPresenterByKey, setRemoteScreenPresenterByKey] = useState<Record<string, string>>({});
  const [livekitStatus, setLivekitStatus] = useState<"idle" | "connecting" | "connected" | "failed">("idle");
  const [livekitError, setLivekitError] = useState<string | null>(null);
  const [nativeVoiceDebugText, setNativeVoiceDebugText] = useState<string | null>(null);
  const [platformDebugText, setPlatformDebugText] = useState<string>("");
  const [noiseMode, setNoiseMode] = useState<NoiseMode>("medium");
  const [settingsNoiseMode, setSettingsNoiseMode] = useState<NoiseMode>("medium");
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
  const livekitConnectPromiseRef = useRef<Promise<Room> | null>(null);
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
  const voiceChannelIdRef = useRef<string | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const voiceVolumeBySocketIdRef = useRef<Record<string, number>>({});
  const micInputVolumeRef = useRef<number>(1);
  const selfDeafenedRef = useRef(false);
  const muteBeforeDeafenRef = useRef(false);
  const pushToTalkHoldingRef = useRef(false);
  const pushToTalkPrevMutedRef = useRef(false);
  const screenShareVolumeByKeyRef = useRef<Record<string, number>>({});
  const joinedScreenSharesByKeyRef = useRef<Record<string, boolean>>({});
  const selectedWorkspaceIdRef = useRef<string | null>(null);
  const selectedChannelIdRef = useRef<string | null>(null);
  const selectedChannelTypeRef = useRef<Channel["type"] | null>(null);
  const currentUserIdRef = useRef<string | null>(null);
  const voicePeersRef = useRef<Map<string, VoicePeer>>(new Map());
  const pendingCandidatesRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const makingOfferRef = useRef<Record<string, boolean>>({});
  const voiceRecoveringRef = useRef(false);
  const uiAudioCtxRef = useRef<AudioContext | null>(null);
  const messageSoundRef = useRef<HTMLAudioElement | null>(null);
  const joinSoundRef = useRef<HTMLAudioElement | null>(null);
  const leaveSoundRef = useRef<HTMLAudioElement | null>(null);
  const screenShareOnSoundRef = useRef<HTMLAudioElement | null>(null);
  const screenShareOffSoundRef = useRef<HTMLAudioElement | null>(null);
  const micOnSoundRef = useRef<HTMLAudioElement | null>(null);
  const micOffSoundRef = useRef<HTMLAudioElement | null>(null);
  const messagesListRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const messageJumpHighlightTimeoutRef = useRef<number | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const hasInitialChatScrollRef = useRef(false);
  const handledInviteTokenRef = useRef<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  );

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  );
  const activeVoiceChannelLabel = useMemo(() => {
    if (!voiceJoinedChannelId) {
      return null;
    }
    const known = channels.find((channel) => channel.id === voiceJoinedChannelId);
    return known ? `# ${known.name}` : "другой канал";
  }, [channels, voiceJoinedChannelId]);
  const canModerateWorkspace = selectedWorkspace?.role === "owner" || selectedWorkspace?.role === "admin";
  const isSelectedWorkspaceOpen = selectedWorkspace?.joinPolicy === "open";
  const canManageWorkspace = canModerateWorkspace;
  const canManageChannels = canManageWorkspace || selectedWorkspace?.role === "moderator";
  const canDeleteForeignMessages = selectedWorkspace?.role === "owner" || selectedWorkspace?.role === "admin" || selectedWorkspace?.role === "moderator";
  const isDesktopRuntime = Boolean(window.gvoiceDesktop);
  const isVoiceChannelSelected = selectedChannel?.type === "voice";
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
    setProfileUsername(user?.username ?? "");
    setProfileEmail(user?.email ?? "");
  }, [user?.username, user?.email]);

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
    selfDeafenedRef.current = selfDeafened;
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
      window.localStorage.setItem(VOICE_KEYBINDS_STORAGE_KEY, JSON.stringify(voiceKeybinds));
    } catch {
      // ignore localStorage failures
    }
  }, [voiceKeybinds]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

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
    selectedChannelIdRef.current = selectedChannelId;
    selectedChannelTypeRef.current = selectedChannel?.type ?? null;
  }, [selectedChannelId, selectedChannel?.type]);

  useEffect(() => {
    if (isProfileEditorOpen) {
      setSettingsNoiseMode(noiseMode);
    }
  }, [isProfileEditorOpen, noiseMode]);

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

  function playUiCue(type: "join" | "leave" | "message" | "screen-on" | "screen-off" | "mic-on" | "mic-off") {
    if (type === "message") {
      if (!messageSoundRef.current) {
        messageSoundRef.current = new Audio(MESSAGE_NOTIFICATION_SOUND_URL);
        messageSoundRef.current.addEventListener("error", () => {
          if (!messageSoundRef.current) {
            return;
          }
          messageSoundRef.current.src = MESSAGE_NOTIFICATION_SOUND_FALLBACK_URL;
        }, { once: true });
        messageSoundRef.current.preload = "auto";
      }
      const sound = messageSoundRef.current;
      sound.volume = 0.25;
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
      }
      const sound = ref.current;
      sound.volume = volume;
      sound.currentTime = 0;
      void sound.play().catch(() => undefined);
      return true;
    };

    if (type === "join") {
      playAudioCue(joinSoundRef, JOIN_NOTIFICATION_SOUND_URL, 0.25);
      return;
    }

    if (type === "leave") {
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
    return {
      toggleMic: typeof parsed.toggleMic === "string" && parsed.toggleMic.trim() ? parsed.toggleMic.trim() : DEFAULT_VOICE_KEYBINDS.toggleMic,
      toggleDeafen:
        typeof parsed.toggleDeafen === "string" && parsed.toggleDeafen.trim()
          ? parsed.toggleDeafen.trim()
          : DEFAULT_VOICE_KEYBINDS.toggleDeafen,
      toggleScreenShare:
        typeof parsed.toggleScreenShare === "string" && parsed.toggleScreenShare.trim()
          ? parsed.toggleScreenShare.trim()
          : DEFAULT_VOICE_KEYBINDS.toggleScreenShare,
      pushToTalk: typeof parsed.pushToTalk === "string" && parsed.pushToTalk.trim() ? parsed.pushToTalk.trim() : DEFAULT_VOICE_KEYBINDS.pushToTalk
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
  const replyPattern = /^↪ Ответ для @([^:]+?)(?: \(id:([^)]+)\))?:\s*(.+?)\n([\s\S]*)$/;
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

  function toAbsoluteAttachmentUrl(url: string) {
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    return new URL(url, API_URL).toString();
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

  function bindLivekitRoomHandlers(room: Room) {
    room.on(RoomEvent.TrackPublished, (publication) => {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        publication.setSubscribed(true);
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio && publication.source === Track.Source.Microphone) {
        const key = `${participant.identity}:${publication.trackSid}`;
        const audio = new Audio();
        audio.autoplay = true;
        audio.volume = voiceVolumeBySocketIdRef.current[participant.identity] ?? DEFAULT_PARTICIPANT_VOLUME;
        audio.muted = selfDeafenedRef.current;
        audio.srcObject = new MediaStream([track.mediaStreamTrack]);
        livekitVoiceAudioElsRef.current.set(key, audio);
        setLivekitRemoteAudioCount(livekitVoiceAudioElsRef.current.size);
        void audio.play().catch(() => undefined);
        return;
      }

      if (track.kind === Track.Kind.Audio && publication.source === Track.Source.ScreenShareAudio) {
        const key = getScreenStreamKey(participant.identity);
        setRemoteScreenPresenterByKey((prev) => ({ ...prev, [key]: participant.name || participant.identity }));
        const audio = new Audio();
        audio.autoplay = false;
        audio.volume = screenShareVolumeByKeyRef.current[key] ?? DEFAULT_PARTICIPANT_VOLUME;
        audio.muted = selfDeafenedRef.current;
        audio.srcObject = new MediaStream([track.mediaStreamTrack]);
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

    room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      const key = getScreenStreamKey(participant.identity);
      if (publication.source === Track.Source.Microphone) {
        const voiceKey = `${participant.identity}:${publication.trackSid}`;
        const audio = livekitVoiceAudioElsRef.current.get(voiceKey);
        if (audio) {
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
  }

  async function connectLivekitRoom(channelId: string) {
    if (livekitRoomRef.current) {
      setLivekitStatus("connected");
      return livekitRoomRef.current;
    }
    if (livekitConnectPromiseRef.current) {
      return livekitConnectPromiseRef.current;
    }

    const connectPromise = (async () => {
    setLivekitStatus("connecting");
    setLivekitError(null);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await authorizedFetch("/voice/livekit-token", {
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
        await room.connect(payload.url, payload.token);
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((publication) => {
            if (
              publication.source === Track.Source.ScreenShare ||
              publication.source === Track.Source.ScreenShareAudio
            ) {
              publication.setSubscribed(true);
            }
          });
        });
        livekitRoomRef.current = room;
        setLivekitStatus("connected");
        setLivekitError(null);
        return room;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error("LiveKit connection failed");
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        }
      }
    }

    setLivekitStatus("failed");
    setLivekitError(lastError?.message ?? "LiveKit connection failed");
    throw lastError ?? new Error("LiveKit connection failed");
    })();
    livekitConnectPromiseRef.current = connectPromise;
    try {
      return await connectPromise;
    } finally {
      livekitConnectPromiseRef.current = null;
    }
  }

  async function disconnectLivekitRoom() {
    for (const publication of localLivekitScreenPublicationsRef.current) {
      publication.track?.stop();
    }
    localLivekitScreenPublicationsRef.current = [];

    const room = livekitRoomRef.current;
    if (!room) {
      return;
    }
    room.disconnect();
    livekitRoomRef.current = null;
    livekitConnectPromiseRef.current = null;
    setLivekitStatus("idle");
    setLivekitError(null);
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

    voiceChannelIdRef.current = null;
    setVoiceJoinedChannelId(null);
    setVoiceParticipants([]);
    setVoiceBusy(false);
    setVoiceMuted(false);
    pushToTalkHoldingRef.current = false;
    pushToTalkPrevMutedRef.current = false;
    setSelfDeafened(false);
    setAllRemoteAudioMuted(false);
    setIsScreenSharing(false);
    setRemoteScreenStreams({});
    setVoiceVolumeBySocketId({});
    void stopAndroidVoiceCallService();
  }

  async function fetchLivekitCredentials(channelId: string): Promise<{ url: string; token: string }> {
    const response = await authorizedFetch("/voice/livekit-token", {
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

  async function connectLivekitMicWeb(channelId: string): Promise<void> {
    const probe = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraintsByNoiseMode(noiseMode),
      video: false
    });
    for (const track of probe.getTracks()) {
      track.stop();
    }

    const room = await connectLivekitRoom(channelId);
    await room.localParticipant.setMicrophoneEnabled(true, getAudioConstraintsByNoiseMode(noiseMode));
    await setLocalMicInputVolume(micInputVolumeRef.current);
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
        currentPeer.audioByTrackId.set(trackId, audio);
      }
      const trackStream = new MediaStream([event.track]);
      audio.volume = voiceVolumeBySocketIdRef.current[target.socketId] ?? DEFAULT_PARTICIPANT_VOLUME;
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

  async function startScreenShare() {
    if (isAndroidNativePlatform()) {
      setError("Демонстрация экрана в Android native-режиме пока отключена.");
      return;
    }
    if (!voiceJoinedChannelId || voiceJoinedChannelId !== selectedChannelId) {
      setError("Сначала войди в голосовой канал");
      return;
    }
    setError(null);

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
            return data[0]?.id ?? null;
          }

          const stillExists = data.some((workspace) => workspace.id === current);
          return stillExists ? current : (data[0]?.id ?? null);
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
        setSelectedChannelId((current) => {
          if (current && data.some((channel) => channel.id === current)) {
            return current;
          }
          return data[0]?.id ?? null;
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
        const shouldScroll = !silent || !hasInitialChatScrollRef.current || isMessagesNearBottom();
        if (silent) {
          setMessages((prev) => mergeMessagesByIdAndTime(prev, fetchedAsc));
        } else {
          setMessages(fetchedAsc);
          const oldest = fetchedAsc[0]?.createdAt ?? null;
          setMessagesCursor(oldest);
          setMessagesHasMore(data.length === pageSize);
        }
        if (shouldScroll) {
          requestAnimationFrame(scrollMessagesToBottom);
        }
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
        if (voiceChannelIdRef.current) {
          setInviteStatus("Связь с сервером прервана. Восстанавливаем голос при возврате...");
        }
      });

      socket.on("chat:message", (message: Message) => {
        const shouldAutoScroll = isMessagesNearBottom();
        const shouldPlaySound =
          message.channelId === selectedChannelIdRef.current &&
          message.author.id !== currentUserIdRef.current;
        setMessages((prev) => {
          if (message.channelId !== selectedChannelIdRef.current) {
            return prev;
          }
          if (prev.some((item) => item.id === message.id)) {
            return prev;
          }
          return [...prev, message];
        });
        if (shouldAutoScroll) {
          requestAnimationFrame(scrollMessagesToBottom);
        }
        if (shouldPlaySound) {
          playUiCue("message");
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
      if (!selectedWorkspaceId || !canModerateWorkspace) {
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
  }, [authorizedFetch, selectedWorkspaceId, canModerateWorkspace]);

  useEffect(() => {
    let mounted = true;

    async function searchMembers() {
      const query = memberSearchQuery.trim();
      if (!selectedWorkspaceId || query.length < 1) {
        setMemberOptions([]);
        return;
      }

      try {
        const response = await authorizedFetch(
          `/workspaces/${selectedWorkspaceId}/members?query=${encodeURIComponent(query)}`
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Не удалось загрузить участников");
        }

        const data = await parseJson<WorkspaceMember[]>(response);
        if (!mounted) {
          return;
        }

        setMemberOptions(data);
      } catch (err) {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : "Ошибка поиска участников");
      }
    }

    void searchMembers();

    return () => {
      mounted = false;
    };
  }, [authorizedFetch, memberSearchQuery, selectedWorkspaceId]);

  
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

  async function createWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      const response = await authorizedFetch("/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: workspaceName, joinPolicy: workspaceJoinPolicy })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось создать пространство");
      }

      const workspace = await parseJson<Workspace>(response);
      setWorkspaces((prev) => [workspace, ...prev]);
      setSelectedWorkspaceId(workspace.id);
      setWorkspaceName("");
      setWorkspaceJoinPolicy("request");
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
        if (settingsNoiseMode !== noiseMode) {
          await updateNoiseMode(settingsNoiseMode);
          setInviteStatus("Настройки звука сохранены.");
        } else {
          setInviteStatus("Режим шумоподавления уже применен. Обновления проверяются отдельной кнопкой ниже.");
        }
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

  async function deleteWorkspace() {
    if (!selectedWorkspaceId || !selectedWorkspace || selectedWorkspace.role !== "owner") {
      setError("Удалить пространство может только владелец.");
      return;
    }

    const ok = window.confirm(`Удалить пространство "${selectedWorkspace.name}"? Это действие необратимо.`);
    if (!ok) {
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось удалить пространство");
      }

      setWorkspaces((prev) => {
        const next = prev.filter((workspace) => workspace.id !== selectedWorkspaceId);
        setSelectedWorkspaceId(next[0]?.id ?? null);
        return next;
      });
      setChannels([]);
      setSelectedChannelId(null);
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

    try {
      const response = await authorizedFetch(`/workspaces/${selectedWorkspaceId}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: channelName, type: channelType, isPrivate: channelIsPrivate })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось создать канал");
      }

      const channel = await parseJson<Channel>(response);
      setChannels((prev) => [...prev, channel]);
      setSelectedChannelId(channel.id);
      setChannelName("");
      setChannelType("text");
      setChannelIsPrivate(false);
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

  async function deleteChannel() {
    if (!selectedChannelId || !selectedWorkspaceId || !canManageChannels) {
      setError("Недостаточно прав для удаления канала.");
      return;
    }

    const target = channels.find((channel) => channel.id === selectedChannelId);
    if (!target) {
      return;
    }

    const ok = window.confirm(`Удалить канал "${target.name}"?`);
    if (!ok) {
      return;
    }

    setError(null);
    try {
      const response = await authorizedFetch(`/channels/${selectedChannelId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось удалить канал");
      }

      setChannels((prev) => {
        const next = prev.filter((channel) => channel.id !== selectedChannelId);
        setSelectedChannelId(next[0]?.id ?? null);
        return next;
      });
      setMessages([]);
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
      ? `↪ Ответ для @${replyToMessage.author.username} (id:${replyToMessage.id}): ${replyToMessage.body
          .slice(0, 120)
          .replace(/\s+/g, " ")
          .trim()}`
      : "";
    const body = replyPrefix ? `${replyPrefix}\n${cleanBody}` : cleanBody;
    if (!messageAttachment && body.startsWith("/")) {
      const [rawCmd, ...args] = body.split(/\s+/);
      const cmd = rawCmd.toLowerCase();
      if (cmd === "/play") {
        const url = args.join(" ").trim();
        if (!url) {
          setError("Используй: /play <ссылка>");
          return;
        }
        setMessageText("");
        sendMediaCommand("play", url);
        setInviteStatus("Media-бот: запуск медиа...");
        return;
      }
      if (cmd === "/pause") {
        setMessageText("");
        sendMediaCommand("pause");
        setInviteStatus("Media-бот: пауза.");
        return;
      }
      if (cmd === "/resume") {
        setMessageText("");
        sendMediaCommand("resume");
        setInviteStatus("Media-бот: продолжить.");
        return;
      }
      if (cmd === "/stop") {
        setMessageText("");
        sendMediaCommand("stop");
        setInviteStatus("Media-бот: остановлено.");
        return;
      }
    }

    setMessageText("");
    const attachment = messageAttachment;
    setMessageAttachment(null);
    setReplyToMessage(null);

    if (socketRef.current && socketRef.current.connected && !attachment) {
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
    const body = editingMessageReplyPrefix ? `${editingMessageReplyPrefix}\n${editedText}` : editedText;
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

  async function inviteUserToChannel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedChannelId || !inviteUsername.trim()) {
      return;
    }

    setError(null);
    setInviteStatus(null);

    try {
      const response = await authorizedFetch(`/channels/${selectedChannelId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: inviteUsername.trim() })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Не удалось пригласить пользователя");
      }

      const payload = await parseJson<{ invitedUser: { username: string }; addedToWorkspace?: boolean }>(response);
      const workspaceNote = payload.addedToWorkspace ? " и добавлен в пространство" : "";
      setInviteStatus(`Пользователь ${payload.invitedUser.username} приглашён в канал${workspaceNote}.`);
      setInviteUsername("");
      setMemberSearchQuery("");
      setMemberOptions([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка приглашения");
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

  async function updateWorkspaceJoinPolicy(workspaceId: string, joinPolicy: "open" | "request") {
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
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload.inviteUrl);
        setInviteStatus("Ссылка приглашения создана и скопирована.");
      } else {
        setInviteStatus(`Ссылка приглашения: ${payload.inviteUrl}`);
      }
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

  async function joinVoice() {
    if (!selectedChannelId || selectedChannel?.type !== "voice" || !socketRef.current?.connected || voiceBusy) {
      return;
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

      voiceChannelIdRef.current = selectedChannelId;
      setVoiceJoinedChannelId(selectedChannelId);
      setVoiceParticipants([]);
      setVoiceMuted(false);
      setSelfDeafened(false);
      setAllRemoteAudioMuted(false);
      socketRef.current.emit("voice:join", { channelId: selectedChannelId });
      if (isAndroidNativePlatform() && isAndroidVoicePluginAvailable()) {
        if (localStreamRef.current) {
          for (const track of localStreamRef.current.getTracks()) {
            track.stop();
          }
          localStreamRef.current = null;
        }
        try {
          const creds = await fetchLivekitCredentials(selectedChannelId);
          await startAndroidVoiceCallService({
            channelName: selectedChannel?.name ?? "Голосовой",
            muted: false,
            screenSharing: false,
            livekitUrl: creds.url,
            livekitToken: creds.token
          });
          setLivekitStatus("connected");
          setLivekitError(null);
        } catch {
          await connectLivekitMicWeb(selectedChannelId);
          setInviteStatus("Native voice недоступен, включён совместимый режим звонка.");
        }
      } else if (isAndroidNativePlatform() && !isAndroidVoicePluginAvailable()) {
        await connectLivekitMicWeb(selectedChannelId);
        setInviteStatus("Установлен APK без native voice plugin, включён совместимый режим звонка.");
      } else {
        try {
          await connectLivekitMicWeb(selectedChannelId);
        } catch (voiceErr) {
          if (isAndroidAppRuntime()) {
            await connectLivekitRoom(selectedChannelId);
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
    leaveVoice(true);
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
        if (currentTrack?.restartTrack) {
          await currentTrack.restartTrack(getAudioConstraintsByNoiseMode(mode));
        } else if (currentTrack?.mediaStreamTrack?.applyConstraints) {
          await currentTrack.mediaStreamTrack.applyConstraints(getAudioConstraintsByNoiseMode(mode));
        }
        await room.localParticipant.setMicrophoneEnabled(false);
        if (shouldBeEnabled) {
          await room.localParticipant.setMicrophoneEnabled(true, getAudioConstraintsByNoiseMode(mode));
          const nextPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
          const nextTrack = nextPublication?.track as
            | { restartTrack?: (constraints?: MediaTrackConstraints) => Promise<void>; mediaStreamTrack?: MediaStreamTrack }
            | undefined;
          if (nextTrack?.restartTrack) {
            await nextTrack.restartTrack(getAudioConstraintsByNoiseMode(mode));
          } else if (nextTrack?.mediaStreamTrack?.applyConstraints) {
            await nextTrack.mediaStreamTrack.applyConstraints(getAudioConstraintsByNoiseMode(mode));
          }
          await setLocalMicInputVolume(micInputVolumeRef.current);
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
    for (const audio of livekitVoiceAudioElsRef.current.values()) {
      audio.muted = muted;
    }
    for (const audio of livekitScreenAudioElsRef.current.values()) {
      audio.muted = muted;
    }
    const screenVideos = document.querySelectorAll<HTMLVideoElement>('video[data-screen-share-video="1"]');
    screenVideos.forEach((video) => {
      video.muted = muted;
    });
  }

  function applyVoiceMute(nextMuted: boolean) {
    if (isAndroidNativePlatform()) {
      setVoiceMuted(nextMuted);
      void updateAndroidVoiceCallService({
        channelName: selectedChannel?.name,
        muted: nextMuted,
        screenSharing: isScreenSharing
      });
      if (socketRef.current?.connected && voiceChannelIdRef.current) {
        socketRef.current.emit("voice:mic-state", {
          channelId: voiceChannelIdRef.current,
          isMuted: nextMuted
        });
      }
      return;
    }

    const stream = localStreamRef.current;
    const room = livekitRoomRef.current;
    if (room) {
      void room.localParticipant.setMicrophoneEnabled(!nextMuted).catch(() => undefined);
    } else if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !nextMuted;
      }
    }
    setVoiceMuted(nextMuted);
    void updateAndroidVoiceCallService({
      channelName: selectedChannel?.name,
      muted: nextMuted,
      screenSharing: isScreenSharing
    });
    if (socketRef.current?.connected && voiceChannelIdRef.current) {
      socketRef.current.emit("voice:mic-state", {
        channelId: voiceChannelIdRef.current,
        isMuted: nextMuted
      });
    }
  }

  function toggleVoiceMute() {
    applyVoiceMute(!voiceMuted);
  }

  function toggleSelfDeafen() {
    const next = !selfDeafenedRef.current;
    if (next) {
      muteBeforeDeafenRef.current = voiceMuted;
      applyVoiceMute(true);
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
    if (isDesktopRuntime) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (recordingKeybindAction) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable) {
          return;
        }
      }
      const combo = formatKeyComboFromKeyboardEvent(event);
      if (!combo) {
        return;
      }
      const matched = (Object.entries(voiceKeybinds) as Array<[VoiceKeybindAction, string]>).find(
        ([, value]) => value === combo
      );
      if (!matched) {
        return;
      }
      event.preventDefault();
      if (matched[0] === "pushToTalk") {
        if (!voiceJoinedChannelId || pushToTalkHoldingRef.current) {
          return;
        }
        pushToTalkHoldingRef.current = true;
        pushToTalkPrevMutedRef.current = voiceMuted;
        applyVoiceMute(false);
        return;
      }
      runVoiceKeybindAction(matched[0]);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (recordingKeybindAction) {
        return;
      }
      if (!pushToTalkHoldingRef.current) {
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
      pushToTalkHoldingRef.current = false;
      applyVoiceMute(pushToTalkPrevMutedRef.current);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [voiceKeybinds, voiceJoinedChannelId, recordingKeybindAction, voiceMuted, selfDeafened, isScreenSharing, livekitStatus, isDesktopRuntime]);

  useEffect(() => {
    if (!isDesktopRuntime || !window.gvoiceDesktop?.setGlobalHotkeys) {
      return;
    }
    void window.gvoiceDesktop.setGlobalHotkeys({
      toggleMic: voiceKeybinds.toggleMic,
      toggleDeafen: voiceKeybinds.toggleDeafen,
      toggleScreenShare: voiceKeybinds.toggleScreenShare,
      pushToTalk: voiceKeybinds.pushToTalk
    });
  }, [isDesktopRuntime, voiceKeybinds]);

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
      if (!voiceJoinedChannelId) {
        return;
      }
      if (payload?.down) {
        if (pushToTalkHoldingRef.current) {
          return;
        }
        pushToTalkHoldingRef.current = true;
        pushToTalkPrevMutedRef.current = voiceMuted;
        applyVoiceMute(false);
        return;
      }
      if (!pushToTalkHoldingRef.current) {
        return;
      }
      pushToTalkHoldingRef.current = false;
      applyVoiceMute(pushToTalkPrevMutedRef.current);
    });
    return () => {
      if (typeof unsub === "function") {
        unsub();
      }
    };
  }, [isDesktopRuntime, voiceJoinedChannelId, voiceMuted]);

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
        await room.localParticipant.setMicrophoneEnabled(!voiceMuted);
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
    const normalized = Math.min(1, Math.max(0, volume));
    const participant = voiceParticipants.find((item) => item.socketId === socketId);
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
    const normalized = Math.min(1, Math.max(0, volume));
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
    const normalized = Math.min(1, Math.max(0, volume));
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
      audio.volume = screenShareVolumeByKeyRef.current[streamKey] ?? DEFAULT_PARTICIPANT_VOLUME;
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
    await startScreenShare();
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
    setVoiceVolumeMenu({
      socketId: participant.socketId,
      userId: participant.userId,
      username: participant.username,
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

  function openMemberRoleMenu(event: React.MouseEvent, member: WorkspaceMember) {
    const isSelf = member.id === user?.id;
    const canEditRole = canManageWorkspace && !isSelf && member.role !== "owner";
    if (!canEditRole) {
      return;
    }
    event.preventDefault();
    const menuWidth = 190;
    const menuHeight = 130;
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8));
    setMemberRoleMenu({
      memberUserId: member.id,
      memberUsername: member.username,
      currentRole: member.role,
      x,
      y
    });
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
    if (!canManageWorkspaceItem(workspace.role)) {
      return;
    }
    event.preventDefault();
    const menuWidth = 210;
    const menuHeight = workspace.role === "owner" ? 212 : 134;
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

  return (
    <main
      className="gvoice-dark"
      style={{
        margin: 0,
        fontFamily: "Segoe UI, sans-serif",
        background: "#0b1020",
        color: "#e5e7eb",
        height: "100vh",
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
          border: 1px solid #334155;
          border-radius: 6px;
        }
        .gvoice-dark input::placeholder {
          color: #94a3b8;
        }
        .gvoice-dark button {
          cursor: pointer;
        }
        .gvoice-dark button:hover:not(:disabled) {
          background: #1e293b;
        }
        .gvoice-dark button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .gvoice-avatar {
          transition: transform 0.16s ease;
          transform-origin: center center;
          position: relative;
          z-index: 1;
        }
        .gvoice-member-avatar:hover {
          transform: scale(4.4);
          z-index: 20;
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
      <header
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          justifyContent: "space-between",
          alignItems: isMobile ? "stretch" : "flex-start",
          gap: isMobile ? 8 : 10,
          marginBottom: 8
        }}
      >
        <div>
          <img
            src={GVOICE_LOGO_MAIN_URL}
            alt="GVoice"
            style={{ display: "block", height: isMobile ? 58 : 88, width: "auto", maxWidth: "100%", objectFit: "contain" }}
          />
        </div>
        <div style={{ display: "grid", justifyItems: isMobile ? "stretch" : "end", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: isMobile ? "flex-start" : "flex-end" }}>
            {voiceJoinedChannelId ? (
              <span
                style={{
                  fontSize: 12,
                  color: "#86efac",
                  border: "1px solid #14532d",
                  background: "#052e16",
                  borderRadius: 999,
                  padding: "4px 8px",
                  whiteSpace: "nowrap"
                }}
              >
                В звонке: {activeVoiceChannelLabel}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setSettingsTab("profile");
                setIsProfileEditorOpen(true);
              }}
            >
              Настройки
            </button>
            <button type="button" onClick={() => void logout()}>Выйти</button>
            <small style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>build: {APP_BUILD_VERSION}</small>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: isMobile ? "flex-start" : "flex-end" }}>
            {user?.avatarUrl ? (
              <img
                src={toAbsoluteAttachmentUrl(user.avatarUrl)}
                alt="avatar"
                className="gvoice-avatar"
                style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", border: "1px solid #334155" }}
              />
            ) : null}
            <p style={{ margin: 0, color: "#94a3b8", fontSize: 14 }}>
              Пользователь: {user?.username}
              {typeof user?.numericId === "number" ? ` • ID: ${user.numericId}` : ""}
            </p>
          </div>
        </div>
      </header>

      {error ? <p style={{ color: "#f87171" }}>{error}</p> : null}
      {inviteStatus ? <p style={{ color: "#4ade80" }}>{inviteStatus}</p> : null}
      {isProfileEditorOpen ? (
        <div
          onClick={() => setIsProfileEditorOpen(false)}
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
              <h3 style={{ margin: 0 }}>Настройки</h3>
              <button type="button" onClick={() => setIsProfileEditorOpen(false)}>Закрыть</button>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button type="button" onClick={() => setSettingsTab("profile")} style={{ background: settingsTab === "profile" ? "#1d4ed8" : "#0f172a" }}>
                Профиль
              </button>
              <button type="button" onClick={() => setSettingsTab("security")} style={{ background: settingsTab === "security" ? "#1d4ed8" : "#0f172a" }}>
                Безопасность
              </button>
              <button type="button" onClick={() => setSettingsTab("audio")} style={{ background: settingsTab === "audio" ? "#1d4ed8" : "#0f172a" }}>
                Звук и микрофон
              </button>
              <button type="button" onClick={() => setSettingsTab("keybinds")} style={{ background: settingsTab === "keybinds" ? "#1d4ed8" : "#0f172a" }}>
                Бинды
              </button>
              {isDesktopRuntime ? (
                <button type="button" onClick={() => setSettingsTab("updates")} style={{ background: settingsTab === "updates" ? "#1d4ed8" : "#0f172a" }}>
                  Обновления
                </button>
              ) : null}
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
                    minLength={3}
                    maxLength={24}
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
              ) : settingsTab === "keybinds" ? (
                <>
                  <small style={{ color: "#94a3b8" }}>
                    Нажмите «Изменить», затем желаемое сочетание клавиш.
                  </small>
                  {(["toggleMic", "toggleDeafen", "toggleScreenShare", "pushToTalk"] as VoiceKeybindAction[]).map((action) => {
                    const label =
                      action === "toggleMic"
                        ? "Микрофон вкл/выкл"
                        : action === "toggleDeafen"
                          ? "Оглушить себя (микрофон + наушники)"
                          : action === "toggleScreenShare"
                            ? "Показ экрана вкл/выкл"
                            : "Push-to-Talk (удерживать)";
                    return (
                      <div
                        key={action}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(180px, 1fr) minmax(120px, 160px) auto",
                          gap: 8,
                          alignItems: "center"
                        }}
                      >
                        <span style={{ color: "#cbd5e1", fontSize: 13 }}>{label}</span>
                        <input
                          value={recordingKeybindAction === action ? "Нажмите клавиши..." : voiceKeybinds[action]}
                          readOnly
                          style={{ textAlign: "center" }}
                        />
                        <button
                          type="button"
                          onClick={() => setRecordingKeybindAction((prev) => (prev === action ? null : action))}
                        >
                          {recordingKeybindAction === action ? "Отмена" : "Изменить"}
                        </button>
                      </div>
                    );
                  })}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setVoiceKeybinds(DEFAULT_VOICE_KEYBINDS);
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
        <aside style={{ background: "#111827", borderRadius: 8, padding: 10, border: "1px solid #1f2937", overflowY: "visible", minHeight: 0 }}>
          <h3 style={{ marginTop: 0 }}>Пространства</h3>
          <form onSubmit={createWorkspace} style={{ display: "grid", gap: 6, marginBottom: 10 }}>
            <input
              placeholder="Название"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              required
            />
            <select
              value={workspaceJoinPolicy}
              onChange={(event) => setWorkspaceJoinPolicy(event.target.value as "open" | "request")}
            >
              <option value="request">По заявке</option>
              <option value="open">Открытое</option>
            </select>
            <button type="submit">Создать</button>
          </form>

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
                    padding: "6px 8px"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <b>{item.name}</b>
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
                  <small style={{ color: "#94a3b8" }}>
                    ID: {formatWorkspaceId(item.slug)} • владелец: {item.ownerUsername} {item.isMember ? "" : "• нет доступа"}
                  </small>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>
                    Режим вступления: {item.joinPolicy === "open" ? "открытое" : "по заявке"}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {loading ? <p>Загрузка...</p> : null}

          <div style={{ display: "grid", gap: 6 }}>
            {workspaces.map((workspace) => {
              const isEditing = editingWorkspaceId === workspace.id;
              const canEditThisWorkspace = canManageWorkspaceItem(workspace.role);
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                  onMouseDown={(event) => {
                    if (event.button === 2) {
                      event.preventDefault();
                    }
                  }}
                  onContextMenu={(event) => {
                    if (!canEditThisWorkspace) {
                      return;
                    }
                    openWorkspaceContextMenu(event, workspace);
                  }}
                  style={{
                    textAlign: "left",
                    background: workspace.id === selectedWorkspaceId ? "#1d4ed8" : "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    padding: "8px 10px"
                  }}
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingWorkspaceName}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setEditingWorkspaceName(event.target.value)}
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
                    <div>{workspace.name}</div>
                  )}
                  <small style={{ color: "#94a3b8" }}>
                    ID: {formatWorkspaceId(workspace.slug)} • {roleLabel(workspace.role)} •{" "}
                    {workspace.joinPolicy === "open" ? "Открытое" : "По заявке"}
                  </small>
                </button>
              );
            })}
          </div>

        </aside>

        <aside style={{ background: "#111827", borderRadius: 8, padding: 10, border: "1px solid #1f2937", overflowY: "auto", minHeight: 0 }}>
          <h3 style={{ marginTop: 0 }}>Каналы</h3>
          <p style={{ marginTop: 0, color: "#94a3b8" }}>{selectedWorkspace?.name ?? "Выбери пространство"}</p>

          <form onSubmit={createChannel} style={{ display: "grid", gap: 6, marginBottom: 10 }}>
            <input
              placeholder="Название канала"
              value={channelName}
              onChange={(event) => setChannelName(event.target.value)}
              required
              disabled={!selectedWorkspaceId || !canManageChannels}
            />
            <select
              value={channelType}
              onChange={(event) => setChannelType(event.target.value as "text" | "voice")}
              disabled={!selectedWorkspaceId || !canManageChannels}
            >
              <option value="text">Текстовый</option>
              <option value="voice">Голосовой</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={channelIsPrivate}
                onChange={(event) => setChannelIsPrivate(event.target.checked)}
                disabled={!selectedWorkspaceId || !canManageChannels}
              />
              Приватный канал (доступ только по приглашению)
            </label>
            <button type="submit" disabled={!selectedWorkspaceId || !canManageChannels}>
              {channelType === "voice" ? "Создать голосовой канал" : "Создать текстовый канал"}
            </button>
          </form>
          {!canManageChannels && selectedWorkspaceId ? (
            <small style={{ color: "#94a3b8", display: "block", marginBottom: 10 }}>
              Каналы может создавать только владелец, админ или модератор пространства.
            </small>
          ) : null}

          <div style={{ display: "grid", gap: 6 }}>
            {channels.map((channel) => {
              const isEditing = editingChannelId === channel.id;
              return (
              <button
                key={channel.id}
                type="button"
                onClick={() => setSelectedChannelId(channel.id)}
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
                  <div># {channel.name}</div>
                )}
                <small style={{ color: "#94a3b8" }}>{channelTypeLabel(channel.type)}{channel.isPrivate ? " • приватный" : ""}</small>
              </button>
              );
            })}
          </div>

          {canModerateWorkspace && !isSelectedWorkspaceOpen ? (
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
                    maxHeight: isMobile ? 280 : 340,
                    overflowY: "auto",
                    paddingRight: 2
                  }}
                >
                  {workspaceMembers.map((member) => {
                    const isSelf = member.id === user?.id;
                    const canEditRole = !isSelf && member.role !== "owner";
                    return (
                      <div
                        key={member.id}
                        onContextMenu={(event) => openMemberRoleMenu(event, member)}
                        style={{
                          background: "#0f172a",
                          border: "1px solid #334155",
                          borderRadius: 6,
                          padding: "8px 10px",
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) minmax(90px, 120px)",
                          alignItems: "center",
                          gap: 8
                        }}
                      >
                        <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            {member.avatarUrl ? (
                              <img
                                src={toAbsoluteAttachmentUrl(member.avatarUrl)}
                                alt={member.username}
                                className="gvoice-avatar gvoice-member-avatar"
                                style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", border: "1px solid #334155" }}
                              />
                            ) : null}
                            <b>{member.username}</b>
                          </div>
                          <small style={{ color: "#64748b" }}>ID: {typeof member.numericId === "number" ? member.numericId : "—"}</small>
                          <small style={{ color: "#94a3b8" }}>{roleLabel(member.role)}</small>
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
        </aside>

        <section
          style={{
            background: "#111827",
            border: "1px solid #1f2937",
            borderRadius: 8,
            padding: 10,
            minHeight: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column"
          }}
        >
          <h3 style={{ marginTop: 0 }}>
            {selectedChannel ? `# ${selectedChannel.name}` : "Выбери канал"}
          </h3>

          {isVoiceChannelSelected ? (
            <div style={{ border: "1px solid #334155", borderRadius: 6, padding: 8, marginBottom: 10, background: "#0f172a" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <b>Голосовой звонок</b>
                  <div style={{ color: "#94a3b8", fontSize: 13 }}>
                    {voiceJoinedChannelId === selectedChannelId ? "Вы в звонке" : "Вы не в звонке"}
                  </div>
                <div style={{ color: livekitStatus === "failed" ? "#fca5a5" : "#94a3b8", fontSize: 12 }}>
                  LiveKit: {livekitStatus}
                  {livekitError ? ` (${livekitError})` : ""}
                </div>
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
                          {!joined ? (
                            <button type="button" onClick={() => joinScreenShareStream(socketId)}>
                              Присоединиться
                            </button>
                          ) : (
                            <button type="button" onClick={() => leaveScreenShareStream(socketId)}>
                              Отсоединиться
                            </button>
                          )}
                        </div>
                        {joined ? (
                          <>
                            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                              <button type="button" onClick={() => void openScreenShareFullscreen(socketId)}>
                                Во весь экран
                              </button>
                            </div>
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
          ) : null}

          <form
            onSubmit={inviteUserToChannel}
            style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, marginBottom: 10 }}
          >
            <input
              list="workspace-members"
              placeholder="Пригласить в канал (username)"
              value={inviteUsername}
              onChange={(event) => {
                setInviteUsername(event.target.value);
                setMemberSearchQuery(event.target.value);
              }}
              disabled={!selectedChannelId || !selectedWorkspaceId}
            />
            <datalist id="workspace-members">
              {memberOptions.map((member) => (
                <option key={member.id} value={member.username}>
                  {member.username} ({roleLabel(member.role)})
                </option>
              ))}
            </datalist>
            <button type="submit" disabled={!selectedChannelId || !inviteUsername.trim()}>
              Пригласить
            </button>
          </form>

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

          <div
            ref={messagesListRef}
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
                <div>
                  <span className="gvoice-chat-avatar-host" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {message.author.avatarUrl ? (
                      <img
                        src={toAbsoluteAttachmentUrl(message.author.avatarUrl)}
                        alt={message.author.username}
                        className="gvoice-avatar"
                        style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover", border: "1px solid #334155" }}
                      />
                    ) : null}
                    <b>{message.author.username}</b>
                  </span>
                  <small style={{ color: "#94a3b8", marginLeft: 8 }}>{new Date(message.createdAt).toLocaleString()}</small>
                  {message.editedAt ? <small style={{ color: "#94a3b8", marginLeft: 8 }}>(изменено)</small> : null}
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
                        return <div style={{ overflowWrap: "anywhere" }}>{renderMessageBody(message.body)}</div>;
                      }
                      return (
                        <div style={{ display: "grid", gap: 6 }}>
                          <div
                            onClick={() => {
                              if (replyPayload.replyMessageId) {
                                jumpToMessage(replyPayload.replyMessageId);
                              }
                            }}
                            title={
                              replyPayload.replyMessageId
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
                              cursor: replyPayload.replyMessageId ? "pointer" : "default"
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
                              {replyPayload.replySnippet}
                            </small>
                          </div>
                          <div style={{ overflowWrap: "anywhere" }}>{renderMessageBody(replyPayload.messageText)}</div>
                        </div>
                      );
                    })()}
                    {message.attachmentUrl ? (
                      <div style={{ marginTop: 8 }}>
                        {isImageAttachment(message.attachmentMime, message.attachmentName, message.attachmentUrl) ? (
                          <a href={toAbsoluteAttachmentUrl(message.attachmentUrl)} target="_blank" rel="noopener noreferrer">
                            <img
                              src={toAbsoluteAttachmentUrl(message.attachmentUrl)}
                              alt={message.attachmentName ?? "image"}
                              style={{ maxWidth: "100%", maxHeight: 240, borderRadius: 8, border: "1px solid #334155" }}
                            />
                          </a>
                        ) : isVideoAttachment(message.attachmentMime, message.attachmentName, message.attachmentUrl) ? (
                          <video
                            controls
                            preload="metadata"
                            src={toAbsoluteAttachmentUrl(message.attachmentUrl)}
                            style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, border: "1px solid #334155", background: "#000" }}
                          />
                        ) : isAudioAttachment(message.attachmentMime, message.attachmentName, message.attachmentUrl) ? (
                          <audio
                            controls
                            preload="metadata"
                            src={toAbsoluteAttachmentUrl(message.attachmentUrl)}
                            style={{ width: "100%", maxWidth: 420 }}
                          />
                        ) : (
                          <a
                            href={toAbsoluteAttachmentUrl(message.attachmentUrl)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#93c5fd" }}
                          >
                            📎 {message.attachmentName ?? "Скачать файл"}
                          </a>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
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
                      setEditingMessageReplyPrefix(newlineIndex >= 0 ? target.body.slice(0, newlineIndex) : null);
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
            </div>
          ) : null}
          {memberRoleMenu ? (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "fixed",
                top: memberRoleMenu.y,
                left: memberRoleMenu.x,
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
                Роль: <b>{memberRoleMenu.memberUsername}</b>
              </div>
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
              <button
                type="button"
                style={{ width: "100%", textAlign: "left", marginBottom: workspaceContextMenu.workspaceRole === "owner" ? 4 : 0 }}
                onClick={() => {
                  void updateWorkspaceJoinPolicy(
                    workspaceContextMenu.workspaceId,
                    workspaceContextMenu.joinPolicy === "open" ? "request" : "open"
                  );
                  setWorkspaceContextMenu(null);
                }}
              >
                {workspaceContextMenu.joinPolicy === "open"
                  ? "Сделать вступление по заявке"
                  : "Сделать пространство открытым"}
              </button>
              {workspaceContextMenu.workspaceRole === "owner" ? (
                <button
                  type="button"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => {
                    void deleteWorkspace();
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
                  void deleteChannel();
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
                Ответ: @{replyToMessage.author.username} — {replyToMessage.body.slice(0, 90).replace(/\s+/g, " ").trim()}
              </small>
              <button type="button" onClick={() => setReplyToMessage(null)}>
                Отменить
              </button>
            </div>
          ) : null}

          <form
            onSubmit={sendMessage}
            style={{
              display: "flex",
              flexDirection: isMobile ? "column" : "row",
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
              style={{ flex: 1 }}
              placeholder={selectedChannelId ? "Напиши сообщение..." : "Сначала выбери канал"}
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
              onKeyDown={handleMessageComposerKeyDown}
              disabled={!selectedChannelId}
            />
            <button
              type="button"
              onClick={() => setIsEmojiPickerOpen((prev) => !prev)}
              disabled={!selectedChannelId}
              title="Смайлики"
              style={{ width: 40, height: 32, padding: 0 }}
            >
              😀
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
                  fontSize: 18,
                  lineHeight: 1,
                  color: messageAttachment ? "#93c5fd" : "#cbd5e1",
                  transform: "translateY(-1px)"
                }}
              >
                📎
              </span>
            </label>
            <button type="submit" disabled={!selectedChannelId || (!messageText.trim() && !messageAttachment)}>
              Отправить
            </button>
          </form>
        </section>
      </section>
    </main>
  );
}
















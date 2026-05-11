import { Capacitor, registerPlugin } from "@capacitor/core";

type VoiceCallPlugin = {
  startCall(options: {
    channelName: string;
    muted: boolean;
    screenSharing: boolean;
    livekitUrl: string;
    livekitToken: string;
  }): Promise<{ ok: boolean }>;
  updateCall(options: { channelName?: string; muted: boolean; screenSharing: boolean }): Promise<{ ok: boolean }>;
  stopCall(): Promise<{ ok: boolean }>;
  getDebugState(): Promise<Record<string, unknown>>;
};

const VoiceCall = registerPlugin<VoiceCallPlugin>("VoiceCall");

export function isAndroidNativePlatform(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isNativePlatform();
}

export function isAndroidAppRuntime(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isNativePlatform();
}

export function isAndroidVoicePluginAvailable(): boolean {
  if (!isAndroidNativePlatform()) {
    return false;
  }
  return Capacitor.isPluginAvailable("VoiceCall");
}

export async function startAndroidVoiceCallService(params: {
  channelName: string;
  muted: boolean;
  screenSharing: boolean;
  livekitUrl: string;
  livekitToken: string;
}): Promise<void> {
  if (!isAndroidNativePlatform()) {
    return;
  }
  await VoiceCall.startCall(params);
}

export async function updateAndroidVoiceCallService(params: {
  channelName?: string;
  muted: boolean;
  screenSharing: boolean;
}): Promise<void> {
  if (!isAndroidNativePlatform()) {
    return;
  }
  await VoiceCall.updateCall(params);
}

export async function stopAndroidVoiceCallService(): Promise<void> {
  if (!isAndroidNativePlatform()) {
    return;
  }
  await VoiceCall.stopCall();
}

export async function getAndroidVoiceDebugState(): Promise<Record<string, unknown> | null> {
  if (!isAndroidNativePlatform()) {
    return null;
  }
  return VoiceCall.getDebugState();
}

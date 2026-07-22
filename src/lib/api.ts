import { invoke } from "@tauri-apps/api/core";

export type Provider = "S3" | "Spaces";

export interface UploadSettings {
  provider: Provider;
  bucket: string;
  region: string;
  endpoint: string | null;
  customDomain: string | null;
  keyPrefix: string | null;
  filenamePrefix: string | null;
}

export function getUploadSettings(): Promise<UploadSettings> {
  return invoke<UploadSettings>("get_upload_settings");
}

export function saveUploadSettings(settings: UploadSettings): Promise<void> {
  return invoke("save_upload_settings", { settings });
}

export function saveCredentials(
  accessKeyId: string,
  secretAccessKey: string,
): Promise<void> {
  return invoke("save_credentials", {
    accessKeyId,
    secretAccessKey,
  });
}

export function hasCredentials(): Promise<boolean> {
  return invoke("has_credentials");
}

export interface HotkeySettings {
  captureArea: string;
  captureFull: string;
  recordArea: string;
  recordFull: string;
}

export function getHotkeySettings(): Promise<HotkeySettings> {
  return invoke<HotkeySettings>("get_hotkey_settings");
}

export function saveHotkeySettings(hotkeys: HotkeySettings): Promise<void> {
  return invoke("save_hotkey_settings", { hotkeys });
}

export function uploadFile(bytes: Uint8Array, extension: string): Promise<string> {
  return invoke("upload_file", { bytes: Array.from(bytes), extension });
}

export function showOverlayForRecording(area: boolean): Promise<void> {
  return invoke("show_overlay_for_recording", { area });
}

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

export function showOverlayForRecording(): Promise<void> {
  return invoke("show_overlay_for_recording");
}

export function trimAndUpload(inputPath: string, inPoint: number, outPoint: number): Promise<string> {
  return invoke("trim_and_upload", { inputPath, inPoint, outPoint });
}

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function startRecording(region: CaptureRegion, micEnabled: boolean): Promise<string> {
  return invoke("start_recording_command", { region, micEnabled });
}

export type LastCapture =
  | { kind: "image"; pngBase64: string }
  | { kind: "video"; path: string };

export function getLastCapture(): Promise<LastCapture | null> {
  return invoke("get_last_capture");
}

export function readVideoBase64(path: string): Promise<string> {
  return invoke("read_video_base64", { path });
}

export interface CaptureHistoryEntry {
  id: string;
  kind: "image" | "video";
  url: string;
  thumbnail: string;
  timestampMs: number;
}

export function recordCaptureHistory(kind: "image" | "video", url: string, thumbnail: string): Promise<void> {
  return invoke("record_capture_history", { kind, url, thumbnail });
}

export function getCaptureHistory(): Promise<CaptureHistoryEntry[]> {
  return invoke("get_capture_history");
}

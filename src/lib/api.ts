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
  return invoke("get_upload_settings");
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

import type Konva from "konva";

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const marker = ";base64,";
  const idx = dataUrl.indexOf(marker);
  if (idx === -1) {
    throw new Error("expected a base64-encoded data URL");
  }
  const base64 = dataUrl.slice(idx + marker.length);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

// pixelRatio compensates for the Stage possibly being displayed smaller than
// the source image (fit-to-panel scaling, like `object-fit: contain`) —
// Konva's toDataURL exports at the Stage's current on-screen size by
// default, so without this the uploaded PNG would be a downscaled copy of
// what's actually on screen. Pass 1 / displayScale to get back full
// native resolution regardless of how small the panel is showing it.
export function exportStageToBytes(stage: Konva.Stage, pixelRatio = 1): Uint8Array {
  const dataUrl = stage.toDataURL({ mimeType: "image/png", pixelRatio });
  return dataUrlToBytes(dataUrl);
}

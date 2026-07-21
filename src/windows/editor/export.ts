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

export function exportStageToBytes(stage: Konva.Stage): Uint8Array {
  const dataUrl = stage.toDataURL({ mimeType: "image/png" });
  return dataUrlToBytes(dataUrl);
}

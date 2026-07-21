import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type Konva from "konva";
import AnnotationCanvas from "./AnnotationCanvas";
import Toolbar from "./Toolbar";
import { exportStageToBytes } from "./export";
import { uploadFile } from "../../lib/api";
import { applyCrop, initialState, setTool, type EditorState } from "./toolState";

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [state, setState] = useState<EditorState>(initialState);
  const [color, setColor] = useState("#ff0000");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<Konva.Stage>(null);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-image", (event) => {
      setImageSrc(`data:image/png;base64,${event.payload}`);
      setState(initialState);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function handleApplyCrop() {
    const cropShape = state.shapes.find((s) => s.type === "crop");
    if (!cropShape || !("width" in cropShape) || !imageSrc) return;
    const { x, y, width, height } = cropShape;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.abs(width);
      canvas.height = Math.abs(height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, -Math.min(x, x + width), -Math.min(y, y + height));
      setImageSrc(canvas.toDataURL("image/png"));
      setState(
        applyCrop(state, {
          x: Math.min(x, x + width),
          y: Math.min(y, y + height),
          width: Math.abs(width),
          height: Math.abs(height),
        }),
      );
    };
    img.src = imageSrc;
  }

  async function handleSaveAndUpload() {
    if (!stageRef.current) return;
    setUploading(true);
    setError(null);
    // Any unapplied crop selection is an uncommitted UI overlay, not a real
    // annotation — hide it on the stage before exporting so it isn't baked
    // into the uploaded PNG, then restore it in case the upload fails.
    const cropNodes = stageRef.current.find(".crop-shape");
    cropNodes.forEach((node) => {
      node.hide();
    });
    stageRef.current.batchDraw();
    try {
      const bytes = exportStageToBytes(stageRef.current);
      const url = await uploadFile(bytes, "png");
      await writeText(url);
      await sendNotification({ title: "pxl", body: `Uploaded — link copied to clipboard\n${url}` });
      await getCurrentWindow().hide();
    } catch (e) {
      setError(String(e));
    } finally {
      cropNodes.forEach((node) => {
        node.show();
      });
      stageRef.current.batchDraw();
      setUploading(false);
    }
  }

  if (!imageSrc) {
    return <div style={{ padding: 16 }}>Waiting for capture…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar
        tool={state.tool}
        color={color}
        strokeWidth={strokeWidth}
        onToolChange={(t) => setState(setTool(state, t))}
        onColorChange={setColor}
        onStrokeWidthChange={setStrokeWidth}
      />
      <button type="button" onClick={handleSaveAndUpload} disabled={uploading}>
        {uploading ? "Uploading…" : "Save & Upload"}
      </button>
      {error && (
        <div style={{ color: "red", padding: 8 }}>
          {error} <button type="button" onClick={handleSaveAndUpload}>Retry</button>
        </div>
      )}
      {state.shapes.some((s) => s.type === "crop") && (
        <button type="button" onClick={handleApplyCrop}>Apply Crop</button>
      )}
      <div id="editor-canvas-container" style={{ flex: 1, overflow: "auto" }}>
        <AnnotationCanvas
          ref={stageRef}
          imageSrc={imageSrc}
          state={state}
          color={color}
          strokeWidth={strokeWidth}
          onStateChange={setState}
        />
      </div>
    </div>
  );
}

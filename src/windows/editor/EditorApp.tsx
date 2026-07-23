import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type Konva from "konva";
import AnnotationCanvas from "./AnnotationCanvas";
import Toolbar from "./Toolbar";
import { exportStageToBytes } from "./export";
import { uploadFile, trimAndUpload } from "../../lib/api";
import { applyCrop, initialState, setTool, type EditorState } from "./toolState";
import VideoTrimmer from "./VideoTrimmer";
import { initialTrimState, type TrimState } from "./trimState";

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [trim, setTrim] = useState<TrimState>(initialTrimState(0));
  const [state, setState] = useState<EditorState>(initialState);
  const [color, setColor] = useState("#ff0000");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const stageRef = useRef<Konva.Stage>(null);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-image", (event) => {
      setImageSrc(`data:image/png;base64,${event.payload}`);
      setState(initialState);
      setVideoSrc(null);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-video", (event) => {
      setVideoPath(event.payload);
      setVideoSrc(convertFileSrc(event.payload));
      setImageSrc(null);
      setTrim(initialTrimState(0));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function handleTrimAndUpload() {
    if (!videoPath) return;
    setUploading(true);
    setError(null);
    try {
      const url = await trimAndUpload(videoPath, trim.inPoint, trim.outPoint);
      await writeText(url);
      await sendNotification({ title: "pxl", body: `Uploaded — link copied to clipboard\n${url}` });
      await getCurrentWindow().hide();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

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
      const bytes = exportStageToBytes(stageRef.current, 1 / displayScale);
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

  if (videoSrc) {
    return (
      <div className="editor-page">
        <div className="editor-actions">
          <button type="button" className="button button-primary" onClick={handleTrimAndUpload} disabled={uploading}>
            {uploading ? "Uploading…" : "Save & Upload"}
          </button>
        </div>
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button type="button" className="button" onClick={handleTrimAndUpload}>
              Retry
            </button>
          </div>
        )}
        <VideoTrimmer videoSrc={videoSrc} trim={trim} onTrimChange={setTrim} />
      </div>
    );
  }

  if (!imageSrc) {
    return <div className="editor-waiting">Waiting for capture…</div>;
  }

  return (
    <div className="editor-page">
      <Toolbar
        tool={state.tool}
        color={color}
        strokeWidth={strokeWidth}
        onToolChange={(t) => setState(setTool(state, t))}
        onColorChange={setColor}
        onStrokeWidthChange={setStrokeWidth}
      />
      <div className="editor-actions">
        <button type="button" className="button button-primary" onClick={handleSaveAndUpload} disabled={uploading}>
          {uploading ? "Uploading…" : "Save & Upload"}
        </button>
        {state.shapes.some((s) => s.type === "crop") && (
          <button type="button" className="button" onClick={handleApplyCrop}>
            Apply Crop
          </button>
        )}
      </div>
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button type="button" className="button" onClick={handleSaveAndUpload}>
            Retry
          </button>
        </div>
      )}
      <div id="editor-canvas-container" className="editor-canvas-container">
        <AnnotationCanvas
          ref={stageRef}
          imageSrc={imageSrc}
          state={state}
          color={color}
          strokeWidth={strokeWidth}
          onStateChange={setState}
          onScaleChange={setDisplayScale}
        />
      </div>
    </div>
  );
}

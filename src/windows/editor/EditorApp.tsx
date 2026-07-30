import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type Konva from "konva";
import AnnotationCanvas from "./AnnotationCanvas";
import Toolbar from "./Toolbar";
import { bytesToDataUrl, exportStageToBytes } from "./export";
import {
  uploadFile,
  trimAndUpload,
  getLastCapture,
  readVideoBase64,
  recordCaptureHistory,
  startFloatingCapture,
} from "../../lib/api";
import { addShape, applyCrop, initialState, selectShape, setTool, updateShape, type EditorState, type ImageShape } from "./toolState";
import VideoTrimmer, { type VideoTrimmerHandle } from "./VideoTrimmer";
import { initialTrimState, type TrimState } from "./trimState";

// Tauri's `asset://` protocol + `convertFileSrc` gets rejected by WebKit
// with "Unsafe attempt to load URL" when the app is served from a plain
// `http://localhost:1420` origin (as it is in `tauri dev`) — a custom-scheme
// resource load from a non-privileged origin. `blob:` URLs have no such
// restriction and work identically in dev and production, so the video's
// bytes are fetched over IPC and turned into one locally instead.
function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

const UPLOAD_SHORTCUT_LABEL = navigator.platform.toLowerCase().includes("mac") ? "⌘E" : "Ctrl+E";

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [trim, setTrim] = useState<TrimState>(initialTrimState(0));
  const [state, setState] = useState<EditorState>(initialState);
  const [color, setColor] = useState(() => localStorage.getItem("editor-color") ?? "#ff0000");
  const [strokeWidth, setStrokeWidth] = useState(() => Number(localStorage.getItem("editor-stroke-width")) || 3);
  const [uploading, setUploading] = useState(false);
  const [fading, setFading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const stageRef = useRef<Konva.Stage>(null);
  const trimmerRef = useRef<VideoTrimmerHandle>(null);
  const videoObjectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state.selectedId) return;
    const selected = state.shapes.find((s) => s.id === state.selectedId);
    if (!selected) return;
    setColor(selected.color);
    if (selected.type === "text") {
      setStrokeWidth((selected.fontSize - 17) / 3);
    } else {
      setStrokeWidth(selected.type === "highlighter" ? selected.strokeWidth / 4 : selected.strokeWidth);
    }
  }, [state.selectedId, state.shapes]);

  const loadVideoFromPath = useCallback((path: string) => {
    readVideoBase64(path)
      .then((base64) => {
        const url = base64ToBlobUrl(base64, "video/mp4");
        if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
        videoObjectUrlRef.current = url;
        setVideoSrc(url);
      })
      .catch((e) => console.error("failed to load video", e));
  }, []);

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

  // The "add screenshot" tool's capture comes back as a new floating image
  // rather than replacing the editor's contents — added at its native
  // captured size (no scaling/distortion) with a small fixed inset so it
  // doesn't land exactly on top of the base image's corner; the user drags
  // it wherever it actually belongs afterward.
  useEffect(() => {
    const unlisten = listen<string>("editor-add-image", (event) => {
      const src = `data:image/png;base64,${event.payload}`;
      const img = new Image();
      img.onload = () => {
        const shape: ImageShape = {
          id: `image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: "image",
          color,
          strokeWidth,
          x: 40,
          y: 40,
          width: img.naturalWidth,
          height: img.naturalHeight,
          src,
        };
        setState((prev) => selectShape(setTool(addShape(prev, shape), "select"), shape.id));
      };
      img.src = src;
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [color, strokeWidth]);

  // Covers both ways handleAddScreenshot's fade-out ever resolves: a new
  // image was added (above), or the capture was cancelled/failed and
  // nothing changed. Rust re-shows and re-focuses this window in either
  // case, so reacting to regaining focus (rather than a second dedicated
  // event) fades it back in either way without duplicating that reset.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) setFading(false);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-video", (event) => {
      setVideoPath(event.payload);
      setImageSrc(null);
      setTrim(initialTrimState(0));
      loadVideoFromPath(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [loadVideoFromPath]);

  // The editor window is created once at startup and never destroyed, so
  // its listeners above are normally live long before any capture happens.
  // As a fallback for the one case where that isn't guaranteed — the very
  // first capture of a session racing this window's own initial mount —
  // pull whatever was last captured once on mount instead of relying solely
  // on the one-shot "editor-load-*" event having a listener ready in time.
  // The `prev ?? ...` guard on imageSrc/videoPath makes this a no-op if a
  // live event already won; videoPath (not videoSrc) is the guard for video
  // since videoSrc is only set asynchronously by loadVideoFromPath.
  useEffect(() => {
    getLastCapture()
      .then((capture) => {
        if (!capture) return;
        if (capture.kind === "image") {
          setImageSrc((prev) => prev ?? `data:image/png;base64,${capture.pngBase64}`);
        } else {
          setVideoPath((prev) => {
            if (prev) return prev;
            loadVideoFromPath(capture.path);
            return capture.path;
          });
        }
      })
      .catch((e) => console.error("failed to load last capture", e));
  }, [loadVideoFromPath]);

  async function handleTrimAndUpload() {
    if (!videoPath) return;
    setUploading(true);
    setError(null);
    try {
      const url = await trimAndUpload(videoPath, trim.inPoint, trim.outPoint);
      try {
        const thumbnail = await trimmerRef.current?.captureThumbnail(trim.inPoint);
        if (thumbnail) await recordCaptureHistory("video", url, thumbnail);
      } catch (e) {
        console.error("failed to record capture history", e);
      }
      await writeText(url);
      await sendNotification({ title: "Snap", body: `Uploaded — link copied to clipboard\n${url}` });
      await getCurrentWindow().hide();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

  function handleColorChange(next: string) {
    setColor(next);
    localStorage.setItem("editor-color", next);
    if (state.selectedId) setState(updateShape(state, state.selectedId, { color: next }));
  }

  function handleStrokeWidthChange(next: number) {
    setStrokeWidth(next);
    localStorage.setItem("editor-stroke-width", String(next));
    const selected = state.shapes.find((s) => s.id === state.selectedId);
    if (selected) {
      if (selected.type === "text") {
        setState(updateShape(state, selected.id, { fontSize: 17 + next * 3 }));
      } else {
        setState(updateShape(state, selected.id, { strokeWidth: selected.type === "highlighter" ? next * 4 : next }));
      }
    }
  }

  function handleTextBackgroundChange(next: boolean) {
    if (state.selectedId) setState(updateShape(state, state.selectedId, { background: next }));
  }

  // Fades this window's content out, then hides the window itself (via
  // start_floating_capture) and shows the capture overlay. The window
  // reappears — and the fade reverses — either with a new floating image
  // (the "editor-add-image" listener above) or on cancel; both paths funnel
  // through this window regaining focus, so that's the one signal used to
  // reset `fading` rather than duplicating the reset in two places.
  async function handleAddScreenshot() {
    setFading(true);
    await new Promise((resolve) => setTimeout(resolve, 180));
    try {
      await startFloatingCapture();
    } catch (e) {
      console.error("failed to start floating capture", e);
      setFading(false);
    }
  }

  function handleApplyCrop() {
    const cropShape = state.shapes.find((s) => s.type === "crop");
    if (!cropShape || cropShape.type !== "crop" || !imageSrc) return;
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
      try {
        await recordCaptureHistory("image", url, bytesToDataUrl(bytes, "image/png"));
      } catch (e) {
        console.error("failed to record capture history", e);
      }
      await writeText(url);
      await sendNotification({ title: "Snap", body: `Uploaded — link copied to clipboard\n${url}` });
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

  // Cmd+E (mac) / Ctrl+E (win/linux) uploads from anywhere in the editor
  // window, whether it's a video (trim) or image (annotation) capture.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "e") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      if (uploading) return;
      if (videoSrc) {
        handleTrimAndUpload();
      } else if (imageSrc) {
        handleSaveAndUpload();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  if (videoSrc) {
    return (
      <div className="editor-page">
        <div className="editor-header-row editor-actions">
          <button type="button" className="button button-primary" onClick={handleTrimAndUpload} disabled={uploading}>
            {uploading ? "Uploading…" : `Save & Upload (${UPLOAD_SHORTCUT_LABEL})`}
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
        <VideoTrimmer ref={trimmerRef} videoSrc={videoSrc} trim={trim} onTrimChange={setTrim} />
      </div>
    );
  }

  if (!imageSrc) {
    return <div className="editor-waiting">Waiting for capture…</div>;
  }

  const selectedShape = state.shapes.find((s) => s.id === state.selectedId);

  return (
    <div className={`editor-page${fading ? " editor-fading" : ""}`}>
      <div className="editor-header-row editor-toolbar-row">
        <Toolbar
          tool={state.tool}
          color={color}
          strokeWidth={strokeWidth}
          showTextBackground={selectedShape?.type === "text"}
          textBackground={selectedShape?.type === "text" ? selectedShape.background : false}
          disableStyleControls={selectedShape?.type === "image"}
          onToolChange={(t) => setState(setTool(state, t))}
          onAddScreenshot={handleAddScreenshot}
          onColorChange={handleColorChange}
          onStrokeWidthChange={handleStrokeWidthChange}
          onTextBackgroundChange={handleTextBackgroundChange}
        />
        <div className="editor-actions">
          {state.shapes.some((s) => s.type === "crop") && (
            <button type="button" className="button" onClick={handleApplyCrop}>
              Apply Crop
            </button>
          )}
          <button type="button" className="button button-primary" onClick={handleSaveAndUpload} disabled={uploading}>
            {uploading ? "Uploading…" : `Save & Upload (${UPLOAD_SHORTCUT_LABEL})`}
          </button>
        </div>
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

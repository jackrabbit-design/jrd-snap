import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
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
  saveBytesToPath,
  saveTrimmedVideo,
  notify,
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

const IS_MAC = navigator.platform.toLowerCase().includes("mac");
const MODIFIER_KEY_LABEL = IS_MAC ? "⌘" : "Ctrl+";
const UPLOAD_SHORTCUT_LABEL = `${MODIFIER_KEY_LABEL}E`;

function UploadIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg"  className="save-icon" fill="currentColor" stroke="currentColor" stroke-width="0" viewBox="0 0 24 24"><title>Upload</title><path stroke="none" d="m12 12.586 4.243 4.242-1.415 1.415L13 16.415V22h-2v-5.587l-1.828 1.83-1.415-1.415zM12 2a7 7 0 0 1 6.954 6.194A5.5 5.5 0 0 1 18 18.978v-2.014a3.5 3.5 0 1 0-1.111-6.91 5 5 0 1 0-9.777 0 3.5 3.5 0 0 0-1.292 6.88l.18.03v2.014a5.5 5.5 0 0 1-.954-10.784A7 7 0 0 1 12 2"/></svg>
  );
}

function SaveIcon() {
  return (
    <svg stroke="currentColor" fill="currentColor" className="save-icon" strokeWidth="0" viewBox="0 0 16 16" height="200px" width="200px" xmlns="http://www.w3.org/2000/svg"><title>Save</title><path d="M14.414 3.207L12.793 1.586C12.421 1.213 11.905 1 11.379 1H3C1.897 1 1 1.897 1 3V13C1 14.103 1.897 15 3 15H13C14.103 15 15 14.103 15 13V4.621C15 4.095 14.787 3.579 14.414 3.207ZM9 2V3.5C9 3.776 8.776 4 8.5 4H6.5C6.224 4 6 3.776 6 3.5V2H9ZM5 14V9.5C5 9.224 5.224 9 5.5 9H10.5C10.776 9 11 9.224 11 9.5V14H5ZM14 13C14 13.551 13.551 14 13 14H12V9.5C12 8.673 11.327 8 10.5 8H5.5C4.673 8 4 8.673 4 9.5V14H3C2.449 14 2 13.551 2 13V3C2 2.449 2.449 2 3 2H5V3.5C5 4.327 5.673 5 6.5 5H8.5C9.327 5 10 4.327 10 3.5V2H11.379C11.642 2 11.9 2.107 12.086 2.293L13.707 3.914C13.893 4.1 14 4.358 14 4.621V13Z"></path></svg>
  );
}

const appWindow = getCurrentWindow();

// Undo/redo for `state` (shapes/tool/selection) — kept as a reducer rather
// than plain useState + a ref-tracked undo stack because that first version
// had a real race: undo()/redo() read `history`/`future`/`state` straight
// out of the render closure, so two rapid calls (key-repeat holding
// Cmd+Z, or double-clicking Undo) could both read the same stale array
// and pop the same entry twice — the stack silently shrank by two while
// state only moved back by one, eventually running dry early or skipping
// steps. A reducer's actions are always applied against the guaranteed-
// latest state, in the order dispatched, so that whole class of race is
// gone regardless of how fast dispatch is called.
interface HistoryState {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

type HistoryAction =
  | { type: "set"; updater: (prev: EditorState) => EditorState; suppressed: boolean }
  // Snapshots the state right before a continuous edit (dragging out a new
  // shape) begins, so the many "set"s while it's in progress (suppressed)
  // can update `present` without each one being its own undo step.
  | { type: "begin" }
  | { type: "undo" }
  | { type: "redo" }
  // Replaces everything and clears both stacks — a new capture loaded, or
  // (see handleApplyCrop) a crop applied. Crop changes the base image
  // itself, which isn't part of this state, so undoing shapes back past a
  // crop would leave annotations misaligned with an image that never
  // reverted — simplest correct answer is it just isn't undoable.
  | { type: "reset"; state: EditorState };

function historyReducer(hist: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "begin":
      return { past: [...hist.past, hist.present], present: hist.present, future: [] };
    case "set": {
      const next = action.updater(hist.present);
      // Suppressed (mid-continuous-edit), or a pure selection/tool change
      // (every reducer in toolState.ts either replaces the `shapes` array
      // for a real content change, or leaves the same reference alone) —
      // either way, update present without pushing a checkpoint.
      if (action.suppressed || next.shapes === hist.present.shapes) {
        return { ...hist, present: next };
      }
      return { past: [...hist.past, hist.present], present: next, future: [] };
    }
    case "undo": {
      if (hist.past.length === 0) return hist;
      return {
        past: hist.past.slice(0, -1),
        present: hist.past[hist.past.length - 1],
        future: [hist.present, ...hist.future],
      };
    }
    case "redo": {
      if (hist.future.length === 0) return hist;
      return {
        past: [...hist.past, hist.present],
        present: hist.future[0],
        future: hist.future.slice(1),
      };
    }
    case "reset":
      return { past: [], present: action.state, future: [] };
  }
}

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [trim, setTrim] = useState<TrimState>(initialTrimState(0));
  const [color, setColor] = useState(() => localStorage.getItem("editor-color") ?? "#ff0000");
  const [strokeWidth, setStrokeWidth] = useState(() => Number(localStorage.getItem("editor-stroke-width")) || 3);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fading, setFading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const stageRef = useRef<Konva.Stage>(null);
  const trimmerRef = useRef<VideoTrimmerHandle>(null);
  const videoObjectUrlRef = useRef<string | null>(null);

  // Undo/redo over `state` (shapes/tool/selection) only — not imageSrc, so a
  // crop (which regenerates the base image) clears this instead of being
  // undoable through it; see handleApplyCrop and historyReducer's "reset".
  const [hist, dispatch] = useReducer(historyReducer, { past: [], present: initialState, future: [] });
  const state = hist.present;
  // Set for the duration of drawing a brand-new shape (mousedown through
  // mouseup) so its many intermediate mousemove updates collapse into one
  // undo step instead of one per pixel dragged. Read at dispatch time (not
  // closed over inside the reducer) so it reflects "was a continuous edit
  // in progress right when this particular change happened", independent
  // of when React actually gets around to running the reducer.
  const suppressHistoryRef = useRef(false);

  function setState(updater: EditorState | ((prev: EditorState) => EditorState)) {
    dispatch({
      type: "set",
      updater: typeof updater === "function" ? updater : () => updater,
      suppressed: suppressHistoryRef.current,
    });
  }

  function resetState(newState: EditorState) {
    dispatch({ type: "reset", state: newState });
  }

  function beginContinuousEdit() {
    suppressHistoryRef.current = true;
    dispatch({ type: "begin" });
  }

  function endContinuousEdit() {
    suppressHistoryRef.current = false;
  }

  function undo() {
    dispatch({ type: "undo" });
  }

  function redo() {
    dispatch({ type: "redo" });
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!videoSrc && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

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
      setVideoSrc(null);
      resetState(initialState);
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
      resetState(initialState);
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
      await notify(`Uploaded — link copied to clipboard\n${url}`);
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
      const cropped = applyCrop(state, {
        x: Math.min(x, x + width),
        y: Math.min(y, y + height),
        width: Math.abs(width),
        height: Math.abs(height),
      });
      resetState(cropped);
    };
    img.src = imageSrc;
  }

  // Any unapplied crop selection is an uncommitted UI overlay, not a real
  // annotation — hidden on the stage before exporting so it isn't baked
  // into the exported PNG (uploaded or saved locally), then restored
  // afterward (by the caller, once its own async work is done) in case
  // that fails. Same idea for the selected/hovered blue glow
  // (SELECTED_SHADOW in AnnotationCanvas) — it's editor UI chrome too.
  // shadowEnabled only exists on Shape (not the base Node type returned by
  // find), hence the type guard rather than a plain property check.
  // find()'s selector param is typed `any`, so its generic can't be
  // inferred from the guard — spelled out explicitly instead.
  function hideExportChrome(): { restore: () => void } {
    const stage = stageRef.current;
    if (!stage) return { restore: () => {} };
    const cropNodes = stage.find(".crop-shape");
    cropNodes.forEach((node) => {
      node.hide();
    });
    type ShadowNode = Konva.Node & { shadowEnabled: (v?: boolean) => boolean };
    function hasShadow(node: Konva.Node): node is ShadowNode {
      return typeof (node as { shadowEnabled?: unknown }).shadowEnabled === "function";
    }
    const glowingNodes = stage.find<ShadowNode>(hasShadow).filter((node) => node.shadowEnabled());
    glowingNodes.forEach((node) => {
      node.shadowEnabled(false);
    });
    stage.batchDraw();
    return {
      restore: () => {
        cropNodes.forEach((node) => {
          node.show();
        });
        glowingNodes.forEach((node) => {
          node.shadowEnabled(true);
        });
        stage.batchDraw();
      },
    };
  }

  async function handleSaveAndUpload() {
    if (!stageRef.current) return;
    setUploading(true);
    setError(null);
    const { restore } = hideExportChrome();
    try {
      const bytes = exportStageToBytes(stageRef.current, 1 / displayScale);
      const url = await uploadFile(bytes, "png");
      try {
        await recordCaptureHistory("image", url, bytesToDataUrl(bytes, "image/png"));
      } catch (e) {
        console.error("failed to record capture history", e);
      }
      await writeText(url);
      await notify(`Uploaded — link copied to clipboard\n${url}`);
      await getCurrentWindow().hide();
    } catch (e) {
      setError(String(e));
    } finally {
      restore();
      setUploading(false);
    }
  }

  async function handleSaveLocally() {
    if (!stageRef.current) return;
    const path = await save({ defaultPath: "screenshot.png", filters: [{ name: "PNG Image", extensions: ["png"] }] });
    if (!path) return;
    setSaving(true);
    setError(null);
    const { restore } = hideExportChrome();
    try {
      const bytes = exportStageToBytes(stageRef.current, 1 / displayScale);
      await saveBytesToPath(path, bytes);
      await notify(`Saved to ${path}`);
    } catch (e) {
      setError(String(e));
    } finally {
      restore();
      setSaving(false);
    }
  }

  async function handleSaveVideoLocally() {
    if (!videoPath) return;
    const path = await save({ defaultPath: "recording.mp4", filters: [{ name: "MP4 Video", extensions: ["mp4"] }] });
    if (!path) return;
    setSaving(true);
    setError(null);
    try {
      await saveTrimmedVideo(videoPath, trim.inPoint, trim.outPoint, path);
      await notify(`Saved to ${path}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
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
      if (uploading || saving) return;
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
        <div className="editor-header-row editor-actions" data-tauri-drag-region>
          <div className="titlebar-controls video-titlebar">
            <button type="button" className="control-btn close-btn" title="Close Window" onClick={() => appWindow.close()}></button>
            <button type="button" className="control-btn min-btn" title="Minimize Window" onClick={() => appWindow.minimize()}></button>
          </div>
          <div style={{ flex: 1, pointerEvents: "none" }} />
          <button type="button" className="button" title="Save to file" onClick={handleSaveVideoLocally} disabled={uploading || saving}>
            {saving ? "Saving…" : <SaveIcon />}
          </button>
          <button
            type="button"
            className="button button-primary"
            title={`Upload (${UPLOAD_SHORTCUT_LABEL})`}
            onClick={handleTrimAndUpload}
            disabled={uploading || saving}
          >
            {uploading ? "Uploading…" : <UploadIcon />}
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
      <div className="editor-header-row editor-toolbar-row" data-tauri-drag-region>
        <div className="titlebar-controls">
          <button type="button" className="control-btn close-btn" title="Close Window" onClick={() => appWindow.close()}></button>
          <button type="button" className="control-btn min-btn" title="Minimize Window" onClick={() => appWindow.minimize()}></button>
        </div>

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
          <button
            type="button"
            className="button"
            title={`Undo (${MODIFIER_KEY_LABEL}Z)`}
            onClick={undo}
            disabled={hist.past.length === 0}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle" }}>
              <title>Undo</title>
              <polyline points="9 14 4 9 9 4" />
              <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
            </svg>
          </button>
          <button
            type="button"
            className="button"
            title={`Redo (${MODIFIER_KEY_LABEL}Shift+Z)`}
            onClick={redo}
            disabled={hist.future.length === 0}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "scaleX(-1)", verticalAlign: "middle" }}>
              <title>Redo</title>
              <polyline points="9 14 4 9 9 4" />
              <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
            </svg>
          </button>
          {state.shapes.some((s) => s.type === "crop") && (
            <button type="button" className="button" onClick={handleApplyCrop}>
              Apply Crop
            </button>
          )}
          <button type="button" className="button" title="Save to file" onClick={handleSaveLocally} disabled={uploading || saving}>
            {saving ? "Saving…" : <SaveIcon />}
          </button>
          <button
            type="button"
            className="button button-primary"
            title={`Upload (${UPLOAD_SHORTCUT_LABEL})`}
            onClick={handleSaveAndUpload}
            disabled={uploading || saving}
          >
            {uploading ? "Uploading…" : <UploadIcon />}
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
          onBeginContinuousEdit={beginContinuousEdit}
          onEndContinuousEdit={endContinuousEdit}
        />
      </div>
    </div>
  );
}

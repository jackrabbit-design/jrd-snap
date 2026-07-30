import { useState, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startRecording } from "../../lib/api";

interface Point {
  x: number;
  y: number;
}

interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Phase = "select" | "confirm" | "recording";
type Purpose = "screenshot" | "record" | "floating";

export default function OverlayApp() {
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);
  const dragging = useRef(false);

  const [phase, setPhase] = useState<Phase>("select");
  const [purpose, setPurpose] = useState<Purpose>("screenshot");
  const [micEnabled, setMicEnabled] = useState(false);
  const [recordRegion, setRecordRegion] = useState<CaptureRect | null>(null);
  const [recordDisplayRegion, setRecordDisplayRegion] = useState<DisplayRect | null>(null);

  // WKWebView doesn't reliably re-sync the native cursor just because a CSS
  // `cursor` property's *value* is already "crosshair" — a same-value
  // reassignment is a no-op to the DOM, so it never re-triggers WebKit's
  // cursor update. This matters a lot here because the overlay window is
  // hidden/shown (and repositioned via resize_overlay_to_monitor) for every
  // single capture rather than recreated, so a plain one-time assignment on
  // mount only ever has a chance to "take" the very first time the overlay
  // is ever shown in a session — every later show relies on whatever native
  // cursor state macOS happened to leave behind. Forcing a real change
  // (clear, then reapply crosshair a frame later) makes WebKit actually
  // re-evaluate it every time, not just once.
  function forceCrosshairCursor() {
    document.documentElement.style.cursor = "default";
    document.body.style.cursor = "default";
    requestAnimationFrame(() => {
      document.documentElement.style.cursor = "crosshair";
      document.body.style.cursor = "crosshair";
    });
  }

  useEffect(() => {
    forceCrosshairCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- forceCrosshairCursor
    // is a plain function redefined each render with no reactive dependencies
    // of its own; listing it would just make this effect (mount-only, on
    // purpose) re-run every render instead.
  }, []);

  useEffect(() => {
    const unlisten = listen<{ purpose: Purpose }>("overlay-mode", (event) => {
      setPurpose(event.payload.purpose);
      setPhase("select");
      forceCrosshairCursor();
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, []);

  // Fires whenever a recording actually stops, regardless of trigger (this
  // window's own Stop button, the tray menu, or a hotkey) — the tray/lib.rs
  // stop path is the single source of truth, so the overlay just reacts to
  // it instead of hiding/resetting itself directly from its own button.
  useEffect(() => {
    const unlisten = listen("trigger-stop-recording", () => {
      setPhase("select");
      setPurpose("screenshot");
      setRecordRegion(null);
      setRecordDisplayRegion(null);
      getCurrentWindow().setIgnoreCursorEvents(false);
      invoke("hide_overlay");
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function handleMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    setStart({ x: e.clientX, y: e.clientY });
    setCurrent({ x: e.clientX, y: e.clientY });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging.current) return;
    setCurrent({ x: e.clientX, y: e.clientY });
  }

  async function handleMouseUp() {
    if (!dragging.current || !start || !current) return;
    dragging.current = false;
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    setStart(null);
    setCurrent(null);
    if (width < 2 || height < 2) {
      if (purpose === "screenshot" || purpose === "floating") {
        await invoke("hide_overlay");
        await invoke("reset_capture_icon");
        if (purpose === "floating") await invoke("cancel_floating_capture");
      }
      return;
    }
    // Convert from logical/CSS pixels (browser mouse coordinates) to physical
    // pixels, since xcap's capture_image() returns full-resolution physical
    // pixels. On HiDPI displays (devicePixelRatio !== 1) these spaces differ.
    const dpr = window.devicePixelRatio;
    const rect = {
      x: Math.round(x * dpr),
      y: Math.round(y * dpr),
      width: Math.round(width * dpr),
      height: Math.round(height * dpr),
    };
    if (purpose === "record") {
      // Overlays are shown on every monitor at once (there's no way to know
      // in advance which one the user means to use), so once they've
      // actually drawn a region here, every other monitor's overlay is no
      // longer relevant — hide them immediately rather than leaving them
      // dimming the rest of the screen through the confirm step.
      await invoke("hide_other_overlays");
      setRecordRegion(rect);
      setRecordDisplayRegion({ left: x, top: y, width, height });
      setPhase("confirm");
      return;
    }
    // Hide the overlay (including its semi-transparent dark tint) BEFORE
    // triggering the actual screen capture, and give the window server a
    // moment to actually composite that away — otherwise the capture can
    // include the overlay's own dimming, making everything look darker.
    await invoke("hide_overlay");
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (purpose === "floating") {
      await invoke("submit_floating_capture", { rect });
    } else {
      await invoke("submit_area_capture", { rect });
    }
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      const wasFloating = purpose === "floating";
      setStart(null);
      setCurrent(null);
      setPhase("select");
      setPurpose("screenshot");
      setRecordRegion(null);
      setRecordDisplayRegion(null);
      await invoke("hide_overlay");
      await invoke("reset_capture_icon");
      if (wasFloating) await invoke("cancel_floating_capture");
    }
  }

  async function handleStartRecording() {
    if (!recordRegion) return;
    try {
      await startRecording(recordRegion, micEnabled);
      setPhase("recording");
      await getCurrentWindow().setIgnoreCursorEvents(true);
    } catch (e) {
      console.error("failed to start recording", e);
      setPhase("select");
      setPurpose("screenshot");
      setRecordRegion(null);
      setRecordDisplayRegion(null);
      await invoke("hide_overlay");
    }
  }

  async function handleCancelConfirm() {
    setPhase("select");
    setPurpose("screenshot");
    setRecordRegion(null);
    setRecordDisplayRegion(null);
    await invoke("hide_overlay");
    await invoke("reset_capture_icon");
  }

  const rect =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : null;

  return (
    <div
      tabIndex={0}
      autoFocus
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onKeyDown={handleKeyDown}
      className="overlay-root"
    >
      {rect && phase === "select" && (
        <div
          className="overlay-selection"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          <span className="overlay-dimensions">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      )}
      {phase === "confirm" && (
        <div className="record-confirm-panel">
          <label>
            <input type="checkbox" checked={micEnabled} onChange={(e) => setMicEnabled(e.target.checked)} />
            Microphone
          </label>
          <div className="record-confirm-actions">
            <button type="button" className="button button-primary" onClick={handleStartRecording}>
              Start Recording
            </button>
            <button type="button" className="button" onClick={handleCancelConfirm}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {phase === "recording" && recordDisplayRegion && (
        <div
          className="recording-border"
          style={{
            left: recordDisplayRegion.left,
            top: recordDisplayRegion.top,
            width: recordDisplayRegion.width,
            height: recordDisplayRegion.height,
          }}
        />
      )}
    </div>
  );
}

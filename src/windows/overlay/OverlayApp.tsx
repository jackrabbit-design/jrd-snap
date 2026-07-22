import { useState, useRef, useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

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

type Phase = "select" | "confirm";
type Purpose = "screenshot" | "record";

export default function OverlayApp() {
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);
  const dragging = useRef(false);

  const [phase, setPhase] = useState<Phase>("select");
  const [purpose, setPurpose] = useState<Purpose>("screenshot");
  const [micEnabled, setMicEnabled] = useState(false);
  const [recordRegion, setRecordRegion] = useState<CaptureRect | null>(null);

  // Some WebKit/WKWebView builds don't reliably propagate a CSS `cursor`
  // set only on a child element over a transparent, borderless window —
  // force it at the document root too so the crosshair actually shows.
  useEffect(() => {
    const previous = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    document.body.style.cursor = "crosshair";
    return () => {
      document.documentElement.style.cursor = previous;
      document.body.style.cursor = "";
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ purpose: "record"; area: boolean }>("overlay-mode", (event) => {
      setPurpose(event.payload.purpose);
      // Full-screen recording skips straight to the confirm panel; area
      // recording goes through the existing drag-select first.
      setPhase(event.payload.area ? "select" : "confirm");
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
      if (purpose === "screenshot") await invoke("hide_overlay");
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
      setRecordRegion(rect);
      setPhase("confirm");
      return;
    }
    // Hide the overlay (including its semi-transparent dark tint) BEFORE
    // triggering the actual screen capture, and give the window server a
    // moment to actually composite that away — otherwise the capture can
    // include the overlay's own dimming, making everything look darker.
    await invoke("hide_overlay");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await emit("overlay-selection", rect);
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setStart(null);
      setCurrent(null);
      setPhase("select");
      setRecordRegion(null);
      await invoke("hide_overlay");
    }
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
            <button
              type="button"
              className="button button-primary"
              onClick={async () => {
                await emit("record-confirmed", { region: recordRegion, micEnabled });
                await invoke("hide_overlay");
              }}
            >
              Start Recording
            </button>
            <button
              type="button"
              className="button"
              onClick={async () => {
                setPhase("select");
                setRecordRegion(null);
                await invoke("hide_overlay");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

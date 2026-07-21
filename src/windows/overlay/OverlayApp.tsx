import { useState, useRef } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface Point {
  x: number;
  y: number;
}

export default function OverlayApp() {
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);
  const dragging = useRef(false);

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
      await invoke("hide_overlay");
      return;
    }
    await emit("overlay-selection", { x, y, width, height });
    await invoke("hide_overlay");
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setStart(null);
      setCurrent(null);
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
      style={{
        position: "fixed",
        inset: 0,
        cursor: "crosshair",
        background: "rgba(0,0,0,0.2)",
      }}
    >
      {rect && (
        <div
          style={{
            position: "absolute",
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            background: "rgba(255,255,255,0.15)",
            border: "1px solid #fff",
          }}
        />
      )}
    </div>
  );
}

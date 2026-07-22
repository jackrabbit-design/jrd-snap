import { forwardRef, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Arrow, Rect, Ellipse, Line, Text } from "react-konva";
import useImage from "use-image";
import Konva from "konva";
import type { BoxShape, EditorState, Shape, TextShape, ToolType } from "./toolState";
import { addShape, removeShape, selectShape, setTool, updateShape } from "./toolState";

const TOOL_HOTKEYS: Record<string, ToolType> = {
  r: "rect",
  o: "ellipse",
  t: "text",
  b: "blur",
  c: "crop",
  p: "pen",
  a: "arrow",
  h: "highlighter",
};

const SELECTED_SHADOW = {
  shadowColor: "#3b82f6",
  shadowBlur: 10,
  shadowOpacity: 0.9,
  shadowEnabled: true,
};

function BlurRegion({ image, shape, selected, onSelect, onDragEnd }: {
  image: HTMLImageElement;
  shape: BoxShape;
  selected: boolean;
  onSelect: () => void;
  onDragEnd: (x: number, y: number) => void;
}) {
  const ref = useRef<Konva.Image>(null);
  const x = Math.min(shape.x, shape.x + shape.width);
  const y = Math.min(shape.y, shape.y + shape.height);
  const width = Math.abs(shape.width);
  const height = Math.abs(shape.height);

  useEffect(() => {
    // Konva refuses to cache (and logs/throws) a zero-size node — this
    // happens for one render right after mousedown, before the first drag
    // move sets a real width/height. Skip caching until there's something
    // real to pixelate, or the filter silently never applies.
    if (width <= 0 || height <= 0) return;
    try {
      ref.current?.cache();
      ref.current?.getLayer()?.batchDraw();
    } catch (e) {
      console.error("failed to cache blur region for pixelation", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- x/y aren't read
    // in this closure, but the crop region (and thus what must be re-cached)
    // moves with position: dragging the box to redact different content
    // needs a fresh cache of the newly-covered pixels, not the old ones.
  }, [x, y, width, height]);

  if (width <= 0 || height <= 0) return null;

  return (
    <KonvaImage
      ref={ref}
      image={image}
      x={x}
      y={y}
      width={width}
      height={height}
      crop={{ x, y, width, height }}
      filters={[Konva.Filters.Pixelate]}
      pixelSize={12}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => onDragEnd(e.target.x(), e.target.y())}
      {...(selected ? SELECTED_SHADOW : {})}
    />
  );
}

interface Props {
  imageSrc: string;
  state: EditorState;
  color: string;
  strokeWidth: number;
  onStateChange: (next: EditorState) => void;
  // Reports the current fit-to-panel scale (<=1) so the parent can export at
  // full native resolution regardless of how small the on-screen display is.
  onScaleChange?: (scale: number) => void;
}

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `shape-${nextId}`;
}

const AnnotationCanvas = forwardRef<Konva.Stage, Props>(function AnnotationCanvas(
  { imageSrc, state, color, strokeWidth, onStateChange, onScaleChange },
  ref,
) {
  const [image] = useImage(imageSrc);
  const drawing = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingText, setEditingText] = useState<{ id: string; x: number; y: number; value: string } | null>(null);

  // Fit the (often much larger than the window) captured image down to the
  // available panel space, like `object-fit: contain` — but Konva renders to
  // a real <canvas>, so this has to be done by scaling the Stage itself, not
  // just CSS. Shapes stay stored in the image's native pixel coordinates
  // throughout (via getRelativePointerPosition below); only the display and
  // export need to know about this scale.
  const [fit, setFit] = useState({ scale: 1, width: 800, height: 600 });

  useEffect(() => {
    if (!image) return;
    const loadedImage = image;
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    const panel = parent;

    function computeFit() {
      const scale = Math.min(1, panel.clientWidth / loadedImage.width, panel.clientHeight / loadedImage.height);
      setFit({ scale, width: loadedImage.width * scale, height: loadedImage.height * scale });
      onScaleChange?.(scale);
    }

    computeFit();
    const observer = new ResizeObserver(computeFit);
    observer.observe(panel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onScaleChange
    // is a setState setter from the parent; including it would cause this
    // effect to fire on every scale update it triggers.
  }, [image]);

  // Delete/Backspace removes the selected shape in Select mode; bare letter
  // keys switch tools. Both are disabled while editing text or while any
  // other input/textarea has focus, so typing a shape's name doesn't yank
  // the active tool out from under you.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (editingText) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "Delete" || e.key === "Backspace") && state.tool === "select" && state.selectedId) {
        onStateChange(removeShape(state, state.selectedId));
        return;
      }
      const hotkeyTool = TOOL_HOTKEYS[e.key.toLowerCase()];
      if (hotkeyTool) {
        onStateChange(setTool(state, hotkeyTool));
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [state, onStateChange, editingText]);

  // Focusing the textarea synchronously (e.g. via the `autoFocus` attribute)
  // races with the native mousedown/mouseup/click sequence that placed the
  // text shape in the first place — the browser can steal focus back to the
  // canvas right after, firing onBlur (which commits/closes the editor)
  // before the user gets a chance to type anything. Deferring focus to the
  // next animation frame lets that click finish first.
  useEffect(() => {
    if (!editingText) return;
    const raf = requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run
    // when a new editing session starts (by id), not on every keystroke.
  }, [editingText?.id]);

  function select(id: string) {
    if (state.tool === "select") onStateChange(selectShape(state, id));
  }

  function startEditingText(shape: TextShape) {
    const containerRect = containerRef.current?.getBoundingClientRect();
    setEditingText({
      id: shape.id,
      x: (containerRect?.left ?? 0) + shape.x * fit.scale,
      y: (containerRect?.top ?? 0) + shape.y * fit.scale,
      value: shape.text,
    });
  }

  function commitEditingText() {
    if (!editingText) return;
    onStateChange(updateShape(state, editingText.id, { text: editingText.value }));
    setEditingText(null);
  }

  function handleMouseDown(e: any) {
    if (state.tool === "select") {
      // Clicked empty canvas: clear selection instead of leaving a stale one.
      if (e.target === e.target.getStage()) {
        onStateChange(selectShape(state, null));
      }
      return;
    }
    // getRelativePointerPosition (not getPointerPosition) accounts for the
    // Stage's fit-to-panel scale, so shapes are always created/tracked in
    // the image's native pixel coordinates regardless of display size.
    const pos = e.target.getStage().getRelativePointerPosition();
    const id = newId();
    if (state.tool === "text") {
      // Prevent the native mousedown from shifting focus to the canvas —
      // that fight is what was stealing focus back from the textarea below.
      e.evt?.preventDefault?.();
      const shape: TextShape = { id, type: "text", color, strokeWidth, x: pos.x, y: pos.y, text: "", fontSize: 20 };
      onStateChange(selectShape(setTool(addShape(state, shape), "select"), shape.id));
      startEditingText(shape);
      return;
    }
    let shape: Shape;
    if (state.tool === "arrow") {
      shape = { id, type: "arrow", color, strokeWidth, points: [pos.x, pos.y, pos.x, pos.y] };
    } else if (state.tool === "pen" || state.tool === "highlighter") {
      shape = {
        id,
        type: state.tool,
        color,
        strokeWidth: state.tool === "highlighter" ? strokeWidth * 4 : strokeWidth,
        points: [pos.x, pos.y],
      };
    } else if (state.tool === "rect" || state.tool === "ellipse" || state.tool === "blur" || state.tool === "crop") {
      shape = {
        id,
        type: state.tool,
        color,
        strokeWidth,
        x: pos.x,
        y: pos.y,
        width: 0,
        height: 0,
      };
    } else {
      return;
    }
    drawing.current = id;
    onStateChange(addShape(state, shape));
  }

  function handleMouseMove(e: any) {
    if (!drawing.current) return;
    const pos = e.target.getStage().getRelativePointerPosition();
    // The shape being drawn is always the last item in the array.
    const idx = state.shapes.length - 1;
    const current = state.shapes[idx];
    if (!current || current.id !== drawing.current) return;
    let updated: Shape;
    if (current.type === "arrow") {
      updated = { ...current, points: [current.points[0], current.points[1], pos.x, pos.y] };
    } else if (current.type === "pen" || current.type === "highlighter") {
      updated = { ...current, points: [...current.points, pos.x, pos.y] };
    } else if (current.type === "rect" || current.type === "ellipse" || current.type === "blur" || current.type === "crop") {
      updated = { ...current, width: pos.x - current.x, height: pos.y - current.y };
    } else {
      return;
    }
    const shapes = state.shapes.slice();
    shapes[idx] = updated;
    onStateChange({ ...state, shapes });
  }

  function handleMouseUp() {
    if (drawing.current) {
      drawing.current = null;
      onStateChange(setTool(state, "select"));
    }
  }

  return (
    <div ref={containerRef} className="canvas-panel" style={{ position: "relative" }}>
      <Stage
        ref={ref}
        width={image ? fit.width : 800}
        height={image ? fit.height : 600}
        scaleX={fit.scale}
        scaleY={fit.scale}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <Layer>
          {image && <KonvaImage image={image} />}
          {state.shapes.map((shape) => {
            const selected = state.selectedId === shape.id;
            const draggable = state.tool === "select";
            if (shape.type === "arrow") {
              return (
                <Arrow
                  key={shape.id}
                  points={shape.points}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  fill={shape.color}
                  hitStrokeWidth={Math.max(shape.strokeWidth, 16)}
                  onClick={() => select(shape.id)}
                  onTap={() => select(shape.id)}
                  {...(selected ? SELECTED_SHADOW : {})}
                />
              );
            }
            if (shape.type === "pen" || shape.type === "highlighter") {
              return (
                <Line
                  key={shape.id}
                  points={shape.points}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  opacity={shape.type === "highlighter" ? 0.4 : 1}
                  lineCap="round"
                  lineJoin="round"
                  tension={0}
                  hitStrokeWidth={Math.max(shape.strokeWidth, 16)}
                  onClick={() => select(shape.id)}
                  onTap={() => select(shape.id)}
                  {...(selected ? SELECTED_SHADOW : {})}
                />
              );
            }
            if (shape.type === "crop") {
              return (
                <Rect
                  key={shape.id}
                  name="crop-shape"
                  x={shape.x}
                  y={shape.y}
                  width={shape.width}
                  height={shape.height}
                  stroke="#fff"
                  dash={[6, 4]}
                  strokeWidth={1}
                />
              );
            }
            if (shape.type === "rect") {
              return (
                <Rect
                  key={shape.id}
                  x={shape.x}
                  y={shape.y}
                  width={shape.width}
                  height={shape.height}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  draggable={draggable}
                  onClick={() => select(shape.id)}
                  onTap={() => select(shape.id)}
                  onDragEnd={(e) => onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }))}
                  {...(selected ? SELECTED_SHADOW : {})}
                />
              );
            }
            if (shape.type === "ellipse") {
              return (
                <Ellipse
                  key={shape.id}
                  x={shape.x + shape.width / 2}
                  y={shape.y + shape.height / 2}
                  radiusX={Math.abs(shape.width) / 2}
                  radiusY={Math.abs(shape.height) / 2}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  draggable={draggable}
                  onClick={() => select(shape.id)}
                  onTap={() => select(shape.id)}
                  onDragEnd={(e) =>
                    onStateChange(
                      updateShape(state, shape.id, {
                        x: e.target.x() - shape.width / 2,
                        y: e.target.y() - shape.height / 2,
                      }),
                    )
                  }
                  {...(selected ? SELECTED_SHADOW : {})}
                />
              );
            }
            if (shape.type === "blur" && image) {
              return (
                <BlurRegion
                  key={shape.id}
                  image={image}
                  shape={shape}
                  selected={selected}
                  onSelect={() => select(shape.id)}
                  onDragEnd={(x, y) => onStateChange(updateShape(state, shape.id, { x, y }))}
                />
              );
            }
            if (shape.type === "text") {
              if (editingText?.id === shape.id) return null;
              return (
                <Text
                  key={shape.id}
                  x={shape.x}
                  y={shape.y}
                  text={shape.text}
                  fontSize={shape.fontSize}
                  fill={shape.color}
                  draggable
                  onClick={() => select(shape.id)}
                  onTap={() => select(shape.id)}
                  onDragEnd={(e) => onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }))}
                  onDblClick={() => startEditingText(shape)}
                  onDblTap={() => startEditingText(shape)}
                  {...(selected ? SELECTED_SHADOW : {})}
                />
              );
            }
            return null;
          })}
        </Layer>
      </Stage>
      {editingText && (
        <textarea
          ref={textareaRef}
          rows={1}
          value={editingText.value}
          onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
          onBlur={commitEditingText}
          onKeyDown={(e) => {
            // Plain Enter inserts a newline (default behavior); commit
            // explicitly with Cmd/Ctrl+Enter, cancel with Escape.
            if (e.key === "Escape") {
              e.preventDefault();
              setEditingText(null);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commitEditingText();
            }
          }}
          style={{
            position: "fixed",
            left: editingText.x,
            top: editingText.y,
            minWidth: 120,
            fontSize: 20 * fit.scale,
            fontFamily: "sans-serif",
            lineHeight: 1.2,
            border: "1px solid #3b82f6",
            padding: 2,
            resize: "both",
            zIndex: 1000,
          }}
        />
      )}
    </div>
  );
});

export default AnnotationCanvas;

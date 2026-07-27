import { forwardRef, Fragment, useEffect, useRef, useState } from "react";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Arrow,
  Rect,
  Ellipse,
  Line,
  Text,
  Label,
  Tag,
  Circle,
  Transformer,
} from "react-konva";
import useImage from "use-image";
import Konva from "konva";
import rough from "roughjs/bin/rough";
import type { Drawable } from "roughjs/bin/core";
import type { BoxShape, EditorState, PointShape, Shape, TextShape, ToolType } from "./toolState";
import { addShape, removeShape, selectShape, setTool, updateShape } from "./toolState";

const roughGenerator = rough.generator();

// Konva calls a custom sceneFunc every redraw (including every frame of a
// drag), so the sketchy wobble has to be deterministic per shape rather than
// re-randomized each time — otherwise the outline would visibly jitter while
// idle or dragging. Seeding rough.js from a hash of the shape's own id keeps
// the same shape's wobble stable across redraws while still varying shape to
// shape.
function seedFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

// Shared by the arrow and line tools — both are plain two-point shapes whose
// endpoints can be dragged individually while selected.
function EndpointHandles({
  points,
  onPointsChange,
}: {
  points: number[];
  onPointsChange: (points: number[]) => void;
}) {
  return (
    <>
      <Circle
        x={points[0]}
        y={points[1]}
        radius={6}
        fill="#3b82f6"
        stroke="#fff"
        strokeWidth={1}
        draggable
        onDragMove={(e) => onPointsChange([e.target.x(), e.target.y(), points[2], points[3]])}
      />
      <Circle
        x={points[2]}
        y={points[3]}
        radius={6}
        fill="#3b82f6"
        stroke="#fff"
        strokeWidth={1}
        draggable
        onDragMove={(e) => onPointsChange([points[0], points[1], e.target.x(), e.target.y()])}
      />
    </>
  );
}

// Averages each interior point with its neighbors so freehand pen/highlighter
// strokes flow smoothly despite the mouse-sampled points being jittery, while
// leaving the very first/last point untouched so the stroke still starts and
// ends exactly where drawn.
function smoothPoints(points: number[]): number[] {
  if (points.length <= 4) return points;
  const smoothed = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    smoothed.push(
      (points[i - 2] + points[i] + points[i + 2]) / 3,
      (points[i - 1] + points[i + 1] + points[i + 3]) / 3,
    );
  }
  smoothed.push(points[points.length - 2], points[points.length - 1]);
  return smoothed;
}

function appendRoughPath(context: Konva.Context, drawable: Drawable) {
  drawable.sets.forEach((set) => {
    if (set.type !== "path") return;
    set.ops.forEach(({ op, data }) => {
      if (op === "move") context.moveTo(data[0], data[1]);
      else if (op === "lineTo") context.lineTo(data[0], data[1]);
      else if (op === "bcurveTo") context.bezierCurveTo(data[0], data[1], data[2], data[3], data[4], data[5]);
    });
  });
}

// Replays one or more rough.js Drawables' stroke outlines onto a Konva
// context as a single path, then hands off to strokeShape so Konva still
// applies the node's own stroke/strokeWidth attrs (and swaps in its hit-test
// color when drawing the hit canvas) exactly as it would for a plain
// built-in shape.
function drawRoughDrawable(context: Konva.Context, shapeNode: Konva.Shape, ...drawables: Drawable[]) {
  context.beginPath();
  drawables.forEach((drawable) => {
    appendRoughPath(context, drawable);
  });
  context.strokeShape(shapeNode);
}

const TOOL_HOTKEYS: Record<string, ToolType> = {
  r: "rect",
  o: "ellipse",
  t: "text",
  b: "blur",
  c: "crop",
  p: "pen",
  a: "arrow",
  l: "line",
  h: "highlighter",
};

const SELECTED_SHADOW = {
  shadowColor: "#3b82f6",
  shadowBlur: 10,
  shadowOpacity: 0.9,
  shadowEnabled: true,
};

function isDarkColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

// Builds a mosaic/pixelated copy of the whole source image once, up front,
// rather than pixelating each blur box individually. A blur box is then just
// a crop window into this static canvas that tracks its own position — so
// dragging it live reveals whatever pixelated content is now underneath,
// instead of dragging around a frozen snapshot rendered at the box's old
// location (which is what made moving an existing blur look so wrong).
function usePixelatedImage(image: HTMLImageElement | undefined, pixelSize: number): HTMLCanvasElement | null {
  const [pixelated, setPixelated] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!image) return;
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(image.width / pixelSize));
    small.height = Math.max(1, Math.round(image.height / pixelSize));
    const smallCtx = small.getContext("2d");
    if (!smallCtx) return;
    smallCtx.drawImage(image, 0, 0, small.width, small.height);

    const big = document.createElement("canvas");
    big.width = image.width;
    big.height = image.height;
    const bigCtx = big.getContext("2d");
    if (!bigCtx) return;
    bigCtx.imageSmoothingEnabled = false;
    bigCtx.drawImage(small, 0, 0, big.width, big.height);
    setPixelated(big);
  }, [image, pixelSize]);
  return pixelated;
}

function BlurRegion({ pixelatedImage, shape, selected, onSelect, onDragEnd, registerNode, onTransformEnd }: {
  pixelatedImage: HTMLCanvasElement;
  shape: BoxShape;
  selected: boolean;
  onSelect: () => void;
  onDragEnd: (x: number, y: number) => void;
  registerNode: (node: Konva.Image | null) => void;
  onTransformEnd: (node: Konva.Image) => void;
}) {
  const x = Math.min(shape.x, shape.x + shape.width);
  const y = Math.min(shape.y, shape.y + shape.height);
  const width = Math.abs(shape.width);
  const height = Math.abs(shape.height);

  if (width <= 0 || height <= 0) return null;

  return (
    <KonvaImage
      ref={registerNode}
      image={pixelatedImage}
      x={x}
      y={y}
      width={width}
      height={height}
      crop={{ x, y, width, height }}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      // Keep the crop window glued to the box's live position while
      // dragging, so it always shows the pixelated content directly
      // beneath it rather than the content from where the drag started.
      onDragMove={(e) => {
        const node = e.target as Konva.Image;
        node.crop({ x: node.x(), y: node.y(), width, height });
      }}
      onDragEnd={(e) => onDragEnd(e.target.x(), e.target.y())}
      onTransformEnd={(e) => onTransformEnd(e.target as Konva.Image)}
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
  const pixelatedImage = usePixelatedImage(image, 12);
  const drawing = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingText, setEditingText] = useState<{ id: string; x: number; y: number; value: string; fontSize: number } | null>(
    null,
  );

  // Resizable shapes (rect/ellipse/blur) register their live Konva node here
  // so the shared Transformer below can attach to whichever one is selected.
  const shapeNodeRefs = useRef<Record<string, Konva.Node>>({});
  const transformerRef = useRef<Konva.Transformer>(null);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = state.selectedId ? shapeNodeRefs.current[state.selectedId] : undefined;
    transformer.nodes(state.tool === "select" && node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [state.selectedId, state.tool]);

  function registerShapeNode(id: string, node: Konva.Node | null) {
    if (node) {
      shapeNodeRefs.current[id] = node;
    } else {
      delete shapeNodeRefs.current[id];
    }
  }

  // Shared by rect and the blur region — both are plain x/y/width/height
  // boxes, so a resize just reads the node's post-drag scale back into an
  // absolute size and resets the node's own scale to 1 (Konva's Transformer
  // resizes by scaling the node, not by changing width/height directly).
  function handleBoxTransformEnd(shape: BoxShape, node: Konva.Node) {
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    onStateChange(
      updateShape(state, shape.id, {
        x: node.x(),
        y: node.y(),
        width: node.width() * scaleX,
        height: node.height() * scaleY,
      }),
    );
  }

  function handleEllipseTransformEnd(shape: BoxShape, node: Konva.Ellipse) {
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    const radiusX = node.radiusX() * scaleX;
    const radiusY = node.radiusY() * scaleY;
    onStateChange(
      updateShape(state, shape.id, {
        x: node.x() - radiusX,
        y: node.y() - radiusY,
        width: radiusX * 2,
        height: radiusY * 2,
      }),
    );
  }

  function handleArrowDragEnd(shape: PointShape, node: Konva.Node) {
    const dx = node.x();
    const dy = node.y();
    node.position({ x: 0, y: 0 });
    onStateChange(
      updateShape(state, shape.id, {
        points: shape.points.map((p, i) => p + (i % 2 === 0 ? dx : dy)),
      }),
    );
  }

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
      autosizeTextarea();
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
      fontSize: shape.fontSize,
    });
  }

  function autosizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
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
      const shape: TextShape = {
        id,
        type: "text",
        color,
        strokeWidth,
        x: pos.x,
        y: pos.y,
        text: "",
        fontSize: 17 + strokeWidth * 3,
        background: false,
      };
      onStateChange(selectShape(setTool(addShape(state, shape), "select"), shape.id));
      startEditingText(shape);
      return;
    }
    let shape: Shape;
    if (state.tool === "arrow" || state.tool === "line") {
      shape = { id, type: state.tool, color, strokeWidth, points: [pos.x, pos.y, pos.x, pos.y] };
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
    if (current.type === "arrow" || current.type === "line") {
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

  // Blur regions always draw directly on top of the base image, underneath
  // every other annotation, regardless of the order they were drawn in —
  // otherwise a blur added after other shapes would cover them up. Array
  // sort is stable, so shapes within each group keep their relative order.
  const orderedShapes = [...state.shapes].sort(
    (a, b) => (a.type === "blur" ? 0 : 1) - (b.type === "blur" ? 0 : 1),
  );

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
          {image && <KonvaImage image={image} listening={false} />}
          {orderedShapes.map((shape) => {
            const selected = state.selectedId === shape.id;
            const draggable = state.tool === "select";
            if (shape.type === "arrow") {
              return (
                <Fragment key={shape.id}>
                  <Arrow
                    points={shape.points}
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth}
                    fill={shape.color}
                    hitStrokeWidth={Math.max(shape.strokeWidth, 16)}
                    draggable={draggable}
                    onClick={() => select(shape.id)}
                    onTap={() => select(shape.id)}
                    onDragEnd={(e) => handleArrowDragEnd(shape, e.target)}
                    sceneFunc={(context, shapeNode) => {
                      const [x1, y1, x2, y2] = shape.points;
                      const seed = seedFromId(shape.id);
                      const angle = Math.atan2(y2 - y1, x2 - x1);
                      const headLength = Math.max(21, shape.strokeWidth * 3.75);
                      const headAngle = Math.PI / 7;
                      const leftX = x2 - headLength * Math.cos(angle - headAngle);
                      const leftY = y2 - headLength * Math.sin(angle - headAngle);
                      const rightX = x2 - headLength * Math.cos(angle + headAngle);
                      const rightY = y2 - headLength * Math.sin(angle + headAngle);
                      const shaft = roughGenerator.line(x1, y1, x2, y2, { seed, roughness: 1.5, bowing: 1 });
                      const headLeft = roughGenerator.line(x2, y2, leftX, leftY, { seed: seed + 1, roughness: 1.5, bowing: 1 });
                      const headRight = roughGenerator.line(x2, y2, rightX, rightY, { seed: seed + 2, roughness: 1.5, bowing: 1 });
                      drawRoughDrawable(context, shapeNode, shaft, headLeft, headRight);
                    }}
                    {...(selected ? SELECTED_SHADOW : {})}
                  />
                  {selected && draggable && (
                    <EndpointHandles
                      points={shape.points}
                      onPointsChange={(points) => onStateChange(updateShape(state, shape.id, { points }))}
                    />
                  )}
                </Fragment>
              );
            }
            if (shape.type === "line") {
              return (
                <Fragment key={shape.id}>
                  <Line
                    points={shape.points}
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth}
                    hitStrokeWidth={Math.max(shape.strokeWidth, 16)}
                    draggable={draggable}
                    onClick={() => select(shape.id)}
                    onTap={() => select(shape.id)}
                    onDragEnd={(e) => handleArrowDragEnd(shape, e.target)}
                    sceneFunc={(context, shapeNode) => {
                      const [x1, y1, x2, y2] = shape.points;
                      const drawable = roughGenerator.line(x1, y1, x2, y2, {
                        seed: seedFromId(shape.id),
                        roughness: 1.5,
                        bowing: 1,
                      });
                      drawRoughDrawable(context, shapeNode, drawable);
                    }}
                    {...(selected ? SELECTED_SHADOW : {})}
                  />
                  {selected && draggable && (
                    <EndpointHandles
                      points={shape.points}
                      onPointsChange={(points) => onStateChange(updateShape(state, shape.id, { points }))}
                    />
                  )}
                </Fragment>
              );
            }
            if (shape.type === "pen" || shape.type === "highlighter") {
              return (
                <Line
                  key={shape.id}
                  points={smoothPoints(shape.points)}
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
                  ref={(node) => registerShapeNode(shape.id, node)}
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
                  onTransformEnd={(e) => handleBoxTransformEnd(shape, e.target)}
                  sceneFunc={(context, shapeNode) => {
                    const drawable = roughGenerator.rectangle(0, 0, shape.width, shape.height, {
                      seed: seedFromId(shape.id),
                      roughness: 1.8,
                      bowing: 1.5,
                    });
                    drawRoughDrawable(context, shapeNode, drawable);
                  }}
                  {...(selected ? SELECTED_SHADOW : {})}
                />
              );
            }
            if (shape.type === "ellipse") {
              return (
                <Ellipse
                  key={shape.id}
                  ref={(node) => registerShapeNode(shape.id, node)}
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
                  onTransformEnd={(e) => handleEllipseTransformEnd(shape, e.target as Konva.Ellipse)}
                  {...(selected ? SELECTED_SHADOW : {})}
                />
              );
            }
            if (shape.type === "blur" && pixelatedImage) {
              return (
                <BlurRegion
                  key={shape.id}
                  pixelatedImage={pixelatedImage}
                  shape={shape}
                  selected={selected}
                  onSelect={() => select(shape.id)}
                  onDragEnd={(x, y) => onStateChange(updateShape(state, shape.id, { x, y }))}
                  registerNode={(node) => registerShapeNode(shape.id, node)}
                  onTransformEnd={(node) => handleBoxTransformEnd(shape, node)}
                />
              );
            }
            if (shape.type === "text") {
              if (editingText?.id === shape.id) return null;
              const textProps = {
                text: shape.text,
                fontSize: shape.fontSize,
                fontFamily: "Instrument Sans, sans-serif",
                fontStyle: '600',
              };
              if (shape.background) {
                return (
                  <Label
                    key={shape.id}
                    x={shape.x}
                    y={shape.y}
                    draggable={draggable}
                    onClick={() => select(shape.id)}
                    onTap={() => select(shape.id)}
                    onDragEnd={(e) => onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }))}
                    onDblClick={() => startEditingText(shape)}
                    onDblTap={() => startEditingText(shape)}
                  >
                    <Tag cornerRadius={shape.fontSize * 0.3} fill={shape.color} {...(selected ? SELECTED_SHADOW : {})} />
                    <Text {...textProps} padding={shape.fontSize * 0.35} fill={isDarkColor(shape.color) ? "white" : "black"} />
                  </Label>
                );
              }
              return (
                <Text
                  key={shape.id}
                  x={shape.x}
                  y={shape.y}
                  {...textProps}
                  fill={shape.color}
                  draggable={draggable}
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
          <Transformer ref={transformerRef} rotateEnabled={false} keepRatio={false} />
        </Layer>
      </Stage>
      {editingText &&
        (() => {
          const editingShape = state.shapes.find((s) => s.id === editingText.id);
          const background = editingShape?.type === "text" && editingShape.background ? editingShape.color : "transparent";
          const foreground =
            editingShape?.type === "text" && editingShape.background
              ? isDarkColor(editingShape.color)
                ? "white"
                : "black"
              : "inherit";
          return (
            <textarea
              ref={textareaRef}
              rows={1}
              value={editingText.value}
              onChange={(e) => {
                setEditingText({ ...editingText, value: e.target.value });
                autosizeTextarea();
              }}
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
                fontSize: editingText.fontSize * fit.scale,
                fontFamily: "var(--font)",
                lineHeight: 1.2,
                border: "1px solid #3b82f6",
                padding: 2,
                background,
                color: foreground,
                resize: "both",
                zIndex: 1000,
              }}
            />
          );
        })()}
    </div>
  );
});

export default AnnotationCanvas;

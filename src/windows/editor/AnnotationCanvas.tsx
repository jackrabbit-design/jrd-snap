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
import type { BoxShape, EditorState, ImageShape, PointShape, Shape, TextShape, ToolType } from "./toolState";
import { addShape, removeShape, selectShape, setTool, updateShape } from "./toolState";

const roughGenerator = rough.generator();

// Deliberately gentle — Excalidraw's own default "artist" preset uses
// roughness around 1, which reads as a relaxed hand-drawn wobble rather
// than a jittery sketch. Bump either of these up for more character, or
// down toward 0 for something closer to perfectly geometric.
const ROUGH_ROUGHNESS = 1;
const ROUGH_BOWING = 0.6;

// Konva calls a custom sceneFunc every redraw (including every frame of a
// drag), so the wobble has to be deterministic per shape rather than
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

// A shared offscreen canvas context, reused across calls rather than
// creating one per measurement — text measurement happens on every render
// of every text-with-arrow shape.
let measureContext: CanvasRenderingContext2D | null | undefined;

// Approximates the box a text shape actually renders into (matching Konva
// Text's own auto-sizing: content size plus padding on all sides) well
// enough to anchor a callout arrow's tail to its perimeter. Doesn't attempt
// to simulate word-wrapping for the rare legacy shape with a stored `width`
// — its height estimate only accounts for literal newlines in that case.
function measureTextBox(shape: TextShape): { x: number; y: number; width: number; height: number } {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  const padding = textPadding(shape.fontSize);
  const lines = shape.text.split("\n");
  let contentWidth = 0;
  const ctx = measureContext;
  if (ctx) {
    ctx.font = `600 ${shape.fontSize}px Instrument Sans, sans-serif`;
    contentWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), 1);
  }
  const width = shape.width ?? contentWidth + padding * 2;
  const height = lines.length * shape.fontSize * TEXT_LINE_HEIGHT + padding * 2;
  return { x: shape.x, y: shape.y, width, height };
}

// The closest point on a rectangle's own outline to some other point —
// clamping the point into the rect lands exactly on the nearest edge
// whenever it started outside (the common case for an arrow tip). Snapped
// to 8 compass points (corners + edge midpoints) rather than sliding freely
// along the perimeter — floating anywhere looked unanchored/jittery as the
// tip moved; fixed points read as a deliberate connection.
function closestCompassPoint(
  box: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number },
): { x: number; y: number } {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  const points = [
    { x: left, y: top },
    { x: midX, y: top },
    { x: right, y: top },
    { x: right, y: midY },
    { x: right, y: bottom },
    { x: midX, y: bottom },
    { x: left, y: bottom },
    { x: left, y: midY },
  ];
  return points.reduce((closest, p) => {
    const d = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
    const dClosest = (closest.x - target.x) ** 2 + (closest.y - target.y) ** 2;
    return d < dClosest ? p : closest;
  });
}

// Shared by the standalone arrow tool and the text tool's callout arrow —
// both are a rough.js hand-drawn shaft plus a two-stroke arrowhead at the
// same (x2, y2) tip.
function drawRoughArrow(
  context: Konva.Context,
  shapeNode: Konva.Shape,
  points: number[],
  seed: number,
  strokeWidth: number,
) {
  const [x1, y1, x2, y2] = points;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLength = Math.max(21, strokeWidth * 3.75);
  const headAngle = Math.PI / 7;
  const leftX = x2 - headLength * Math.cos(angle - headAngle);
  const leftY = y2 - headLength * Math.sin(angle - headAngle);
  const rightX = x2 - headLength * Math.cos(angle + headAngle);
  const rightY = y2 - headLength * Math.sin(angle + headAngle);
  const opts = { seed, roughness: ROUGH_ROUGHNESS, bowing: ROUGH_BOWING };
  const shaft = roughGenerator.line(x1, y1, x2, y2, opts);
  const headLeft = roughGenerator.line(x2, y2, leftX, leftY, { ...opts, seed: seed + 1 });
  const headRight = roughGenerator.line(x2, y2, rightX, rightY, { ...opts, seed: seed + 2 });
  drawRoughDrawable(context, shapeNode, shaft, headLeft, headRight);
}

// An SVG path string for a rounded rectangle, fed to rough.js's path()
// generator (rather than its plain rectangle(), which has no corner-radius
// option) so the rect tool keeps its rounded corners *and* picks up the
// same hand-drawn wobble as everything else. width/height can be negative
// (dragged up/left from the start point) — same as Konva's own Rect, which
// draws in that direction natively — so this works in the shape's own
// magnitude-agnostic local box rather than assuming a positive width/height
// starting at (0,0).
function roundedRectPath(width: number, height: number, radius: number): string {
  const w = Math.abs(width);
  const h = Math.abs(height);
  const r = Math.min(radius, w / 2, h / 2);
  const ox = Math.min(0, width);
  const oy = Math.min(0, height);
  const left = ox;
  const right = ox + w;
  const top = oy;
  const bottom = oy + h;
  return (
    `M${left + r},${top} H${right - r} Q${right},${top} ${right},${top + r} ` +
    `V${bottom - r} Q${right},${bottom} ${right - r},${bottom} H${left + r} ` +
    `Q${left},${bottom} ${left},${bottom - r} V${top + r} Q${left},${top} ${left + r},${top} Z`
  );
}

// A single draggable endpoint, for shapes with a fixed tail (the text
// callout arrow) — unlike EndpointHandles, only the tip is ever adjustable,
// since the tail is always derived from the text shape's own position.
function TipHandle({
  x,
  y,
  onPositionChange,
  onBeginContinuousEdit,
  onEndContinuousEdit,
}: {
  x: number;
  y: number;
  onPositionChange: (x: number, y: number) => void;
  onBeginContinuousEdit?: () => void;
  onEndContinuousEdit?: () => void;
}) {
  return (
    <Circle
      x={x}
      y={y}
      radius={6}
      fill="#3b82f6"
      stroke="#fff"
      strokeWidth={1}
      draggable
      onDragStart={() => onBeginContinuousEdit?.()}
      onDragMove={(e) => onPositionChange(e.target.x(), e.target.y())}
      onDragEnd={() => onEndContinuousEdit?.()}
    />
  );
}

// Shared by the arrow and line tools — both are plain two-point shapes whose
// endpoints can be dragged individually while selected.
function EndpointHandles({
  points,
  onPointsChange,
  onBeginContinuousEdit,
  onEndContinuousEdit,
}: {
  points: number[];
  onPointsChange: (points: number[]) => void;
  onBeginContinuousEdit?: () => void;
  onEndContinuousEdit?: () => void;
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
        onDragStart={() => onBeginContinuousEdit?.()}
        onDragMove={(e) => onPointsChange([e.target.x(), e.target.y(), points[2], points[3]])}
        onDragEnd={() => onEndContinuousEdit?.()}
      />
      <Circle
        x={points[2]}
        y={points[3]}
        radius={6}
        fill="#3b82f6"
        stroke="#fff"
        strokeWidth={1}
        draggable
        onDragStart={() => onBeginContinuousEdit?.()}
        onDragMove={(e) => onPointsChange([points[0], points[1], e.target.x(), e.target.y()])}
        onDragEnd={() => onEndContinuousEdit?.()}
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

// Applied to text uniformly whether or not it has a background, so toggling
// the background doesn't shift the glyphs — only the box behind them.
const TEXT_LINE_HEIGHT = 1.2;
function textPadding(fontSize: number): number {
  return fontSize * 0.35;
}

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

function BlurRegion({ pixelatedImage, shape, selected, hovered, onSelect, onDragEnd, registerNode, onTransformEnd }: {
  pixelatedImage: HTMLCanvasElement;
  shape: BoxShape;
  selected: boolean;
  hovered: boolean;
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
      id={shape.id}
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
      {...((selected || hovered) ? SELECTED_SHADOW : {})}
    />
  );
}

// A screenshot pasted on top of the base capture via the "add screenshot"
// tool — draggable/resizable like any other shape, but rendered as an
// actual image rather than a drawn annotation. Loads its own bitmap via
// useImage() (one hook call per shape instance, via this dedicated
// component) rather than trying to call the hook from inside the shapes
// .map() in the parent, which would break the rules of hooks.
function FloatingImage({ shape, selected, hovered, draggable, onSelect, onDragEnd, registerNode, onTransformEnd }: {
  shape: ImageShape;
  selected: boolean;
  hovered: boolean;
  draggable: boolean;
  onSelect: () => void;
  onDragEnd: (x: number, y: number) => void;
  registerNode: (node: Konva.Image | null) => void;
  onTransformEnd: (node: Konva.Image) => void;
}) {
  const [image] = useImage(shape.src);
  if (!image) return null;

  return (
    <KonvaImage
      id={shape.id}
      ref={registerNode}
      image={image}
      x={shape.x}
      y={shape.y}
      width={shape.width}
      height={shape.height}
      draggable={draggable}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => onDragEnd(e.target.x(), e.target.y())}
      onTransformEnd={(e) => onTransformEnd(e.target as Konva.Image)}
      {...((selected || hovered) ? SELECTED_SHADOW : {})}
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
  // Bracket a new shape being drawn out (mousedown through mouseup), so the
  // parent's undo history can treat the whole drag as one step instead of
  // one step per intermediate mousemove — dragging an *existing* shape
  // doesn't need this since Konva only reports its position once, on
  // release, not continuously.
  onBeginContinuousEdit?: () => void;
  onEndContinuousEdit?: () => void;
}

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `shape-${nextId}`;
}

const AnnotationCanvas = forwardRef<Konva.Stage, Props>(function AnnotationCanvas(
  { imageSrc, state, color, strokeWidth, onStateChange, onScaleChange, onBeginContinuousEdit, onEndContinuousEdit },
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

  // Hovering an existing annotation makes it behave like the select tool is
  // active for that annotation specifically, regardless of which tool is
  // actually selected — so switching tools to draw something else doesn't
  // stop you from nudging/resizing a shape you're pointing at.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const selectedShape = state.shapes.find((s) => s.id === state.selectedId);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = state.selectedId ? shapeNodeRefs.current[state.selectedId] : undefined;
    const showTransformer = state.tool === "select" || hoveredId === state.selectedId;
    transformer.nodes(showTransformer && node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [state.selectedId, state.tool, hoveredId]);

  function registerShapeNode(id: string, node: Konva.Node | null) {
    if (node) {
      shapeNodeRefs.current[id] = node;
    } else {
      delete shapeNodeRefs.current[id];
    }
  }

  // Shared by rect, the blur region, and floating images — all are plain
  // x/y/width/height boxes, so a resize just reads the node's post-drag
  // scale back into an absolute size and resets the node's own scale to 1
  // (Konva's Transformer resizes by scaling the node, not by changing
  // width/height directly). Only shape.id is used, so this accepts any
  // shape rather than specifically BoxShape.
  function handleBoxTransformEnd(shape: { id: string }, node: Konva.Node) {
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

  // Delete/Backspace removes whatever's selected — not gated on the active
  // tool being "select", since hovering a shape already lets you select it
  // (and drag/resize it) no matter which tool is active; requiring tool
  // === "select" here too meant Delete silently did nothing for a shape
  // selected that way. Bare letter keys switch tools. Both are disabled
  // while editing text or while any other input/textarea has focus, so
  // typing a shape's name doesn't yank the active tool out from under you.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (editingText) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
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
    if (state.tool === "select" || hoveredId === id) onStateChange(selectShape(state, id));
  }

  function startEditingText(shape: TextShape) {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const padding = textPadding(shape.fontSize) * fit.scale;
    setEditingText({
      id: shape.id,
      x: (containerRect?.left ?? 0) + shape.x * fit.scale + padding,
      y: (containerRect?.top ?? 0) + shape.y * fit.scale + padding,
      value: shape.text,
      fontSize: shape.fontSize,
    });
  }

  // Grows the textarea to fit its content in both directions — there's no
  // fixed box to wrap within any more, so a line just keeps growing wider
  // as you type and only breaks on a real newline. Resetting to a small
  // size before reading scroll{Width,Height} is required in both axes:
  // browsers report the *larger* of the current size and the content size,
  // so without the reset the box would grow but never shrink back down as
  // text is deleted.
  function autosizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.width = "0px";
    el.style.height = "auto";
    el.style.width = `${el.scrollWidth + 2}px`;
    el.style.height = `${el.scrollHeight}px`;
  }

  // Shared by the textarea's onBlur and by handleMouseDown's "clicked
  // elsewhere while still editing" case, so both paths commit the same way
  // — a previous version duplicated a simplified copy of this in
  // handleMouseDown, which was easy to let drift out of sync.
  //
  // Unlike the other tools, text reverts to "select" once you're done with
  // it (rather than staying on "text") — placing text is a modal edit
  // session, not a quick single-gesture shape, and this also keeps
  // handleMouseDown's "click elsewhere to finish" from itself being
  // interpreted as the start of a brand new text box.
  function commitTextInto(base: EditorState): EditorState {
    if (!editingText) return base;
    return setTool(updateShape(base, editingText.id, { text: editingText.value }), "select");
  }

  function commitEditingText() {
    if (!editingText) return;
    onStateChange(commitTextInto(state));
    setEditingText(null);
  }

  function handleMouseDown(e: any) {
    // Since the active tool no longer auto-switches to "select" once a text
    // box is created, clicking elsewhere while still on the text tool falls
    // through to the shape-creation branch below instead of the click
    // naturally blurring (and thereby committing) the textarea — the same
    // <textarea> DOM node just gets reused for the new text box, discarding
    // whatever was typed into the previous one before it ever blurs. Commit
    // any in-progress text edit into the base state up front so every path
    // below (creating another shape, selecting something else, or just
    // deselecting) starts from a state that already has it saved.
    let baseState = state;
    if (editingText) {
      baseState = commitTextInto(baseState);
      setEditingText(null);
    }
    // Recomputed from baseState rather than using the outer `selectLike`:
    // committing a text edit just above can flip baseState.tool to "select"
    // on its own, and if that's not accounted for here, this click falls
    // through to the shape-creation logic below, which returns without ever
    // calling onStateChange when the (now-"select") tool matches nothing —
    // silently dropping the just-committed text change entirely.
    const selectLikeNow = baseState.tool === "select" || hoveredId !== null;
    if (selectLikeNow) {
      // Clicked empty canvas: clear selection instead of leaving a stale one.
      // (No-op when this is select-like because of hovering a shape, since
      // then e.target is that shape, not the stage.)
      if (e.target === e.target.getStage()) {
        onStateChange(selectShape(baseState, null));
      } else if (baseState !== state) {
        onStateChange(baseState);
      }
      return;
    }
    // getRelativePointerPosition (not getPointerPosition) accounts for the
    // Stage's fit-to-panel scale, so shapes are always created/tracked in
    // the image's native pixel coordinates regardless of display size.
    const pos = e.target.getStage().getRelativePointerPosition();
    const id = newId();
    if (baseState.tool === "text") {
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
      onStateChange(selectShape(addShape(baseState, shape), shape.id));
      startEditingText(shape);
      return;
    }
    let shape: Shape;
    if (baseState.tool === "arrow" || baseState.tool === "line") {
      shape = { id, type: baseState.tool, color, strokeWidth, points: [pos.x, pos.y, pos.x, pos.y] };
    } else if (baseState.tool === "pen" || baseState.tool === "highlighter") {
      shape = {
        id,
        type: baseState.tool,
        color,
        strokeWidth: baseState.tool === "highlighter" ? strokeWidth * 4 : strokeWidth,
        points: [pos.x, pos.y],
      };
    } else if (baseState.tool === "rect" || baseState.tool === "ellipse" || baseState.tool === "blur" || baseState.tool === "crop") {
      shape = {
        id,
        type: baseState.tool,
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
    onBeginContinuousEdit?.();
    onStateChange(addShape(baseState, shape));
  }

  function handleMouseMove(e: any) {
    // Each shape node below has a Konva `id` (distinct from the React key)
    // matching its shape id, so the node currently under the pointer tells
    // us directly which annotation (if any) is being hovered.
    const target = e.target;
    setHoveredId(target !== target.getStage() ? target.id() || null : null);
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
      onEndContinuousEdit?.();
    }
  }

  // Fallback for a mouseup that lands outside the Stage (releasing a fast
  // drag past the canvas edge) — the Stage's own onMouseUp above wouldn't
  // fire for that, leaving drawing.current (and the parent's undo-history
  // suppression) stuck on indefinitely, silently swallowing every edit
  // after it into one never-ending "still drawing" span. Runs after the
  // Stage's own handler for the same physical event when it does fire, so
  // it's a no-op then (drawing.current already null).
  useEffect(() => {
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  });

  // Layering is independent of draw/capture order: blur regions always sit
  // directly on top of the base image (otherwise a blur added after other
  // annotations would cover them up); floating screenshots sit above that
  // but below every other annotation type, per the "add screenshot" tool's
  // whole point — pasting reference material underneath your annotations,
  // not on top of them. Array sort is stable, so shapes within each of
  // those groups keep their own relative (i.e. draw/capture) order.
  function shapeRank(type: Shape["type"]): number {
    if (type === "blur") return 0;
    if (type === "image") return 1;
    return 2;
  }
  const orderedShapes = [...state.shapes].sort((a, b) => shapeRank(a.type) - shapeRank(b.type));

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
        onMouseLeave={() => setHoveredId(null)}
      >
        <Layer>
          {image && <KonvaImage image={image} listening={false} />}
          {orderedShapes.map((shape) => {
            const selected = state.selectedId === shape.id;
            const hovered = hoveredId === shape.id;
            const draggable = state.tool === "select" || hovered;
            if (shape.type === "arrow") {
              return (
                <Fragment key={shape.id}>
                  <Arrow
                    id={shape.id}
                    points={shape.points}
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth}
                    fill={shape.color}
                    lineCap="round"
                    lineJoin="round"
                    hitStrokeWidth={Math.max(shape.strokeWidth, 16)}
                    draggable={draggable}
                    onClick={() => select(shape.id)}
                    onTap={() => select(shape.id)}
                    onDragEnd={(e) => handleArrowDragEnd(shape, e.target)}
                    sceneFunc={(context, shapeNode) => {
                      drawRoughArrow(context, shapeNode, shape.points, seedFromId(shape.id), shape.strokeWidth);
                    }}
                    {...((selected || hovered) ? SELECTED_SHADOW : {})}
                  />
                  {selected && draggable && (
                    <EndpointHandles
                      points={shape.points}
                      onPointsChange={(points) => onStateChange(updateShape(state, shape.id, { points }))}
                      onBeginContinuousEdit={onBeginContinuousEdit}
                      onEndContinuousEdit={onEndContinuousEdit}
                    />
                  )}
                </Fragment>
              );
            }
            if (shape.type === "line") {
              return (
                <Fragment key={shape.id}>
                  <Line
                    id={shape.id}
                    points={shape.points}
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth}
                    lineCap="round"
                    lineJoin="round"
                    hitStrokeWidth={Math.max(shape.strokeWidth, 16)}
                    draggable={draggable}
                    onClick={() => select(shape.id)}
                    onTap={() => select(shape.id)}
                    onDragEnd={(e) => handleArrowDragEnd(shape, e.target)}
                    sceneFunc={(context, shapeNode) => {
                      const [x1, y1, x2, y2] = shape.points;
                      const drawable = roughGenerator.line(x1, y1, x2, y2, {
                        seed: seedFromId(shape.id),
                        roughness: ROUGH_ROUGHNESS,
                        bowing: ROUGH_BOWING,
                      });
                      drawRoughDrawable(context, shapeNode, drawable);
                    }}
                    {...((selected || hovered) ? SELECTED_SHADOW : {})}
                  />
                  {selected && draggable && (
                    <EndpointHandles
                      points={shape.points}
                      onPointsChange={(points) => onStateChange(updateShape(state, shape.id, { points }))}
                      onBeginContinuousEdit={onBeginContinuousEdit}
                      onEndContinuousEdit={onEndContinuousEdit}
                    />
                  )}
                </Fragment>
              );
            }
            if (shape.type === "pen" || shape.type === "highlighter") {
              return (
                <Line
                  key={shape.id}
                  id={shape.id}
                  points={smoothPoints(shape.points)}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  opacity={shape.type === "highlighter" ? 0.4 : 1}
                  lineCap="round"
                  lineJoin="round"
                  tension={0}
                  hitStrokeWidth={Math.max(shape.strokeWidth, 16)}
                  draggable={draggable}
                  onClick={() => select(shape.id)}
                  onTap={() => select(shape.id)}
                  onDragEnd={(e) => handleArrowDragEnd(shape, e.target)}
                  {...((selected || hovered) ? SELECTED_SHADOW : {})}
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
                  id={shape.id}
                  ref={(node) => registerShapeNode(shape.id, node)}
                  x={shape.x}
                  y={shape.y}
                  width={shape.width}
                  height={shape.height}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  lineJoin="round"
                  draggable={draggable}
                  onClick={() => select(shape.id)}
                  onTap={() => select(shape.id)}
                  onDragEnd={(e) => onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }))}
                  onTransformEnd={(e) => handleBoxTransformEnd(shape, e.target)}
                  sceneFunc={(context, shapeNode) => {
                    const drawable = roughGenerator.path(roundedRectPath(shape.width, shape.height, 10), {
                      seed: seedFromId(shape.id),
                      roughness: ROUGH_ROUGHNESS,
                      bowing: ROUGH_BOWING,
                    });
                    drawRoughDrawable(context, shapeNode, drawable);
                  }}
                  {...((selected || hovered) ? SELECTED_SHADOW : {})}
                />
              );
            }
            if (shape.type === "ellipse") {
              return (
                <Ellipse
                  key={shape.id}
                  id={shape.id}
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
                  sceneFunc={(context, shapeNode) => {
                    const drawable = roughGenerator.ellipse(0, 0, Math.abs(shape.width), Math.abs(shape.height), {
                      seed: seedFromId(shape.id),
                      roughness: ROUGH_ROUGHNESS,
                      bowing: ROUGH_BOWING,
                    });
                    drawRoughDrawable(context, shapeNode, drawable);
                  }}
                  {...((selected || hovered) ? SELECTED_SHADOW : {})}
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
                  hovered={hovered}
                  onSelect={() => select(shape.id)}
                  onDragEnd={(x, y) => onStateChange(updateShape(state, shape.id, { x, y }))}
                  registerNode={(node) => registerShapeNode(shape.id, node)}
                  onTransformEnd={(node) => handleBoxTransformEnd(shape, node)}
                />
              );
            }
            if (shape.type === "image") {
              return (
                <FloatingImage
                  key={shape.id}
                  shape={shape}
                  selected={selected}
                  hovered={hovered}
                  draggable={draggable}
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
                lineHeight: TEXT_LINE_HEIGHT,
                width: shape.width,
                padding: textPadding(shape.fontSize),
              };
              const arrowEnd = shape.arrow ? shape.arrowEnd : undefined;
              // The arrow's tail is always derived from the text's own
              // position (never stored) — snapped to whichever of the 8
              // compass points around its bounding box is nearest the tip —
              // so dragging the text drags the whole arrow along with it.
              const arrowTail = arrowEnd && closestCompassPoint(measureTextBox(shape), arrowEnd);
              const arrow = arrowEnd && arrowTail && (
                <Fragment key={`${shape.id}-arrow`}>
                  <Arrow
                    points={[arrowTail.x, arrowTail.y, arrowEnd.x, arrowEnd.y]}
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth}
                    fill={shape.color}
                    lineCap="round"
                    lineJoin="round"
                    listening={false}
                    sceneFunc={(context, shapeNode) => {
                      drawRoughArrow(
                        context,
                        shapeNode,
                        [arrowTail.x, arrowTail.y, arrowEnd.x, arrowEnd.y],
                        seedFromId(shape.id),
                        shape.strokeWidth,
                      );
                    }}
                  />
                  <TipHandle
                    x={arrowEnd.x}
                    y={arrowEnd.y}
                    onPositionChange={(x, y) => onStateChange(updateShape(state, shape.id, { arrowEnd: { x, y } }))}
                    onBeginContinuousEdit={onBeginContinuousEdit}
                    onEndContinuousEdit={onEndContinuousEdit}
                  />
                </Fragment>
              );
              if (shape.background) {
                return (
                  <Fragment key={shape.id}>
                    <Label
                      id={shape.id}
                      x={shape.x}
                      y={shape.y}
                      draggable={draggable}
                      onClick={() => select(shape.id)}
                      onTap={() => select(shape.id)}
                      onDragStart={() => onBeginContinuousEdit?.()}
                      onDragMove={(e) => onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }))}
                      onDragEnd={(e) => {
                        onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }));
                        onEndContinuousEdit?.();
                      }}
                      onDblClick={() => startEditingText(shape)}
                      onDblTap={() => startEditingText(shape)}
                    >
                      <Tag id={shape.id} cornerRadius={shape.fontSize * 0.3} fill={shape.color} {...((selected || hovered) ? SELECTED_SHADOW : {})} />
                      <Text id={shape.id} {...textProps} fill={isDarkColor(shape.color) ? "white" : "black"} />
                    </Label>
                    {arrow}
                  </Fragment>
                );
              }
              return (
                <Fragment key={shape.id}>
                  <Text
                    id={shape.id}
                    x={shape.x}
                    y={shape.y}
                    {...textProps}
                    fill={shape.color}
                    draggable={draggable}
                    onClick={() => select(shape.id)}
                    onTap={() => select(shape.id)}
                    onDragStart={() => onBeginContinuousEdit?.()}
                    onDragMove={(e) => onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }))}
                    onDragEnd={(e) => {
                      onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }));
                      onEndContinuousEdit?.();
                    }}
                    onDblClick={() => startEditingText(shape)}
                    onDblTap={() => startEditingText(shape)}
                    {...((selected || hovered) ? SELECTED_SHADOW : {})}
                  />
                  {arrow}
                </Fragment>
              );
            }
            return null;
          })}
          <Transformer ref={transformerRef} rotateEnabled={false} keepRatio={selectedShape?.type === "image"} />
        </Layer>
      </Stage>
      {editingText &&
        (() => {
          const editingShape = state.shapes.find((s) => s.id === editingText.id);
          const background = editingShape?.type === "text" && editingShape.background ? editingShape.color : "transparent";
          // Matches the color the shape will actually render with (the same
          // value used as the Konva Text's `fill`), except when it has a
          // background box, where white/black is picked for contrast against
          // that background color instead.
          const foreground =
            editingShape?.type === "text"
              ? editingShape.background
                ? isDarkColor(editingShape.color)
                  ? "white"
                  : "black"
                : editingShape.color
              : "inherit";
          return (
            <textarea
              ref={textareaRef}
              rows={1}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
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
                  onStateChange(setTool(state, "select"));
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
                fontSize: editingText.fontSize * fit.scale,
                fontFamily: "var(--font)",
                lineHeight: TEXT_LINE_HEIGHT,
                whiteSpace: "pre",
                border: "none",
                outline: "none",
                padding: 0,
                margin: 0,
                overflow: "hidden",
                background,
                color: foreground,
                resize: "none",
                zIndex: 1000,
              }}
            />
          );
        })()}
    </div>
  );
});

export default AnnotationCanvas;

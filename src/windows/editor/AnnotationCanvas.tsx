import { useRef } from "react";
import { Stage, Layer, Image as KonvaImage, Arrow, Rect, Ellipse, Line, Text } from "react-konva";
import useImage from "use-image";
import type { EditorState, Shape, TextShape } from "./toolState";
import { addShape, updateShape } from "./toolState";

interface Props {
  imageSrc: string;
  state: EditorState;
  color: string;
  strokeWidth: number;
  onStateChange: (next: EditorState) => void;
}

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `shape-${nextId}`;
}

export default function AnnotationCanvas({ imageSrc, state, color, strokeWidth, onStateChange }: Props) {
  const [image] = useImage(imageSrc);
  const drawing = useRef<string | null>(null);

  function handleMouseDown(e: any) {
    if (state.tool === "select") return;
    const pos = e.target.getStage().getPointerPosition();
    const id = newId();
    if (state.tool === "text") {
      const shape: TextShape = { id, type: "text", color, strokeWidth, x: pos.x, y: pos.y, text: "Text", fontSize: 20 };
      onStateChange(addShape(state, shape));
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
    } else if (state.tool === "rect" || state.tool === "ellipse") {
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
    const pos = e.target.getStage().getPointerPosition();
    // The shape being drawn is always the last item in the array.
    const idx = state.shapes.length - 1;
    const current = state.shapes[idx];
    if (!current || current.id !== drawing.current) return;
    let updated: Shape;
    if (current.type === "arrow") {
      updated = { ...current, points: [current.points[0], current.points[1], pos.x, pos.y] };
    } else if (current.type === "pen" || current.type === "highlighter") {
      updated = { ...current, points: [...current.points, pos.x, pos.y] };
    } else if (current.type === "rect" || current.type === "ellipse") {
      updated = { ...current, width: pos.x - current.x, height: pos.y - current.y };
    } else {
      return;
    }
    const shapes = state.shapes.slice();
    shapes[idx] = updated;
    onStateChange({ ...state, shapes });
  }

  function handleMouseUp() {
    drawing.current = null;
  }

  return (
    <Stage
      width={image?.width ?? 800}
      height={image?.height ?? 600}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <Layer>
        {image && <KonvaImage image={image} />}
        {state.shapes.map((shape) => {
          if (shape.type === "arrow") {
            return (
              <Arrow
                key={shape.id}
                points={shape.points}
                stroke={shape.color}
                strokeWidth={shape.strokeWidth}
                fill={shape.color}
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
              />
            );
          }
          if (shape.type === "text") {
            return (
              <Text
                key={shape.id}
                x={shape.x}
                y={shape.y}
                text={shape.text}
                fontSize={shape.fontSize}
                fill={shape.color}
                draggable
                onDragEnd={(e) => onStateChange(updateShape(state, shape.id, { x: e.target.x(), y: e.target.y() }))}
                onDblClick={() => {
                  const next = window.prompt("Edit text", shape.text);
                  if (next !== null) {
                    onStateChange(updateShape(state, shape.id, { text: next }));
                  }
                }}
              />
            );
          }
          return null;
        })}
      </Layer>
    </Stage>
  );
}

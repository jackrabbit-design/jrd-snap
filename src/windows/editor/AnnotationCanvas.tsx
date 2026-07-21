import { useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Arrow, Rect, Ellipse } from "react-konva";
import useImage from "use-image";
import type { EditorState, Shape } from "./toolState";
import { addShape } from "./toolState";

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
  const drawing = useRef<Shape | null>(null);
  const [, forceRerender] = useState(0);

  function handleMouseDown(e: any) {
    if (state.tool === "select") return;
    const pos = e.target.getStage().getPointerPosition();
    const id = newId();
    if (state.tool === "arrow") {
      drawing.current = { id, type: "arrow", color, strokeWidth, points: [pos.x, pos.y, pos.x, pos.y] };
    } else if (state.tool === "rect" || state.tool === "ellipse") {
      drawing.current = {
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
    onStateChange(addShape(state, drawing.current));
  }

  function handleMouseMove(e: any) {
    if (!drawing.current) return;
    const pos = e.target.getStage().getPointerPosition();
    const shapes = state.shapes.slice();
    const idx = shapes.findIndex((s) => s.id === drawing.current!.id);
    if (idx === -1) return;
    const current = drawing.current;
    if (current.type === "arrow") {
      current.points = [current.points[0], current.points[1], pos.x, pos.y];
    } else if (current.type === "rect" || current.type === "ellipse") {
      current.width = pos.x - current.x;
      current.height = pos.y - current.y;
    }
    shapes[idx] = { ...current };
    onStateChange({ ...state, shapes });
    forceRerender((n) => n + 1);
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
          return null;
        })}
      </Layer>
    </Stage>
  );
}

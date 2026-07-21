export type ToolType =
  | "select"
  | "arrow"
  | "rect"
  | "ellipse"
  | "pen"
  | "highlighter"
  | "text"
  | "blur"
  | "crop";

export interface ShapeBase {
  id: string;
  color: string;
  strokeWidth: number;
}

export interface PointShape extends ShapeBase {
  type: "arrow" | "pen" | "highlighter";
  points: number[];
}

export interface BoxShape extends ShapeBase {
  type: "rect" | "ellipse" | "blur" | "crop";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextShape extends ShapeBase {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

export type Shape = PointShape | BoxShape | TextShape;

export interface EditorState {
  tool: ToolType;
  shapes: Shape[];
  selectedId: string | null;
}

export const initialState: EditorState = {
  tool: "select",
  shapes: [],
  selectedId: null,
};

export function setTool(state: EditorState, tool: ToolType): EditorState {
  return { ...state, tool };
}

export function addShape(state: EditorState, shape: Shape): EditorState {
  return { ...state, shapes: [...state.shapes, shape] };
}

export type ShapePatch = Partial<PointShape> | Partial<BoxShape> | Partial<TextShape>;

export function updateShape(state: EditorState, id: string, patch: ShapePatch): EditorState {
  return {
    ...state,
    shapes: state.shapes.map((s) => (s.id === id ? ({ ...s, ...patch } as Shape) : s)),
  };
}

export function removeShape(state: EditorState, id: string): EditorState {
  return {
    ...state,
    shapes: state.shapes.filter((s) => s.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  };
}

export function selectShape(state: EditorState, id: string | null): EditorState {
  return { ...state, selectedId: id };
}

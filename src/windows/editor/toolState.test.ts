import { describe, it, expect } from "vitest";
import {
  initialState,
  setTool,
  addShape,
  updateShape,
  removeShape,
  selectShape,
  applyCrop,
  type BoxShape,
  type Shape,
  type TextShape,
} from "./toolState";

function rectShape(id: string): BoxShape {
  return { id, type: "rect", color: "#ff0000", strokeWidth: 2, x: 0, y: 0, width: 10, height: 10 };
}

function textShape(id: string): TextShape {
  return { id, type: "text", color: "#000000", strokeWidth: 1, x: 0, y: 0, text: "hello", fontSize: 12 };
}

describe("toolState", () => {
  it("starts with the select tool and no shapes", () => {
    expect(initialState.tool).toBe("select");
    expect(initialState.shapes).toEqual([]);
    expect(initialState.selectedId).toBeNull();
  });

  it("setTool switches the active tool without touching shapes", () => {
    const next = setTool(initialState, "arrow");
    expect(next.tool).toBe("arrow");
    expect(next.shapes).toBe(initialState.shapes);
  });

  it("addShape appends a shape and does not mutate the previous state", () => {
    const shape = rectShape("a");
    const next = addShape(initialState, shape);
    expect(next.shapes).toHaveLength(1);
    expect(initialState.shapes).toHaveLength(0);
    expect(next.shapes[0]).toEqual(shape);
  });

  it("updateShape patches only the matching shape", () => {
    const state = addShape(addShape(initialState, rectShape("a")), rectShape("b"));
    const next = updateShape(state, "a", { width: 99 });
    const a = next.shapes.find((s) => s.id === "a") as BoxShape;
    const b = next.shapes.find((s) => s.id === "b") as BoxShape;
    expect(a.width).toBe(99);
    expect(b.width).toBe(10);
  });

  it("removeShape drops the matching shape and clears selection if it was selected", () => {
    const state = selectShape(addShape(initialState, rectShape("a")), "a");
    const next = removeShape(state, "a");
    expect(next.shapes).toHaveLength(0);
    expect(next.selectedId).toBeNull();
  });

  it("removeShape leaves selection alone if a different shape was selected", () => {
    const state = selectShape(
      addShape(addShape(initialState, rectShape("a")), rectShape("b")),
      "b",
    );
    const next = removeShape(state, "a");
    expect(next.selectedId).toBe("b");
  });

  it("selectShape sets selectedId, including back to null", () => {
    const selected = selectShape(initialState, "a");
    expect(selected.selectedId).toBe("a");
    const cleared = selectShape(selected, null);
    expect(cleared.selectedId).toBeNull();
  });

  it("narrows a Shape to TextShape via its type discriminant", () => {
    const shape: Shape = textShape("t");
    if (shape.type === "text") {
      // If Shape were not a true discriminated union, `shape.text` would not
      // type-check here (it would fail `tsc`/`npm run build`, not just this assertion).
      expect(shape.text).toBe("hello");
      expect(shape.fontSize).toBe(12);
    } else {
      throw new Error("expected shape to narrow to TextShape");
    }
  });
});

describe("applyCrop", () => {
  it("removes crop-type shapes and shifts remaining shapes by the crop origin", () => {
    const cropShape: BoxShape = { id: "c", type: "crop", color: "#000", strokeWidth: 1, x: 10, y: 10, width: 50, height: 50 };
    const rect: BoxShape = { id: "r", type: "rect", color: "#f00", strokeWidth: 2, x: 20, y: 20, width: 5, height: 5 };
    const state = addShape(addShape(initialState, cropShape), rect);
    const next = applyCrop(state, { x: 10, y: 10, width: 50, height: 50 });
    expect(next.shapes).toHaveLength(1);
    const shifted = next.shapes[0] as BoxShape;
    expect(shifted.x).toBe(10);
    expect(shifted.y).toBe(10);
  });
});

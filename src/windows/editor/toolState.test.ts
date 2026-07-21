import { describe, it, expect } from "vitest";
import {
  initialState,
  setTool,
  addShape,
  updateShape,
  removeShape,
  selectShape,
  type BoxShape,
} from "./toolState";

function rectShape(id: string): BoxShape {
  return { id, type: "rect", color: "#ff0000", strokeWidth: 2, x: 0, y: 0, width: 10, height: 10 };
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
});

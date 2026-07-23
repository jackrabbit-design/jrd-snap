import { describe, it, expect } from "vitest";
import { initialTrimState, setInPoint, setOutPoint } from "./trimState";

describe("trimState", () => {
  it("starts with the full clip selected", () => {
    const state = initialTrimState(10);
    expect(state).toEqual({ duration: 10, inPoint: 0, outPoint: 10 });
  });

  it("setInPoint moves the in-point within bounds", () => {
    const state = setInPoint(initialTrimState(10), 3);
    expect(state.inPoint).toBe(3);
  });

  it("setInPoint clamps below zero to zero", () => {
    const state = setInPoint(initialTrimState(10), -5);
    expect(state.inPoint).toBe(0);
  });

  it("setInPoint clamps to just below the current out-point, never past or equal to it", () => {
    const withOut = setOutPoint(initialTrimState(10), 6);
    const state = setInPoint(withOut, 9);
    expect(state.inPoint).toBeLessThan(state.outPoint);
  });

  it("setOutPoint moves the out-point within bounds", () => {
    const state = setOutPoint(initialTrimState(10), 7);
    expect(state.outPoint).toBe(7);
  });

  it("setOutPoint clamps above duration to duration", () => {
    const state = setOutPoint(initialTrimState(10), 999);
    expect(state.outPoint).toBe(10);
  });

  it("setOutPoint clamps to just above the current in-point, never before or equal to it", () => {
    const withIn = setInPoint(initialTrimState(10), 4);
    const state = setOutPoint(withIn, 1);
    expect(state.outPoint).toBeGreaterThan(state.inPoint);
  });
});

import { describe, it, expect } from "vitest";
import { dataUrlToBytes } from "./export";

describe("dataUrlToBytes", () => {
  it("decodes a base64 data URL into raw bytes", () => {
    // "hi" base64-encoded is "aGk="
    const bytes = dataUrlToBytes("data:image/png;base64,aGk=");
    expect(Array.from(bytes)).toEqual([104, 105]);
  });

  it("throws on a non-base64 data URL", () => {
    expect(() => dataUrlToBytes("data:image/png,not-base64")).toThrow();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SettingsApp from "./SettingsApp";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "has_credentials") {
      return Promise.resolve(false);
    }
    return Promise.resolve({
      provider: "S3",
      bucket: "",
      region: "",
      endpoint: null,
      customDomain: null,
      keyPrefix: null,
      filenamePrefix: null,
    });
  }),
}));

describe("SettingsApp", () => {
  it("renders the settings heading", () => {
    render(<SettingsApp />);
    expect(screen.getByText("pxl Settings")).toBeInTheDocument();
  });
});

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
  it("renders the Connection and Hotkeys tabs, starting on Connection", () => {
    render(<SettingsApp />);
    expect(screen.getByRole("button", { name: "Connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hotkeys" })).toBeInTheDocument();
    expect(screen.getByText("Upload Destination")).toBeInTheDocument();
  });
});

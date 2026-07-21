import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SettingsApp from "./SettingsApp";

describe("SettingsApp", () => {
  it("renders the placeholder text", () => {
    render(<SettingsApp />);
    expect(screen.getByText("Settings (placeholder)")).toBeInTheDocument();
  });
});

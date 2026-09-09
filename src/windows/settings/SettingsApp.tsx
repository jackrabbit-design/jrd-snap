import { useState } from "react";
import HotkeyConfigForm from "./HotkeyConfigForm";
import UploadConfigForm from "./UploadConfigForm";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

const TABS = [
  { key: "connection", label: "Connection" },
  { key: "hotkeys", label: "Hotkeys" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function SettingsApp() {
  const [tab, setTab] = useState<TabKey>("connection");

  return (
    <div className="settings-page">
      <div className="titlebar-controls" data-tauri-drag-region>
        <button type="button" className="control-btn close-btn" title="Close Window" onClick={() => appWindow.close()}></button>
        <button type="button" className="control-btn min-btn" title="Minimize Window" onClick={() => appWindow.minimize()}></button>
      </div>
      <img src="/logo.png" alt="Snap" id="logo" />
      <div className="settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`settings-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "connection" && <UploadConfigForm />}
      {tab === "hotkeys" && <HotkeyConfigForm />}
    </div>
  );
}

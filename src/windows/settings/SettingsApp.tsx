import { useState } from "react";
import HotkeyConfigForm from "./HotkeyConfigForm";
import UploadConfigForm from "./UploadConfigForm";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
  appWindow.minimize();
});

document.getElementById('titlebar-close')?.addEventListener('click', () => {
  appWindow.close();
});

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
        <button type="button" id="titlebar-close" className="control-btn close-btn" title="Close Window"></button>
        <button type="button" id="titlebar-minimize" className="control-btn min-btn" title="Minimize Window"></button>
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

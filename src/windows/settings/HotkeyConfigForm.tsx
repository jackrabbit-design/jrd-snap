import { useEffect, useState } from "react";
import { getHotkeySettings, saveHotkeySettings, type HotkeySettings } from "../../lib/api";

const DEFAULT: HotkeySettings = {
  captureArea: "CommandOrControl+Shift+2",
  captureFull: "CommandOrControl+Shift+3",
  recordArea: "CommandOrControl+Shift+4",
};

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift"]);

// JS's KeyboardEvent.key values mostly already match Tauri's accelerator
// key names (e.g. "Escape", "ArrowUp", "F1"); this only covers the ones
// that don't.
const KEY_NAME_OVERRIDES: Record<string, string> = {
  " ": "Space",
  "+": "Plus",
};

// Builds a Tauri accelerator string (e.g. "Control+D") from a live keydown
// event, or null if only modifier keys are currently held (not a complete
// shortcut yet). Cmd and Ctrl are recorded as their own distinct literal
// modifiers ("Command" / "Control") rather than merged into the
// cross-platform "CommandOrControl" — recording Ctrl+D must not also fire
// on Cmd+D, and vice versa.
function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("Command");
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const keyName = KEY_NAME_OVERRIDES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(keyName);
  return parts.join("+");
}

function HotkeyRecorderField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);

  // WebKit on macOS doesn't focus a <button> on mouse click (only on Tab
  // navigation), unlike Chrome/Firefox — so a keydown handler attached to
  // the button itself never fires after clicking it in Tauri's webview.
  // Listen at the document level instead, gated on `recording`.
  useEffect(() => {
    if (!recording) return;
    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorFromEvent(e);
      if (accelerator) {
        onChange(accelerator);
        setRecording(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [recording, onChange]);

  return (
    <label className="field">
      {label}
      <button
        type="button"
        className="input"
        onClick={() => setRecording((r) => !r)}
        style={{ textAlign: "left", cursor: "pointer", borderColor: recording ? "var(--accent)" : undefined }}
      >
        {recording ? "Press a key combination… (Escape to cancel)" : value}
      </button>
    </label>
  );
}

export default function HotkeyConfigForm() {
  const [hotkeys, setHotkeys] = useState<HotkeySettings>(DEFAULT);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getHotkeySettings()
      .then(setHotkeys)
      .catch((err) => setStatus(`Failed to load hotkeys: ${err}`));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await saveHotkeySettings(hotkeys);
      setStatus("Saved");
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setStatus(`Save failed: ${err}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="settings-section">
      <h3>Hotkeys</h3>
      <HotkeyRecorderField
        label="Capture Area"
        value={hotkeys.captureArea}
        onChange={(v) => setHotkeys((h) => ({ ...h, captureArea: v }))}
      />
      <HotkeyRecorderField
        label="Capture Full Screen"
        value={hotkeys.captureFull}
        onChange={(v) => setHotkeys((h) => ({ ...h, captureFull: v }))}
      />
      <HotkeyRecorderField
        label="Record Area"
        value={hotkeys.recordArea}
        onChange={(v) => setHotkeys((h) => ({ ...h, recordArea: v }))}
      />
      <div className="settings-form-footer">
        <button type="submit" className="button button-primary">
          Save Hotkeys
        </button>
        {status && <span className="status-text">{status}</span>}
      </div>
    </form>
  );
}

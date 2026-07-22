import { useEffect, useState } from "react";
import { getHotkeySettings, saveHotkeySettings, type HotkeySettings } from "../../lib/api";

const DEFAULT: HotkeySettings = {
  captureArea: "CommandOrControl+Shift+2",
  captureFull: "CommandOrControl+Shift+3",
};

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift"]);

// JS's KeyboardEvent.key values mostly already match Tauri's accelerator
// key names (e.g. "Escape", "ArrowUp", "F1"); this only covers the ones
// that don't.
const KEY_NAME_OVERRIDES: Record<string, string> = {
  " ": "Space",
  "+": "Plus",
};

// Builds a Tauri accelerator string (e.g. "CommandOrControl+Shift+2") from a
// live keydown event, or null if only modifier keys are currently held (not
// a complete shortcut yet). Cmd (macOS) and Ctrl are both treated as the
// cross-platform "CommandOrControl" modifier, matching this app's defaults,
// so a shortcut recorded on one platform means the same thing on the other.
function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const keyName = KEY_NAME_OVERRIDES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(keyName);
  return parts.join("+");
}

function HotkeyRecorderField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);

  function handleKeyDown(e: React.KeyboardEvent) {
    e.preventDefault();
    if (e.key === "Escape") {
      setRecording(false);
      return;
    }
    const accelerator = acceleratorFromEvent(e.nativeEvent);
    if (accelerator) {
      onChange(accelerator);
      setRecording(false);
    }
  }

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label}
      <button
        type="button"
        onClick={() => setRecording(true)}
        onKeyDown={recording ? handleKeyDown : undefined}
        onBlur={() => setRecording(false)}
        style={{
          textAlign: "left",
          padding: "6px 10px",
          border: recording ? "2px solid #3b82f6" : "1px solid #ccc",
        }}
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
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
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
      <button type="submit">Save Hotkeys</button>
      {status && <span>{status}</span>}
    </form>
  );
}

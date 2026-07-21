import { useEffect, useState } from "react";
import { getHotkeySettings, saveHotkeySettings, type HotkeySettings } from "../../lib/api";

const DEFAULT: HotkeySettings = {
  captureArea: "CommandOrControl+Shift+2",
  captureFull: "CommandOrControl+Shift+3",
};

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
      <label>
        Capture Area
        <input
          value={hotkeys.captureArea}
          onChange={(e) => setHotkeys((h) => ({ ...h, captureArea: e.target.value }))}
        />
      </label>
      <label>
        Capture Full Screen
        <input
          value={hotkeys.captureFull}
          onChange={(e) => setHotkeys((h) => ({ ...h, captureFull: e.target.value }))}
        />
      </label>
      <button type="submit">Save Hotkeys</button>
      {status && <span>{status}</span>}
    </form>
  );
}

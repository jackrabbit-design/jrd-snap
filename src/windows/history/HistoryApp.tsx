import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCaptureHistory, type CaptureHistoryEntry } from "../../lib/api";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
  appWindow.minimize();
});

document.getElementById('titlebar-close')?.addEventListener('click', () => {
  appWindow.close();
});

function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const hours24 = date.getHours();
  const ampm = hours24 < 12 ? "a" : "p";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${date.getMonth() + 1}/${date.getDate()} ${hours12}:${minutes}${ampm}`;
}

export default function HistoryApp() {
  const [entries, setEntries] = useState<CaptureHistoryEntry[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    getCaptureHistory().then(setEntries).catch((e) => console.error("failed to load capture history", e));
  }, []);

  useEffect(() => {
    const unlisten = listen<CaptureHistoryEntry[]>("capture-history-updated", (event) => {
      setEntries(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function handleCopy(entry: CaptureHistoryEntry) {
    await writeText(entry.url);
    setCopiedId(entry.id);
    setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 1500);
  }

  return (
    <div className="history-page">
      <div className="history-header editor-toolbar-row">
        <div className="titlebar-controls">
          <button type="button" id="titlebar-close" className="control-btn close-btn" title="Close Window"></button>
          <button type="button" id="titlebar-minimize" className="control-btn min-btn" title="Minimize Window"></button>
        </div>
        <h2>Recent Captures</h2>
      </div>
      {entries.length === 0 ? (
        <div className="history-empty">Nothing captured yet this session.</div>
      ) : (
        <div className="history-grid">
          {entries.map((entry) => (
            <div key={entry.id} className="history-cell">
              <div className="history-thumbnail-wrap">
                <img src={entry.thumbnail} alt="" className="history-thumbnail" />
                {entry.kind === "video" && <span className="history-video-badge">▶</span>}
              </div>
              <div className="history-cell-footer">
                <span className="history-timestamp">{formatTimestamp(entry.timestampMs)}</span>
                <button type="button" className="button" onClick={() => handleCopy(entry)}>
                  {copiedId === entry.id ? "Copied!" : "Copy URL"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

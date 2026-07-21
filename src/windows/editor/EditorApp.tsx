import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-image", (event) => {
      setImageSrc(`data:image/png;base64,${event.payload}`);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  if (!imageSrc) {
    return <div style={{ padding: 16 }}>Waiting for capture…</div>;
  }

  return (
    <div id="editor-canvas-container" style={{ width: "100%", height: "100%" }}>
      <img src={imageSrc} style={{ maxWidth: "100%", display: "block" }} alt="captured screenshot" />
    </div>
  );
}

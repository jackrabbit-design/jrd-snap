import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import AnnotationCanvas from "./AnnotationCanvas";
import Toolbar from "./Toolbar";
import { initialState, setTool, type EditorState } from "./toolState";

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [state, setState] = useState<EditorState>(initialState);
  const [color, setColor] = useState("#ff0000");
  const [strokeWidth, setStrokeWidth] = useState(3);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-image", (event) => {
      setImageSrc(`data:image/png;base64,${event.payload}`);
      setState(initialState);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  if (!imageSrc) {
    return <div style={{ padding: 16 }}>Waiting for capture…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar
        tool={state.tool}
        color={color}
        strokeWidth={strokeWidth}
        onToolChange={(t) => setState(setTool(state, t))}
        onColorChange={setColor}
        onStrokeWidthChange={setStrokeWidth}
      />
      <div id="editor-canvas-container" style={{ flex: 1, overflow: "auto" }}>
        <AnnotationCanvas
          imageSrc={imageSrc}
          state={state}
          color={color}
          strokeWidth={strokeWidth}
          onStateChange={setState}
        />
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { hideDropWindow, notify, uploadFileFromPath } from "../../lib/api";

export default function DropApp() {
  const [isOver, setIsOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
          case "over":
            setIsOver(true);
            break;
          case "leave":
            setIsOver(false);
            break;
          case "drop":
            setIsOver(false);
            void handleDrop(event.payload.paths);
            break;
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  async function handleDrop(paths: string[]) {
    if (paths.length !== 1) {
      await notify("Only one file at a time is supported");
      return;
    }
    setUploading(true);
    try {
      const url = await uploadFileFromPath(paths[0]);
      await writeText(url);
      await notify(`Uploaded — link copied to clipboard\n${url}`);
    } catch (e) {
      await notify(`Upload failed: ${e}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={`drop-upload-root${isOver ? " drop-upload-over" : ""}`}>
      <button
        type="button"
        className="control-btn close-btn drop-upload-close"
        title="Hide Drop Window"
        onClick={() => hideDropWindow()}
        style={{ margin: "5px"}}
      ></button>
      <div className="drop-upload-zone">
        <svg style={{ display: "block", width: "50px", height: "50px" }} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 303 296" fill="none"><title>Snap</title><path fill="#404143" fill-rule="evenodd" d="M165.617 152.068c75.366 0 136.466 61.1 136.466 136.466v7.384H0v-7.384c0-75.366 61.1-136.466 136.467-136.466h29.15Zm-21.765 86.313h-14.388v14.384h14.388v14.382h14.382v-14.382h14.384v-14.384h-14.384v-.004h-14.382v.004Zm-57.542-.004h14.382v-43.154H86.31v43.154Zm115.08 0h14.382l-.001-43.154H201.39v43.154Z" clip-rule="evenodd"/><path fill="#404143" fill-rule="evenodd" d="M64.73 0c19.86 0 35.962 16.1 35.962 35.963l.001 132.537-71.924 61.658V35.963C28.769 16.1 44.869 0 64.729 0Zm-7.19 129.465h14.383l-.001-100.696H57.54v100.696ZM237.35 0c19.861 0 35.962 16.1 35.962 35.963l.001 194.195-71.924-57.658V35.963C201.389 16.1 217.489 0 237.35 0Zm-7.19 129.465h14.383V28.769H230.16v100.696Z" clip-rule="evenodd"/></svg>
        {uploading ? "Uploading…" : "Drop a file to upload"}
      </div>
    </div>
  );
}

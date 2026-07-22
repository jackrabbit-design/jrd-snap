import type { ToolType } from "./toolState";

const TOOLS: { type: ToolType; label: string; title: string }[] = [
  { type: "select", label: "Select", title: "Click a shape to select it, drag to move it, Delete/Backspace to remove it" },
  { type: "arrow", label: "Arrow (A)", title: "Arrow — hotkey A" },
  { type: "rect", label: "Rectangle (R)", title: "Rectangle — hotkey R" },
  { type: "ellipse", label: "Oval (O)", title: "Oval — hotkey O" },
  { type: "pen", label: "Pen (P)", title: "Pen — hotkey P" },
  { type: "highlighter", label: "Highlighter (H)", title: "Highlighter — hotkey H" },
  { type: "text", label: "Text (T)", title: "Text — hotkey T. Click to place and start typing immediately, double-click existing text to edit it" },
  { type: "blur", label: "Blur (B)", title: "Blur — hotkey B" },
  { type: "crop", label: "Crop (C)", title: "Crop — hotkey C" },
];

interface Props {
  tool: ToolType;
  color: string;
  strokeWidth: number;
  onToolChange: (t: ToolType) => void;
  onColorChange: (c: string) => void;
  onStrokeWidthChange: (w: number) => void;
}

export default function Toolbar({ tool, color, strokeWidth, onToolChange, onColorChange, onStrokeWidthChange }: Props) {
  return (
    <div style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid #ccc" }}>
      {TOOLS.map((t) => (
        <button
          key={t.type}
          type="button"
          title={t.title}
          onClick={() => onToolChange(t.type)}
          style={{ fontWeight: tool === t.type ? "bold" : "normal" }}
        >
          {t.label}
        </button>
      ))}
      <input type="color" value={color} onChange={(e) => onColorChange(e.target.value)} />
      <input
        type="number"
        min={1}
        max={20}
        value={strokeWidth}
        onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
        style={{ width: 48 }}
      />
    </div>
  );
}

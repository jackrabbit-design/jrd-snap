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
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.type}
          type="button"
          title={t.title}
          onClick={() => onToolChange(t.type)}
          className={`tool-button${tool === t.type ? " active" : ""}`}
        >
          {t.label}
        </button>
      ))}
      <div className="toolbar-divider" />
      <input
        type="color"
        className="color-swatch"
        title="Color"
        value={color}
        onChange={(e) => onColorChange(e.target.value)}
      />
      <input
        type="number"
        className="input stroke-width-input"
        title="Stroke width"
        min={1}
        max={20}
        value={strokeWidth}
        onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
      />
    </div>
  );
}

import ToolIcon from "./ToolIcon";
import type { ToolType } from "./toolState";

const TOOLS: { type: ToolType; title: string }[] = [
  { type: "select", title: "Select — click a shape to select it, drag to move it, Delete/Backspace to remove it" },
  { type: "arrow", title: "Arrow (A)" },
  { type: "rect", title: "Rectangle (R)" },
  { type: "ellipse", title: "Oval (O)" },
  { type: "pen", title: "Pen (P)" },
  { type: "highlighter", title: "Highlighter (H)" },
  { type: "text", title: "Text (T) — click to place and start typing immediately, double-click existing text to edit it" },
  { type: "blur", title: "Blur (B)" },
  { type: "crop", title: "Crop (C)" },
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
          <ToolIcon type={t.type} />
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

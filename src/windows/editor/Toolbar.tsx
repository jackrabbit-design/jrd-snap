import ToolIcon from "./ToolIcon";
import type { ToolType } from "./toolState";

const TOOLS: { type: ToolType; title: string }[] = [
  { type: "select", title: "Select — click a shape to select it, drag to move it, Delete/Backspace to remove it" },
  { type: "arrow", title: "Arrow (A)" },
  { type: "line", title: "Line (L)" },
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
  showTextBackground: boolean;
  textBackground: boolean;
  onToolChange: (t: ToolType) => void;
  onColorChange: (c: string) => void;
  onStrokeWidthChange: (w: number) => void;
  onTextBackgroundChange: (v: boolean) => void;
}

export default function Toolbar({
  tool,
  color,
  strokeWidth,
  showTextBackground,
  textBackground,
  onToolChange,
  onColorChange,
  onStrokeWidthChange,
  onTextBackgroundChange,
}: Props) {
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
        type="range"
        className="stroke-width-input"
        title="Stroke width"
        min={1}
        max={30}
        value={strokeWidth}
        disabled={tool === "blur"}
        onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
      />
      {showTextBackground && (
        <label className="text-background-toggle" title="Text background">
          <input
            type="checkbox"
            checked={textBackground}
            onChange={(e) => onTextBackgroundChange(e.target.checked)}
          />
          Background
        </label>
      )}
    </div>
  );
}

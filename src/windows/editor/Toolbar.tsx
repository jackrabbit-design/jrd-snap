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
  // True when the selected shape is a floating screenshot, which has no use
  // for a stroke color or width.
  disableStyleControls: boolean;
  onToolChange: (t: ToolType) => void;
  onAddScreenshot: () => void;
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
  disableStyleControls,
  onToolChange,
  onAddScreenshot,
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
      <button
        type="button"
        title="Add screenshot — hides this window, take another capture, and drop it on top of the current one"
        onClick={onAddScreenshot}
        className="tool-button"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none"><title>Add Screenshot</title>
          <rect x="1" y="1" width="14" height="14" rx="2" stroke="#fff" strokeWidth="1.5" />
          <path d="M8 5v6M5 8h6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div className="toolbar-divider" />
      <input
        type="color"
        className="color-swatch"
        title="Color"
        value={color}
        disabled={disableStyleControls}
        onChange={(e) => onColorChange(e.target.value)}
      />
      <input
        type="range"
        className="stroke-width-input"
        title="Stroke width"
        min={1}
        max={30}
        value={strokeWidth}
        disabled={tool === "blur" || disableStyleControls}
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

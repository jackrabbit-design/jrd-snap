import type { ToolType } from "./toolState";

const TOOLS: { type: ToolType; label: string }[] = [
  { type: "select", label: "Select" },
  { type: "arrow", label: "Arrow" },
  { type: "rect", label: "Rectangle" },
  { type: "ellipse", label: "Ellipse" },
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

import type { ToolType } from "./toolState";

interface Props {
  type: ToolType;
}

// Simple, geometrically-trivial icons (basic shapes/lines only, no freeform
// paths) so each one is easy to get right without a way to preview them.
export default function ToolIcon({ type }: Props) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
  };

  switch (type) {
    case "select":
      return (
        <svg {...common}>
          <polygon
            points="4,3 4,18 8,14.5 10.5,20 13,19 10.5,13.5 16,13.5"
            fill="currentColor"
          />
        </svg>
      );
    case "arrow":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="19" x2="19" y2="5" />
          <polyline points="11,5 19,5 19,13" />
        </svg>
      );
    case "rect":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="4" y="6" width="16" height="12" rx="1.5" />
        </svg>
      );
    case "ellipse":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6">
          <ellipse cx="12" cy="12" rx="9" ry="6" />
        </svg>
      );
    case "pen":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <line x1="5" y1="19" x2="17" y2="7" />
          <circle cx="18.5" cy="5.5" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "highlighter":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity="0.85">
          <line x1="5" y1="19" x2="17" y2="7" />
        </svg>
      );
    case "text":
      return (
        <svg {...common}>
          <text x="12" y="17" fontSize="15" fontWeight="700" textAnchor="middle" fill="currentColor">
            T
          </text>
        </svg>
      );
    case "blur":
      return (
        <svg {...common} fill="currentColor">
          {[8, 14, 20].flatMap((cy) =>
            [7, 13, 19].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.5} />),
          )}
        </svg>
      );
    case "crop":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M7 3 L7 17 L21 17" />
          <path d="M3 7 L17 7 L17 21" />
        </svg>
      );
    default:
      return null;
  }
}

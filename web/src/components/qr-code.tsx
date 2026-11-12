import { useMemo } from "react";

import { encodeQr } from "@/lib/qr";
import { cn } from "@/lib/utils";

// A QR code drawn as one SVG path (ADR 0139). Dark modules are the theme's foreground, the ground is
// the theme's background, and four modules of quiet zone go round it, as the standard asks: a scanner
// needs the light border to find the three corner squares. `crispEdges` keeps the modules square at
// any scale (set as a CSS property). The text it encodes is not shown here; the caller names it in `label`.

/** Modules of light border on every side. The standard's minimum. */
const QUIET_ZONE = 4;

export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const symbol = encodeQr(value, "M");
    let d = "";
    symbol.modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      });
    });
    return { size: symbol.size + QUIET_ZONE * 2, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      data-slot="qr-code"
      // 240 CSS px: above the 220 floor a phone camera reads from arm's length, inside a 320px column.
      className={cn("size-60 shrink-0 text-foreground [shape-rendering:crispEdges]", className)}
    >
      <rect width={size} height={size} className="fill-background" />
      <path d={path} fill="currentColor" />
    </svg>
  );
}

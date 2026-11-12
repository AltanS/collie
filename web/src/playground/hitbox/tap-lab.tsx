// THE TAP LAB: four squares of known size, for a person holding a real phone. A headless browser sends
// a point with a fixed radius and a perfectly still finger; a hand does neither. Tap each square a few
// times the way you tap in the app and the table says, per square, how many taps arrived as a click, how
// many the browser took for a scroll or a cancel, how far the finger wandered, and how large the contact
// patch was (Chrome on Android reports it as `PointerEvent.width` and `.height`, in CSS px).
//
// It listens and counts and changes nothing in the app. DEV-ONLY, like the rest of `src/playground/`.

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SIZES = [28, 36, 44, 56] as const;

interface Tally {
  taps: number;
  clicks: number;
  cancelled: number;
  /** Largest wander between down and up, px. */
  maxDrift: number;
  /** Longest press, ms. */
  maxHold: number;
  /** Widest contact patch the browser reported, px; 0 when the device reports none. */
  maxPatch: number;
  /** Farthest the down landed from the square's centre, px. */
  maxOff: number;
}

const EMPTY: Tally = { taps: 0, clicks: 0, cancelled: 0, maxDrift: 0, maxHold: 0, maxPatch: 0, maxOff: 0 };

interface Down {
  x: number;
  y: number;
  at: number;
  patch: number;
  off: number;
}

export function TapLab() {
  const [tallies, setTallies] = useState<Record<number, Tally>>({});
  const [last, setLast] = useState("no tap yet");
  const downs = useRef(new Map<number, Down>());
  const clicked = useRef(new Set<number>());

  const bump = (size: number, patch: (t: Tally) => Tally) => setTallies((all) => ({ ...all, [size]: patch(all[size] ?? EMPTY) }));

  return (
    <div className="flex flex-col gap-3" data-slot="tap-lab">
      <div className="flex flex-wrap items-end gap-6">
        {SIZES.map((size) => (
          <div key={size} className="flex flex-col items-center gap-1">
            <button
              type="button"
              aria-label={`${String(size)} pixel square`}
              style={{ width: size, height: size }}
              className="rounded-md border border-primary bg-primary/15 transition-colors active:bg-primary/40"
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                downs.current.set(size, { x: e.clientX, y: e.clientY, at: e.timeStamp, patch: Math.max(e.width, e.height), off: Math.hypot(e.clientX - (r.x + r.width / 2), e.clientY - (r.y + r.height / 2)) });
                clicked.current.delete(size);
              }}
              onClick={() => clicked.current.add(size)}
              onPointerUp={(e) => {
                const d = downs.current.get(size);
                if (d === undefined) return;
                const drift = Math.hypot(e.clientX - d.x, e.clientY - d.y);
                const hold = e.timeStamp - d.at;
                setTimeout(() => {
                  const arrived = clicked.current.has(size);
                  bump(size, (t) => ({ taps: t.taps + 1, clicks: t.clicks + (arrived ? 1 : 0), cancelled: t.cancelled, maxDrift: Math.max(t.maxDrift, drift), maxHold: Math.max(t.maxHold, hold), maxPatch: Math.max(t.maxPatch, d.patch), maxOff: Math.max(t.maxOff, d.off) }));
                  setLast(`${String(size)}px: ${arrived ? "click" : "NO click"}, held ${String(Math.round(hold))} ms, moved ${drift.toFixed(1)} px, off centre ${d.off.toFixed(1)} px, patch ${d.patch.toFixed(0)} px`);
                }, 60);
              }}
              onPointerCancel={() => {
                bump(size, (t) => ({ ...t, taps: t.taps + 1, cancelled: t.cancelled + 1 }));
                setLast(`${String(size)}px: the browser CANCELLED the touch (it took it for a scroll)`);
              }}
            />
            <span className="font-mono text-[11px] text-muted-foreground">{size}</span>
          </div>
        ))}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-rule text-left text-muted-foreground">
            {["square", "taps", "click", "cancelled", "max move", "max hold", "max patch", "max off"].map((h) => (
              <th key={h} scope="col" className="px-1 pb-1 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border font-mono tabular-nums">
          {SIZES.map((size) => {
            const t = tallies[size] ?? EMPTY;
            return (
              <tr key={size} className={cn(t.taps > t.clicks + t.cancelled && "text-status-blocked")}>
                <td className="px-1 py-1">{size}px</td>
                <td className="px-1 py-1">{t.taps}</td>
                <td className="px-1 py-1">{t.clicks}</td>
                <td className="px-1 py-1">{t.cancelled}</td>
                <td className="px-1 py-1">{t.maxDrift.toFixed(1)} px</td>
                <td className="px-1 py-1">{Math.round(t.maxHold)} ms</td>
                <td className="px-1 py-1">{t.maxPatch === 0 ? "none" : `${t.maxPatch.toFixed(0)} px`}</td>
                <td className="px-1 py-1">{t.maxOff.toFixed(1)} px</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="font-mono text-[11px] text-muted-foreground" data-slot="tap-lab-last">
        {last}
      </p>
      <Button type="button" variant="outline" size="sm" className="h-6 w-fit px-2 text-[11px]" onClick={() => { setTallies({}); setLast("no tap yet"); }}>
        Clear the counts
      </Button>
    </div>
  );
}

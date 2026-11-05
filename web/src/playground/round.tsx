// A design round: numbered options side by side, one control bar for all of them. DEV-ONLY.
//
// The page rule applies (app.tsx): a label is a number and at most five words. Each option wears a
// big number and its title, nothing else. The bar holds the controls that act on every option at
// once: Case (one switch drives all of them), Zoom (so a tiny mark can be seen), Replay (remounts
// every option) and Flip (one frame, tap to swap between two options, for subtle colour changes).
//
// A section hands in its options as `render` functions of the current case. Option 0 is "Today"
// when the round has a baseline. Each option carries `data-state="<round id>-option-<n>"`, and the
// options are direct children of a `.pg-grid`, so app.test.tsx counts and checks them like cards.

import { useState, type MouseEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { PhoneFrame, Segmented, Stage } from "./layout";

export interface RoundCase {
  readonly value: string;
  readonly label: string;
}

export interface RoundOption {
  readonly n: number;
  /** At most five words. */
  readonly title: string;
  readonly render: (c: { caseValue: string }) => ReactNode;
}

/** What each option paints inside. Every option gets the same size. */
export type RoundFrame =
  | { readonly kind: "phone"; readonly height?: number }
  | { readonly kind: "stage"; readonly height: number };

const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 720;

const ZOOMS = [
  { value: "1", label: "1x" },
  { value: "2", label: "2x" },
  { value: "3", label: "3x" },
] as const satisfies readonly { value: string; label: string }[];

const FLIP = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

function frameHeight(frame: RoundFrame): number {
  return frame.kind === "stage" ? frame.height : (frame.height ?? PHONE_HEIGHT);
}

/**
 * The frame, clipped to its own layout box. Zoom scales the content from the top-left and the box
 * stays the size it was, so at 2x or 3x the frame shows its top-left corner (where the mark sits)
 * larger instead of pushing the options beside it away.
 */
function Framed({ frame, zoom, children }: { frame: RoundFrame; zoom: number; children: ReactNode }) {
  const height = frameHeight(frame);
  const inner = frame.kind === "phone" ? <PhoneFrame height={height}>{children}</PhoneFrame> : <Stage height={height}>{children}</Stage>;
  return (
    <div className="max-w-full overflow-hidden" style={{ height, width: frame.kind === "phone" ? PHONE_WIDTH : undefined }}>
      <div style={zoom === 1 ? undefined : { transform: `scale(${zoom})`, transformOrigin: "0 0" }}>{inner}</div>
    </div>
  );
}

function OptionHead({ option }: { option: RoundOption }) {
  return (
    <div className="mb-2 flex items-baseline gap-3">
      <span className="text-2xl font-semibold tabular-nums leading-none">{option.n}</span>
      <span className="min-w-0 truncate text-sm text-muted-foreground">{option.title}</span>
    </div>
  );
}

function NumberChips({ label, options, value, onPick }: { label: string; options: readonly RoundOption[]; value: number; onPick: (n: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 text-[11px] text-muted-foreground">{label}</span>
      <Segmented
        name={`Flip ${label}`}
        value={String(value)}
        options={options.map((o) => ({ value: String(o.n), label: String(o.n) }))}
        onChange={(next) => onPick(Number(next))}
      />
    </div>
  );
}

export function Round({
  id,
  cases,
  options,
  frame,
}: {
  id: string;
  cases: readonly RoundCase[];
  options: readonly RoundOption[];
  frame: RoundFrame;
}) {
  const [caseValue, setCaseValue] = useState(cases[0]?.value ?? "");
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]["value"]>("1");
  const [replay, setReplay] = useState(0);
  const [flip, setFlip] = useState(false);
  const [a, setA] = useState(options[0]?.n ?? 0);
  const [b, setB] = useState(options[1]?.n ?? options[0]?.n ?? 0);
  const [showB, setShowB] = useState(false);

  const zoomFactor = Number(zoom);
  const shown = flip ? options.filter((o) => o.n === a || o.n === b) : options;
  const current = showB ? b : a;
  const swap = (event: MouseEvent) => {
    // The tap belongs to the flip, not to the frame's own buttons.
    event.preventDefault();
    event.stopPropagation();
    setShowB((now) => !now);
  };

  return (
    <div data-round={id}>
      {/* Sticky under the page's own header: --pg-top is that header's height (set in app.tsx). */}
      <div className="sticky top-[var(--pg-top,0px)] z-20 -mx-4 border-b border-rule bg-background/95 px-4 py-2 backdrop-blur lg:top-0 lg:mx-0 lg:px-0">
        <div className="pg-scroll-row items-center gap-x-4">
          {cases.length > 0 && <Segmented name="Case" value={caseValue} options={cases} onChange={setCaseValue} />}
          <Segmented name="Zoom" value={zoom} options={ZOOMS} onChange={setZoom} />
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setReplay((n) => n + 1)}>
            Replay
          </Button>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Flip</span>
            <Segmented name="Flip" value={flip ? "on" : "off"} options={FLIP} onChange={(next) => setFlip(next === "on")} />
          </div>
        </div>
        {flip && (
          <div className="mt-2 flex flex-col gap-2">
            <NumberChips label="A" options={options} value={a} onPick={(n) => { setA(n); setShowB(false); }} />
            <NumberChips label="B" options={options} value={b} onPick={(n) => { setB(n); setShowB(true); }} />
          </div>
        )}
      </div>

      <div className={cn("pg-grid mt-4", flip ? "pg-round-flip" : "pg-round-row")}>
        {shown.map((option) => {
          const hidden = flip && option.n !== current;
          return (
            <div
              key={option.n}
              data-state={`${id}-option-${option.n}`}
              onClickCapture={flip && !hidden ? swap : undefined}
              className={cn("min-w-0", flip && "cursor-pointer", hidden && "pointer-events-none invisible")}
            >
              <OptionHead option={option} />
              <Framed frame={frame} zoom={zoomFactor}>
                <div key={replay} className="flex min-h-full flex-1 flex-col">
                  {option.render({ caseValue })}
                </div>
              </Framed>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { effortLabel, modelLabel } from "@/lib/model-label";
import type { PaneUsage } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE PANE'S MODEL, SMALL, ABOVE THE BELT. Altan asked for the selected model "somewhere subtle and
// super small above the belt, floating and at all times": which brain is answering is a fact he
// checks before he sends, and until now it was one tap away inside the Model command.
//
// IT FLOATS ON THE MIRROR'S BOTTOM-RIGHT CORNER, inside the same `relative` box the terminal-draft
// notice's slot pins to (agent-chat.tsx). Absolute, so it changes the height of nothing: not the
// scroller, not the card dock, not the chrome block (DESIGN.md §2). It is not a floating LAYER in the
// sense of ui/sheet.tsx: it is anchored to the pane, scrolls with nothing, takes no touch
// (`pointer-events-none`, so a tap on it reaches the mirror under it) and holds no control. The
// right corner because terminal and chat text both start at the left, and the centre belongs to the
// jump-to-latest button. Under the notice slot's `z-20`, so a draft notice covers it while it shows.
//
// 10px on a 12px line box, the caption size the belt's own tags use, on a page ground translucent
// enough that the mirror's last row still shows where the tag ends, and opaque enough that a dot does
// not drown in the letters under it. Absent, never a placeholder: nothing to say, no tag.
//
// THE USAGE DOTS FOLLOW THE MODEL (.adr/0115): the context use, then the 5-hour and 7-day windows of
// the subscription, five dots each, one per fifth. Picked by Altan from three shapes in the playground
// (2026-10-23, `#usage-row`, card 2). A dot lights from the left for each FULL fifth, so only 100% lights
// the fifth and 81% shows four, not five as a full window would; at 80% and up the lit dots take the
// working colour, never red, because red marks harm (DESIGN.md §4). A gauge the harness did not report
// is not drawn, and the screen reader gets the exact figure the dots round down.
//
// THE MODEL NAME STANDS DOWN WHILE THE SCREEN NAMES IT, the effort included. The caller passes no
// model then (agent-chat.tsx asks hooks/use-model-on-screen.ts), so a statusline that prints
// "Opus 5.5" is not doubled; the dots still draw. The tag is absolute either way, so it arriving or
// leaving moves nothing (DESIGN.md §2): there is no line to reserve because it owns none.

/** At or above this percentage a gauge takes the working colour. */
export const USAGE_WARN_AT = 80;

/** The dots per gauge: one per fifth. */
const DOTS = 5;

/** The short label and the spoken sentence of each window the phone draws. Unknown windows are skipped. */
const WINDOW_KEYS = new Map<string, { short: MessageKey; spoken: MessageKey }>([
  ["5h", { short: "chat.usage.window.5h", spoken: "chat.usage.window.5h.aria" }],
  ["7d", { short: "chat.usage.window.7d", spoken: "chat.usage.window.7d.aria" }],
]);

interface Gauge {
  id: string;
  short: string;
  spoken: string;
  used: number;
}

/** The gauges to draw, in order: the context, then each window this build knows. */
function gaugesOf(usage: PaneUsage | undefined): Gauge[] {
  if (usage === undefined) return [];
  const gauges: Gauge[] = [];
  if (usage.context !== undefined) {
    gauges.push({ id: "context", short: t("chat.usage.context"), spoken: t("chat.usage.context.aria", { percent: Math.round(usage.context) }), used: usage.context });
  }
  for (const limit of usage.limits ?? []) {
    const keys = WINDOW_KEYS.get(limit.window);
    if (keys === undefined) continue;
    gauges.push({ id: limit.window, short: t(keys.short), spoken: t(keys.spoken, { percent: Math.round(limit.used) }), used: limit.used });
  }
  return gauges;
}

/** Five 3px dots, lit from the left, one per full fifth. A dot is as wide as it is tall, so it may be round (DESIGN.md §3). */
function Dots({ used }: { used: number }) {
  const lit = Math.min(DOTS, Math.max(0, Math.floor(used / (100 / DOTS))));
  const warn = used >= USAGE_WARN_AT;
  return (
    <span data-slot="usage-dots" data-lit={lit} data-warn={warn || undefined} className="inline-flex items-center gap-px">
      {Array.from({ length: DOTS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-[3px] rounded-full",
            i < lit ? (warn ? "bg-status-working" : "bg-muted-foreground") : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

export function ModelTag({
  model,
  effort,
  usage,
}: {
  model: string | undefined;
  effort?: string | undefined;
  usage?: PaneUsage | undefined;
}) {
  useLocale();
  const name = modelLabel(model);
  const gauges = gaugesOf(usage);
  if (name === null && gauges.length === 0) return null;
  // THE EFFORT FOLLOWS THE MODEL, in the harness's own word (#463): "Opus 5.5 · high". It never draws
  // alone, and it goes with the model when the screen already names it, because the caller passes
  // neither then. The same model at `high` and at `low` is a different trade-off in time and cost.
  const level = name === null ? null : effortLabel(effort);
  const label = name === null ? null : level === null ? name : `${name} · ${level}`;
  const spoken = [label === null ? null : t("chat.model.aria", { name: label }), ...gauges.map((g) => g.spoken)].filter(
    (part): part is string => part !== null,
  );
  return (
    <div
      data-slot="model-tag"
      className="pointer-events-none absolute right-3 bottom-1 z-10 max-w-[70%] rounded-[2px] bg-background/90 px-1 text-[10px]/3 text-muted-foreground"
    >
      <span aria-hidden className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        {label !== null && <span className="min-w-0 truncate">{label}</span>}
        {gauges.map((g) => (
          <span key={g.id} data-gauge={g.id} className="flex shrink-0 items-center gap-[3px]">
            <span>{g.short}</span>
            <Dots used={g.used} />
          </span>
        ))}
      </span>
      <span className="sr-only">{spoken.join(". ")}</span>
    </div>
  );
}

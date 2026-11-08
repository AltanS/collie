// A PART IN ITS FRAME (M94 slice 02): the freshness of the design's section 4 and the failure display
// of its section 7, around any part.
//
// The frame reserves ONE line under the part, always, so a part going stale, failing or coming back
// repaints that line and moves nothing (DESIGN.md section 2). The line says the one thing that matters
// most (lib/mods/frame.ts): a tap that failed or got no answer, a paused or stopped mod, a failed run,
// the age of a part past its fresh window, and for a fresh part its age alone, in muted text. A failure's masked line opens on a tap, through
// `Collapse` (the one sanctioned way in-flow content appears), with one button, "Ask the agent to fix
// it", which hands a draft to `onDraft`; slice 03 asks which session's empty reply box it goes to.
//
// `ModView` puts a stored part, its frame and its view together for slice 03's places, and holds a
// new FORM back while a finger is down on the part, so a list that grows a row does not move the row
// under the thumb (design section 5). A new version of the same form draws at once.

import { Clock, Pause, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Collapse } from "../../components/ui/collapse";
import { NOTICE_ACTION } from "../../components/ui/notice";
import { t } from "../i18n";
import { cn } from "../utils";
import { useBridgeNow } from "./clock";
import { problemOf, readFrame, type FrameLine } from "./frame";
import { viewForm } from "./layout";
import { Placeholder, renderView, type RenderCtx } from "./render";
import type { ModPart, OpenTarget, ViewNode, WireModInfo, WireModPart } from "./schema";
import { modTapper, modsStore, useModPart, type DraftRequest, type ModsStore, type TapHandlers, type TapState } from "./store";
import { modTimeText, spanText } from "./time";

export interface PartFrameProps {
  part: WireModPart;
  /** The part's mod in the mod list: its state says paused or stopped. */
  mod?: WireModInfo;
  /** The last tap on this part. */
  tap?: TapState;
  /** When a paused mod runs again, when the bridge says. Absent: the line says it is paused. */
  retryAt?: string;
  /** The fix button's draft. */
  onDraft: (draft: DraftRequest) => void;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. */
  now?: number;
  /** The part itself, drawn with the frame's reading: `stale` takes the tone away. */
  children: (frame: { stale: boolean }) => ReactNode;
}

function ageText(asOf: string | undefined, now: number): string {
  return asOf === undefined ? "" : (modTimeText(asOf, "ago", now) ?? "");
}

/** The words of the frame line. A fresh part's line is its age alone, muted, never a blank band. */
function lineWords(line: FrameLine, now: number): string {
  switch (line.kind) {
    case "none":
      return ageText(line.asOf, now);
    case "age":
      return t("mods.frame.updated", { time: ageText(line.asOf, now) });
    case "failed":
      return line.asOf === undefined ? t("mods.frame.failedBare") : t("mods.frame.failed", { time: ageText(line.asOf, now) });
    case "paused": {
      const at = line.retryAt === undefined ? Number.NaN : Date.parse(line.retryAt);
      return Number.isFinite(at) && at > now ? t("mods.frame.paused", { time: t("mods.time.in", { time: spanText(at - now) }) }) : t("mods.frame.pausedSoon");
    }
    case "stopped":
      return t("mods.frame.stopped");
    case "tap-failed":
      return t("mods.frame.tapFailed");
    case "tap-unknown":
      return t("mods.frame.tapUnknown");
  }
}

function LineGlyph({ line }: { line: FrameLine }) {
  const glyph = "size-3.5 shrink-0";
  if (line.kind === "age") return <Clock aria-hidden className={glyph} />;
  if (line.kind === "paused") return <Pause aria-hidden className={glyph} />;
  if (line.kind === "none" || line.kind === "tap-unknown") return null;
  return <TriangleAlert aria-hidden className={glyph} />;
}

export function PartFrame({ part, mod, tap, retryAt, onDraft, now, children }: PartFrameProps) {
  const clock = useBridgeNow(now);
  const { stale, line } = readFrame(part, mod, tap, clock, retryAt);
  const problem = problemOf(line);
  const [open, setOpen] = useState(false);
  const shown = open && problem !== undefined;
  // The part redraws only when its own reading changes, not on every tick of the clock.
  const body = useMemo(() => children({ stale }), [children, stale]);
  return (
    <div data-slot="mod-part" data-stale={stale ? "" : undefined} data-line={line.kind} className="flex min-w-0 flex-col">
      {body}
      <div data-slot="mod-frame-line" className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <LineGlyph line={line} />
        <span className="min-w-0 flex-1 truncate tabular-nums">{lineWords(line, clock)}</span>
        {problem !== undefined && (
          <Button type="button" variant="ghost" size="sm" aria-expanded={shown} onClick={() => setOpen((was) => !was)} className={cn(NOTICE_ACTION, "shrink-0")}>
            {shown ? t("mods.frame.hide") : t("mods.frame.why")}
          </Button>
        )}
      </div>
      <Collapse open={shown}>
        {problem !== undefined && (
          <div data-slot="mod-frame-problem" className="flex flex-col items-start gap-2 pb-1">
            <p className="font-mono text-xs leading-4 break-words text-foreground">{problem}</p>
            <Button type="button" variant="outline" className="h-11" onClick={() => onDraft({ text: t("mods.frame.fixDraft", { id: part.mod, error: problem }) })}>
              {t("mods.frame.fix")}
            </Button>
          </div>
        )}
      </Collapse>
    </div>
  );
}

/** The view a part carries, for the places whose body is a view. `undefined` for a mark or a line. */
export function viewOf(value: ModPart): ViewNode | undefined {
  return "view" in value ? value.view : undefined;
}

/**
 * Hold a view's form while a finger is down on it. A new version of the same form shows at once (a
 * data change repaints); a new form waits for the finger to lift, then shows.
 */
interface HeldView {
  view: ViewNode | undefined;
  onPointerDown: () => void;
}

function useHeldView(view: ViewNode | undefined): HeldView {
  const [held, setHeld] = useState(view);
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (!down) return;
    const lift = () => setDown(false);
    window.addEventListener("pointerup", lift);
    window.addEventListener("pointercancel", lift);
    return () => {
      window.removeEventListener("pointerup", lift);
      window.removeEventListener("pointercancel", lift);
    };
  }, [down]);
  // React's "adjust state while rendering": the shown view follows the live one, except a new form
  // while a finger is down, which waits for the lift.
  const waits = down && view !== undefined && held !== undefined && viewForm(view) !== viewForm(held);
  if (held !== view && !waits) setHeld(view);
  return { view: waits ? held : view, onPointerDown: () => setDown(true) };
}

export interface ModViewProps {
  /** The `partKey` of a part whose place has a view: a mod session, a mod tab, a view on a session. */
  partKey: string;
  /** A reply's or the fix button's draft. */
  onDraft: (draft: DraftRequest) => void;
  /** A reply's open. */
  onOpen: (target: OpenTarget) => void;
  /** The session open on the phone, sent with a tap. */
  from?: string;
  store?: ModsStore;
  /** Pin the clock, for a test or a playground card. */
  now?: number;
}

/** A stored part's view in its frame, with its taps wired to the store. Nothing while the part is not held. */
export function ModView({ partKey, onDraft, onOpen, from, store = modsStore, now }: ModViewProps) {
  const { part, mod, tap } = useModPart(partKey, store);
  const { view, onPointerDown } = useHeldView(part === undefined ? undefined : viewOf(part.value));
  const onTap = useMemo(() => {
    const handlers: TapHandlers = { onDraft, onOpen };
    if (from !== undefined) handlers.from = { session: from };
    return modTapper(handlers, store);
  }, [onDraft, onOpen, from, store]);
  const draw = useMemo(
    () =>
      ({ stale }: { stale: boolean }) => {
        if (view === undefined) return <Placeholder />;
        const ctx: RenderCtx = { partKey, modName: mod?.name ?? part?.mod ?? "", stale, tap, onTap, onDraft, onOpen, now };
        return renderView(view, ctx);
      },
    [view, partKey, mod?.name, part?.mod, tap, onTap, onDraft, onOpen, now],
  );
  if (part === undefined) return null;
  return (
    <div onPointerDown={onPointerDown} className="min-w-0">
      <PartFrame part={part} mod={mod} tap={tap} onDraft={onDraft} now={now}>
        {draw}
      </PartFrame>
    </div>
  );
}

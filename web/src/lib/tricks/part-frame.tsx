// A PART IN ITS FRAME (M94 slice 02): the freshness of the design's section 4 and the failure display
// of its section 7, around any part.
//
// The frame reserves ONE line under the part, always, so a part going stale, failing or coming back
// repaints that line and moves nothing (DESIGN.md section 2). The line says the one thing that matters
// most (lib/tricks/frame.ts): a tap that failed or got no answer, a paused or stopped trick, a failed run,
// the age of a part past its fresh window, and for a fresh part its age alone, in muted text. A failure's masked line opens on a tap, through
// `Collapse` (the one sanctioned way in-flow content appears), with one button that COPIES "the trick
// `<id>` failed: `<error>`" on the phone (the tree's `does: copy`, design section 7), so the person can
// paste it to any agent. It sends nothing and places no draft: nothing in tricks writes into a reply box.
//
// `TrickView` puts a stored part, its frame and its view together for slice 03's places, and holds a
// new FORM back while a finger is down on the part, so a list that grows a row does not move the row
// under the thumb (design section 5). A new version of the same form draws at once.

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Icon } from "../../components/icons/icon";
import { Button } from "../../components/ui/button";
import { authedObjectUrl } from "../authed-url";
import { copyText } from "../clipboard";
import { setStatus } from "../status";
import { Collapse } from "../../components/ui/collapse";
import { NOTICE_ACTION } from "../../components/ui/notice";
import { t } from "../i18n";
import { cn } from "../utils";
import { useBridgeNow } from "./clock";
import { TrickBoundary } from "./boundary";
import { problemOf, readFrame, type FrameLine } from "./frame";
import { viewForm } from "./layout";
import { Placeholder, renderView, type LinkTarget, type RenderCtx } from "./render";
import { parsePartKey, partKey as keyOfPart, trickMediaPath, type TrickPart, type View, type ViewNode, type WireTrickInfo, type WireTrickPart } from "./schema";
import { tapRefusalLine, trickTapper, tricksStore, useTrickPart, type TricksStore, type TapHandlers, type TapState } from "./store";
import { trickTimeText, spanText } from "./time";

export interface PartFrameProps {
  part: WireTrickPart;
  /** The part's trick in the trick list: its state says paused or stopped. */
  trick?: WireTrickInfo;
  /** The last tap on this part. */
  tap?: TapState;
  /** When a paused trick runs again, when the bridge says. Absent: the line says it is paused. */
  retryAt?: string;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. */
  now?: number;
  /** The part itself, drawn with the frame's reading: `stale` takes the tone away. */
  children: (frame: { stale: boolean }) => ReactNode;
}

function ageText(asOf: string | undefined, now: number): string {
  return asOf === undefined ? "" : (trickTimeText(asOf, "ago", now) ?? "");
}

/** The words of the frame line. A fresh part's line is its age alone, muted, never a blank band. */
function lineWords(line: FrameLine, now: number): string {
  switch (line.kind) {
    case "none":
      return ageText(line.asOf, now);
    case "age":
      return t("tricks.frame.updated", { time: ageText(line.asOf, now) });
    case "failed":
      return line.asOf === undefined ? t("tricks.frame.failedBare") : t("tricks.frame.failed", { time: ageText(line.asOf, now) });
    case "paused": {
      const at = line.retryAt === undefined ? Number.NaN : Date.parse(line.retryAt);
      return Number.isFinite(at) && at > now ? t("tricks.frame.paused", { time: t("tricks.time.in", { time: spanText(at - now) }) }) : t("tricks.frame.pausedSoon");
    }
    case "stopped":
      return t("tricks.frame.stopped");
    case "tap-failed":
      return t("tricks.frame.tapFailed");
    case "tap-unknown":
      return t("tricks.frame.tapUnknown");
    case "tap-refused":
      return tapRefusalLine(line.refused);
  }
}

function LineGlyph({ line }: { line: FrameLine }) {
  const glyph = "size-3.5 shrink-0";
  if (line.kind === "age") return <Icon name="mod-age" aria-hidden className={glyph} />;
  if (line.kind === "paused") return <Icon name="mod-paused" aria-hidden className={glyph} />;
  // A tap on a face that moved is a race, not a fault: its line carries no trouble mark.
  if (line.kind === "none" || line.kind === "tap-unknown" || (line.kind === "tap-refused" && line.refused === "changed")) return null;
  return <Icon name="mod-trouble" aria-hidden className={glyph} />;
}

/** Copy the fix line on the phone: a phone action, no bridge write, no draft. */
function copyFixLine(text: string): void {
  copyText(text).then(
    () => setStatus(t("tricks.copied"), "success"),
    () => setStatus(t("tricks.copyFailed"), "error"),
  );
}

export function PartFrame({ part, trick, tap, retryAt, now, children }: PartFrameProps) {
  const clock = useBridgeNow(now);
  const { stale, line } = readFrame(part, trick, tap, clock, retryAt);
  const problem = problemOf(line);
  const [open, setOpen] = useState(false);
  const shown = open && problem !== undefined;
  // The part redraws only when its own reading changes, not on every tick of the clock.
  const body = useMemo(() => children({ stale }), [children, stale]);
  return (
    <div data-slot="trick-part" data-stale={stale ? "" : undefined} data-line={line.kind} className="flex min-w-0 flex-col">
      {/* A view that throws draws the placeholder here and keeps its frame line; a new rev tries it again. */}
      <TrickBoundary fallback="placeholder" resetKey={`${keyOfPart(part)}@${part.rev}`}>
        {body}
      </TrickBoundary>
      <div data-slot="trick-frame-line" className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <LineGlyph line={line} />
        <span className="min-w-0 flex-1 truncate tabular-nums">{lineWords(line, clock)}</span>
        {problem !== undefined && (
          <Button type="button" variant="ghost" size="sm" aria-expanded={shown} onClick={() => setOpen((was) => !was)} className={cn(NOTICE_ACTION, "shrink-0")}>
            {shown ? t("tricks.frame.hide") : t("tricks.frame.why")}
          </Button>
        )}
      </div>
      <Collapse open={shown}>
        {problem !== undefined && (
          <div data-slot="trick-frame-problem" className="flex flex-col items-start gap-2 pb-1">
            <p className="font-mono text-xs leading-4 break-words text-foreground">{problem}</p>
            <Button type="button" variant="outline" className="h-11" onClick={() => copyFixLine(t("tricks.frame.fixText", { id: part.trick, error: problem }))}>
              {t("tricks.frame.fix")}
            </Button>
          </div>
        )}
      </Collapse>
    </div>
  );
}

/** The view a part carries (the kids of its frame), for the places whose body is a view. `undefined` for a mark. */
export function viewOf(value: TrickPart): View | undefined {
  // A view that is no list is a part with no view: the placeholder.
  return "view" in value && Array.isArray(value.view) ? value.view : undefined;
}

/**
 * Hold a view's form while a finger is down on it. A new version of the same form shows at once (a
 * data change repaints); a new form waits for the finger to lift, then shows.
 */
interface HeldView {
  view: View | undefined;
  /** The rev of the part the shown view came from: a tap names it (N4). */
  rev: number;
  onPointerDown: () => void;
}

/** A view and the rev of the part it came from. */
interface DrawnView {
  view: View | undefined;
  rev: number;
}

function useHeldView(drawn: DrawnView): HeldView {
  const [held, setHeld] = useState(drawn);
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
  const view = drawn.view;
  const waits = down && view !== undefined && held.view !== undefined && viewForm(view) !== viewForm(held.view);
  if (held !== drawn && !waits) setHeld(drawn);
  const shown = waits ? held : drawn;
  return { view: shown.view, rev: shown.rev, onPointerDown: () => setDown(true) };
}

/** Every image `src` in a view, in order, each once. */
function imageSrcsOf(nodes: readonly ViewNode[] | undefined, out: string[] = []): string[] {
  for (const node of nodes ?? []) {
    const src = node.kind === "image" ? node.attrs.src : undefined;
    if (src !== undefined && !out.includes(src)) out.push(src);
    if ("kids" in node) imageSrcsOf(node.kids, out);
  }
  return out;
}

/**
 * The images of a part's view, from the trick's own `media/` folder (bridge/tricks/media.ts). An `<img
 * src>` cannot carry the pairing token (ADR 0086), so each picture is fetched with it
 * (`authedObjectUrl`) and handed to the view as an object URL; until it arrives, and when it fails, the
 * image's reserved box says its `alt`. The part's rev rides in the path, so a new version asks again.
 */
function useTrickImages(key: string, rev: number, view: View | undefined): ((src: string) => string | undefined) | undefined {
  const paths = useMemo(() => {
    const parsed = parsePartKey(key);
    if (parsed === undefined) return new Map<string, string>();
    return new Map(imageSrcsOf(view).map((src) => [src, trickMediaPath(parsed.host, parsed.trick, src, rev)]));
  }, [key, rev, view]);
  // Object URLs by path: a path names one src at one rev, so a stale answer never lands on a new rev.
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    const load = async (path: string): Promise<void> => {
      try {
        const url = await authedObjectUrl(path);
        if (live) setUrls((had) => new Map(had).set(path, url));
      } catch {
        // A picture that does not load keeps its box and its alt words.
      }
    };
    for (const path of paths.values()) void load(path);
    return () => {
      live = false;
    };
  }, [paths]);
  return useMemo(() => {
    if (paths.size === 0) return undefined;
    return (src: string) => {
      const path = paths.get(src);
      return path === undefined ? undefined : urls.get(path);
    };
  }, [paths, urls]);
}

export interface TrickViewProps {
  /** The `partKey` of a part whose place has a view: a trick session, a trick's own tab, a view on a session. */
  partKey: string;
  /** A row's `href` or a link was tapped. */
  onLink: (target: LinkTarget) => void;
  /**
   * The URL of an image of the trick folder, for a playground card. Absent: the picture is fetched from
   * the trick's `media/` folder on its bridge, with the pairing token.
   */
  imageUrl?: (src: string) => string | undefined;
  /** The session open on the phone, sent with a tap. */
  from?: string;
  store?: TricksStore;
  /** Pin the clock, for a test or a playground card. */
  now?: number;
}

/** A stored part's view in its frame, with its taps wired to the store. Nothing while the part is not held. */
export function TrickView({ partKey, onLink, imageUrl, from, store = tricksStore, now }: TrickViewProps) {
  const { part, trick, tap } = useTrickPart(partKey, store);
  if (part === undefined) return null;
  // The boundary stands outside the body that reads the part's value, so a value that throws as it is
  // read draws the placeholder too, and a new rev tries it again.
  return (
    <TrickBoundary fallback="placeholder" resetKey={`${partKey}@${part.rev}`}>
      <TrickViewBody partKey={partKey} part={part} trick={trick} tap={tap} onLink={onLink} imageUrl={imageUrl} from={from} store={store} now={now} />
    </TrickBoundary>
  );
}

interface TrickViewBodyProps extends Omit<TrickViewProps, "store"> {
  part: WireTrickPart;
  trick: WireTrickInfo | undefined;
  tap: TapState | undefined;
  store: TricksStore;
}

function TrickViewBody({ partKey, part, trick, tap, onLink, imageUrl, from, store, now }: TrickViewBodyProps) {
  const partValue = part.value;
  // Read once per version of the part, so the held view keeps one identity between redraws.
  const partRev = part.rev;
  const live = useMemo((): DrawnView => ({ view: viewOf(partValue), rev: partRev }), [partValue, partRev]);
  const { view, rev, onPointerDown } = useHeldView(live);
  const fetched = useTrickImages(partKey, part.rev, view);
  const images = imageUrl ?? fetched;
  const onTap = useMemo(() => {
    const handlers: TapHandlers = {};
    if (from !== undefined) handlers.from = { session: from };
    // N4: the rev of the view drawn now (a held one while a finger is down), not the store's newest.
    return trickTapper(handlers, store, rev);
  }, [from, store, rev]);
  const draw = useMemo(
    () =>
      ({ stale }: { stale: boolean }) => {
        if (view === undefined) return <Placeholder />;
        const ctx: RenderCtx = { partKey, stale, tap, onTap, onLink, now };
        if (images !== undefined) ctx.imageUrl = images;
        return renderView(view, ctx);
      },
    [view, partKey, tap, onTap, onLink, images, now],
  );
  return (
    <div onPointerDown={onPointerDown} className="min-w-0">
      <PartFrame part={part} trick={trick} tap={tap} now={now}>
        {draw}
      </PartFrame>
    </div>
  );
}

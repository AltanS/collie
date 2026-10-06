// What is busy right now, as ONE model the Collie mark and the busy bar read (web/src/lib/busy.ts
// and web/src/hooks/use-poll-busy.ts, as a plain module on a TypedEventTarget).
//
// TWO CHANNELS, NOT ONE, as in web/:
//   - the ORBIT (`orbit`): operator-started work the person is waiting on. A first read of a screen,
//     a send, an upload, a transcription. A background poll is EXCLUDED on purpose: it runs on a
//     constant beat, so an orbit fed from it would never rest.
//   - the BAR (`bar`): "is the app talking to the bridge at all". Every write counts for its whole
//     flight; a first read counts once it has run past NAV_BAR_MS; a poll counts only once it HUNG,
//     past POLL_BAR_MS. A routine fast poll or navigation never trips it, so the bar stays dark on
//     healthy traffic. The CSS holds the bar invisible for its first 120 ms on top of that.
//   - `stalled` is the third reading, for the connection state: any load (first read or poll) in
//     flight past STALLED_MS looks like a black-holed fetch (web/src/hooks/use-loading-stalled.ts).
//
// Nothing here renders. Consumers subscribe to `change` through `scheduleUpdate` (REMIX3.md rule 1),
// or, for the mark, write the DOM directly. Every `begin*` returns an IDEMPOTENT release, so a
// teardown that runs twice cannot drive a counter negative.
import { TypedEventTarget } from "remix/component";

/** A navigation (a first read) still in flight this long shows the bar (web: NAV_BUSY_THRESHOLD_MS). */
export const NAV_BAR_MS = 500;
/** A poll still in flight this long has hung and shows the bar (web: POLL_BUSY_THRESHOLD_MS). */
export const POLL_BAR_MS = 6_000;
/** A load in flight this long counts as stalled for the connection state (web: 2500). */
export const STALLED_MS = 2_500;

export type LoadKind = "nav" | "poll";

/** The three readings, compared by value so an unchanged one wakes nobody. */
export interface BusyView {
  orbit: boolean;
  bar: boolean;
  stalled: boolean;
}

/** The timer pair a test swaps for a fake clock. A handle is the number `window.setTimeout` returns. */
export interface Timers {
  set(run: () => void, ms: number): number;
  clear(handle: number): void;
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (handle) => window.clearTimeout(handle),
};

interface Load {
  kind: LoadKind;
  pastBar: boolean;
  pastStalled: boolean;
  timers: number[];
}

export class BusyModel extends TypedEventTarget<{ change: Event }> {
  #timers: Timers;
  #work = 0;
  #writes = 0;
  #loads = new Set<Load>();
  #view: BusyView = { orbit: false, bar: false, stalled: false };

  constructor(timers: Timers = REAL_TIMERS) {
    super();
    this.#timers = timers;
  }

  /** The current readings. Same object until one of them changes. */
  get view(): BusyView {
    return this.#view;
  }

  /** Operator-started work the orbit should turn for (a send, an upload, a transcription). */
  beginWork(): () => void {
    this.#work++;
    this.#refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#work--;
      this.#refresh();
    };
  }

  /** One write in flight: the bar shows for its whole flight. */
  beginWrite(): () => void {
    this.#writes++;
    this.#refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#writes--;
      this.#refresh();
    };
  }

  /** Count `work` as a write for as long as it runs (web's `trackBusy`). */
  track<T>(work: Promise<T>): Promise<T> {
    const release = this.beginWrite();
    return work.finally(release);
  }

  /**
   * One read in flight. A `nav` load (the first read of a screen) turns the orbit for its whole
   * flight and shows the bar once it passes NAV_BAR_MS; a `poll` load never turns the orbit and
   * shows the bar only past POLL_BAR_MS. Either kind marks the app stalled past STALLED_MS.
   */
  beginLoad(kind: LoadKind): () => void {
    const load: Load = { kind, pastBar: false, pastStalled: false, timers: [] };
    this.#loads.add(load);
    load.timers.push(
      this.#timers.set(() => {
        load.pastBar = true;
        this.#refresh();
      }, kind === "nav" ? NAV_BAR_MS : POLL_BAR_MS),
      this.#timers.set(() => {
        load.pastStalled = true;
        this.#refresh();
      }, STALLED_MS),
    );
    this.#refresh();
    return () => {
      if (!this.#loads.delete(load)) return;
      for (const handle of load.timers) this.#timers.clear(handle);
      this.#refresh();
    };
  }

  /** Drop everything counted. For a test that left work open. */
  reset(): void {
    for (const load of this.#loads) for (const handle of load.timers) this.#timers.clear(handle);
    this.#loads.clear();
    this.#work = 0;
    this.#writes = 0;
    this.#refresh();
  }

  #refresh(): void {
    let nav = false;
    let pastBar = false;
    let stalled = false;
    for (const load of this.#loads) {
      if (load.kind === "nav") nav = true;
      pastBar ||= load.pastBar;
      stalled ||= load.pastStalled;
    }
    const next: BusyView = { orbit: this.#work > 0 || nav, bar: this.#writes > 0 || pastBar, stalled };
    const prev = this.#view;
    if (prev.orbit === next.orbit && prev.bar === next.bar && prev.stalled === next.stalled) return;
    this.#view = next;
    this.dispatchEvent(new Event("change"));
  }
}

/** The app's one model. */
export const busy = new BusyModel();

/** Hold the orbit for as long as the returned release has not been called (web's `beginBusy`). */
export function beginBusy(): () => void {
  return busy.beginWork();
}

/** Count a promise as an in-flight write for the bar (web's `trackBusy`). */
export function trackBusy<T>(work: Promise<T>): Promise<T> {
  return busy.track(work);
}

// ── Which requests are which ─────────────────────────────────────────────────────────────────────

export type RequestClass = "write" | "first-read" | "other";

/** The reads a screen waits on when it opens: web's loaders (pane, history, crew, machines, devices). */
const SCREEN_READS = [/^\/api\/pane\/[^/]+$/, /^\/api\/history$/, /^\/api\/crew$/, /^\/api\/machines$/, /^\/api\/devices$/];

/** The bridge path of a URL, with any mount prefix (ADR 0052) taken off. Null for a non-API URL. */
function bridgePath(url: URL): string | null {
  const at = url.pathname.indexOf("/api/");
  return at === -1 ? null : url.pathname.slice(at);
}

export interface Classified {
  kind: RequestClass;
  /** Which screen read this is (path, machine and session), for "has it been answered yet". */
  key: string;
}

/** What a request means for the busy model. Pure: `answered` is the set of screen reads already seen. */
export function classify(method: string, url: URL, answered: ReadonlySet<string>): Classified {
  const path = bridgePath(url);
  if (path === null) return { kind: "other", key: "" };
  if (method.toUpperCase() !== "GET") return { kind: "write", key: "" };
  if (!SCREEN_READS.some((pattern) => pattern.test(path))) return { kind: "other", key: "" };
  const key = `${path}|${url.searchParams.get("host") ?? ""}|${url.searchParams.get("session") ?? ""}`;
  return { kind: answered.has(key) ? "other" : "first-read", key };
}

type FetchInput = Request | URL | string;
type Fetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface Described {
  method: string;
  url: URL;
}

function describe(input: FetchInput, init: RequestInit | undefined, base: string): Described {
  const isRequest = input instanceof Request;
  const method = init?.method ?? (isRequest ? input.method : "GET");
  const raw = isRequest ? input.url : input instanceof URL ? input.href : String(input);
  return { method, url: new URL(raw, base) };
}

const wrapped = new WeakSet<object>();

/**
 * Count the bridge's own traffic into `model`, once, for the page's life: every non-GET under
 * `/api/` for its whole flight (the bar), and the first read of a screen's data (the orbit and,
 * past NAV_BAR_MS, the bar). It wraps `fetch` because every write and read of this shell, its own
 * `lib/api.ts` and web/'s, ends in that one call; counting at the call sites would miss half.
 * GETs that are not a screen's first read pass through untouched.
 */
export function startBusyTracking(model: BusyModel = busy, target: { fetch: Fetch; location: { href: string } } = globalThis): void {
  if (wrapped.has(target)) return;
  wrapped.add(target);
  const original = target.fetch.bind(target);
  const answered = new Set<string>();
  target.fetch = (input, init) => {
    const { method, url } = describe(input, init, target.location.href);
    const { kind, key } = classify(method, url, answered);
    if (kind === "other") return original(input, init);
    const release = kind === "write" ? model.beginWrite() : model.beginLoad("nav");
    const call = original(input, init);
    // Watches the call without changing what the caller gets: the same promise goes back.
    const settle = async (): Promise<void> => {
      try {
        const res = await call;
        if (kind === "first-read" && res.ok) answered.add(key);
      } catch {
        // The caller sees the failure; a failed first read stays a first read.
      } finally {
        release();
      }
    };
    void settle();
    return call;
  };
}

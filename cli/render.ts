// The presentation seam: one decision, made once per invocation, about whether this run gets the
// TTY view or the plain lines.
//
// ── WHY A SEAM AND NOT A `process.stdout.isTTY` CHECK AT THE POINT OF USE ────
// Every verb's output is pinned — by `cli/*.test.ts` against a fake `Io`, and by
// `scripts/collie-cli.test.sh` against the compiled binary with its stdout redirected to a file.
// Both of those are non-TTY, and both must keep seeing EXACTLY the lines they saw before the TTY
// view existed. So the rich renderer is not a formatting flag threaded through the verbs: it is an
// object that is either there or `null`, resolved here, and every verb that has a rich surface
// keeps its plain branch as the one that runs when it is `null`.
//
// The inputs are arguments rather than reads of `process`, so the decision is a pure function a
// unit test can drive through all of its corners without monkeypatching the runtime.

import type { Io } from "./io.ts";

/** What the decision is made from. Nothing here is read from `process` — the caller supplies it. */
export interface RenderInputs {
  /** Is stdout a terminal? A pipe, a file and a systemd journal are all `false`. */
  readonly isTTY: boolean;
  /** Is this a CI runner? A CI log is a file with a terminal's clothes on. */
  readonly ci: boolean;
  /** Did the operator say `--plain`? The override that always wins. */
  readonly plain: boolean;
}

/** The rule, in one line: a terminal, not CI, not overridden. */
export function wantsRich(inputs: RenderInputs): boolean {
  return inputs.isTTY && !inputs.ci && !inputs.plain;
}

/**
 * Read the two ambient inputs off the environment. `CI` is honoured however it is spelled — any
 * non-empty value that is not the word "false", which is the convention every runner follows.
 */
export function renderInputs(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
  plain: boolean,
): RenderInputs {
  const ci = (env.CI ?? "").trim().toLowerCase();
  return { isTTY, ci: ci !== "" && ci !== "false" && ci !== "0", plain };
}

/**
 * The global `--plain` escape hatch, taken out of argv before the parser ever sees it.
 *
 * It is stripped rather than declared as a commander option so it works in every position — after
 * the verb, after a subcommand, in the middle of a pack invite's flags — without every leaf command
 * having to redeclare it. Nothing else in the CLI's grammar spells a bare `--plain`, so there is no
 * value it could be shadowing.
 */
export function takePlainFlag(argv: readonly string[]): { plain: boolean; rest: string[] } {
  const rest = argv.filter((a) => a !== "--plain");
  return { plain: rest.length !== argv.length, rest };
}

// ── What a rich surface is handed ────────────────────────────────────────────
// These are the models, and they live HERE rather than in `cli/ui/` so a verb can describe what it
// wants drawn without importing ink. A plain run never loads a line of React: `loadUi` is the only
// path to `cli/ui/`, and it is only called when {@link wantsRich} said yes.
//
// Every model is derived from the same data the plain lines are formatted from, in the same place,
// so the two renderings cannot describe different worlds — the plain formatter and the ink component
// are two readers of one value, not two writers of one screen.

/** How a line reads, not what colour it is — `cli/ui/` decides that. */
export type Tone = "plain" | "dim" | "good" | "warn" | "bad";

/** A pre-formatted line that already contains its own indentation, plus how it should read. */
export interface TonedLine {
  readonly text: string;
  readonly tone: Tone;
}

/** Structurally `cli/doctor.ts`'s `Finding`, restated so this module depends on nothing. */
export interface UiFinding {
  readonly check: string;
  readonly status: "ok" | "warn" | "error" | "skipped";
  readonly detail: string;
  readonly remedy: string | null;
}

/** `collie doctor`, as a table. `pack` empty means `packNote` is the whole pack section. */
export interface DoctorView {
  readonly heading: string;
  readonly local: readonly UiFinding[];
  readonly packTitle: string;
  readonly pack: readonly UiFinding[];
  readonly packNote: readonly string[];
}

/** The `status` / `start` banner: one verdict and a label-value block. */
export interface StatusView {
  readonly running: boolean;
  readonly headline: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

// ── WHICH VERBS GET A SURFACE ────────────────────────────────────────────────
// **A verb that streams progress or prompts on stdin may have an ink surface if and only if that
// surface owns EVERY byte of the verb's output — prompts included — for as long as it is mounted.**
// Nothing else may write to stdout or stderr between mount and unmount: not a `console.log`, not a
// nested lifecycle verb's own lines, not Bun's `confirm()`/`prompt()`. A verb that cannot promise
// that gets no surface, and the one-shot verbs (`doctor`, `status`/`start`, `pack status`) satisfy
// it trivially — they compute an answer and then draw it once.
//
// The rule is written that way because of how `pack add` failed in the field the first time. It had
// a live leg spinner MIXED with plain `io` writes and Bun's own prompts on the same tty, and the
// report was every way that can go wrong at once — leg lines out of order, the `[y/N]` prompt
// clobbered mid-render, and ✓/spinner statuses landing AFTER the error verdict they were supposed to
// precede. `console` patching moves the tearing around; it does not fix it, because the prompts do
// not go through `console` at all. The fix is not "no surface" — it is **one writer**.
//
// So `pack add` now has a surface, and it holds the whole run: every line it would have printed is
// an {@link AddEvent} instead ({@link plainAdd} replays those as the plain lines, byte for byte),
// every nested write goes through the `Io` the surface hands out, and both questions are answered
// inside the ink app. `cli/remote.ts` swaps `deps.io`, `deps.confirm` and `deps.prompt` for the
// surface's own for the length of the run, which is what makes "nothing else writes" structural.

/** The four legs of `pack add`, in the order they run. */
export type AddLeg = "probe" | "install" | "configure" | "enroll";

/** How a `pack add` line reads. Not a stream — {@link AddEvent}'s `line` carries that separately. */
export type AddTone = "info" | "warn" | "error";

/**
 * Everything `pack add` says, as structure rather than text.
 *
 * Two readers: {@link plainAdd}, which writes the lines the verb has always written, and
 * {@link projectAdd}, which folds the stream into the model `cli/ui/pack-add.tsx` draws. The rich
 * view never parses a line — the leg it belongs to, whether it passed and what the detail is are all
 * carried here.
 */
export type AddEvent =
  /** The run's subject, once, as soon as it is known. */
  | { readonly kind: "title"; readonly host: string }
  /** A leg began. `text` is the plain line it has always printed, or `""` for the three silent ones. */
  | { readonly kind: "leg-start"; readonly leg: AddLeg; readonly text: string }
  /** A leg finished. A failing leg's diagnosis is the `line` events around it, not `detail`. */
  | { readonly kind: "leg-done"; readonly leg: AddLeg; readonly ok: boolean; readonly detail: string }
  /** One of the probe's name/value pairs. */
  | { readonly kind: "fact"; readonly name: string; readonly value: string }
  /** A free line, with its stream pinned: `warn:` on stdout is a real case here, so it is explicit. */
  | { readonly kind: "line"; readonly text: string; readonly tone: AddTone; readonly stream: "out" | "err" }
  /**
   * A nested `collie restart` is about to write its own block — the two "bridge stopped/started"
   * lines, the serve config, the boxed banner, TWICE in one run. Plain prints all of it (it always
   * has); the rich view collapses the window to `label` on one dim row, and only flushes what the
   * restart said when it FAILED, where it is the diagnosis.
   */
  | { readonly kind: "restart-begin"; readonly label: string }
  | { readonly kind: "restart-end"; readonly ok: boolean }
  /** The last word. A failing verdict has no plain form — the `error:` lines above it are the verdict. */
  | { readonly kind: "verdict"; readonly ok: boolean; readonly text: string };

/**
 * The value column of `pack add`'s `✓` rows.
 *
 * 11 characters, except for the two rows that have always been 10 — `git` and `bun` were written a
 * column short and every golden in the suite records it. The rich view lays the same pairs out with
 * the layout engine and does not inherit the wart.
 */
const ADD_LABEL_WIDTH = 11;
const ADD_NARROW_LABELS: ReadonlySet<string> = new Set(["git", "bun"]);

/** The `✓ <label><pad><value>` row, as `pack add` has always spelled it. */
function addRow(label: string, value: string): string {
  const width = ADD_NARROW_LABELS.has(label) ? ADD_LABEL_WIDTH - 1 : ADD_LABEL_WIDTH;
  return `✓ ${label}${" ".repeat(Math.max(1, width - label.length))}${value}`;
}

/** The `✓` label a finished leg wears. `probe` has none — its facts are its output. */
const ADD_LEG_LABEL: Record<AddLeg, string | null> = {
  probe: null,
  install: "install",
  configure: "bind",
  enroll: "enrolled",
};

/**
 * The plain reader: replay one event as the exact line(s) `pack add` printed before it had a
 * surface. This is the only formatter — the rich view derives its own text from the same events, so
 * neither can drift into describing a different run.
 */
export function plainAdd(io: Io, event: AddEvent): void {
  switch (event.kind) {
    case "title":
      return;
    case "leg-start":
      if (event.text !== "") io.out(event.text);
      return;
    case "leg-done": {
      const label = ADD_LEG_LABEL[event.leg];
      if (!event.ok || label === null) return;
      io.out(addRow(label, event.detail));
      return;
    }
    case "fact":
      io.out(addRow(event.name, event.value));
      return;
    case "line":
      if (event.stream === "err") io.err(event.text);
      else io.out(event.text);
      return;
    case "restart-begin":
    case "restart-end":
      // The nested verb writes its own block through the same `Io`; these only bracket it.
      return;
    case "verdict":
      if (event.ok) io.out(`✓ ${event.text}`);
      return;
  }
}

// ── The rich model ───────────────────────────────────────────────────────────

export interface AddNote {
  readonly text: string;
  readonly tone: AddTone;
}

export interface AddLegView {
  readonly leg: AddLeg;
  readonly status: "pending" | "active" | "done" | "failed";
  /** The finished leg's one-line summary. Empty until it finishes. */
  readonly detail: string;
  /** Everything said while this leg was the one running. */
  readonly notes: readonly AddNote[];
}

export interface AddView {
  readonly host: string | null;
  readonly facts: readonly { readonly name: string; readonly value: string }[];
  /** Anything said before the first leg started — a usage error, a refusal from local state. */
  readonly preamble: readonly AddNote[];
  readonly legs: readonly AddLegView[];
  readonly verdict: { readonly ok: boolean; readonly text: string } | null;
}

const ADD_LEGS: readonly AddLeg[] = ["probe", "install", "configure", "enroll"];

/**
 * Fold the event stream into what the terminal draws. Pure, and deliberately outside `cli/ui/`: the
 * whole of the rich view's behaviour is testable without mounting anything.
 */
export function projectAdd(events: readonly AddEvent[]): AddView {
  let host: string | null = null;
  const facts: { name: string; value: string }[] = [];
  const preamble: AddNote[] = [];
  let verdict: { ok: boolean; text: string } | null = null;
  const legs = new Map<AddLeg, { status: AddLegView["status"]; detail: string; notes: AddNote[] }>(
    ADD_LEGS.map((leg) => [leg, { status: "pending", detail: "", notes: [] }]),
  );
  let current: AddLeg | null = null;
  // The restart window: lines land here instead of on the leg, and are dropped when it worked.
  let restart: { label: string; held: AddNote[] } | null = null;

  const noteHere = (note: AddNote): void => {
    if (restart !== null) restart.held.push(note);
    else if (current === null) preamble.push(note);
    else legs.get(current)!.notes.push(note);
  };

  for (const event of events) {
    switch (event.kind) {
      case "title":
        host = event.host;
        break;
      case "leg-start":
        current = event.leg;
        legs.get(event.leg)!.status = "active";
        break;
      case "leg-done": {
        const leg = legs.get(event.leg)!;
        leg.status = event.ok ? "done" : "failed";
        leg.detail = event.detail;
        break;
      }
      case "fact":
        facts.push({ name: event.name, value: event.value });
        break;
      case "line":
        noteHere({ text: event.text, tone: event.tone });
        break;
      case "restart-begin":
        restart = { label: event.label, held: [] };
        break;
      case "restart-end": {
        const window = restart;
        restart = null;
        if (window === null) break;
        if (event.ok) {
          noteHere({ text: `↻ ${window.label}`, tone: "info" });
        } else {
          for (const held of window.held) noteHere({ text: held.text, tone: "warn" });
          noteHere({ text: `↻ ${window.label} — the restart failed`, tone: "error" });
        }
        break;
      }
      case "verdict":
        verdict = { ok: event.ok, text: event.text };
        // A verdict ends the run: a leg still spinning at that point never finished.
        if (current !== null && legs.get(current)!.status === "active") {
          legs.get(current)!.status = event.ok ? "done" : "failed";
        }
        break;
    }
  }
  return {
    host,
    facts,
    preamble,
    verdict,
    legs: ADD_LEGS.map((leg) => ({ leg, ...legs.get(leg)! })),
  };
}

/**
 * A mounted `pack add` surface. **While this exists, it is the only writer**: `io` is what every
 * nested write must go through, and the two questions are answered inside the app rather than on
 * Bun's `confirm()`/`prompt()`.
 */
export interface AddSurface {
  /** Free lines — errors, warnings, a nested verb's chatter — as events, never as terminal writes. */
  readonly io: Io;
  emit(event: AddEvent): void;
  /** `[y/N]`, drawn in the app. `null` is never returned: the app is on a terminal by construction. */
  confirm(question: string): Promise<boolean | null>;
  prompt(question: string): Promise<string | null>;
  /** Render the last frame, then let go of the terminal. */
  close(): Promise<void>;
}

/** The rich renderer. Absent (`null`) is the normal case: every verb's plain branch is the default. */
export interface Ui {
  doctor(view: DoctorView): Promise<void>;
  status(view: StatusView): Promise<void>;
  packMembers(lines: readonly TonedLine[]): Promise<void>;
  /**
   * Mounts the streaming surface. The caller MUST `close()` it, on every exit path.
   *
   * Optional so a test's stand-in `Ui` can be the three one-shot surfaces and nothing else — a fake
   * without it simply leaves `pack add` on its plain branch, which is the default anyway.
   */
  packAdd?(): AddSurface;
}

/**
 * Load the ink renderer. Dynamic on purpose: `import` is where react, ink and yoga's layout engine
 * get pulled in, and a piped `collie url` should not pay for a UI it will not draw.
 */
export async function loadUi(): Promise<Ui> {
  const { createUi } = await import("./ui/index.tsx");
  return createUi();
}

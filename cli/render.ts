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
// **A verb that streams progress or prompts on stdin never gets an ink surface. Ink is for a verb
// that renders a finished model once.** The three below (`doctor`, `status`/`start`, `pack status`)
// each compute an answer and then draw it; nothing is printed while they are still working, and
// nothing is read from stdin while a frame is on screen.
//
// `pack add` had a live leg spinner and it is gone, because it is the other kind of verb: it streams
// informational lines for the whole of a four-leg SSH pipeline and asks two questions on Bun's
// `confirm()`/`prompt()` in the middle of it. Ink owns the bottom of the terminal for as long as it
// is mounted, and the field report was every way that can go wrong at once — leg lines out of order,
// the `[y/N]` prompt clobbered mid-render, and ✓/spinner statuses landing AFTER the error verdict
// they were supposed to precede. `console` patching moves the tearing around; it does not fix it,
// because the prompts do not go through `console` at all. So `pack add` is plain, always.

/** The rich renderer. Absent (`null`) is the normal case: every verb's plain branch is the default. */
export interface Ui {
  doctor(view: DoctorView): Promise<void>;
  status(view: StatusView): Promise<void>;
  packMembers(lines: readonly TonedLine[]): Promise<void>;
}

/**
 * Load the ink renderer. Dynamic on purpose: `import` is where react, ink and yoga's layout engine
 * get pulled in, and a piped `collie url` should not pay for a UI it will not draw.
 */
export async function loadUi(): Promise<Ui> {
  const { createUi } = await import("./ui/index.tsx");
  return createUi();
}

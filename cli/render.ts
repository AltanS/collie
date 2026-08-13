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

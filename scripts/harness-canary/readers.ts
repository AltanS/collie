// Collie's own readers, loaded from a checkout at run time.
//
// The canary judges a screen with exactly the code the phone runs: `parseAnsi` + `splitLines`, the
// agent's adapter (`composerReady`, `extractInputDraft`, `draftCarriesSend`), `buildBlocks`, and the
// client's `sendGuardedReply`. They are imported by path from `<root>/web/src/lib/`, so `--readers`
// can point the same canary at an older checkout (a git worktree at v1.13.1) and show that it would
// have caught what that release missed.
//
// The imports are dynamic on purpose. The root tsconfig does not type-check web/, and a static import
// would pull the whole client into it; the few shapes used here are restated below instead.

import { join } from "node:path";

/** A parsed terminal row. Opaque here: only the readers look inside it. */
export interface Line {
  readonly segments: readonly { readonly text: string }[];
}

export interface Block {
  readonly kind: string;
}

export interface Adapter {
  readonly agent: string;
  extractInputDraft(lines: Line[]): string | null;
  composerReady?(lines: Line[]): boolean;
  draftCarriesSend?(sent: string, draft: string): boolean;
  draftIsOpaque?(draft: string): boolean;
}

export type ReplyOutcome =
  | { readonly status: "sent" }
  | { readonly status: "blocked" | "stalled" | "error"; readonly error: string };

export interface Readers {
  /** The checkout the readers came from. */
  readonly root: string;
  parse(text: string): Line[];
  lineText(line: Line): string;
  buildBlocks(lines: Line[], agent: string): Block[];
  adapterFor(agent: string): Adapter | undefined;
  draftCarriesSend(sent: string, draft: string | null): boolean;
  sendGuardedReply(paneId: string, text: string, agent: string): Promise<ReplyOutcome>;
  /** The shipped harness bar for an agent. Absent when the checkout predates `harness-bar.ts`. */
  readonly barFor?: (agent: string) => readonly BarItem[];
  /**
   * Stamp a successful read into the readers' own lib/liveness.ts (M46). Absent when the checkout
   * predates it (`--readers` at v1.13.1), where the reply action has no liveness gate to satisfy.
   */
  readonly markLive?: (paneId: string) => void;
}

/** One harness-bar button, as `web/src/lib/harness-bar.ts` ships it. */
export interface BarItem {
  readonly id: string;
  readonly command: string;
  readonly confirm?: boolean;
}
interface BarModule {
  barFor(agent: string): readonly BarItem[];
}
interface LivenessModule {
  markLive(paneId: string): void;
}

interface AnsiModule {
  parseAnsi(input: string): readonly Line["segments"][number][];
}
interface BlocksModule {
  splitLines(segments: readonly Line["segments"][number][]): Line[];
  lineText(line: Line): string;
}
interface HarnessModule {
  buildBlocks(lines: Line[], ctx: { agent: string }): Block[];
  adapterFor(agent: string | undefined): Adapter | undefined;
}
interface DraftMatchModule {
  draftCarriesSend(sent: string, draft: string | null): boolean;
}
interface SendTextReply {
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
}
type SendTextOutcome =
  | { readonly status: "answered"; readonly reply: SendTextReply }
  | { readonly status: "noAnswer" | "refused"; readonly error: string };
interface ReplyModule {
  draftCarriesSend?(sent: string, draft: string | null): boolean;
  sendGuardedReply?(args: { paneId: string; text: string; agent: string }): Promise<ReplyOutcome>;
  sendText?(args: { paneId: string; text: string; held: null }): Promise<SendTextOutcome>;
}

function mapSendTextOutcome(res: SendTextOutcome): ReplyOutcome {
  if (res.status !== "answered") {
    return { status: res.status === "refused" ? "blocked" : "error", error: res.error };
  }
  const { outcome, reason, detail } = res.reply;
  if (outcome === "sent" || outcome === "effective") return { status: "sent" };
  const head = reason === null ? (outcome ?? "unknown") : `${outcome ?? "unknown"} (${reason})`;
  const error = detail === null || detail === "" ? head : `${head}: ${detail}`;
  if (outcome === "refused") return { status: "blocked", error };
  if (outcome === "typed_not_submitted" || outcome === "unknown") return { status: "stalled", error };
  return { status: "error", error };
}

/**
 * Import the readers from `root`. The caller must have installed the browser stand-ins and the
 * fetch shim first (transport.ts): the reply action reads `localStorage` and `document` when its
 * modules load, and every call it makes goes through `fetch`.
 */
export async function loadReaders(root: string): Promise<Readers> {
  const lib = join(root, "web", "src", "lib");
  const ansi: AnsiModule = await import(join(lib, "ansi.ts"));
  const blocks: BlocksModule = await import(join(lib, "blocks.ts"));
  const harness: HarnessModule = await import(join(lib, "harness", "index.ts"));
  const reply: ReplyModule = await import(join(lib, "reply-action.ts"));
  const draftMatch: DraftMatchModule | undefined = await import(join(lib, "draft-match.ts")).catch(() => undefined);
  const liveness: LivenessModule | undefined = await import(join(lib, "liveness.ts")).catch(() => undefined);
  const bar: BarModule | undefined = await import(join(lib, "harness-bar.ts")).catch(() => undefined);
  const carriesSend = draftMatch?.draftCarriesSend ?? reply.draftCarriesSend;
  if (carriesSend === undefined) {
    throw new Error(`loadReaders(${root}): neither draft-match.ts nor reply-action.ts exports draftCarriesSend`);
  }
  const sendReply = reply.sendGuardedReply;
  const sendText = reply.sendText;
  if (sendReply === undefined && sendText === undefined) {
    throw new Error(`loadReaders(${root}): reply-action.ts exports neither sendGuardedReply nor sendText`);
  }
  return {
    root,
    parse: (text) => blocks.splitLines(ansi.parseAnsi(text)),
    lineText: (line) => blocks.lineText(line),
    buildBlocks: (lines, agent) => harness.buildBlocks(lines, { agent }),
    adapterFor: (agent) => harness.adapterFor(agent),
    draftCarriesSend: (sent, draft) => carriesSend(sent, draft),
    sendGuardedReply:
      sendReply !== undefined
        ? (paneId, text, agent) => sendReply({ paneId, text, agent })
        : (paneId, text) => sendText!({ paneId, text, held: null }).then(mapSendTextOutcome),
    markLive: liveness === undefined ? undefined : (paneId) => liveness.markLive(paneId),
    barFor: bar === undefined ? undefined : (agent) => bar.barFor(agent),
  };
}

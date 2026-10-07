// The branch a "New agent on a branch" sheet opens with: `worktree/<adjective>-<noun>-<4 hex>`
// (ADR 0089). Collie's own two word lists, plain English, short, and nothing that reads badly in a
// branch list. The hex makes two taps in the same second two different names; the words make the
// name sayable. The field stays editable, so this is a starting point and never a rule. The bridge
// checks whatever the operator sends (`bridge/worktree-branch.ts`); every name this mints passes it.

export const BRANCH_ADJECTIVES: readonly string[] = [
  "amber",
  "bold",
  "brisk",
  "calm",
  "clear",
  "cosy",
  "deft",
  "eager",
  "fair",
  "fleet",
  "fresh",
  "gentle",
  "keen",
  "lively",
  "lucky",
  "mellow",
  "nimble",
  "quick",
  "quiet",
  "steady",
  "sunny",
  "swift",
  "tidy",
  "warm",
];

export const BRANCH_NOUNS: readonly string[] = [
  "badger",
  "beacon",
  "bramble",
  "brook",
  "canyon",
  "cedar",
  "comet",
  "falcon",
  "fern",
  "harbor",
  "heron",
  "lantern",
  "maple",
  "meadow",
  "otter",
  "pebble",
  "ridge",
  "river",
  "robin",
  "sparrow",
  "summit",
  "thistle",
  "willow",
  "wren",
];

/** The prefix every minted name starts with, so the operator can spot Collie's branches at a glance. */
export const BRANCH_PREFIX = "worktree/";

/** A random source in [0, 1). Injected so a test can pin the name. */
export type RandomFn = () => number;

/** One item of `list`, picked by `random`. */
function pick(list: readonly string[], random: RandomFn): string {
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[index] ?? list[0] ?? "";
}

/** Four lowercase hex digits. */
function hex4(random: RandomFn): string {
  return Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0")
    .slice(-4);
}

/** A fresh branch name: `worktree/<adjective>-<noun>-<4 hex>`. */
export function branchOffName(random: RandomFn = Math.random): string {
  return `${BRANCH_PREFIX}${pick(BRANCH_ADJECTIVES, random)}-${pick(BRANCH_NOUNS, random)}-${hex4(random)}`;
}

/**
 * A request id for one create: a version-4 UUID.
 *
 * Built from `getRandomValues` rather than `randomUUID`, because `randomUUID` needs a secure context
 * and Collie is also served over plain HTTP on a tailnet (lib/nav-entry.ts makes the same choice).
 */
export function mintRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

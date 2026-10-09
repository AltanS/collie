import { asJsonNumber, parseJsonObject } from "@/lib/json";

// THE "NO PROMPTS" GUARDS, ON THIS DEVICE (M48 spec 02, ADR 0094).
//
// A launcher that skips permission prompts (`noPrompts` on a row or an item from GET /api/launchers)
// carries a "No prompts" badge in words, and the first start of it on each device asks once, showing
// the command, the folder and the machine. Starting it is the person's choice, never a permission
// answer, and only these guards make it one: the badge, this one confirm per device, and the
// operator's `[phone]` switch on the bridge.
//
// The confirm is remembered HERE, per device, keyed by the machine and the exact line: another phone
// asks again, and a changed line is a new line. It names machines and command lines of one pairing,
// so it goes with the pairing (lib/wipe.ts).

export const NO_PROMPTS_KEY = "collie:no-prompts-confirmed:v1";
/** The most confirms kept; the oldest goes first. */
export const MAX_NO_PROMPTS_CONFIRMS = 100;

/** The key one confirm is stored under: the machine (`""` for the lead or a solo install) and the line. */
function confirmKey(machine: string, command: string): string {
  return `${machine}\u0000${command}`;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readAll(storage: Pick<Storage, "getItem"> | undefined): Map<string, number> {
  let text: string | null = null;
  try {
    text = storage?.getItem(NO_PROMPTS_KEY) ?? null;
  } catch {
    return new Map();
  }
  const parsed = text === null ? undefined : parseJsonObject(text);
  const out = new Map<string, number>();
  if (parsed === undefined) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const at = asJsonNumber(value);
    if (at !== undefined && Number.isFinite(at)) out.set(key, at);
  }
  return out;
}

/** Whether this device already confirmed `command` on `machine`. */
export function noPromptsConfirmed(
  machine: string,
  command: string,
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): boolean {
  return readAll(storage).has(confirmKey(machine, command));
}

/** Whether a start must ask first: the line skips prompts and this device has not confirmed it there. */
export function needsNoPromptsConfirm(
  item: { noPrompts?: boolean; command?: string },
  machine: string,
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): boolean {
  if (item.noPrompts !== true) return false;
  // A no-prompts item with no line of its own cannot be keyed, so it asks every time.
  if (item.command === undefined) return true;
  return !noPromptsConfirmed(machine, item.command, storage);
}

/** Remember the person's confirm. A storage that refuses keeps nothing, so the next start asks again. */
export function rememberNoPromptsConfirm(
  machine: string,
  command: string,
  now: number = Date.now(),
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
): void {
  const all = readAll(storage);
  all.set(confirmKey(machine, command), now);
  const kept = [...all]
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, MAX_NO_PROMPTS_CONFIRMS);
  try {
    storage?.setItem(NO_PROMPTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Private mode or a full quota: the next start asks again, which is the safe side.
  }
}

/** Forget every confirm. The wipe at the end of a pairing runs it. */
export function forgetNoPromptsConfirms(storage: Pick<Storage, "removeItem"> | undefined = safeStorage()): void {
  try {
    storage?.removeItem(NO_PROMPTS_KEY);
  } catch {
    // Locked-down storage kept nothing.
  }
}

/** A line as the confirm shows it: every character that does not show itself, written as its code. */
export interface VisibleLine {
  text: string;
  /** How many characters were written as a code. */
  hidden: number;
  /** Whether the line has any character outside printable ASCII (a look-alike letter is one). */
  nonAscii: boolean;
}

/**
 * Make a command line safe to read before it runs: control, format (zero-width), separator other
 * than the plain space, private-use and unassigned characters become `⟨U+XXXX⟩`. The bridge already
 * refuses controls, line separators and bidi controls; this shows the rest, so what the person reads
 * is what the terminal is given.
 */
export function visibleLine(line: string): VisibleLine {
  let text = "";
  let hidden = 0;
  let nonAscii = false;
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7e) nonAscii = true;
    if (ch !== " " && /[\p{C}\p{Z}]/u.test(ch)) {
      text += `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
      hidden++;
    } else {
      text += ch;
    }
  }
  return { text, hidden, nonAscii };
}

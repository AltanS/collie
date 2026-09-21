// The per-pane "don't invert this one" override.
//
// ADR 0002 inverts the light mirror because agents overwhelmingly emit dark-theme colours, and it
// records the failure mode honestly: an agent on a LIGHT theme is unreadable in both Collie themes,
// and the fix "if wanted, is a per-pane 'don't invert this one' — so any storage added for mirror
// preferences should be keyed to let that layer on later". This is that storage, and that override.
//
// **Why per-pane and not per-agent.** ADR 0047 gave Muse an agent-wide bit because Muse is mid-tone
// in every background answer, so the bit is true for every Muse pane that can exist. That does not
// generalise. opencode was measured for #241 and is the counter-example: its default theme carries
// dark AND light variants and picks by the background the terminal reports, so
//
//   light answer — body rgb(26,26,26)    16.91:1 raw on #fffbf8 /  1.16:1 inverted
//   dark answer  — body rgb(238,238,238)  1.13:1 raw            / 17.32:1 inverted
//
// The same agent wants opposite answers, and Herdr's theme is independent of Collie's, so a dark
// Herdr pane sits in a light Collie routinely. An agent-keyed bit cannot express that; the pane is
// the smallest thing that knows which way its own colours point. codex is reported to show the same
// symptom, and gets the same lever without anyone having to measure codex's palette first.
//
// **localStorage, and keyed by scope+pane** — the same shape as lib/drafts.ts. This is a deliberate
// operator choice about one pane, so it should survive the OS killing a phone PWA, and it must not
// bleed across hosts: two machines in a pack can both have a `w1:p1`.
//
// Bounded, because panes are not forever. Herdr reuses pane ids as workspaces come and go, so an
// unbounded map would both grow without limit and eventually apply a stale opt-out to an unrelated
// pane. Past MAX the oldest entry by its own stamp is evicted, exactly as last-seen does it.

import { asJsonBoolean, asJsonNumber, parseJsonObject } from "@/lib/json";
import { paneScopeKey, type Scope } from "@/lib/scope";

const PREFIX = "collie:mirror-native:";

/** How many panes may carry a decision. Far more than a phone visits in a session, small enough that
 *  a reused pane id cannot inherit one set months ago. */
const MAX = 32;

// One localStorage entry PER PANE, the shape lib/last-seen.ts uses, rather than a single JSON map.
// A map would have to be read, parsed and rewritten on every toggle, and its value type is an open
// dictionary the lint gate rightly objects to; per-key entries are each a closed little record.
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

/** A decision and the wall-clock it was made, so the prune can drop the oldest. */
interface Decision {
  at: number;
  native: boolean;
}

function decode(raw: string | null): Decision | undefined {
  if (!raw) return undefined;
  const parsed = parseJsonObject(raw);
  if (!parsed) return undefined;
  const at = asJsonNumber(parsed.at);
  const native = asJsonBoolean(parsed.native);
  if (at === undefined || native === undefined) return undefined;
  return { at, native };
}

/** Every key this module owns, decodable or not — enumerated up front because removing while
 *  walking `store.key(i)` reindexes the store underneath the loop. */
function ownedKeys(store: Storage): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(PREFIX)) out.push(key);
  }
  return out;
}

/**
 * Keep only the MAX newest decisions, and drop anything unreadable on the way past.
 *
 * Undecodable entries are removed rather than skipped. Skipping them looks harmless — they already
 * read as "no override" — but it makes them immortal: they never decode, so they never sort into the
 * prune, so they sit in storage forever and count against the browser's quota. Removing them is also
 * self-healing, since the pane simply falls back to the agent bit next time.
 */
function prune(store: Storage): void {
  try {
    const decisions: { key: string; at: number }[] = [];
    for (const key of ownedKeys(store)) {
      const decision = decode(store.getItem(key));
      if (decision) decisions.push({ key, at: decision.at });
      else store.removeItem(key);
    }
    if (decisions.length <= MAX) return;
    for (const { key } of decisions.toSorted((a, b) => b.at - a.at).slice(MAX)) {
      store.removeItem(key);
    }
  } catch {
    // A store we cannot enumerate simply does not get pruned.
  }
}

function entryKey(scope: Scope | undefined, paneId: string): string {
  return `${PREFIX}${paneScopeKey(scope, paneId)}`;
}

/**
 * This pane's override, or undefined when it has none.
 *
 * Tri-state on purpose, matching `rendersNativeMirror`'s second argument: absent means "no opinion,
 * let the agent bit decide", which is not the same as an explicit `false`. Without the distinction a
 * toggle would have to lie about a Muse pane, showing off while the pane renders natively anyway.
 */
export function paneMirrorOverride(
  scope: Scope | undefined,
  paneId: string | undefined,
): boolean | undefined {
  if (!paneId) return undefined;
  const store = storage();
  if (!store) return undefined;
  try {
    return decode(store.getItem(entryKey(scope, paneId)))?.native;
  } catch {
    // A corrupt or unreadable entry reads as no override, which leaves the shipped inverting
    // behaviour in place: the safe direction, since that is what every pane does today.
    return undefined;
  }
}

/**
 * Set or clear one pane's override.
 *
 * `undefined` REMOVES the entry rather than storing a third value, so storage only ever holds panes
 * the operator actually decided about. That keeps the bound meaningful — 32 decisions, not 32 panes
 * that once had the sheet open — and makes "no entry" the single spelling of "no opinion".
 */
export function setPaneMirrorOverride(
  scope: Scope | undefined,
  paneId: string,
  native: boolean | undefined,
  now: number = Date.now(),
): void {
  const store = storage();
  if (!store) return;
  const key = entryKey(scope, paneId);
  try {
    if (native === undefined) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, JSON.stringify({ at: now, native }));
    prune(store);
  } catch {
    // Quota or private mode. The override is a convenience; losing it must never throw into a render.
  }
}

/** Test seam: drop every entry this module owns, INCLUDING ones it cannot decode. Going through the
 *  decodable set would leave a corrupt entry behind for the next test to trip over. */
export function __clearMirrorOverrides(): void {
  const store = storage();
  if (!store) return;
  try {
    for (const key of ownedKeys(store)) store.removeItem(key);
  } catch {
    // same reasoning as above
  }
}

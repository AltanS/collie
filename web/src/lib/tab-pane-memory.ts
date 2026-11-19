// THE PANE A TAB WAS LAST OPEN ON, ON THIS DEVICE.
//
// A tab can hold several panes side by side. The tab strip opens a tab by opening one of its panes,
// and it used to open the FIRST one every time: open the second pane of a tab, go to another tab, come
// back, and the phone was on the first pane, not the one you were on. This remembers, per tab, the pane
// the pane view last showed, and `pickTabPane` prefers it when a tab is opened from a strip.
//
// IT IS WRITTEN WHEN A PANE IS SHOWN, NOT WHEN A STRIP IS TAPPED (routes/detail.tsx), so a pane opened
// by a push, a link or a switcher row becomes its tab's pane the same way, and the memory never
// disagrees with what was on screen.
//
// KEYED BY MACHINE, SESSION AND TAB. Tab ids (`w1:t1`) are unique only within one session on one
// machine; on a crew every machine has its own `w1:t1`. The value is a pane id, never a name or a
// message. Memory for the page plus sessionStorage, so a reload keeps it and a closed tab does not. A
// remembered pane that is no longer in the tab is ignored, and the caller's own choice stands.
// Every storage access is behind a try/catch: a private-mode browser keeps the memory copy only.

import { hostKey } from "./hosts";

/** The key prefix. The version is part of it, so a changed shape starts empty. */
const PREFIX = "collie:tab-pane:v1:";

// NUL-joined like lib/hosts.ts: a machine id and a tab id are opaque strings.
const SEP = "\u0000";

const memory = new Map<string, string>();

interface TabAddress {
  host?: string | undefined;
  session?: string | undefined;
  tabId: string;
}

function keyOf(at: TabAddress): string {
  return `${PREFIX}${hostKey(at)}${SEP}${at.session ?? ""}${SEP}${at.tabId}`;
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The pane the tab was last open on, or undefined when it never was on this device. */
export function rememberedPaneId(at: TabAddress): string | undefined {
  const key = keyOf(at);
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    return storage()?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The pane view showed this pane: it is now its tab's pane. */
export function rememberTabPane(pane: { paneId: string; tabId: string; host?: string | undefined; session?: string | undefined }): void {
  const key = keyOf(pane);
  if (memory.get(key) === pane.paneId) return;
  memory.set(key, pane.paneId);
  try {
    storage()?.setItem(key, pane.paneId);
  } catch {
    // Quota or private mode: the memory copy still holds for this page.
  }
}

/**
 * The pane to open for a tab: the remembered one when it is still among `panes` (the tab's panes, in
 * the order the caller would have taken the first of), else the first, which is the choice the strip
 * always made. `at` names the tab on the machine and session the strip belongs to.
 */
export function pickTabPane<T extends { paneId: string; host?: string | undefined }>(panes: readonly T[], at: TabAddress): T | undefined {
  const remembered = rememberedPaneId(at);
  const kept = remembered === undefined ? undefined : panes.find((p) => p.paneId === remembered && hostKey(p) === hostKey(at));
  return kept ?? panes[0];
}

/** Drop every remembered pane, memory and storage (the wipe at the end of a pairing runs it). */
export function forgetAllTabPanes(): void {
  memory.clear();
  try {
    const store = storage();
    if (store === null) return;
    const held: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(PREFIX)) held.push(key);
    }
    for (const key of held) store.removeItem(key);
  } catch {
    // Locked-down storage kept nothing.
  }
}

/** Test seam: forget the memory copies, as a reload does, and leave sessionStorage as it is. */
export function __forgetTabPaneMemory(): void {
  memory.clear();
}

// The lab's slash-command walk (M44 spec 05, carried by M56 spec 10). The walk reads the agent's own
// `/` menu, then opens each command that is on the hand-kept safe list, reads the screen it reaches
// through the Surface, and closes it with Escape. A command that is on neither list is reported as
// unclassified and never sent. The walk ends at a free box, or it says it could not (`returned: false`).
//
// The walk never sends Enter on a command the menu does not point at: it reads the pointer first.
// It never sends Enter on anything else. Every screen it reaches is returned as a fact for the verdict.

import { classifyCommands, parseSlashMenu, type SlashLists } from "../slash-commands";
import type { ScreenView } from "./screens";
import { factOf } from "./screens";
import type { ScreenFact, WalkFact } from "./verdict";

/** The hands of the walk. The lab gives it a tmux pane. A test gives it a script. */
export interface WalkPane {
  read(): Promise<ScreenView>;
  type(text: string): Promise<void>;
  keys(...keys: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface Settle {
  readonly pollMs: number;
  /** The screen must hold for this many reads in a row. */
  readonly stable: number;
  readonly maxMs: number;
}

export const SETTLE_COMMAND: Settle = { pollMs: 300, stable: 3, maxMs: 6000 };
export const SETTLE_MENU: Settle = { pollMs: 150, stable: 2, maxMs: 2000 };
/** The most Down presses the menu read makes. The menu wraps long before this. */
export const MENU_PRESS_CAP = 220;
/** The most Escape presses a close makes before the walk gives up. */
export const CLOSE_PRESS_CAP = 3;

export async function settle(pane: WalkPane, how: Settle): Promise<ScreenView> {
  let view = await pane.read();
  let same = 1;
  let waited = 0;
  while (same < how.stable && waited < how.maxMs) {
    await pane.sleep(how.pollMs);
    waited += how.pollMs;
    const next = await pane.read();
    same = next.hash === view.hash ? same + 1 : 1;
    view = next;
  }
  return view;
}

/** Read the whole `/` menu: type `/`, press Down until the pointer comes back to the first command. */
export async function readMenu(pane: WalkPane): Promise<string[]> {
  await pane.type("/");
  let view = await settle(pane, SETTLE_MENU);
  const names: string[] = [];
  let first: string | null = null;
  for (let press = 0; press < MENU_PRESS_CAP; press++) {
    const { names: shown, pointed } = parseSlashMenu(view.plain);
    for (const name of shown) if (!names.includes(name)) names.push(name);
    if (pointed !== null && first === null) first = pointed;
    else if (pointed !== null && pointed === first && press > 0) break;
    await pane.keys("Down");
    view = await settle(pane, { ...SETTLE_MENU, stable: 1, maxMs: 300 });
  }
  return names;
}

/** Close a screen with Escape until the box is free. The last view, and whether it is free. */
async function closeToIdle(pane: WalkPane, from: ScreenView): Promise<{ view: ScreenView; presses: number }> {
  let view = from;
  let presses = 0;
  while (!view.free && presses < CLOSE_PRESS_CAP) {
    await pane.keys("Escape");
    presses++;
    view = await settle(pane, SETTLE_MENU);
  }
  return { view, presses };
}

/** Empty the box after the menu read: Escape closes the popup, Backspace takes the `/` out. */
async function clearSlash(pane: WalkPane): Promise<ScreenView> {
  await pane.keys("Escape");
  await pane.keys("Backspace");
  const view = await settle(pane, SETTLE_MENU);
  if (view.free) return view;
  await pane.keys("Backspace");
  return settle(pane, SETTLE_MENU);
}

export interface WalkResult {
  readonly walk: WalkFact;
  readonly screens: ScreenFact[];
  readonly log: string[];
}

export async function runWalk(pane: WalkPane, lists: SlashLists): Promise<WalkResult> {
  const screens: ScreenFact[] = [];
  const log: string[] = [];
  const note = (line: string): void => {
    log.push(line);
  };
  const hasWalk = lists.safe.length > 0;
  const start = await settle(pane, SETTLE_COMMAND);
  // A harness with no profile has no idle anchors, so no screen of it reads free. Its first screen is
  // read and judged as a dialog screen would be, and no command is sent.
  screens.push(factOf(start, "start", "the first screen of the agent", hasWalk ? "idle" : "either"));
  const stop = (partial: Partial<WalkFact>): WalkResult => ({
    walk: { reached: true, returned: true, menuRead: true, startedTurn: null, sent: [], unclassified: [], missing: [], ...partial },
    screens,
    log,
  });
  if (!hasWalk) {
    note("walk: this harness has no slash command list, so only the first screen was read");
    return stop({});
  }
  if (!start.free) {
    note("walk: the first screen is not a free box, so no command is sent");
    return stop({ reached: false, returned: false });
  }

  const listed = await readMenu(pane);
  note(`walk: the / menu listed ${String(listed.length)} commands`);
  const idle = await clearSlash(pane);
  if (!idle.free) {
    screens.push(factOf(idle, "walk", "after the / menu", "idle"));
    note("walk: the box was not free after the / menu was closed");
    return stop({ returned: false, menuRead: listed.length > 0 });
  }
  if (listed.length === 0) return stop({ menuRead: false });

  const sorted = classifyCommands(listed, lists);
  if (sorted.unclassified.length > 0) note(`walk: ${String(sorted.unclassified.length)} commands are unclassified and were not sent: ${sorted.unclassified.join(" ")}`);
  if (sorted.missing.length > 0) note(`walk: ${String(sorted.missing.length)} safe commands are no longer listed: ${sorted.missing.join(" ")}`);
  const sent: string[] = [];
  for (const entry of sorted.send) {
    await pane.type(entry.command);
    const menu = await settle(pane, SETTLE_MENU);
    if (parseSlashMenu(menu.plain).pointed !== entry.command) {
      note(`walk: ${entry.command}: the menu does not point at it, so Enter was not sent`);
      const cleared = await clearSlashLine(pane, entry.command);
      if (!cleared.free) return stop({ returned: false, sent, unclassified: sorted.unclassified, missing: sorted.missing });
      continue;
    }
    await pane.keys("Enter");
    sent.push(entry.command);
    const reached = await settle(pane, SETTLE_COMMAND);
    const fact = factOf(reached, "walk", entry.command, entry.opens === "dialog" ? "dialog" : "either");
    screens.push(fact);
    note(`walk: ${entry.command} -> turn ${reached.surface.turn}, modal ${fact.surface.modal}, composer ${reached.surface.composer}, free ${String(reached.free)}`);
    if (reached.surface.turn === "running") {
      await pane.keys("Escape");
      return stop({ startedTurn: entry.command, returned: false, sent, unclassified: sorted.unclassified, missing: sorted.missing });
    }
    const closed = await closeToIdle(pane, reached);
    if (closed.presses > 0) note(`walk: ${entry.command}: ${String(closed.presses)} Escape to get back`);
    if (!closed.view.free) {
      screens.push(factOf(closed.view, "walk", `after ${entry.command}`, "idle"));
      note(`walk: ${entry.command}: the box did not come back`);
      return stop({ returned: false, sent, unclassified: sorted.unclassified, missing: sorted.missing });
    }
  }
  return stop({ sent, unclassified: sorted.unclassified, missing: sorted.missing });
}

/** Take a typed command out of the box without sending it: Escape, then one Backspace per character. */
async function clearSlashLine(pane: WalkPane, command: string): Promise<ScreenView> {
  await pane.keys("Escape");
  await pane.keys(...Array.from({ length: command.length }, () => "Backspace"));
  return settle(pane, SETTLE_MENU);
}

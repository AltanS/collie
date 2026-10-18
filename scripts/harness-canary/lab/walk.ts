// The lab's slash-command walk (M44 spec 05, carried by M56 spec 10). The walk reads the agent's own
// `/` menu, then opens each command that is on the hand-kept safe list, reads the screen it reaches
// through the Surface, and closes it with Escape. A command that is on neither list is reported as
// unclassified and never sent. The walk ends at a free box, or it says it could not (`returned: false`).
//
// The walk never sends Enter on a command the menu does not point at: it reads the pointer first.
// It never sends Enter on anything else. Every screen it reaches is returned as a fact for the verdict.

import { classifyCommands, parseSlashMenu, type SlashLists, type SlashMenu } from "../slash-commands";
import type { ScreenView } from "./screens";
import { factOf } from "./screens";
import { isDialogScreen, type ScreenFact, type WalkFact } from "./verdict";

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
/** How long one Down may take to move the pointer, and how often the walk looks. */
export const MENU_MOVE_MS = 600;
export const MENU_MOVE_POLL_MS = 60;
/** The screen did not move for this many Down presses in a row: the menu has no more rows. */
export const MENU_STUCK_PRESSES = 2;
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

/** Wait for the screen to differ from `before`, up to a short bound. The same screen back means the key did nothing yet. */
async function nextScreen(pane: WalkPane, before: ScreenView): Promise<ScreenView> {
  let view = await pane.read();
  for (let waited = 0; view.hash === before.hash && waited < MENU_MOVE_MS; waited += MENU_MOVE_POLL_MS) {
    await pane.sleep(MENU_MOVE_POLL_MS);
    view = await pane.read();
  }
  return view;
}

/**
 * Read the whole `/` menu: type `/`, press Down until the pointer comes back to the first command or the
 * screen stops moving. Each Down waits for the screen to change, so a slow redraw is not read as a wrap.
 */
/** The whole `/` menu: every command it lists, and those it marks "(removed)". */
export interface MenuRead {
  readonly names: readonly string[];
  readonly removed: readonly string[];
}

export async function readMenu(pane: WalkPane): Promise<MenuRead> {
  await pane.type("/");
  let view = await settle(pane, SETTLE_MENU);
  const names: string[] = [];
  const removed: string[] = [];
  const take = (shown: SlashMenu): void => {
    for (const name of shown.names) if (!names.includes(name)) names.push(name);
    for (const name of shown.removed) if (!removed.includes(name)) removed.push(name);
  };
  const first = parseSlashMenu(view.plain).pointed;
  let stuck = 0;
  for (let press = 0; press < MENU_PRESS_CAP; press++) {
    take(parseSlashMenu(view.plain));
    await pane.keys("Down");
    const next = await nextScreen(pane, view);
    stuck = next.hash === view.hash ? stuck + 1 : 0;
    const shown = parseSlashMenu(next.plain);
    take(shown);
    if (stuck >= MENU_STUCK_PRESSES) break;
    if (first !== null && shown.pointed === first && next.hash !== view.hash) break;
    view = next;
  }
  return { names, removed };
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
export async function clearSlash(pane: WalkPane): Promise<ScreenView> {
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

/** `onNote` hears each line the moment the walk writes it, so the run log carries the walk's own timestamps. */
export async function runWalk(pane: WalkPane, lists: SlashLists, onNote: (line: string) => void = () => {}): Promise<WalkResult> {
  const screens: ScreenFact[] = [];
  const log: string[] = [];
  const note = (line: string): void => {
    log.push(line);
    onNote(line);
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

  const whole = await readMenu(pane);
  const listed = whole.names;
  note(`walk: the / menu listed ${String(listed.length)} commands`);
  const idle = await clearSlash(pane);
  if (!idle.free) {
    screens.push(factOf(idle, "walk", "after the / menu", "idle"));
    note("walk: the box was not free after the / menu was closed");
    return stop({ returned: false, menuRead: listed.length > 0 });
  }
  if (listed.length === 0) return stop({ menuRead: false });

  const sorted = classifyCommands(listed, lists, whole.removed);
  if (sorted.removed.length > 0) note(`walk: ${String(sorted.removed.length)} commands are marked removed and were not sent: ${sorted.removed.join(" ")}`);
  if (sorted.unclassified.length > 0) note(`walk: ${String(sorted.unclassified.length)} commands are unclassified and were not sent: ${sorted.unclassified.join(" ")}`);
  if (sorted.missing.length > 0) note(`walk: ${String(sorted.missing.length)} safe commands are no longer listed: ${sorted.missing.join(" ")}`);
  // A menu read that lost more than half of the safe list is a short read or a vendor that moved its commands.
  // Either way a person must look, so the verdict fails it with a reason instead of passing on two screens.
  const menuRead = sorted.missing.length * 2 <= lists.safe.length;
  if (!menuRead) note(`walk: the menu read found ${String(listed.length)} commands and lost ${String(sorted.missing.length)} of ${String(lists.safe.length)} safe ones`);
  const sent: string[] = [];
  const after = (partial: Partial<WalkFact>): WalkResult => stop({ menuRead, sent, unclassified: sorted.unclassified, missing: sorted.missing, removed: sorted.removed, ...partial });
  for (const entry of sorted.send) {
    await pane.type(entry.command);
    const menu = await settle(pane, SETTLE_MENU);
    if (parseSlashMenu(menu.plain).pointed !== entry.command) {
      note(`walk: ${entry.command}: the menu does not point at it, so Enter was not sent`);
      const cleared = await clearSlashLine(pane, entry.command);
      if (!cleared.free) return after({ returned: false });
      continue;
    }
    await pane.keys("Enter");
    sent.push(entry.command);
    const reached = await settle(pane, SETTLE_COMMAND);
    const fact = factOf(reached, "walk", entry.command, entry.opens === "dialog" ? "dialog" : "either");
    screens.push(fact);
    note(`walk: ${entry.command} -> turn ${reached.surface.turn}, modal ${fact.surface.modal}, composer ${reached.surface.composer}, free ${String(reached.free)}`);
    if (isDialogScreen(fact) && fact.free) {
      // The Surface read a dialog as a free box. A key sent into a real dialog is a risk, so the walk
      // presses Escape once, reads what is left, and ends. The verdict fails the run for this screen.
      await pane.keys("Escape");
      const left = await settle(pane, SETTLE_MENU);
      note(`walk: ${entry.command} is a dialog and the Surface read it free, so the walk ends after one Escape (free after: ${String(left.free)})`);
      return after({ returned: left.free });
    }
    if (reached.surface.turn === "running") {
      await pane.keys("Escape");
      return after({ startedTurn: entry.command, returned: false });
    }
    const closed = await closeToIdle(pane, reached);
    if (closed.presses > 0) note(`walk: ${entry.command}: ${String(closed.presses)} Escape to get back`);
    if (!closed.view.free) {
      screens.push(factOf(closed.view, "walk", `after ${entry.command}`, "idle"));
      note(`walk: ${entry.command}: the box did not come back`);
      return after({ returned: false });
    }
  }
  return after({});
}

/** Take a typed command out of the box without sending it: Escape, then one Backspace per character. */
async function clearSlashLine(pane: WalkPane, command: string): Promise<ScreenView> {
  await pane.keys("Escape");
  await pane.keys(...Array.from({ length: command.length }, () => "Backspace"));
  return settle(pane, SETTLE_MENU);
}

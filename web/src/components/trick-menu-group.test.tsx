import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import type { JsonValue } from "@/lib/json";
import { partsInSession } from "@/lib/tricks/menu";
import { menuMessageLine } from "@/lib/tricks/menu-message";
import { MENU_TAP_WORDS, MENU_WORDS, type MenuRow, type TrickTapReply, type TricksReply, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, firstOfEachTrick, type TricksStore } from "@/lib/tricks/store";
import { readTricksReply } from "@/lib/tricks/wire";
import type { AgentView } from "@/lib/types";
import { SETTLE_MS } from "@/hooks/use-settled";
import { VIEW_SETTLE_MS } from "./agent-view-screen";
import { PaneActionsSheet } from "./pane-actions-sheet";
import { TrickMenuGroups, type TrickMenuGroupsProps } from "./trick-menu-group";

// A TRICK'S ROWS IN A SESSION'S SETTINGS (the menu place, contract 2): tests named by rule.

const NOW = Date.parse("2026-11-12T09:00:00Z");
const AS_OF = "2026-11-12T08:59:50Z";
const PANE: AgentView = { paneId: "w6X:3", workspaceId: "w6X", workspaceLabel: "collie", workspaceNumber: 1, tabId: "w6X:t1", agent: "claude", status: "idle", cwd: "/work", focused: false, kind: "agent", instance: "ab12" };
const RERUN: MenuRow = { id: "rerun", kind: "button", label: "Rerun CI", icon: "refresh", intent: "rerun" };
const WATCH: MenuRow = { id: "watch", kind: "switch", label: "Watch branch", icon: "flag", intent: "watch", on: true };

function menuPart(trick: string, rows: MenuRow[], extra: Partial<WireTrickPart> = {}, rev = 1): WireTrickPart {
  return { host: "lodge", trick, part: trick, rev, asOf: AS_OF, fresh: "10m", value: { at: "menu", id: trick, rows }, ...extra };
}
function info(id: string, on = true): WireTrickInfo {
  return { host: "lodge", id, name: id.toUpperCase(), icon: "flask", on, state: "ok", places: ["menu"] };
}

/** A store whose replies the test sets, and whose taps wait for the test to answer them. */
function rig(parts: WireTrickPart[], tricks: WireTrickInfo[] = [...new Set(parts.map((p) => p.trick))].map((id) => info(id))) {
  let reply: TricksReply = { rev: 1, tricks, parts, present: parts.map((p) => `${p.host}/${p.trick}/${p.part}`) };
  const taps: { body: unknown; answer: (reply: TrickTapReply) => void }[] = [];
  let n = 0;
  const store: TricksStore = createTricksStore({
    fetchTricks: async () => reply,
    tapTrick: (_host, _trick, body) => new Promise<TrickTapReply>((resolve) => taps.push({ body, answer: resolve })),
    mintRequestId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  const set = async (next: WireTrickPart[], nextTricks = tricks, rev = reply.rev + 1): Promise<void> => {
    reply = { rev, tricks: nextTricks, parts: next, present: next.map((p) => `${p.host}/${p.trick}/${p.part}`) };
    await act(async () => {
      await store.syncTricks(rev);
    });
  };
  return { store, taps, set };
}

function mount(store: TricksStore, props: Partial<TrickMenuGroupsProps> = {}) {
  const base: TrickMenuGroupsProps = { open: true, pane: PANE, canWrite: true, store, now: NOW, settleMs: 0, ...props };
  const view = render(<TrickMenuGroups {...base} />);
  return { ...view, rerender: (next: Partial<TrickMenuGroupsProps>) => view.rerender(<TrickMenuGroups {...base} {...next} />) };
}

const groups = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-slot="trick-menu-group"]')];
const rowEl = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-row="${id}"]`);
const switchOf = (root: HTMLElement, id: string) => rowEl(root, id)?.querySelector<HTMLButtonElement>('[role="switch"]') ?? null;
const footer = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-slot="trick-menu-footer"]')?.textContent ?? null;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the menu place on the phone", () => {
  it("draws one group per trick under Collie's heading, with its rows and a reserved footer line", async () => {
    const { store } = rig([menuPart("ci", [RERUN, WATCH])]);
    await store.syncTricks(1);
    const { container } = mount(store);
    const [group] = groups(container);
    expect(group?.querySelector('[data-slot="trick-menu-row"]')).not.toBeNull();
    expect(group?.textContent).toContain("From the trick CI");
    expect(rowEl(container, "rerun")?.textContent).toBe("Rerun CITap again: Rerun CI");
    expect(switchOf(container, "watch")?.getAttribute("aria-checked")).toBe("true");
    expect(footer(container)).toBe("");
  });

  it("switch-no-optimistic-flip: a switch keeps the document's state while the tap waits, inert with a spinner, and takes the receipt's", async () => {
    const { store, taps } = rig([menuPart("ci", [RERUN, WATCH])]);
    await store.syncTricks(1);
    const { container } = mount(store);
    fireEvent.click(switchOf(container, "watch")!);
    expect(taps).toHaveLength(1);
    expect(taps[0]?.body).toEqual({ rid: "00000000-0000-4000-8000-000000000001", node: "ci", intent: "watch", value: "off", from: { session: "lodge:w6X:3" }, rev: 1 });
    // Not flipped: the program owns the state.
    expect(switchOf(container, "watch")?.getAttribute("aria-checked")).toBe("true");
    expect(switchOf(container, "watch")?.disabled).toBe(true);
    expect(rowEl(container, "watch")?.querySelector('[data-slot="trick-menu-busy"]')).not.toBeNull();
    expect(rowEl(container, "rerun")).toBeDisabled();
    expect(footer(container)).toBe("Waiting for CI…");
    await act(async () => {
      taps[0]?.answer({ rid: "00000000-0000-4000-8000-000000000001", code: "ok", rev: 2, parts: [menuPart("ci", [RERUN, { ...WATCH, on: false }], {}, 2)], present: ["lodge/ci/ci"] });
    });
    expect(switchOf(container, "watch")?.getAttribute("aria-checked")).toBe("false");
    expect(switchOf(container, "watch")?.disabled).toBe(false);
    expect(footer(container)).toBe("");
  });

  it("a confirm button arms with Collie's words and the whole label, and runs on the second tap", async () => {
    const { store, taps } = rig([menuPart("ci", [{ ...RERUN, confirm: true }])]);
    await store.syncTricks(1);
    const { container } = mount(store);
    const button = rowEl(container, "rerun")!;
    fireEvent.click(button);
    expect(taps).toHaveLength(0);
    expect(button.dataset.armed).toBe("");
    fireEvent.click(button);
    expect(taps).toHaveLength(1);
    expect(taps[0]?.body).toMatchObject({ node: "ci", intent: "rerun", from: { session: "lodge:w6X:3" } });
  });

  it("the footer says no answer, a refusal with the trick's name, and a part past its window", async () => {
    const { store, taps, set } = rig([menuPart("ci", [RERUN])]);
    await store.syncTricks(1);
    const { container } = mount(store);
    fireEvent.click(rowEl(container, "rerun")!);
    await act(async () => taps[0]?.answer({ rid: "x", code: "ok" }));
    expect(footer(container)).toBe("No answer from CI. It may have changed.");
    fireEvent.click(rowEl(container, "rerun")!);
    await act(async () => taps[1]?.answer({ rid: "00000000-0000-4000-8000-000000000001", code: "rejected", message: "The trick is busy. Try again in a moment." }));
    expect(footer(container)).toBe("CI: The trick is busy. Try again in a moment.");
    await set([menuPart("ci", [RERUN], { asOf: "2026-11-12T07:00:00Z", fresh: "1m" }, 3)]);
    expect(footer(container)).toMatch(/^As of .+\.$/u);
  });

  it("a trick switched off while the sheet is open goes inert and says so", async () => {
    const { store, set } = rig([menuPart("ci", [RERUN, WATCH])]);
    await store.syncTricks(1);
    const { container } = mount(store);
    await set([menuPart("ci", [RERUN, WATCH])], [info("ci", false)]);
    expect(footer(container)).toBe("CI is off.");
    expect(rowEl(container, "rerun")).toBeDisabled();
    expect(switchOf(container, "watch")?.disabled).toBe(true);
  });

  it("N4: a confirm disarms when its row changes, and the second tap sends the rev of the first", async () => {
    const CONFIRM: MenuRow = { ...RERUN, confirm: true };
    const { store, taps, set } = rig([menuPart("ci", [CONFIRM, WATCH])]);
    await store.syncTricks(1);
    const { container } = mount(store);
    fireEvent.click(rowEl(container, "rerun")!);
    expect(rowEl(container, "rerun")?.dataset.armed).toBe("");
    // The armed row now says something else: the first tap confirmed the old words, so it disarms.
    await set([menuPart("ci", [{ ...CONFIRM, label: "Delete branch" }, WATCH], {}, 2)]);
    expect(rowEl(container, "rerun")?.dataset.armed).toBeUndefined();
    fireEvent.click(rowEl(container, "rerun")!);
    expect(taps).toHaveLength(0);
    expect(rowEl(container, "rerun")?.dataset.armed).toBe("");
    // Another row changes: the armed one stays armed, and the tap carries the rev it was armed at.
    await set([menuPart("ci", [{ ...CONFIRM, label: "Delete branch" }, { ...WATCH, on: false }], {}, 3)]);
    expect(rowEl(container, "rerun")?.dataset.armed).toBe("");
    fireEvent.click(rowEl(container, "rerun")!);
    expect(taps).toHaveLength(1);
    expect(taps[0]?.body).toMatchObject({ node: "ci", intent: "rerun", rev: 2 });
  });

  it("menu-rows-frozen-at-open: a new row waits for the next open, a removed one stays in place inert, a changed one redraws", async () => {
    const PAUSE: MenuRow = { id: "pause", kind: "button", label: "Pause CI", icon: "clock", intent: "pause" };
    const { store, set } = rig([menuPart("ci", [RERUN, WATCH])]);
    await store.syncTricks(1);
    const view = mount(store);
    await set([menuPart("ci", [{ ...RERUN, label: "Rerun all" }, PAUSE], {}, 2)]);
    const ids = () => [...view.container.querySelectorAll<HTMLElement>('[data-slot="trick-menu-row"]')].map((el) => el.dataset.row);
    expect(ids()).toEqual(["rerun", "watch"]);
    expect(rowEl(view.container, "rerun")?.textContent).toContain("Rerun all");
    expect(switchOf(view.container, "watch")?.disabled).toBe(true);
    view.rerender({ open: false });
    view.rerender({ open: true });
    expect(ids()).toEqual(["rerun", "pause"]);
  });

  it("menu-label-settle-500ms: a row whose words just changed takes no tap until it stood still for the window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    expect(SETTLE_MS).toBe(500);
    expect(VIEW_SETTLE_MS).toBe(SETTLE_MS);
    const { store, taps, set } = rig([menuPart("ci", [RERUN])]);
    await store.syncTricks(1);
    const { container } = mount(store, { settleMs: undefined });
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    await set([menuPart("ci", [{ ...RERUN, label: "Delete branch" }], {}, 2)]);
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1));
    fireEvent.click(rowEl(container, "rerun")!);
    expect(taps).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(rowEl(container, "rerun")!);
    expect(taps).toHaveLength(1);
  });

  it("menu-caps-group-whole: at most 12 trick rows, whole groups left out in the order of the trick ids, and the sheet says how many", async () => {
    const rows = (n: number, p: string): MenuRow[] => Array.from({ length: n }, (_, i) => ({ id: `${p}${String(i)}`, kind: "button", label: `Row ${p}${String(i)}`, intent: `${p}${String(i)}` }));
    const { store } = rig([menuPart("zeta", rows(2, "z")), menuPart("alpha", rows(5, "a")), menuPart("beta", rows(6, "b")), menuPart("gamma", rows(1, "g"))]);
    await store.syncTricks(1);
    const { container } = mount(store);
    // alpha 5 + beta 6 = 11; gamma's 1 fits (12); zeta's 2 do not.
    expect(groups(container).map((el) => el.dataset.trick)).toEqual(["alpha", "beta", "gamma"]);
    expect(container.querySelector('[data-slot="trick-menu-more"]')?.textContent).toBe("1 more trick has rows. See Settings, Tricks.");
  });

  it("N5: over the cap an agent view group shows its switch alone, its rows count like any other, and the trick counts as left out", async () => {
    const rows = (n: number, p: string): MenuRow[] => Array.from({ length: n }, (_, i) => ({ id: `${p}${String(i)}`, kind: "button", label: `Row ${p}${String(i)}`, intent: `${p}${String(i)}` }));
    const { store } = rig([menuPart("alpha", rows(6, "a")), menuPart("zeta", rows(8, "z"))]);
    await store.syncTricks(1);
    const onSwitch = vi.fn(async () => null);
    const { container } = mount(store, { views: { rows: [{ trick: "zeta", label: "Zeta view", on: false }], onSwitch } });
    // The switch counts first (1), alpha's 6 fit (7), zeta's 8 do not: zeta shows its switch alone.
    expect(groups(container).map((el) => el.dataset.trick)).toEqual(["alpha", "zeta"]);
    const zeta = groups(container)[1]!;
    expect(zeta.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(zeta.querySelectorAll('[data-slot="trick-menu-row"]')).toHaveLength(0);
    expect(zeta.querySelector('[data-slot="trick-menu-footer"]')).toBeNull();
    expect(container.querySelector('[data-slot="trick-menu-more"]')?.textContent).toBe("1 more trick has rows. See Settings, Tricks.");
  });

  it("agent sessions only, and on a crew member's session only where the instance binds", async () => {
    const bound = menuPart("bound", [RERUN], { bound: [{ session: "m_workshop:w1:2", instance: "kk77" }] });
    const { store } = rig([menuPart("ci", [WATCH]), bound]);
    await store.syncTricks(1);
    const shell = mount(store, { pane: { ...PANE, kind: "shell" } });
    expect(groups(shell.container)).toEqual([]);
    cleanup();
    const member = { ...PANE, host: "m_workshop", paneId: "w1:2", instance: "kk77" };
    expect(groups(mount(store, { pane: member }).container).map((el) => el.dataset.trick)).toEqual(["bound"]);
    cleanup();
    // The pane id went to a new session: another instance, so nothing shows.
    expect(groups(mount(store, { pane: { ...member, instance: "zz99" } }).container)).toEqual([]);
    cleanup();
    // A read-only device draws no trick rows.
    expect(groups(mount(store, { canWrite: false }).container)).toEqual([]);
  });

  it("the agent view switch is in its trick's group, after Close, not among Collie's rows", async () => {
    const { store } = rig([]);
    await store.syncTricks(1);
    const onSwitch = vi.fn(async () => null);
    const { baseElement } = render(
      <PaneActionsSheet open onClose={vi.fn()} pane={PANE} onRenamed={vi.fn()} onClosed={vi.fn()} agentViews={{ rows: [{ trick: "morph", label: "Morph", on: false }], label: undefined, on: false, showing: false, onShow: vi.fn(), onSwitch }} />,
    );
    const group = baseElement.querySelector<HTMLElement>('[data-slot="trick-menu-group"][data-trick="morph"]');
    expect(group?.textContent).toContain("From the trick Morph");
    expect(group?.querySelector('[role="switch"]')).not.toBeNull();
    expect(baseElement.querySelectorAll('[role="switch"]')).toHaveLength(1);
    // No "Uses agent tokens" here (2026-11-12): at 360 px the chip does not fit the hint's second line and
    // would add a third. The trick's own row in Settings, Tricks carries it.
    expect(group?.querySelector('[data-slot="token-use"]')).toBeNull();
    void store;
  });
});

describe("the menu place's words and readers", () => {
  it("the About sheet's two lines are the schema's constants", () => {
    expect(en["settings.tricks.about.menu"]).toBe(MENU_WORDS);
    expect(en["settings.tricks.about.menuTap"]).toBe(MENU_TAP_WORDS);
    expect(en["settings.tricks.place.menu"]).toBe("session settings");
  });

  it("a footer message is one line cut to 80 characters with the cut shown, and none with a hidden character or Collie's words", () => {
    expect(menuMessageLine("x".repeat(80))).toBe("x".repeat(80));
    expect(menuMessageLine("x".repeat(81))).toBe(`${"x".repeat(79)}…`);
    expect(menuMessageLine("Rerun​ done")).toBeNull();
    expect(menuMessageLine("Drawn by this session's agent")).toBeNull();
    expect(menuMessageLine("  two\n lines ")).toBe("two lines");
    expect(menuMessageLine("two  spaces")).toBe("two spaces");
  });

  it("N1: a footer message that reads as the sheet's own row, holds Collie's word or starts as a permission is not shown", () => {
    for (const message of ["Close pane", "Waiting for deploy", "CoIlie restarted", "Allow the deploy", "Drawn by this session's agent"]) {
      expect(menuMessageLine(message), message).toBeNull();
    }
    expect(menuMessageLine("Deploy started on lodge")).toBe("Deploy started on lodge");
  });

  it("bound-mark-pane-reuse-hidden: a bound belt mark shows only at its session's instance and replaces the unbound one there", () => {
    const mark = (part: string): WireTrickPart => ({ host: "lodge", trick: "ci", part, rev: 1, value: { at: "belt", id: part, mark: { label: part } } });
    const here = mark("here");
    here.bound = [{ session: "lodge:w6X:3", instance: "ab12" }];
    const all = [mark("every"), here];
    expect(partsInSession(all, PANE).map((p) => p.part)).toEqual(["here"]);
    expect(partsInSession(all, { ...PANE, instance: "zz99" }).map((p) => p.part)).toEqual(["every"]);
    expect(partsInSession(all, { ...PANE, paneId: "w6X:4" }).map((p) => p.part)).toEqual(["every"]);
    expect(partsInSession(all, undefined).map((p) => p.part)).toEqual(["every"]);
  });

  it("a menu row that does not read is left out at the wire, never drawn half", () => {
    const rows: JsonValue = [
      { id: "ok", kind: "button", label: "Rerun CI", intent: "rerun", confirm: true },
      { id: "sw", kind: "switch", label: "Watch", intent: "watch" },
      { id: "odd", kind: "slider", label: "Volume", intent: "volume" },
      { id: "fake", kind: "button", label: "Drawn by this session's agent", intent: "x" },
      { id: "ico", kind: "button", label: "Pause", intent: "pause", icon: "no-such-icon" },
    ];
    const wired = readTricksReply({ rev: 1, tricks: [], present: [], parts: [{ host: "lodge", trick: "ci", part: "ci", rev: 1, value: { at: "menu", id: "ci", rows } }] });
    const value = wired?.parts[0]?.value;
    expect(value?.at === "menu" ? value.rows : undefined).toEqual([{ id: "ok", kind: "button", label: "Rerun CI", intent: "rerun", confirm: true }]);
  });

  it("M2-phone: a session shows one part per trick and place, whatever the bridge sends", () => {
    const belt = (part: string, trick = "ci"): WireTrickPart => ({ host: "lodge", trick, part, rev: 1, value: { at: "belt", id: part, mark: { label: part } } });
    const here = (part: string): WireTrickPart => Object.assign(belt(part), { bound: [{ session: "lodge:w6X:3", instance: "ab12" }] });
    // Two unbound marks of one trick (a stale one kept by an older bridge): the first only.
    expect(partsInSession([belt("a"), belt("b"), belt("x", "notes")], PANE).map((p) => p.part)).toEqual(["a", "x"]);
    // Two bound marks for one session: the first only, and no unbound one beside it.
    expect(partsInSession([belt("a"), here("h1"), here("h2")], PANE).map((p) => p.part)).toEqual(["h1"]);
    // The status line, the Dashboard and the bottom bar: the first part of each trick, and no bound one.
    const chip = (part: string, trick = "ci"): WireTrickPart => ({ host: "lodge", trick, part, rev: 1, value: { at: "status", id: part, chip: { text: part } } });
    expect(firstOfEachTrick([chip("s1"), chip("s2"), chip("n1", "notes"), Object.assign(chip("s3", "bound"), { bound: [{ session: "lodge:w6X:3", instance: "ab12" }] })]).map((p) => p.part)).toEqual(["s1", "n1"]);
  });

  it("a part whose binding does not read is no part: drawn without it, it would show in every session", () => {
    const part = { host: "lodge", trick: "ci", part: "ci", rev: 1, value: { at: "menu", id: "ci", rows: [] } };
    const reply = (bound: JsonValue) => readTricksReply({ rev: 1, tricks: [], present: [], parts: [{ ...part, bound }] });
    expect(reply([{ session: "lodge:w6X:3", instance: "ab12" }])?.parts[0]?.bound).toEqual([{ session: "lodge:w6X:3", instance: "ab12" }]);
    for (const bad of [[], [{ session: "lodge:w6X:3" }], [{ session: "lodge", instance: "ab12" }], [{ session: "lodge:w6X:3", instance: "AB12" }], "x"]) expect(reply(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

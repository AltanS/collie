// ZELLIJ'S CONFORMANCE FIXTURE — what lets the zellij adapter be proved on a box with no zellij.
//
// NOT a production module and not imported by one. `registry.ts` builds `ZellijMux` over a
// {@link SpawnZellijExec}; this file builds the SAME adapter over a fake of the same shape, so the
// conformance engine (../conformance.ts) drives the whole translation — every argv the adapter
// composes, the JSON it decodes, the key table, the session binding, the census that stands in for a
// missing event — without a subprocess.
//
// THE FAKE IS ARGV-DRIVEN, AND THAT IS THE POINT. It does not stub the adapter's methods; it reads
// the command line the adapter actually built and answers it the way the real binary answered the
// probe. So a flag the adapter stops passing stops working here too.
//
// A FAKE THAT IS KINDER THAN THE REAL BINARY PROVES NOTHING — and on zellij the trap runs the other
// way, because the real binary is HARSHER than a naive fake would be. Every answer below was probed
// on 0.44.2 (M10/05):
//   • **`action` against a pane that does not exist exits 0 and prints nothing.** That is faithfully
//     reproduced, and it is what forces the adapter's own listing check to be real — a fake that
//     returned an error here would let the contract's `gone` pass while the shipped adapter answered
//     `ok` to a write that went nowhere.
//   • a session that is not running answers `Session 'x' not found …` on stderr with exit 1 — the one
//     failure an exit code proves, and the adapter's `unreachable`;
//   • `dump-screen --ansi` carries SGR and nothing else, and without it carries none, so the
//     contract's `styling` request is a real branch;
//   • `--full` reaches behind the viewport and a plain dump does not;
//   • the pane stream is newline-delimited JSON — `pane_update` frames and one `pane_closed`;
//   • pane ids climb from a counter that never goes back, so a dead pane's id is never reused — the
//     zellij promise identity rule 4 rests on, and the fake would be lying if it recycled them.
//
// ONE SPACE, TWO TABS, THREE PANES. The engine's world contract asks for a non-trivial world; on
// zellij "two spaces" is not a thing an adapter can have (adapter.ts § the mapping), so the world is
// the most non-trivial one zellij admits.

import type { JsonObject } from "../../json.ts";
import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { ZellijMux } from "./adapter.ts";
import type { ZellijExec, ZellijRunResult, ZellijStreamClient, ZellijStreamHandlers } from "./exec.ts";
import { terminalPaneId } from "./protocol.ts";
import { ZellijSessionBinding } from "./session.ts";

// SGR only — a colour on and a reset off, which is all `dump-screen --ansi` emits and the whole
// reason Collie can render zellij's grid with no terminal emulator (ADR 0008).
const GREEN = "[32m";
const RESET = "[0m";

/**
 * The session the fixture's world runs in.
 *
 * Exported because it is zellij's whole addressing space, and so it is what a beacon's `scope` is
 * compared against at the join (markers.ts) — the decorated variant seeds its fake beacons with it.
 */
export const SESSION = "collie-fixture";

/** zellij's own default name for a pane nobody has named. */
function defaultPaneTitle(index: number): string {
  return `Pane #${String(index)}`;
}

/** One tab in the fake session. */
interface FakeTab {
  tabNumber: number;
  position: number;
  name: string;
  active: boolean;
}

/** One terminal pane in the fake session, screen included. */
interface FakePane {
  paneId: string;
  tabNumber: number;
  focused: boolean;
  exited: boolean;
  title: string;
  rows: number;
  /** Lines that have scrolled off — what only a `--full` dump reaches. */
  scrollback: string[];
  /** Lines on screen now. */
  viewport: string[];
}

/** One live pane stream of the fake session. */
interface FakeStream {
  readonly handlers: ZellijStreamHandlers;
  readonly paneIds: readonly string[];
  ended: boolean;
}

/** A successful zellij command that printed something (or nothing). */
function said(stdout: string): ZellijRunResult {
  return { code: 0, stdout, stderr: "" };
}

/**
 * A zellij session, in memory, behaving as the real binary does.
 *
 * Implements {@link ZellijExec} — the narrow shape the adapter's session binding depends on — so the
 * adapter under test is the real one, unmodified.
 */
export class FakeZellij implements ZellijExec {
  private tabs: FakeTab[] = [];
  private panes: FakePane[] = [];
  private readonly streams = new Set<FakeStream>();
  private readonly recorded: MuxWrite[] = [];
  /** Only ever climbs, so no id is ever handed to a second pane. */
  private mintedPanes = 0;
  /** False while the session is "down" — every command answers as zellij does with nothing running. */
  private running = true;

  constructor() {
    this.seed();
  }

  // ── What the fixture drives ────────────────────────────────────────────────

  writes(): readonly MuxWrite[] {
    return this.recorded;
  }

  /**
   * The connection drops and comes back.
   *
   * Invisible to a caller by construction, and that is the zellij truth rather than a shortcut: the
   * adapter's transport is a subprocess, so every call already opens and closes its own connection.
   * What the conformance check is really asking is whether the adapter mints ids per-connection — it
   * must not, and this proves it does not.
   */
  async reconnect(): Promise<void> {
    this.running = false;
    await Promise.resolve();
    this.running = true;
  }

  /**
   * The zellij session restarts with the same panes.
   *
   * Every record is REBUILT as a fresh object carrying the same ids and values, which is what makes
   * the identity check meaningful: an adapter caching object identity, or deriving an id from
   * anything ephemeral, fails here and nowhere else.
   */
  async restartMux(): Promise<void> {
    this.tabs = this.tabs.map((tab) => ({ ...tab }));
    this.panes = this.panes.map((pane) => ({ ...pane, scrollback: [...pane.scrollback], viewport: [...pane.viewport] }));
    for (const stream of this.streams) this.endStream(stream, "the pane stream ended");
    await Promise.resolve();
  }

  /** Someone renames a pane in zellij itself — the operator's own keyboard, not Collie. */
  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const pane = this.paneAt(paneId);
    if (pane !== undefined) pane.title = label;
    await Promise.resolve();
  }

  /**
   * The PROGRAM in a pane prints a title. The same one slot `rename-pane` writes — which is the whole
   * hazard, and why the adapter has to remember what it set rather than read the slot.
   */
  async setProgramTitle(paneId: string, title: string): Promise<void> {
    const pane = this.paneAt(paneId);
    if (pane !== undefined) pane.title = title;
    await Promise.resolve();
  }

  /** The pane paints another line. What a keystroke landing would have done. */
  async changePane(paneId: string): Promise<void> {
    this.repaint(paneId);
    await Promise.resolve();
  }

  /**
   * The pane's process ends and zellij forgets it.
   *
   * Removed outright rather than left `exited`, because that IS zellij's default: a pane whose
   * command ends is closed unless the session was configured to hold it, and every `action` aimed at
   * it afterwards exits 0 having done nothing — which is exactly the silence the adapter's own
   * listing check exists to turn into `gone`.
   */
  async endPane(paneId: string): Promise<void> {
    this.panes = this.panes.filter((pane) => pane.paneId !== paneId);
    for (const stream of this.streams) {
      if (stream.paneIds.includes(paneId)) this.emitTo(stream, { event: "pane_closed", pane_id: paneId });
    }
    await Promise.resolve();
  }

  /**
   * Announce one pane's repaint on the stream.
   *
   * There is deliberately NO `pokeTopology` sibling: zellij has no channel to announce a structure
   * change on, which is why `pushTopologyEvents` is declared absent and the adapter censuses instead.
   */
  pokePane(paneId: string): void {
    const pane = this.repaint(paneId);
    if (pane === undefined) return;
    for (const stream of this.streams) {
      if (stream.paneIds.includes(paneId)) this.emitTo(stream, this.updateFrame(pane, false));
    }
  }

  /** Bring every stream down and forget it. Idempotent. */
  shutdown(): void {
    for (const stream of this.streams) this.endStream(stream, "closed");
    this.streams.clear();
  }

  // ── The transport (ZellijExec) ─────────────────────────────────────────────

  async run(args: readonly string[]): Promise<ZellijRunResult> {
    await Promise.resolve();
    if (args.at(0) === "list-sessions") {
      return this.running ? said(`${SESSION} [Created 1m 0s ago] \n`) : said("");
    }
    // Everything else is `--session <name> action <verb> …`. A session that is not running answers
    // the way the real binary does, which is the adapter's `unreachable`.
    const session = flagValue(args, "--session");
    if (!this.running || session !== SESSION) {
      return { code: 1, stdout: "", stderr: `Session '${session ?? ""}' not found. The following sessions are active:\n` };
    }
    return this.action(args);
  }

  stream(args: readonly string[], handlers: ZellijStreamHandlers): ZellijStreamClient {
    const paneIds = flagValues(args, "--pane-id");
    const stream: FakeStream = { handlers, paneIds, ended: false };
    const missing = paneIds.find((paneId) => this.paneAt(paneId) === undefined);
    if (!this.running || missing !== undefined) {
      // `subscribe` refuses the WHOLE invocation for one pane it cannot find (probed: exit 2), which
      // is why the watch only ever names panes its latest census still lists.
      queueMicrotask(() => handlers.onExit(missing === undefined ? "no session" : `Pane ${missing} not found`));
      return { kill: () => undefined };
    }
    this.streams.add(stream);
    // A real subscription opens with one `is_initial` frame per pane it follows.
    queueMicrotask(() => {
      for (const paneId of paneIds) {
        const pane = this.paneAt(paneId);
        if (pane !== undefined && !stream.ended) this.emitTo(stream, this.updateFrame(pane, true));
      }
    });
    return { kill: () => this.endStream(stream, "closed") };
  }

  // ── The verbs ──────────────────────────────────────────────────────────────

  private action(args: readonly string[]): ZellijRunResult {
    // `["--session", name, "action", verb, …]` — the binding prepends the session flag (session.ts).
    const verb = args.at(3) ?? "";
    if (verb === "list-panes") return said(JSON.stringify(this.panes.map((pane) => this.paneJson(pane))));
    if (verb === "list-tabs") return said(JSON.stringify(this.tabs.map((tab) => this.tabJson(tab))));
    if (verb === "dump-screen") return this.dumpScreen(args);
    if (verb === "write-chars") return this.writeChars(args);
    if (verb === "send-keys") return this.sendKeys(args);
    if (verb === "rename-pane") return this.renamePane(args);
    if (verb === "close-pane") return this.closePane(args);
    if (verb === "new-tab") return this.newTab(args);
    if (verb === "rename-tab-by-id") return this.renameTab(args);
    if (verb === "close-tab-by-id") return this.closeTab(args);
    return { code: 2, stdout: "", stderr: `unknown action: ${verb}\n` };
  }

  private dumpScreen(args: readonly string[]): ZellijRunResult {
    const pane = this.paneAt(flagValue(args, "--pane-id") ?? "");
    // The probed silence: no such pane, a bare newline printed, exit 0. The newline is the detail
    // that matters — an adapter testing stdout for emptiness by LENGTH would read it as a one-line
    // screen and answer `ok` for a pane that is gone (caught live, M10/05).
    if (pane === undefined) return said("\n");
    const lines = args.includes("--full") ? [...pane.scrollback, ...pane.viewport] : pane.viewport;
    const paint = (line: string): string => (args.includes("--ansi") ? `${GREEN}${line}${RESET}` : line);
    return said(`${lines.map(paint).join("\n")}\n`);
  }

  private writeChars(args: readonly string[]): ZellijRunResult {
    const paneId = flagValue(args, "--pane-id") ?? "";
    const pane = this.paneAt(paneId);
    if (pane === undefined) return said("");
    this.recorded.push({ paneId, kind: "text", payload: [afterDoubleDash(args).join(" ")] });
    return said("");
  }

  private sendKeys(args: readonly string[]): ZellijRunResult {
    const paneId = flagValue(args, "--pane-id") ?? "";
    const pane = this.paneAt(paneId);
    if (pane === undefined) return said("");
    this.recorded.push({ paneId, kind: "keys", payload: afterDoubleDash(args) });
    return said("");
  }

  private renamePane(args: readonly string[]): ZellijRunResult {
    const pane = this.paneAt(flagValue(args, "--pane-id") ?? "");
    if (pane === undefined) return said("");
    const label = afterDoubleDash(args).at(0) ?? "";
    // An empty name puts zellij's own default back, which is what `renamePane(id, null)` means.
    pane.title = label.length > 0 ? label : defaultPaneTitle(this.panes.indexOf(pane) + 1);
    return said("");
  }

  private closePane(args: readonly string[]): ZellijRunResult {
    const paneId = flagValue(args, "--pane-id") ?? "";
    this.panes = this.panes.filter((pane) => pane.paneId !== paneId);
    return said("");
  }

  private newTab(args: readonly string[]): ZellijRunResult {
    // zellij hands a new tab the lowest free stable id rather than a fresh one — reproduced, so the
    // adapter can never come to lean on tab ids climbing the way pane ids do.
    let tabNumber = 0;
    while (this.tabs.some((tab) => tab.tabNumber === tabNumber)) tabNumber += 1;
    const tab: FakeTab = {
      tabNumber,
      position: this.tabs.length,
      name: flagValue(args, "--name") ?? `Tab #${String(this.tabs.length + 1)}`,
      active: false,
    };
    this.tabs.push(tab);
    this.newPaneIn(tab);
    return said(`${String(tabNumber)}\n`);
  }

  private renameTab(args: readonly string[]): ZellijRunResult {
    const rest = afterDoubleDash(args);
    const tab = this.tabs.find((candidate) => String(candidate.tabNumber) === rest.at(0));
    if (tab !== undefined) tab.name = rest.at(1) ?? tab.name;
    return said("");
  }

  private closeTab(args: readonly string[]): ZellijRunResult {
    const tabNumber = Number.parseInt(afterDoubleDash(args).at(0) ?? "", 10);
    this.tabs = this.tabs.filter((tab) => tab.tabNumber !== tabNumber);
    this.panes = this.panes.filter((pane) => pane.tabNumber !== tabNumber);
    return said("");
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private paneAt(paneId: string): FakePane | undefined {
    return this.panes.find((pane) => pane.paneId === paneId);
  }

  private repaint(paneId: string): FakePane | undefined {
    const pane = this.paneAt(paneId);
    if (pane !== undefined) pane.viewport.push(`changed at ${String(pane.viewport.length)}`);
    return pane;
  }

  private emitTo(stream: FakeStream, frame: JsonObject): void {
    if (!stream.ended) stream.handlers.onLine(JSON.stringify(frame));
  }

  private updateFrame(pane: FakePane, initial: boolean): JsonObject {
    return {
      event: "pane_update",
      is_initial: initial,
      pane_id: pane.paneId,
      scrollback: null,
      viewport: pane.viewport.map((line) => `${GREEN}${line}${RESET}`),
    };
  }

  private endStream(stream: FakeStream, reason: string): void {
    if (stream.ended) return;
    stream.ended = true;
    this.streams.delete(stream);
    stream.handlers.onExit(reason);
  }

  private paneJson(pane: FakePane): JsonObject {
    const tab = this.tabs.find((candidate) => candidate.tabNumber === pane.tabNumber);
    return {
      id: Number.parseInt(pane.paneId.replace("terminal_", ""), 10),
      is_plugin: false,
      is_focused: pane.focused,
      title: pane.title,
      exited: pane.exited,
      pane_content_rows: pane.rows,
      terminal_command: null,
      tab_id: pane.tabNumber,
      tab_position: tab?.position ?? 0,
      tab_name: tab?.name ?? "",
    };
  }

  private tabJson(tab: FakeTab): JsonObject {
    const inTab = this.panes.filter((pane) => pane.tabNumber === tab.tabNumber).length;
    return {
      position: tab.position,
      name: tab.name,
      active: tab.active,
      tab_id: tab.tabNumber,
      selectable_tiled_panes_count: inTab,
      selectable_floating_panes_count: 0,
    };
  }

  private newPaneIn(tab: FakeTab): FakePane {
    this.mintedPanes += 1;
    const paneId = terminalPaneId(this.mintedPanes);
    const pane: FakePane = {
      paneId,
      tabNumber: tab.tabNumber,
      focused: !this.panes.some((candidate) => candidate.tabNumber === tab.tabNumber),
      exited: false,
      title: defaultPaneTitle(this.mintedPanes),
      rows: 24,
      scrollback: Array.from({ length: 30 }, (_, i) => `scrollback line ${String(i)} of ${paneId}`),
      viewport: [`$ shell in ${paneId}`, `pane ${paneId} on screen`],
    };
    this.panes.push(pane);
    return pane;
  }

  /**
   * The world every conformance world starts in: three live panes across two tabs of the one space,
   * one of them carrying a name the operator chose.
   *
   * A single bare shell would let half the suite pass vacuously — nothing about two tabs, nothing
   * about ids staying unique across them.
   */
  private seed(): void {
    const first: FakeTab = { tabNumber: 0, position: 0, name: "agents", active: true };
    const second: FakeTab = { tabNumber: 1, position: 1, name: "scratch", active: false };
    this.tabs.push(first, second);
    const labelled = this.newPaneIn(first);
    labelled.title = "the pane the operator named";
    this.newPaneIn(first);
    this.newPaneIn(second);
  }
}

/** The value of a flag, or undefined when it is not there. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args.at(at + 1);
}

/** Every value of a flag that may be repeated (`--pane-id a --pane-id b`). */
function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg !== flag) continue;
    const value = args.at(index + 1);
    if (value !== undefined) values.push(value);
  }
  return values;
}

/** Everything after zellij's own `--`, which is where the operator's text and labels live. */
function afterDoubleDash(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  return end < 0 ? [] : args.slice(end + 1);
}

/**
 * zellij's entry in the fixture registry (../fixtures.ts).
 *
 * The world is the real {@link ZellijMux} over a {@link FakeZellij} — the same adapter `registry.ts`
 * builds, with only the subprocess replaced.
 */
export const zellijConformanceFixture: MuxConformanceFixture = {
  mux: "zellij",
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(zellijWorld(new FakeZellij()).world);
  },
};

/**
 * One world over a caller-supplied fake, and the binding it was built with.
 *
 * Split out so the DECORATED variant (../fixtures.ts, M11/03) proves the same world through the same
 * adapter, with the beacon join added — its matcher must resolve the session through THE SAME
 * binding the adapter uses, or the two could disagree about which session this collie drives.
 */
export function zellijWorld(fake: FakeZellij): ZellijFixtureWorld {
  // The DEFAULT configuration — no session named, so the binding discovers the single running
  // one exactly as an operator who set nothing but `COLLIE_MUX=zellij` gets.
  const session = new ZellijSessionBinding(fake, "");
  const adapter = new ZellijMux(session);
  return {
    session,
    world: {
      adapter,
      writes: () => fake.writes(),
      reconnect: () => fake.reconnect(),
      restartMux: () => fake.restartMux(),
      renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
      setProgramTitle: (paneId, title) => fake.setProgramTitle(paneId, title),
      changePane: (paneId) => fake.changePane(paneId),
      endPane: (paneId) => fake.endPane(paneId),
      pokePane: (paneId) => fake.pokePane(paneId),
      close: () => {
        fake.shutdown();
        return Promise.resolve();
      },
    },
  };
}

/** A zellij world and the session binding behind it. */
export interface ZellijFixtureWorld {
  readonly session: ZellijSessionBinding;
  readonly world: MuxConformanceWorld;
}

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSlashLists } from "../slash-commands";
import { viewOf, type ScreenView } from "./screens";
import { runWalk, type WalkPane } from "./walk";

// The walk against a scripted pane: a small state machine that stands in for the agent. The screens
// are real Claude fixtures, so the Surface reads them the way it reads a live pane.

const PANES = join(import.meta.dir, "..", "..", "..", "web", "src", "fixtures", "panes");
const fixture = (name: string): ScreenView => viewOf(readFileSync(join(PANES, `claude--${name}.txt`), "utf8"), "claude");
const IDLE = fixture("fresh-idle");
const DRAFT = fixture("autocomplete-slash-short");
const DIALOG = fixture("menu-model-picker");
const RUNNING = fixture("working-esc-to-interrupt");

const LISTS = parseSlashLists(
  JSON.stringify({
    claude: {
      safe: [
        { command: "/help", opens: "dialog", reason: "reads only" },
        { command: "/status", opens: "dialog", reason: "reads only" },
        { command: "/gone", opens: "dialog", reason: "reads only" },
      ],
      unsafe: [{ command: "/clear", reason: "wipes the conversation" }],
    },
  }),
  "claude",
);
const MENU = ["/help", "/status", "/clear", "/mystery"];

type Mode = "idle" | "popup" | "closed" | "dialog" | "turn";

class ScriptPane implements WalkPane {
  mode: Mode = "idle";
  typed = "";
  pointer = 0;
  readonly entered: string[] = [];
  readonly pressed: string[] = [];
  stuck: string | null = null;
  starts: string | null = null;
  liar: string | null = null;

  constructor(
    private readonly menu: readonly string[],
    private readonly retired: readonly string[] = [],
  ) {}

  private describe(name: string): string {
    return this.retired.includes(name) ? "  (removed) no longer runs" : "  description";
  }

  private shown(): string[] {
    const rows: string[] = [];
    for (let i = 0; i < 4; i++) {
      const name = this.menu[(this.pointer + i) % this.menu.length]!;
      rows.push(`${i === 0 ? "❯" : " "} ${name}`.padEnd(24) + this.describe(name));
    }
    return rows;
  }

  private popupMatches(): string[] {
    const hits = this.menu.filter((name) => name.startsWith(this.typed));
    return hits;
  }

  async read(): Promise<ScreenView> {
    if (this.mode === "idle") return IDLE;
    if (this.mode === "dialog") return DIALOG;
    if (this.mode === "turn") return RUNNING;
    if (this.mode === "closed") return { ...DRAFT, plain: [`❯ ${this.typed}`], hash: `closed:${this.typed}` };
    // popup. A typed prefix narrows the list, and the pointer stands on its first hit.
    const plain = this.typed === "/" ? this.shown() : this.popupMatches().map((name, i) => `${i === 0 ? "❯" : " "} ${name}`.padEnd(24) + "  description");
    return { ...DRAFT, plain, hash: `popup:${this.typed}:${String(this.pointer)}` };
  }

  async type(text: string): Promise<void> {
    this.typed += text;
    this.mode = "popup";
    if (this.typed === "/") this.pointer = 0;
  }

  async keys(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.pressed.push(key);
      if (key === "Down") this.pointer = (this.pointer + 1) % this.menu.length;
      else if (key === "Backspace") {
        this.typed = this.typed.slice(0, -1);
        this.mode = this.typed === "" ? "idle" : "popup";
      } else if (key === "Escape") {
        if (this.mode === "dialog" && this.stuck === null) this.mode = "idle";
        else if (this.mode === "popup") this.mode = "closed";
        else if (this.mode === "turn") this.mode = "idle";
      } else if (key === "Enter") {
        const hit = this.popupMatches()[0];
        this.entered.push(this.typed);
        this.typed = "";
        this.mode = this.starts === hit ? "turn" : this.liar === hit ? "idle" : "dialog";
      }
    }
  }

  async sleep(): Promise<void> {}
}

describe("runWalk", () => {
  test("it sends only the safe commands the menu lists, and gets back to a free box", async () => {
    const pane = new ScriptPane(MENU);
    const done = await runWalk(pane, LISTS);
    expect(pane.entered).toEqual(["/help", "/status"]);
    expect(done.walk.sent).toEqual(["/help", "/status"]);
    expect(done.walk).toMatchObject({ reached: true, returned: true, menuRead: true, startedTurn: null });
    expect(pane.mode).toBe("idle");
  });

  test("an unclassified command is reported and never sent, and so is an unsafe one", async () => {
    const pane = new ScriptPane(MENU);
    const done = await runWalk(pane, LISTS);
    expect(done.walk.unclassified).toEqual(["/mystery"]);
    expect(done.walk.missing).toEqual(["/gone"]);
    expect(pane.entered).not.toContain("/mystery");
    expect(pane.entered).not.toContain("/clear");
  });

  test("a command the menu marks (removed) is reported as removed and never sent, even when it is on the safe list", async () => {
    const pane = new ScriptPane(["/help", "/status", "/agents", "/mystery"], ["/status", "/agents"]);
    const done = await runWalk(pane, LISTS);
    expect(done.walk.removed).toEqual(["/status", "/agents"]);
    expect(done.walk.unclassified).toEqual(["/mystery"]);
    expect(pane.entered).toEqual(["/help"]);
  });

  test("every dialog it reached is a fact, expected as a dialog, with the dialog read as not free", async () => {
    const done = await runWalk(new ScriptPane(MENU), LISTS);
    const reached = done.screens.filter((screen) => screen.leg === "walk" && screen.expects === "dialog");
    expect(reached.map((screen) => screen.label)).toEqual(["/help", "/status"]);
    expect(reached.every((screen) => !screen.free)).toBe(true);
    expect(done.screens[0]).toMatchObject({ leg: "start", free: true });
  });

  test("a safe command that starts a turn stops the walk and says which one", async () => {
    const pane = new ScriptPane(MENU);
    pane.starts = "/status";
    const done = await runWalk(pane, LISTS);
    expect(done.walk.startedTurn).toBe("/status");
    expect(done.walk.returned).toBe(false);
    expect(pane.entered).toEqual(["/help", "/status"]);
  });

  test("a dialog that does not close ends the walk with returned false, after three Escape", async () => {
    const pane = new ScriptPane(MENU);
    pane.stuck = "yes";
    const done = await runWalk(pane, LISTS);
    expect(done.walk.returned).toBe(false);
    expect(pane.pressed.filter((key) => key === "Escape").length).toBeGreaterThanOrEqual(3);
    expect(pane.entered).toEqual(["/help"]);
  });

  test("Enter is not sent when the menu does not point at the typed command", async () => {
    const pane = new ScriptPane(["/help", "/status", "/clear", "/mystery"]);
    // The menu points at /status first for the typed "/help": the pointer check refuses.
    const read = pane.read.bind(pane);
    pane.read = async (): Promise<ScreenView> => {
      const view = await read();
      return pane.mode === "popup" && pane.typed.length > 1 ? { ...view, plain: ["  /wrong          description", "❯ /other          description"], hash: `w:${pane.typed}` } : view;
    };
    const done = await runWalk(pane, LISTS);
    expect(pane.entered).toEqual([]);
    expect(done.walk.sent).toEqual([]);
  });

  test("a start screen that is not a free box sends nothing", async () => {
    const pane = new ScriptPane(MENU);
    pane.mode = "dialog";
    const done = await runWalk(pane, LISTS);
    expect(done.walk.reached).toBe(false);
    expect(pane.entered).toEqual([]);
    expect(pane.typed).toBe("");
  });

  test("a harness with no list reads its first screen only and sends nothing", async () => {
    const pane = new ScriptPane(MENU);
    const done = await runWalk(pane, { safe: [], unsafe: [] });
    expect(pane.pressed).toEqual([]);
    expect(done.screens).toHaveLength(1);
    expect(done.screens[0]?.expects).toBe("either");
  });

  test("a slow redraw after Down is not read as the end of the menu", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `/cmd${String(i).padStart(2, "0")}`);
    const pane = new ScriptPane(long);
    const read = pane.read.bind(pane);
    let stale: ScreenView | null = null;
    let calls = 0;
    pane.read = async (): Promise<ScreenView> => {
      const view = await read();
      calls++;
      // After each Down, the first read still shows the screen from before the key.
      if (stale !== null && pane.mode === "popup" && calls % 2 === 0) {
        const old = stale;
        stale = null;
        return old;
      }
      stale = view;
      return view;
    };
    const lists = parseSlashLists(JSON.stringify({ claude: { safe: [{ command: "/cmd29", opens: "dialog", reason: "reads only" }], unsafe: [] } }), "claude");
    const done = await runWalk(pane, lists);
    // Every command of the long menu was seen: the safe one at the very end was found and sent.
    expect(done.walk.missing).toEqual([]);
    expect(done.walk.sent).toEqual(["/cmd29"]);
  });

  test("a menu read that lost more than half of the safe list fails the menu check", async () => {
    const pane = new ScriptPane(["/help", "/mystery"]);
    const done = await runWalk(pane, LISTS);
    expect(done.walk.menuRead).toBe(false);
    expect(done.walk.missing).toEqual(["/status", "/gone"]);
    expect(done.log.join("\n")).toContain("lost 2 of 3 safe ones");
  });

  test("a dialog that reads free ends the walk after one Escape, and no later command is sent", async () => {
    const pane = new ScriptPane(MENU);
    pane.liar = "/help";
    const done = await runWalk(pane, LISTS);
    expect(pane.entered).toEqual(["/help"]);
    expect(pane.pressed.filter((key) => key === "Escape")).toHaveLength(2);
    expect(done.log.join("\n")).toContain("the walk ends after one Escape");
    expect(done.screens.some((screen) => screen.label === "/help" && screen.free)).toBe(true);
  });

  test("each note reaches the caller as it is written", async () => {
    const heard: string[] = [];
    const done = await runWalk(new ScriptPane(MENU), LISTS, (line) => heard.push(line));
    expect(heard).toEqual(done.log);
  });
});

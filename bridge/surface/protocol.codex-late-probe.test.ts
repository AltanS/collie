// The Send Protocol against the scripted fake multiplexer: part codex-late-probe. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles, type Profile } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { BOUNDS, LATE_PROBE, SendProtocol } from "./protocol.ts";
import { sendReceiptsRoute } from "../server.ts";
import { LaunchWindow } from "../launch-window.ts";
import { DIALOG, FakePane, OmpPane, PROBE, type Rig, nextId, omp, rig, surfaceFixture, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("a send's profile is read for its pane", () => {
  test("the profile lookup gets the pane, and the receipt names the version and the file that was read", async () => {
    const { deps } = rig();
    const asked: Array<string | undefined> = [];
    const protocol = new SendProtocol({
      ...deps,
      profile: async (harness: string, paneId?: string) => {
        asked.push(paneId);
        const match = await deps.profile(harness);
        return match === null ? null : { ...match, version: "2.1.999", status: "provisional" as const, binary: "/lab/copy/bin/agent" };
      },
    });
    const answer = await protocol.handle({ id: nextId(), text: "hello there, agent", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(asked).toEqual(["%1"]);
    expect(answer.receipt).toMatchObject({ outcome: "sent", version: "2.1.999", profileStatus: "provisional", binary: "/lab/copy/bin/agent" });
    // The file is kept in the stored receipt, and stays out of the recent-sends rows a problem report reads.
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.binary).toBe("/lab/copy/bin/agent");
    expect(protocol.recent("%1")[0]?.version).toBe("2.1.999");
    expect(Object.keys(protocol.recent("%1")[0] ?? {})).not.toContain("binary");
    // What a Report a problem sheet reads is `GET /api/send/receipts` (rows) and `GET /api/report/context`
    // (this machine's setup, bridge/report.ts): the file's path is on neither wire. The route is the
    // only way the phone sees a past send, and it answers rows.
    const wire = await sendReceiptsRoute({ send: protocol, driver: undefined }, "%1", null).text();
    expect(wire).toContain("2.1.999");
    expect(wire).not.toContain("binary");
    expect(wire).not.toContain("/lab/copy");
  });

  test("a version read from the PATH binary names no file", async () => {
    const { send } = rig();
    const answer = await send("please fix the failing test in the parser");
    expect(answer.receipt?.binary).toBeUndefined();
  });
});

describe("a Codex 0.169.0 goal notice remains after the empty-box shortcuts disappear", () => {
  const notice = "Goal hit usage limits (/goal resume) · ⚠ 6 warnings · f2 to view";
  const goalPane = (): FakePane => {
    const pane = new FakePane("codex");
    const render = pane.render.bind(pane);
    pane.render = () => `${render()}${pane.box === "" ? "" : "\n"}${" ".repeat(70)}${notice}`;
    return pane;
  };

  test("the standalone goal footer does not hold a message with probe_failed", async () => {
    const pane = goalPane();
    const answer = await rig({ pane, harness: "codex", version: "0.169.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
    expect(pane.transcript.at(-1)).toBe("› reply with one word: ready");
  });

  test("without the goal hint the same footer transition is refused and only the probe is cleaned up", async () => {
    const pane = goalPane();
    const answer = await rig({
      pane,
      harness: "codex",
      version: "0.169.0",
      edit: (profile) => ({
        ...profile,
        idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: {
          ...profile.idle.volatile.below,
          hints: (profile.idle.volatile.below.hints ?? []).filter((hint) => !hint.includes("Goal hit usage limits")),
        } } },
      }),
    }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.receipt?.detail).toStartWith("The probe character changed more than the box.");
    expect(pane.box).toBe("");
    expect(pane.transcript).not.toContain("› reply with one word: ready");
  });

  test("the goal hint matches only the observed status and its warning suffix", () => {
    const hints = (loadProfiles().get("codex")?.idle.volatile.below.hints ?? []).map((source) => new RegExp(source, "u"));
    const isHint = (row: string): boolean => hints.some((hint) => hint.test(row));
    expect(isHint(`  ${notice}`)).toBe(true);
    expect(isHint("  Goal hit usage limits (/goal resume)")).toBe(true);
    expect(isHint("  Goal hit usage limits (/goal resume) · ⚠ 1 warning · f2 to view")).toBe(true);
    expect(isHint("  Goal hit usage limits (/goal resume) · ⚠ 12 · f2")).toBe(true);
    expect(isHint("  Goal hit usage limits (/goal resume) · choose an account")).toBe(false);
    expect(isHint("  Goal hit usage limits (/goal resume) · ⚠ 6 warnings · f2 to view the diff")).toBe(false);
    expect(isHint("  Goal requires approval · Enter to confirm")).toBe(false);
    expect(isHint("  GPT-6-Astra xhigh · ~/project")).toBe(false);
  });
});

describe("a command into a Codex 0.163.0 turn whose idle footer carries a warning segment (lab, 2026-10-28)", () => {
  // The footer row is `? for shortcuts` with `⚠ 1 warning · f2 to view` after wide spacing; a turn swaps it for `tab to queue message`.
  /** The idle capture while the box is empty; the capture with the probe typed, its box row redrawn, once it holds text. */
  const inTurn = (): FakePane => {
    // The lab capture is plain text: the empty box's placeholder gets the faint paint Codex draws it in (`idle.placeholders.sgr`).
    const idle = surfaceFixture("codex--v0-163-0-idle-warning.txt")
      .replace("› Ask Codex to do anything", "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m")
      .split("\n");
    const typed = surfaceFixture("codex--v0-163-0-in-turn-probe.txt").split("\n");
    const at = typed.findLastIndex((row) => row.startsWith("› "));
    const pane = new FakePane("codex");
    pane.render = () => (pane.box === "" ? idle : typed.map((row, i) => (i === at ? `› ${pane.box}` : row))).join("\r\n");
    return pane;
  };
  /** The Codex profile as it was before the footer hint took a trailing segment. */
  const strictHint = (profile: Profile): Profile => ({
    ...profile,
    idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, hints: ["^\\s*← for agents · \\? for shortcuts$", "^\\s*\\? for shortcuts$", "^\\s*[Tt]ab to queue message$"] } } },
  });

  test("the probe passes: the footer row only changed from one hint to another, so the command is not refused probe_failed", async () => {
    const pane = inTurn();
    const answer = await rig({ pane, harness: "codex", version: "0.163.0" }).send("/status", { mode: "command" });
    expect(answer.receipt).not.toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  test("without the trailing segment in the hint the warning row counts as a screen that moved, and the command is refused probe_failed, as it was live", async () => {
    const pane = inTurn();
    const answer = await rig({ pane, harness: "codex", version: "0.163.0", edit: strictHint }).send("/status", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
  });
});

describe("a command on a fresh Codex 0.163.0 screen, whose welcome picture hides once the box holds text (rig, 2026-10-28)", () => {
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
  /** The idle capture while the box is empty; the capture with `/status` typed, its box row redrawn, once it holds text. */
  const welcome = (): FakePane => {
    const idle = surfaceFixture("codex--v0-163-0-welcome-idle.txt").split("\n");
    const typed = surfaceFixture("codex--v0-163-0-welcome-slash-status.txt").split("\n");
    const at = typed.findLastIndex((row) => plain(row).startsWith("› "));
    const pane = new FakePane("codex");
    pane.render = () => (pane.box === "" ? idle : typed.map((row, i) => (i === at ? `› ${pane.box}` : row))).join("\r\n");
    return pane;
  };
  const noLosesText = (profile: Profile): Profile => ({ ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, above: { maxRows: profile.idle.volatile.above.maxRows } } } });

  test("the command is entered: the picture only lost its rows (idle.volatile.above.losesText), as the probe already allows", async () => {
    const pane = welcome();
    const answer = await rig({ pane, harness: "codex", version: "0.163.0" }).send("/status", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen).toContain("Enter");
  });

  test("without the profile's word the picture going reads as a moved screen, and the text stays typed, as it did live", async () => {
    const pane = welcome();
    const answer = await rig({ pane, harness: "codex", version: "0.163.0", edit: noLosesText }).send("/status", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

describe("a probed message into a tall Codex 0.166.0 pane (harness lab drift, 2026-10-29)", () => {
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
  const pane = (name: string): string[] => readFileSync(join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", name), "utf8").replace(/\n$/u, "").split("\n");
  /**
   * The captures as Codex draws them: `empty` until the first key, `typed` with its box row redrawn while
   * the box holds text, and `back` once the box is empty again (the logo returns after the probe's Backspace).
   */
  const codex0166 = (empty: string, typed: string, back: string): FakePane => {
    const before = pane(empty);
    const holding = pane(typed);
    const after = pane(back);
    const at = holding.findLastIndex((row) => plain(row).startsWith("› "));
    const fake = new FakePane("codex");
    let touched = false;
    fake.afterInput = () => {
      touched = true;
    };
    fake.render = () => (fake.box !== "" ? holding.map((row, i) => (i === at ? `\u001b[1m›\u001b[0m ${fake.box}` : row)) : touched ? after : before).join("\n");
    return fake;
  };
  const logo = (): FakePane => codex0166("codex--v0166-art-empty--w120.txt", "codex--v0166-art-typed--w120.txt", "codex--v0166-art-backspace--w120.txt");
  const warning = (): FakePane => codex0166("codex--v0166-warning-art-empty--w120.txt", "codex--v0166-warning-typed--w120.txt", "codex--v0166-warning-art-empty--w120.txt");
  const noLosesText = (profile: Profile): Profile => ({ ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, above: { maxRows: profile.idle.volatile.above.maxRows } } } });
  /** The Codex profile as it was before the warning row of its own took a hint. */
  const noWarningHint = (profile: Profile): Profile => ({
    ...profile,
    idle: {
      ...profile.idle,
      volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, hints: (profile.idle.volatile.below.hints ?? []).filter((hint) => !hint.includes("⚠")) } },
    },
  });

  test("the 17-row logo hides at the probe character and returns after Backspace: the rows above only lost text, so the probe passes and Tab sends", async () => {
    const fake = logo();
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileStatus: "provisional", keys: ["probe", "Backspace", "Tab"] });
    expect(fake.transcript.at(-1)).toBe("› reply with one word: ready");
  });

  test("a message's probe reads only the box and the rows under it (Codex takes text in a turn): the logo is no factor, with or without losesText", async () => {
    const answer = await rig({ pane: logo(), harness: "codex", version: "0.166.0", edit: noLosesText }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
  });

  test("a command compares the rows above too: the logo only lost its rows (idle.volatile.above.losesText), so /status goes in", async () => {
    const fake = logo();
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0" }).send("/status", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("without losesText the logo going reads as a moved screen for a command, and its probe is refused", async () => {
    const fake = logo();
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0", edit: noLosesText }).send("/status", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(fake.keysSeen).not.toContain("Enter");
  });

  test("a lone `⚠ 1 warning · f2 to view` row under the box once it holds text is a hint, so the probe passes and Tab sends", async () => {
    const fake = warning();
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileStatus: "provisional", keys: ["probe", "Backspace", "Tab"] });
    expect(fake.transcript.at(-1)).toBe("› reply with one word: ready");
  });

  test("without the warning hint the lone warning row counts as a screen that moved, and the probe is refused, as it was in the lab", async () => {
    const fake = warning();
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0", edit: noWarningHint }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(fake.keysSeen.filter((key) => key === "Tab" || key === "Enter")).toEqual([]);
  });

  test("the warning hint takes the full and the narrow notice, and no other row", () => {
    const hints = (loadProfiles().get("codex")?.idle.volatile.below.hints ?? []).map((source) => new RegExp(source, "u"));
    const isHint = (row: string): boolean => hints.some((hint) => hint.test(row));
    expect(isHint(`${" ".repeat(95)}⚠ 1 warning · f2 to view`)).toBe(true);
    expect(isHint(`${" ".repeat(20)}⚠ 12 warnings · f2 to view`)).toBe(true);
    expect(isHint("  ⚠ 1 · f2")).toBe(true);
    expect(isHint("  ⚠ 1 warning · f2 to view the diff")).toBe(false);
    expect(isHint("  GPT-6.1-Sol default · ~/project")).toBe(false);
    expect(isHint("  ⚠ Heads up, you have less than 5% of your weekly limit left")).toBe(false);
  });
});

// Live check 2026-10-30, Claude Code 2.1.312 over tmux (release 1.25.0): a fresh pane draws a usage
// row under the footer (claude--v2312-weekly-limit-row--w120) and drops it once the box holds two
// rows. The rows under the box went from 2 to 1, and the send ended typed_not_submitted (changed),
// keys probe, Backspace, ctrl+j, ctrl+j. The profile names the row a hint (`idle.volatile.below.hints`).
describe("the usage-limit row under a fresh Claude Code box (2.1.312)", () => {
  const FOOTER = "  ⏸ manual mode on · ? for shortcuts";
  const LIMIT = "   You've used 75% of your weekly limit · resets Nov 4, 2am (Europe/Lisbon) · /usage-credits to keep using Claude Code";
  /** The row stands at S0 and through the probe, and goes when the box grows to a second row, as live. */
  const fresh = (pane: FakePane): void => {
    pane.status = [FOOTER, LIMIT];
    pane.afterInput = (p) => {
      p.status = p.box === "" ? [FOOTER, LIMIT] : p.box.includes("\n") ? ["  ⏸ manual mode on                ctrl+g to edit in VS Code"] : ["  ⏸ manual mode on", LIMIT];
    };
  };
  const text = "also mobile looks off\n\nmenu should be centered";

  test("the row present at S0 and gone after the probe: sent", async () => {
    const pane = new FakePane("claude");
    fresh(pane);
    const { send } = rig({ pane });
    expect((await send(text)).receipt).toMatchObject({ outcome: "sent", keys: ["ctrl+j", "ctrl+j", "Enter"] });
    expect(pane.transcript.at(-1)).toBe("> also mobile looks off  menu should be centered");
  });

  test("the row gone at the first character: sent", async () => {
    const pane = new FakePane("claude");
    pane.status = [FOOTER, LIMIT];
    pane.statusWithText = ["  ⏸ manual mode on"];
    const { send } = rig({ pane });
    expect((await send("hello there")).receipt).toMatchObject({ outcome: "sent" });
  });

  test("without the profile's hint the same pair ends typed_not_submitted (changed): the defect", async () => {
    const pane = new FakePane("claude");
    fresh(pane);
    const { send } = rig({ pane, edit: (profile) => ({ ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, hints: [] } } } }) });
    expect((await send(text)).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a row that is no hint still counts: a new row under the box keeps Enter back", async () => {
    const pane = new FakePane("claude");
    fresh(pane);
    pane.afterInput = (p) => {
      p.status = p.box.includes("\n") ? [FOOTER, LIMIT, "  Do you want to proceed?"] : [FOOTER, LIMIT];
    };
    const { send } = rig({ pane });
    expect((await send(text)).receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

// The late-probe window (M80 spec 09, 2026-11-01). A busy agent takes typed keys and draws them seconds
// late: Claude Code 2.1.314 with a subagent running drew Collie's probes after the probe's reads had
// ended, so three sends in ten seconds refused `probe_failed` on an empty box (#623). omp 18.6.1 did the
// same right after its start on a loaded machine: the browser leg's model picker refused its first tap
// four times in a week, the box idle and empty, the probe read twice in 242 ms (M80 spec 08). When the
// probe's reads saw the screen without the character and the turn read idle, the probe reads on.
describe("the late-probe window: a probe drawn late on an idle pane (M80 spec 09, #623)", () => {
  /** The pane draws each probe character only once the rig's clock reaches `due(writtenAt)`: the agent is busy. */
  const probeShowsAt = (r: Rig, due: (writtenAt: number) => number): void => {
    const waiting: number[] = [];
    r.pane.afterInput = (p, what) => {
      if (what !== `type:${PROBE}` || !p.box.endsWith(PROBE)) return;
      p.box = p.box.slice(0, -PROBE.length);
      waiting.push(due(r.clock.now));
    };
    r.pane.beforeRead = (p) => {
      while (waiting.length > 0 && waiting[0]! <= r.clock.now) {
        waiting.shift();
        p.box += PROBE;
        p.revision++;
      }
    };
  };

  test("a probe drawn late, 1.5 s after its write, shows in the window and the send goes on: no probe character stays", async () => {
    const r = rig({ version: "2.1.999" });
    probeShowsAt(r, (at) => at + 1500);
    const answer = await r.send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(r.pane.transcript.at(-1)).toBe("> hello there");
    expect(r.pane.box).toBe("");
    // The probe's reads (80 + 160 ms), the window's first read 1000 ms on, its second 2000 ms after that
    // (3240 ms after the write, where the character shows), then the Backspace read.
    expect(answer.receipt?.gapsMs.probe).toBe(80 + 160 + LATE_PROBE.firstGapMs * 3 + 80);
  });

  test("a probe drawn 5 s late refuses after the window, gapsMs.probe holds the whole wait; once drawn, the next send takes it out", async () => {
    const r = rig({ version: "2.1.999" });
    let lateBy = 5000;
    probeShowsAt(r, (at) => at + lateBy);
    const first = await r.send("hello there");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(first.receipt?.detail).toContain("The probe character did not show in the box.");
    expect(first.receipt?.gapsMs.probe).toBeGreaterThanOrEqual(LATE_PROBE.ms);
    expect(r.pane.transcript.at(-1)).not.toBe("> hello there");
    // The agent draws the character at last and answers at once from then on: the box holds Collie's
    // own residue, which the next send takes out (the late-keys cleanup, #623) before its own probe.
    r.clock.now += 5000;
    lateBy = 0;
    expect((await r.send("", { mode: "prepare" })).surface).toMatchObject({ turn: "idle", composer: "draft" });
    expect(r.pane.box).toBe(PROBE);
    const second = await r.send("hello there");
    expect(second.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Backspace", "probe", "Backspace", "Enter"] });
    expect(r.pane.transcript.at(-1)).toBe("> hello there");
    expect(r.pane.box).toBe("");
  });

  test("a free, responsive pane never opens the probe window: the probe takes its reads as before", async () => {
    const r = rig({ version: "2.1.999" });
    const answer = await r.send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.gapsMs.probe).toBe(160);
  });

  test("a running turn keeps today's path: no probe window, the probe refuses inside its own bound", async () => {
    const { pane, send } = omp();
    pane.inTurn = true;
    pane.swallow = true;
    const answer = await send("look at the tests too");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(answer.receipt?.gapsMs.probe).toBeLessThanOrEqual(BOUNDS.probe.ms);
  });

  test("omp's first redraw after its start is slow: a pane that echoes nothing for 1.5 s, then echoes, opens /model on the first tap (slow echo)", async () => {
    // The leg's omp case 1, the first case after omp's start: the launch window is open (`POST /api/launch`),
    // the box reads idle and empty, and omp draws nothing typed until its first redraw.
    const made = omp();
    const window = new LaunchWindow(() => made.clock.now);
    window.mark("main", "%1", "omp");
    const started = made.clock.now;
    probeShowsAt(made, () => started + 1500);
    const protocol = new SendProtocol({
      ...made.deps,
      starting: (paneId, named) => window.starting("main", paneId, named),
      framed: (paneId, harness) => window.framed("main", paneId, harness),
      deaf: (paneId, harness, typedAt) => window.deaf("main", paneId, harness, typedAt),
      pending: (paneId) => window.pending("main", paneId),
    });
    const answer = await protocol.handle({ id: nextId(), text: "/model", mode: "command" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.detail).toBeUndefined();
    expect(made.pane.transcript.at(-1)).toBe("> /model");
    expect(made.pane.box).toBe("");
    // The window took the character: the probe read past its own bound.
    expect(answer.receipt?.gapsMs.probe).toBeGreaterThan(BOUNDS.probe.ms);
    // The box took a key: the launch window ends, and no probe character is pending on the pane.
    expect(window.pending("main", "%1")).toBe(0);
  });

  /** A protocol on `made`'s pane with one session's launch window open for omp, as after `POST /api/launch`. */
  const launchedOmp = (made: Rig): ((text: string) => Promise<SendAnswer>) => {
    const window = new LaunchWindow(() => made.clock.now);
    window.mark("main", "%1", "omp");
    const protocol = new SendProtocol({
      ...made.deps,
      starting: (paneId, named) => window.starting("main", paneId, named),
      framed: (paneId, harness) => window.framed("main", paneId, harness),
      deaf: (paneId, harness, typedAt) => window.deaf("main", paneId, harness, typedAt),
      pending: (paneId) => window.pending("main", paneId),
    });
    return (text) => protocol.handle({ id: nextId(), text, mode: "command" }, { session: "main", paneId: "%1", harness: "omp" });
  };

  /**
   * The pane draws nothing typed until `at` on the rig's clock, then repaints the whole screen (every row
   * above the box new) with the probe character in the box: omp's first redraw after its start.
   */
  const repaintsWithProbeAt = (made: Rig & { pane: OmpPane }, at: number, repaints = 1): void => {
    let held = 0;
    let painted = 0;
    made.pane.afterInput = (p, what) => {
      if (what !== `type:${PROBE}` || !p.box.endsWith(PROBE)) return;
      if (made.clock.now >= at && painted >= repaints) return;
      p.box = p.box.slice(0, -PROBE.length);
      held++;
    };
    made.pane.beforeRead = (p) => {
      if (held === 0 || made.clock.now < at) return;
      painted++;
      // Words, not a counter: the rows above omp's box may tick (a number that moves is no new row).
      const word = painted % 2 === 1 ? "welcome" : "settled";
      p.transcript = p.transcript.map((_, i) => ` omp ${word} screen, row ${"abcdefghijklmnopqrstuvwxyz"[i % 26]!}`);
      p.box += PROBE.repeat(held);
      held = 0;
      p.revision++;
    };
  };

  test("omp's first redraw after its start repaints the whole screen with the late probe: the probe goes once more from a fresh S0, and /model goes on (first redraw)", async () => {
    // The first Herdr leg with the window (2026-11-01T21-04-12Z): `probe 3337`, "The probe character changed
    // more than the box. One Backspace removed the probe character", then a second tap went `sent`.
    const made = omp();
    repaintsWithProbeAt(made, made.clock.now + 1500);
    const answer = await launchedOmp(made)("/model");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "probe", "Backspace", "Enter"] });
    expect(answer.receipt?.detail).toBeUndefined();
    expect(answer.receipt?.gapsMs.probe).toBeGreaterThan(LATE_PROBE.firstGapMs);
    expect(made.pane.transcript.at(-1)).toBe("> /model");
    expect(made.pane.box).toBe("");
  });

  test("the second chance is taken once: a pane that repaints with every probe refuses as the first probe did, after two probes", async () => {
    const made = omp();
    repaintsWithProbeAt(made, made.clock.now + 1500, 2);
    const answer = await launchedOmp(made)("/model");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace", "probe", "Backspace"] });
    expect(answer.receipt?.detail).toContain("The probe character changed more than the box. One Backspace removed the probe character");
    expect(made.pane.box).toBe("");
    expect(made.pane.transcript.at(-1)).not.toBe("> /model");
  });

  test.each([
    ["a dialog", DIALOG],
    ["a list of plain rows under the box", ["  first match", "  second match"]],
  ])("a late probe that opens a popup which stays after its Backspace refuses as today: the fresh S0 still shows %s, no second probe", async (_name, popup) => {
    const r = rig({ version: "2.1.999" });
    let due: number | null = null;
    r.pane.afterInput = (p, what) => {
      if (what !== `type:${PROBE}` || !p.box.endsWith(PROBE)) return;
      p.box = p.box.slice(0, -PROBE.length);
      due = r.clock.now + 1500;
    };
    r.pane.beforeRead = (p) => {
      if (due === null || r.clock.now < due) return;
      due = null;
      p.box += PROBE;
      p.popup = popup;
      p.revision++;
    };
    const answer = await r.send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.receipt?.detail).toContain("The probe character changed more than the box. One Backspace removed the probe character");
    expect(r.pane.calls.filter((call) => call === `type:${PROBE}`)).toHaveLength(1);
    expect(r.pane.transcript.at(-1)).not.toBe("> hello there");
  });

  test("a first redraw later than the window still refuses the first tap with the starting words, as the leg saw it", async () => {
    // The same pane, its first redraw past the window: the leg's receipt, `probe_failed` with the launch window's words.
    const made = omp();
    const window = new LaunchWindow(() => made.clock.now);
    window.mark("main", "%1", "omp");
    const started = made.clock.now;
    probeShowsAt(made, () => started + 10_000);
    const protocol = new SendProtocol({
      ...made.deps,
      starting: (paneId, named) => window.starting("main", paneId, named),
      framed: (paneId, harness) => window.framed("main", paneId, harness),
      deaf: (paneId, harness, typedAt) => window.deaf("main", paneId, harness, typedAt),
      pending: (paneId) => window.pending("main", paneId),
    });
    const answer = await protocol.handle({ id: nextId(), text: "/model", mode: "command" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"], saw: { turn: "idle", modal: "none", composer: "empty" } });
    expect(answer.receipt?.detail).toContain("The omp input box does not take keys yet; it may still be starting.");
    expect(answer.receipt?.gapsMs.probe).toBeGreaterThanOrEqual(LATE_PROBE.ms);
  });
});

// #655: agy 1.4.12 lists a running sub-agent in a rail between the box's bottom rule and a closing
// rule, and that rail row ends in the sub-agent's elapsed time. The profile's rail shape (agy.json,
// frameAlternates) puts the rail inside the frame, so a draft's two-read compare would see the time
// tick. An EMPTY box compares by its two edges alone: its top rule and the rail's closing rule. The
// screen is the report's own (agy--v1412-subagent-band-idle.txt), its elapsed time set per read.
describe("agy 1.4.12, the empty box over a sub-agent rail, replayed from the report's screen (#655)", () => {
  const screen = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/agy--v1412-subagent-band-idle.txt"), "utf8");
  const ELAPSED = "· 1h15m35s";
  const draw = (elapsed: string, box: string): string => screen.replace(ELAPSED, `· ${elapsed}`).replace(/^>$/mu, box === "" ? ">" : `> ${box}`);

  test("the screen holds one Agent row with its elapsed time and one empty `>` row", () => {
    expect(screen.split("\n").filter((row) => row.startsWith("  ● Agent(") && row.endsWith(ELAPSED))).toHaveLength(1);
    expect(screen.split("\n").filter((row) => row === ">")).toHaveLength(1);
    expect(draw("12s", "")).not.toBe(draw("13s", ""));
  });

  test("12s at the first read, 13s at the second, a second more at every read after: S0 reads the same box and the send goes out", async () => {
    const pane = new FakePane("claude");
    const elapsed: string[] = [];
    pane.beforeRead = (p, n) => {
      const time = `${String(11 + n)}s`;
      elapsed.push(time);
      p.fixed = draw(time, p.box);
    };
    const answer = await rig({ pane, harness: "agy", version: "1.4.12" }).send("hello agy");
    expect(elapsed.slice(0, 2)).toEqual(["12s", "13s"]);
    expect(answer.detail ?? "").not.toMatch(/moved between two reads/u);
    expect(answer.receipt?.s0).toMatchObject({ hash: expect.any(String) });
    expect(pane.calls).toEqual([`type:${PROBE}`, "paste:hello agy"]);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
  });

  test("the control: the box's top rule changes between the two reads, and S0 refuses not_free", async () => {
    const pane = new FakePane("claude");
    pane.beforeRead = (p, n) => {
      const drawn = draw(`${String(11 + n)}s`, p.box);
      p.fixed = n === 2 ? drawn.replace(/^(─+)\n>$/mu, (_all, rule: string) => `${rule.slice(0, -10)}\n>`) : drawn;
    };
    const answer = await rig({ pane, harness: "agy", version: "1.4.12" }).send("hello agy");
    expect(answer.receipt).toMatchObject({ outcome: "refused" });
    expect(pane.calls).toEqual([]);
  });
});

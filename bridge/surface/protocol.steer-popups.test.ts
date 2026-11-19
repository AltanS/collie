// The Send Protocol against the scripted fake multiplexer: part steer-popups. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles, type Profile } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { BOUNDS, COMMAND_SETTLE_MS, type SendDeps, type SendRequest } from "./protocol.ts";
import { HoldStore } from "./holds.ts";
import { FakePane, LIVE_ROW, PROBE, PiPane, dir, neverEscape, omp, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("S1 reads the turn again before the commit key (PR 491): a turn starts between S0 and the Enter", () => {
  const TURN_STARTED = "A turn started while the text was typed, so Enter was not pressed. The text is in the box. Submit it when the turn ends.";

  test("pi: /model typed on an idle box, a turn starts while it goes in: Enter must not steer the turn", async () => {
    const pane = new PiPane("alt+Enter");
    const { send } = rig({ pane, harness: "pi", version: "0.87.1" });
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("omp: /model typed on an idle box, a turn starts while it goes in: Enter must not steer the turn", async () => {
    const { pane, send } = omp();
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("omp: /goal pause typed on an idle box, a turn starts while it goes in (the status row's spinner): it takes Enter, which OMP runs at once, never steering", async () => {
    const { pane, send } = omp({ version: "18.12.2" });
    pane.runsAtOnce = ["/goal"];
    pane.showWorking = false;
    pane.afterInput = (_p, what) => {
      if (what === "type:/goal pause" || what === "paste:/goal pause") pane.inTurn = true;
    };
    const answer = await send("/goal pause", { mode: "command" });
    expect({ steered: pane.steered, ran: pane.ran, outcome: answer.receipt?.outcome, key: answer.receipt?.keys.at(-1) }).toEqual({ steered: [], ran: ["/goal pause"], outcome: "sent", key: "Enter" });
    expect(answer.receipt?.queued).toBeUndefined();
  });

  test("codex: /new (never held) typed on an idle box, a turn starts while it goes in: no Enter into the turn", async () => {
    const pane = new FakePane("codex");
    const { send } = rig({ pane, harness: "codex", version: "0.159.2" });
    pane.afterInput = (p, what) => {
      if (what === "type:/new" || what === "paste:/new") p.over = ["• Working (0s • esc to interrupt)"];
    };
    const answer = await send("/new", { mode: "command" });
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: false, outcome: "typed_not_submitted" });
  });

  test("claude: /clear (never held) typed on an idle box, a turn starts while it goes in: no Enter (Claude would queue /clear)", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what === "type:/clear" || what === "paste:/clear") p.over = [LIVE_ROW];
    };
    const answer = await send("/clear", { mode: "command" });
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: false, outcome: "typed_not_submitted" });
    expect(answer.receipt).toMatchObject({ reason: "changed", detail: TURN_STARTED });
  });

  test("claude, version unread: a message typed on an idle box, a turn starts while it goes in: no Enter (S0 would have held it)", async () => {
    const { pane, send } = rig({ version: "no version here" });
    pane.afterInput = (p, what) => {
      if (what.endsWith("then give it a title")) p.over = [LIVE_ROW];
    };
    const answer = await send("then give it a title");
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: false, outcome: "typed_not_submitted" });
  });

  test("pi on a full screen (the turn's Working row scrolls the transcript up one row): Enter must not steer the turn", async () => {
    const pane = new PiPane("alt+Enter");
    const render = pane.render.bind(pane);
    pane.render = () => render().split("\n").slice(-16).join("\n");
    const { send } = rig({ pane, harness: "pi", version: "0.87.1" });
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("omp on a full screen (the turn's Working row scrolls the transcript up one row): Enter must not steer the turn", async () => {
    const { pane, send } = omp();
    const render = pane.render.bind(pane);
    pane.render = () => render().split("\n").slice(-16).join("\n");
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("unchanged: a message on a Claude whose version was read, a turn starts while it goes in: Enter still goes out (Claude queues it)", async () => {
    // The same screens as the unread-version case above, where S1 reads the turn; here the rule allows the send.
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.endsWith("then give it a title")) p.over = [LIVE_ROW];
    };
    const answer = await send("then give it a title");
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: true, outcome: "sent" });
  });

  test("codex: /status (a command Codex queues) typed on an idle box, a turn starts while it goes in: it takes Tab, as at S0, never Enter", async () => {
    const pane = new FakePane("codex");
    const { send } = rig({ pane, harness: "codex", version: "0.159.2" });
    pane.afterInput = (p, what) => {
      if (what === "type:/status" || what === "paste:/status") p.over = ["• Working (0s • esc to interrupt)"];
    };
    const answer = await send("/status", { mode: "command" });
    expect({ enter: pane.keysSeen.includes("Enter"), last: answer.receipt?.keys.at(-1), queued: pane.queued }).toEqual({ enter: false, last: "Tab", queued: ["/status"] });
  });

  test("omp, no box found (the manual send, two taps): /model typed, a running row draws under it: Enter must not steer the turn", async () => {
    const pane = new FakePane("generic");
    const { send, protocol } = rig({ pane, harness: "omp", version: "18.11.3" });
    const prepared = await protocol.handle({ id: "prepare-omp-s1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface?.reason).toBe("no-match");
    pane.afterInput = (p, what) => {
      if (what === "type:/model" || what === "paste:/model") p.footer = "⠋ Working... (4s • esc to interrupt)";
    };
    const answer = await send("/model", { mode: "command", rowsHash: prepared.rowsHash! });
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome, detail: answer.detail }).toEqual({ enter: false, outcome: "typed_not_submitted", detail: TURN_STARTED });
  });

  test("control: pi, a turn start that also adds two transcript rows above the band: the S1 compare keeps Enter back on its own", async () => {
    const pane = new PiPane("alt+Enter");
    const render = pane.render.bind(pane);
    pane.render = () => render().split("\n").slice(-16).join("\n");
    const { send } = rig({ pane, harness: "pi", version: "0.87.1" });
    pane.afterInput = (p, what) => {
      if (what === "type:/model" || what === "paste:/model") {
        pane.inTurn = true;
        p.transcript.push(" > a queued prompt that started the turn", "");
      }
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });
});

describe("pi under pi-powerline-footer's inset editor (issue 544, live 2026-10-20)", () => {
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\[[0-9;:]*m/gu, "");
  const capture = (name: string): string[] => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split(/\r?\n/u);
  const GLYPH = " \u001b[38;2;200;200;200m>\u001b[39m";
  const WIDGET = " \u001b[38;5;244m↳\u001b[39m \u001b[38;5;244mReply with exactly DONE-1 and nothing else.\u001b[39m";
  const INSET_WRAP = 112;

  /** The extension's box holding `box`: ` > ` and the first row, later rows and wrapped rows three spaces in, the cursor last. */
  const insetRows = (box: string): string[] => {
    const rows: string[] = [];
    for (const line of box.split("\n")) {
      for (let at = 0; at === 0 || at < line.length; at += INSET_WRAP) rows.push(line.slice(at, at + INSET_WRAP));
    }
    return rows.map((row, i) => `${i === 0 ? `${GLYPH} ` : "   "}${row}${i === rows.length - 1 ? "\u001b[7m \u001b[0m" : ""}`);
  };

  /**
   * The live screen around the box (`two-row-draft` capture): the rows over the box, the box redrawn
   * from the pane's text, the bottom rule and what stands under it. pi pads the screen with blank rows
   * at the top, so a taller box takes them and the rows under stay at the bottom. Submit (alt+Enter)
   * takes the text and leaves the box empty.
   */
  const live = (pane: FakePane, under: string[] = []): void => {
    const rows = capture("pi--v130-powerline-editor-two-row-draft--w120.txt");
    const prompt = rows.findIndex((row) => plain(row).startsWith(" > "));
    const bottom = rows.findIndex((row, i) => i > prompt && /^ ─{20,}$/u.test(plain(row)));
    pane.collapseOver = 100_000;
    pane.afterInput = (p, what) => {
      if (what.startsWith("keys:") && what.includes("alt+Enter")) p.box = "";
    };
    pane.beforeRead = (p) => {
      const box = insetRows(p.box);
      const drawn = [...rows.slice(0, prompt), ...box, ...rows.slice(bottom, bottom + 1), ...under];
      const pad = rows.length - drawn.length;
      p.fixed = [...drawn.slice(0, 3), ...Array<string>(Math.max(0, pad)).fill(""), ...drawn.slice(3)].join("\r\n");
    };
  };

  const LONG = 'Use the question tool exactly once: ask "Which fruit do you like?" with the options Apple, Banana, Cherry. Do nothing else.';
  const WALKY = "[walky-talky wt_0a1b2c3d4e5f] from operator (Phone)\nReply with exactly WALKY-1 and nothing else.";

  for (const [name, text] of [["a message that wraps to a second row", LONG], ["a walky talky header and body", WALKY]] as const) {
    for (const under of [[], [WIDGET]]) {
      test(`${name}${under.length > 0 ? ", the widget row under the box" : ""}: sent with one submit`, async () => {
        const pane = new FakePane("claude");
        const { send } = rig({ pane, harness: "pi", version: "1.3.0" });
        live(pane, under);
        const answer = await send(text);
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("alt+Enter");
        expect(pane.box).toBe("");
        neverEscape(pane);
      });
    }
  }

  test("a dialog's key hints drawn in the box after the text went in: left typed, never submitted", async () => {
    const pane = new FakePane("claude");
    const { send } = rig({ pane, harness: "pi", version: "1.3.0" });
    live(pane);
    const draw = pane.beforeRead!;
    pane.beforeRead = (p, n) => {
      void draw(p, n);
      // The box's second row (the only row three spaces in) turns into a dialog's hint row.
      if (p.box === LONG) p.fixed = p.fixed!.replace(/\r\n {3}[^\r\n]*/u, "\r\n   ↑↓ navigate • Enter to select • Esc to cancel");
    };
    const answer = await send(LONG);
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(pane.keysSeen).not.toContain("alt+Enter");
    neverEscape(pane);
  });

  // The slash list opens under the box (the editor draws it), and the widget row stands under the list.
  for (const under of [[], [WIDGET]]) {
    test(`/model over its own list${under.length > 0 ? " and the widget row" : ""}: one Enter, and the selector it opens counts as sent`, async () => {
      const listed = capture("pi--v130-powerline-editor-slash-model--w120.txt");
      const opened = capture("pi--v130-powerline-model-selector--w120.txt").join("\r\n");
      const boxRow = listed.findIndex((row) => plain(row).startsWith(" > /model"));
      const list = listed.slice(boxRow + 2);
      const head = listed.slice(0, boxRow + 2);
      const pane = new FakePane("claude");
      const { send } = rig({ pane, harness: "pi", version: "1.3.0" });
      pane.beforeRead = (p) => {
        if (p.box === "" && p.keysSeen.includes("Enter")) {
          p.fixed = opened;
          return;
        }
        const rows = [...head];
        rows[boxRow] = `${GLYPH} ${p.box}\u001b[7m \u001b[0m`;
        const below = p.box.startsWith("/") ? [...list, ...under] : under;
        const pad = Array<string>(list.length + under.length - below.length).fill("");
        p.fixed = [rows[0]!, ...pad, ...rows.slice(1), ...below].join("\r\n");
      };
      const answer = await send("/model", { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("Enter");
      neverEscape(pane);
    });
  }
});

// M69 spec 02: the steer, replayed from real captures of pi 1.3.0, Codex 0.164.0 and OMP 18.6.1 (lab
// 2026-10-23, web/src/fixtures/panes/*-{steer,queue}-*--w120.txt). Each read answers with the capture
// the lab took at that point: the text typed, then one capture per read after the commit key (the last
// one stands for every later read). The empty box and the probe are the typed capture with the line
// taken out of the box, or the probe put in its place.
describe("steer or queue (M69), replayed from the real captures (lab 2026-10-23)", () => {
  const PANES = join(import.meta.dir, "../../web/src/fixtures/panes");
  const LINE = "also say hello at the end";
  const capture = (name: string): string => readFileSync(join(PANES, `${name}--w120.txt`), "utf8");
  // eslint-disable-next-line no-control-regex
  const plainRow = (row: string): string => row.replace(/\u001b\[[0-9;:]*m/gu, "");
  /** The capture with the box's text (the line's last place on the screen) replaced. */
  const inBox = (screen: string, text: string): string => {
    const at = screen.lastIndexOf(LINE);
    return screen.slice(0, at) + text + screen.slice(at + LINE.length);
  };
  /** The capture without the rows whose plain text holds one of these. */
  const without = (screen: string, rows: readonly string[]): string =>
    screen
      .split("\n")
      .filter((row) => !rows.some((part) => plainRow(row).includes(part)))
      .join("\n");

  interface Replayed {
    pane: FakePane;
    /** Each text write and key with the rig's clock when it went in. */
    log: [string, number][];
  }
  /** `typedName` names a capture, or is a whole screen built from captures (it holds a newline). */
  const replay = (typedName: string, after: readonly string[], clock: { now: number }, line = LINE): Replayed => {
    const lab = typedName.includes("\n") ? typedName : capture(typedName);
    const typed = line === LINE ? lab : inBox(lab, line);
    const pane = new FakePane("generic");
    const log: [string, number][] = [];
    let committed = false;
    let read = 0;
    pane.afterInput = (_p, what) => {
      log.push([what, clock.now]);
      if (what.startsWith("keys:") && what !== "keys:Backspace") committed = true;
    };
    pane.beforeRead = (p) => {
      if (committed) p.fixed = after[Math.min(read++, after.length - 1)]!;
      else if (p.box === "") p.fixed = inBox(lab, "");
      else if (p.box === PROBE) p.fixed = inBox(lab, PROBE);
      else if (p.box === line) p.fixed = typed;
      else throw new Error(`the lab never saw the box hold ${JSON.stringify(p.box)}`);
    };
    return { pane, log };
  };
  const steerOn = async (
    harness: string,
    version: string,
    typedName: string,
    after: readonly string[],
    over: Partial<SendRequest> = { when: "steer", fromPhone: true },
    holds?: HoldStore,
    line = LINE,
  ): Promise<{ answer: SendAnswer } & Replayed & { clock: { now: number } }> => {
    const clock = { now: 1_000_000 };
    const replayed = replay(typedName, after, clock, line);
    const made = rig({ pane: replayed.pane, harness, version, clock, holds });
    return { answer: await made.send(line, over), clock, ...replayed };
  };
  /** The capture with each row whose plain text, trimmed, matches `pick` replaced by `row`. */
  const swapRow = (screen: string, pick: (plain: string) => boolean, row: string): string =>
    screen
      .split("\n")
      .map((at) => (pick(plainRow(at).trim()) ? row : at))
      .join("\n");
  const STEER = { when: "steer", fromPhone: true } as const;

  test("pi 1.3.0: Enter after the text; no row at 0.4 s, the Steering row at 1.2 s: steered", async () => {
    const { answer, pane } = await steerOn("pi", "1.3.0", "pi--v130-steer-typed", [capture("pi--v130-steer-after-now"), capture("pi--v130-steer-after")]);
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"], version: "1.3.0" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(answer.receipt?.reason).toBeUndefined();
    expect(pane.keysSeen).not.toContain("alt+Enter");
    neverEscape(pane);
  });

  // Live rerun 2026-10-23: with a follow-up queued first, pi draws `Steering: say banana`, then
  // `Follow-up: ok`, then the hint. The block witness read the hint right under the Steering row only,
  // so the receipt said unknown and kept the draft, and a resend would have steered twice.
  test("pi 1.3.0: a steer after a queued follow-up, its `Follow-up:` row between the Steering row and the hint: steered", async () => {
    const after = capture("pi--v130-steer-after-queued");
    expect(after.split("\n").map(plainRow).filter((row) => /^\s*(?:Steering|Follow-up): /u.test(row)).map((row) => row.trim())).toEqual(["Steering: say banana", "Follow-up: ok"]);
    const { answer, pane } = await steerOn("pi", "1.3.0", "pi--v130-steer-typed", [capture("pi--v130-steer-after-now"), after], STEER, undefined, "say banana");
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"], version: "1.3.0" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.keysSeen).not.toContain("alt+Enter");
    neverEscape(pane);
  });

  test("Codex 0.164.0: one second between the text and Enter, the steer header at 0.4 s: steered", async () => {
    const { answer, pane, log } = await steerOn("codex", "0.164.0", "codex--v0164-steer-typed", [capture("codex--v0164-steer-after-now")]);
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.keysSeen).not.toContain("Tab");
    const wrote = log.find(([what]) => what === `paste:${LINE}`)![1];
    const entered = log.find(([what]) => what === "keys:Enter")![1];
    expect(entered - wrote).toBeGreaterThanOrEqual(1000);
  });

  test("Codex 0.164.0: no witness at 0.4 s or 1.2 s, the line as `› <line>` in the transcript at 2 s: steered", async () => {
    const after = capture("codex--v0164-steer-after");
    const bare = without(after, [`› ${LINE}`]);
    expect(bare.split("\n").length).toBe(after.split("\n").length - 1);
    const { answer } = await steerOn("codex", "0.164.0", "codex--v0164-steer-typed", [bare, bare, after]);
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"] });
  });

  test("OMP 18.6.1: the box still holds the line at 0.4 s, the backgrounded tool and the line in the transcript at 1.2 s: steered", async () => {
    const { answer, pane } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [capture("omp--v18-6-steer-after-now"), capture("omp--v18-6-steer-after")]);
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  // Live rerun 2026-10-23: a steer while OMP streams waits for the next step in a block `Steering · 1`
  // / `1. <line>` / `└ Alt+↑ to edit`, the rows and hint of OMP's queue under another header. The
  // queued row read the block without its header, so the receipt said sent and queued ("Queued
  // instead") although OMP steered.
  test("OMP 18.6.1: the `Steering · 1` block over the line: steered, not queued", async () => {
    const after = capture("omp--v18-6-steer-pending-block");
    expect(after.split("\n").map((row) => plainRow(row).trim())).toEqual(expect.arrayContaining(["Steering · 1", "1. say banana", "└ Alt+↑ to edit"]));
    const { answer, pane } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [after], STEER, undefined, "say banana");
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  // Live rerun 2026-10-23, second pass: with `ok` queued first, a steer draws its `Steering · 1` block
  // over the queue's `After yield · 1` block, and one `└ Alt+↑ to edit` hint stands under both. The
  // steer witness read up from the hint, took ` After yield · 1` for a wrapped row of `1. ok` and
  // stopped at `Steering · 1` with nothing found: unknown, the draft kept, a resend would steer twice.
  test("OMP 18.6.1: a steer after a queued `ok`, its `Steering · 1` block over the `After yield · 1` block, one hint: steered", async () => {
    const after = capture("omp--v18-6-steer-over-queued");
    const { answer, pane } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [after], STEER, undefined, "say banana");
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(answer.receipt?.reason).toBeUndefined();
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  test("OMP 18.6.1: the same stacked screen after the queue key for `ok`: sent, queued (the After yield block is still read)", async () => {
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-queue-typed", [capture("omp--v18-6-steer-over-queued")], {}, undefined, "ok");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
  });

  test("OMP 18.6.1: `ok` queued already and steered again; the stacked screen's `ok` is the After yield block's: no steer", async () => {
    const stacked = capture("omp--v18-6-steer-over-queued").split("\n");
    const block = stacked.filter((row) => /^\s*(?:After yield · 1|1\. ok|└ Alt\+↑ to edit)\s*$/u.test(plainRow(row)));
    expect(block).toHaveLength(3);
    // The queue-typed capture with that block over its spinner row: `ok` is queued before the steer.
    const typed = capture("omp--v18-6-queue-typed").split("\n");
    const spinner = typed.findIndex((row) => plainRow(row).includes("Running counting loop"));
    const before = [...typed.slice(block.length + 1, spinner), ...block, "", ...typed.slice(spinner)].join("\n");
    const { answer } = await steerOn("omp", "18.6.1", before, [capture("omp--v18-6-steer-over-queued")], STEER, undefined, "ok");
    expect(answer.receipt?.outcome).not.toBe("steered");
  });

  test("OMP 18.6.1: the queue's `After yield · 1` block after a steer key: sent, queued", async () => {
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-queue-typed", [capture("omp--v18-6-queue-after-now"), capture("omp--v18-6-queue-after")]);
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"] });
  });

  test("OMP 18.6.1 without a steer: the queue key, `After yield · 1` over the line: sent, queued", async () => {
    const { answer, pane } = await steerOn("omp", "18.6.1", "omp--v18-6-queue-typed", [capture("omp--v18-6-queue-after-now"), capture("omp--v18-6-queue-after")], {});
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("OMP: the queue's rows and hint under no header are neither queued nor a steer block", async () => {
    const after = without(capture("omp--v18-6-queue-after"), ["After yield"]);
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-queue-typed", [after]);
    expect(answer.receipt?.queued).toBeUndefined();
    expect(answer.receipt?.outcome).not.toBe("steered");
  });

  test("OMP: the line in the transcript alone, with no backgrounded tool, is a steer too", async () => {
    const after = without(capture("omp--v18-6-steer-after"), ["Backgrounded early to handle an incoming message"]);
    const lines = after.split("\n").map((row) => plainRow(row).trimEnd());
    expect(lines.some((row) => row.includes("Backgrounded early"))).toBe(false);
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [after]);
    expect(answer.receipt?.outcome).toBe("steered");
  });

  // A transcript row or a marker counts only once the box let the text go (review before the tag): a
  // short text is also a line the agent may write, and a marker does not say which text went in.
  test("OMP, the short text `ok` still in the box while the agent writes the line ` ok`: not steered, typed_not_submitted at the deadline", async () => {
    const after = swapRow(inBox(capture("omp--v18-6-steer-after-now"), "ok"), (plain) => plain === "- name: null", " ok");
    expect(after.split("\n").filter((row) => plainRow(row) === " ok")).toHaveLength(1);
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [after], STEER, undefined, "ok");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "submit_failed", keys: ["probe", "Backspace", "Enter"] });
  });

  test("OMP, the short text `ok`: the line in the transcript and the box empty: steered", async () => {
    const after = without(inBox(capture("omp--v18-6-steer-after"), "ok"), ["Backgrounded early to handle an incoming message"]);
    expect(after.split("\n").filter((row) => plainRow(row).trimEnd() === " ok")).toHaveLength(1);
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [after], STEER, undefined, "ok");
    expect(answer.receipt).toMatchObject({ outcome: "steered", keys: ["probe", "Backspace", "Enter"] });
  });

  test("OMP: the backgrounded tool while the line is still in the box: not steered, typed_not_submitted", async () => {
    const marker = capture("omp--v18-6-steer-after")
      .split("\n")
      .find((row) => plainRow(row).includes("Backgrounded early to handle an incoming message"))!;
    const after = swapRow(capture("omp--v18-6-steer-after-now"), (plain) => plain.includes("⟦Timeout: 60s⟧"), marker);
    expect(after).toContain(LINE);
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [after]);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "submit_failed" });
  });

  test("OMP: the backgrounded tool and the box empty, the transcript row not drawn yet: steered", async () => {
    const after = without(capture("omp--v18-6-steer-after"), [LINE]);
    expect(after).toContain("Backgrounded early to handle an incoming message");
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [after]);
    expect(answer.receipt?.outcome).toBe("steered");
  });

  test("pi: the Steering block counts as drawn, the box check does not apply to a block witness", async () => {
    const typedRows = capture("pi--v130-steer-typed").split("\n");
    const rows = capture("pi--v130-steer-after").split("\n");
    const box = rows.findIndex((row, at) => at > 0 && plainRow(rows[at - 1]!).includes("Working") && plainRow(row).trim() === "");
    expect(box).toBeGreaterThan(0);
    rows[box] = typedRows.find((row) => plainRow(row).startsWith(LINE))!;
    const { answer } = await steerOn("pi", "1.3.0", "pi--v130-steer-typed", [rows.join("\n")]);
    expect(answer.receipt?.outcome).toBe("steered");
  });

  test("the harness's queued row shows instead of the steer witness: sent, queued", async () => {
    const { answer } = await steerOn("pi", "1.3.0", "pi--v130-steer-typed", [capture("pi--v130-queue-after-now"), capture("pi--v130-queue-after")]);
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"] });
  });

  test("the line still in the box after the last read: typed_not_submitted, offered Submit and Discard", async () => {
    const { answer } = await steerOn("omp", "18.6.1", "omp--v18-6-steer-typed", [capture("omp--v18-6-steer-after-now")]);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "submit_failed", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.offers).toEqual(["submit", "discard", "keys"]);
  });

  test("an empty box and no row after the last read: unknown(no_evidence)", async () => {
    const { answer } = await steerOn("pi", "1.3.0", "pi--v130-steer-typed", [capture("pi--v130-steer-after-now")]);
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", keys: ["probe", "Backspace", "Enter"] });
  });

  test("when absent, pi in a turn takes today's path: the queue key, never Enter, sent and queued", async () => {
    const { answer, pane } = await steerOn("pi", "1.3.0", "pi--v130-queue-typed", [capture("pi--v130-queue-after-now"), capture("pi--v130-queue-after")], {});
    // The fake draws no Follow-up row, so the receipt says `sent` alone (live it said `queued` too).
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "alt+Enter"] });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a steer on an idle turn goes as a plain send: the submit key, receipt sent", async () => {
    const r = rig({ pane: new FakePane("codex"), harness: "codex", version: "0.164.0" });
    const answer = await r.send("tidy the parser please", { when: "steer", fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(r.pane.keysSeen).not.toContain("Enter");
  });

  test("Claude has no steer key: steer_unsupported, nothing read past S0 typed", async () => {
    const r = rig();
    r.pane.over = ["✻ Working… (3s · esc to interrupt)"];
    const answer = await r.send("also say hello", { when: "steer", fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "steer_unsupported", keys: [] });
    expect(r.pane.calls).toEqual([]);
  });

  test("an unread version is not trusted with a turn: steer_unsupported", async () => {
    const { answer, pane } = await steerOn("pi", "no version here", "pi--v130-steer-typed", [capture("pi--v130-steer-after")]);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "steer_unsupported", keys: [] });
    expect(pane.calls).toEqual([]);
  });

  test("a command never steers: steer_unsupported before any read", async () => {
    const { answer, pane } = await steerOn("pi", "1.3.0", "pi--v130-steer-typed", [capture("pi--v130-steer-after")], { when: "steer", fromPhone: true, mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "steer_unsupported", keys: [] });
    expect(pane.readsSeen).toBe(0);
  });

  test("a walky talky delivery asking to steer is refused steer_not_allowed, never typed and never held", async () => {
    const holds = new HoldStore(join(dir, "held-walky-steer"), () => 1_000_000);
    const walky = { when: "steer" as const, draftHolds: true, holdUntil: 2_000_000 };
    const { answer, pane } = await steerOn("pi", "1.3.0", "pi--v130-steer-typed", [capture("pi--v130-steer-after")], walky, holds);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "steer_not_allowed", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.readsSeen).toBe(0);
    expect(holds.list()).toEqual([]);
  });

  // The S1-idle fallback (review before the tag): S0 read the turn running, the turn ended while the
  // text went in, so the steer goes as the plain send S0's read put it on. On pi and Codex the key of
  // that path is the profile's queue key, which is also its submit key: read from the profile here.
  for (const [harness, version] of [["pi", "0.87.1"], ["codex", "0.164.0"]] as const) {
    test(`${harness}: the turn ends while the text goes in: the steer presses keys.submit, the profile's queue key, and says sent`, async () => {
      const keys = loadProfiles().get(harness)!.keys;
      expect(keys.queueKey).toBeDefined();
      expect([keys.queueKey]).toEqual([...keys.submit]);
      const pane = harness === "pi" ? new PiPane(keys.queueKey!) : new FakePane("codex");
      if (pane instanceof PiPane) pane.inTurn = true;
      else pane.over = ["• Working (4s • esc to interrupt)"];
      pane.afterInput = (p, what) => {
        if (!what.startsWith("paste:") && !what.startsWith("type:")) return;
        if (what === `paste:${PROBE}` || what === `type:${PROBE}`) return;
        if (p instanceof PiPane) p.inTurn = false;
        else p.over = [];
      };
      const answer = await rig({ pane, harness, version }).send(LINE, { when: "steer", fromPhone: true });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe(keys.submit[0]);
      expect(pane.keysSeen).not.toContain("Enter");
    });
  }

  // Re-read before the key (counsel on the Edge 5 candidate): the read after the steer pause and
  // before the steer key refuses the press when a dialog drew over the typed text. The key would
  // answer the dialog, so no key leaves and the receipt says why.
  for (const [harness, version, typedName, dialog] of [
    ["codex", "0.164.0", "codex--v0164-steer-typed", "codex--v0156-approval-exec-2opt.txt"],
    ["omp", "18.6.1", "omp--v18-6-steer-typed", "omp--v18-4-approval-bash.txt"],
  ] as const) {
    test(`${harness}: an approval dialog draws between the text and the steer key: no key, typed_not_submitted(dialog_open)`, async () => {
      const clock = { now: 1_000_000 };
      const replayed = replay(typedName, [capture(`${typedName.replace("-typed", "-after")}`)], clock);
      const shown = replayed.pane.beforeRead!;
      const approval = readFileSync(join(PANES, dialog), "utf8");
      replayed.pane.beforeRead = async (p, n) => {
        await shown(p, n);
        if (p.box === LINE) p.fixed = approval;
      };
      const made = rig({ pane: replayed.pane, harness, version, clock });
      const answer = await made.send(LINE, STEER);
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "dialog_open" });
      expect(replayed.pane.keysSeen).not.toContain("Enter");
      expect(answer.receipt?.keys).toEqual(["probe", "Backspace"]);
      neverEscape(replayed.pane);
    });
  }

  test("pi: the box is gone on the read before the steer key: no key, typed_not_submitted(unreadable)", async () => {
    const clock = { now: 1_000_000 };
    const replayed = replay("pi--v130-steer-typed", [capture("pi--v130-steer-after")], clock);
    const shown = replayed.pane.beforeRead!;
    replayed.pane.beforeRead = async (p, n) => {
      await shown(p, n);
      if (p.box === LINE) p.fixed = "just some words\non a plain screen\n";
    };
    const answer = await rig({ pane: replayed.pane, harness: "pi", version: "1.3.0", clock }).send(LINE, STEER);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "unreadable", keys: ["probe", "Backspace"] });
    expect(replayed.pane.keysSeen).not.toContain("Enter");
  });

  test("a steer refused at S0 is never held, even with a hold queue", async () => {
    const holds = new HoldStore(join(dir, "held-steer"), () => 1_000_000);
    const r = rig({ holds });
    r.pane.over = ["✻ Working… (3s · esc to interrupt)"];
    const answer = await r.send("also say hello", { when: "steer", fromPhone: true });
    expect(answer.receipt?.outcome).toBe("refused");
    expect(holds.list()).toEqual([]);
  });
});

// omp 18.6.1 and 18.12.6 draw a fuzzy list of up to ten rows under the box for any text that starts with
// `/` (omp-gang tester reports 02 and 04, 2026-10-25). The list is as tall as the screen's rows under the
// box, so the box was not found, the Surface read torn and `/help`, `/mo` and `/nothere` ended
// `typed_not_submitted (modal_cue)` with the generic detail. 18.12.6 also leaves the last list row on
// screen under an emptied box (report 01, case 8a), which held the next plain send.
describe("omp's fuzzy command list under the box (1.24.1)", () => {
  const PANES = join(import.meta.dir, "../../web/src/fixtures/panes");
  const SURFACE = join(import.meta.dir, "../../web/src/fixtures/surface");
  const LIST_NOTICE = "The command list at the box pointed at another command, so Enter was not pressed.";
  const SUBMIT_NOTICE = "The command list at the box points at another command, so Enter was not pressed. Discard the text, or pick the command with the keys.";

  interface SceneOptions {
    /** The list shows only on an untouched empty box: the row omp 18.12.6 leaves under it. */
    readonly stale?: boolean;
    /** The screen once Enter took the typed command. */
    readonly after?: string;
    /** The list draws only from this read of the typed text on (1 is S1's first read): a list omp draws late. */
    readonly lateFrom?: number;
    /** The rows under the box at the nth read of the typed text, in place of the capture's: rows that move. */
    readonly underAt?: (n: number) => readonly string[];
  }

  /**
   * The capture `name` as the pane: its rows over the box row, the box row holding the typed text, and
   * the capture's rows under the box (the list) only while the box starts with `/`. A stale scene draws
   * them on the empty box until the first key and never again. A submit key takes the text out of the box
   * into the transcript, or, with `after`, redraws the screen the command opens.
   */
  const scene = (pane: FakePane, name: string, options: SceneOptions = {}): void => {
    const rows = readFileSync(existsSync(join(PANES, name)) ? join(PANES, name) : join(SURFACE, name), "utf8").split(/\r?\n/u);
    const boxAt = rows.findLastIndex((row) => row.startsWith("╰─"));
    expect(boxAt, name).toBeGreaterThan(0);
    const head = rows.slice(0, boxAt - 1);
    const top = rows[boxAt - 1]!;
    const under = rows.slice(boxAt + 1);
    const boxRow = (text: string): string => `╰─ ${text}`.padEnd(120);
    const above: string[] = [];
    let touched = false;
    let taken: string | null = null;
    pane.collapseOver = 100_000;
    pane.beforeWrite = (p, what) => {
      if ((what === "keys:Enter" || what === "keys:ctrl+q") && p.box !== "") taken = p.box;
    };
    pane.afterInput = (p, what) => {
      touched = true;
      if (taken === null || (what !== "keys:Enter" && what !== "keys:ctrl+q")) return;
      above.push(` ${taken}`, "");
      taken = null;
      p.box = "";
      if (options.after !== undefined) pane.fixed = options.after;
    };
    let typedReads = 0;
    pane.beforeRead = (p) => {
      if (p.fixed === options.after && options.after !== undefined && p.box === "") return;
      if (p.box.startsWith("/")) typedReads++;
      const listed = options.stale === true ? p.box === "" && !touched : p.box.startsWith("/") && typedReads >= (options.lateFrom ?? 0);
      const rowsUnder = options.underAt === undefined ? under : options.underAt(typedReads);
      p.fixed = [...head.slice(above.length), ...above, top, boxRow(p.box), ...(listed ? rowsUnder : [])].join("\n");
    };
  };

  const ompPane = (version: string, name: string, options: SceneOptions = {}, edit?: (profile: Profile) => Profile) => {
    const pane = new FakePane("generic");
    const made = edit === undefined ? rig({ pane, harness: "omp", version }) : rig({ pane, harness: "omp", version, edit });
    scene(pane, name, options);
    return { ...made, pane };
  };

  const CASES = [
    ["18.6.1", "omp--v18-6-1-slash-help-unlisted--w120.txt", "/help"],
    ["18.6.1", "omp--v18-6-1-slash-mo-fuzzy--w120.txt", "/mo"],
    ["18.6.1", "omp--v18-6-1-slash-nothere-fuzzy--w120.txt", "/nothere"],
    ["18.12.6", "omp--v18-12-6-slash-help-unlisted--w120.txt", "/help"],
    ["18.12.6", "omp--v18-12-6-slash-mo-fuzzy--w120.txt", "/mo"],
    ["18.12.6", "omp--v18-12-6-slash-nothere-fuzzy--w120.txt", "/nothere"],
  ] as const;

  for (const [version, name, text] of CASES) {
    test(`${name}: ${text} typed under a ten-row list is left typed with the list notice, no Enter`, async () => {
      const { send, pane, deps } = ompPane(version, name);
      const id = `fuzzy-${version.replaceAll(".", "-")}-${text.slice(1)}`;
      const answer = await send(text, { id, mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue", keys: ["probe", "Backspace"] });
      expect(answer.receipt?.saw).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(answer.offers).toEqual(["submit", "discard", "keys"]);
      expect(deps.store.get(id)?.receipt?.detail).toBe(LIST_NOTICE);
      expect(pane.keysSeen).not.toContain("Enter");
      expect(pane.box).toBe(text);
      neverEscape(pane);
    });

    test(`${name}: with ${text} in the box the pane reads a draft, and Submit is refused while the list points elsewhere`, async () => {
      const looked = ompPane(version, name);
      looked.pane.box = text;
      const prepared = await looked.protocol.handle({ id: `fuzzy-prep-${version.replaceAll(".", "-")}-${text.slice(1)}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
      expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      const { send, pane, deps } = ompPane(version, name);
      pane.box = text;
      const id = `fuzzy-submit-${version.replaceAll(".", "-")}-${text.slice(1)}`;
      const answer = await send(text, { id, mode: "submit" });
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
      expect(deps.store.get(id)?.receipt?.detail).toBe(SUBMIT_NOTICE);
      expect(pane.keysSeen).toEqual([]);
      expect(pane.box).toBe(text);
    });

    test(`${name}: Discard clears the box and a later plain send is not held behind it`, async () => {
      const { send, pane } = ompPane(version, name);
      pane.box = text;
      expect((await send(text, { mode: "discard" })).receipt).toMatchObject({ outcome: "discarded" });
      expect(pane.box).toBe("");
      expect(pane.keysSeen).not.toContain("Enter");
    });
  }

  test("a command whose name is the list's pointed entry still goes out with one Enter (the list is its own)", async () => {
    const { send, pane } = ompPane("18.6.1", "omp--v18-6-1-slash-mo-fuzzy--w120.txt", { after: readFileSync(join(PANES, "omp--v18-6-model-selector-empty--w120.txt"), "utf8") });
    // The capture's list is the fuzzy list of `/mo`, its pointer on `model`: typed in full, the pointer rests on the text.
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    neverEscape(pane);
  });

  // `symbolPreset: ascii` draws the list cursor as `>`, not `❯` (omp-gang 11-geometry, W3). The list was not
  // read as the typed command's own, so `/session` ended `typed_not_submitted (modal_cue)` on both versions.
  for (const [version, name] of [
    ["18.6.1", "omp--v18-6-1-ascii-symbols-session-list--w130.txt"],
    ["18.12.6", "omp--v18-12-6-ascii-symbols-session-list--w130.txt"],
  ] as const) {
    test(`${version}: /session under the ascii symbols' list (cursor >) goes out with one Enter`, async () => {
      const { send, pane } = ompPane(version, name);
      const answer = await send("/session", { id: `ascii-session-${version.replaceAll(".", "-")}`, mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(pane.box).toBe("");
      neverEscape(pane);
    });
  }

  test("18.12.6: the list row left under the emptied box after a cancelled slash command does not hold the next send", async () => {
    const { send, pane } = ompPane("18.12.6", "omp--v18-12-6-stale-list-row-empty-box--w120.txt", { stale: true });
    const prepared = await send("", { mode: "prepare" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const answer = await send("hello there again");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("ctrl+q");
    neverEscape(pane);
  });

  test("the same screen without the profile's staleWhenEmpty holds that send: the rule is what lets it through", async () => {
    const { send } = ompPane("18.12.6", "omp--v18-12-6-stale-list-row-empty-box--w120.txt", { stale: true }, (profile) => {
      const { staleWhenEmpty, ...list } = profile.idle.volatile.below.commandList!;
      void staleWhenEmpty;
      // The popup rules name the stale mark too (their rows are as loose as a list row's), so they go as well.
      const popups = profile.idle.volatile.below.popups!;
      const rules = popups.rules.map((rule) => ({ name: rule.name, text: rule.text, rows: rule.rows }));
      return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, commandList: list, popups: { ...popups, rules } } } } };
    });
    const answer = await send("hello there again");
    expect(answer.receipt?.outcome).not.toBe("sent");
  });

  test("a one-row list under a typed //comment is the box's own popup: left typed with the list notice", async () => {
    const { send, pane, deps } = ompPane("18.12.6", "omp--v18-12-6-slash-comment-loop-row--w120.txt");
    const answer = await send("//comment", { id: "fuzzy-comment-1", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(deps.store.get("fuzzy-comment-1")?.receipt?.detail).toBe(LIST_NOTICE);
    expect(pane.keysSeen).not.toContain("Enter");
  });

  // omp-gang tester 05 (2026-10-25): a text that is only an upload path starts with `/`, so the phone sends it as
  // a command, and omp draws its FILE popup under the box, `❯ name.png`, not a command list. The profile read
  // that row as a command list pointing at another command and the send ended `typed_not_submitted (modal_cue)`
  // with nothing wrong (issue 497, part 5). The profile's `notForText` says a path typed at the end of the box
  // opens no command list. omp 18.12.6's source (pi-tui editor.ts): with the popup open and the typed path
  // equal to the only entry, `selectedSlashArgumentIsAlreadyTyped` is true, so Enter cancels the popup and
  // submits the text (the tester's manual Enter on 18.6.1 submitted it).
  describe("omp's file popup under a path typed in the box", () => {
    const UPLOAD = "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/";
    const PATHS = [
      ["18.6.1", "omp--v18-6-1-path-popup--w120.txt", `${UPLOAD}w2_p1-mvo3m20o-6e1a9e71.png`],
      ["18.12.6", "omp--v18-12-6-path-popup--w120.txt", `${UPLOAD}w2_p1-mvo44h6i-fd050f5a.png`],
    ] as const;

    for (const [version, name, text] of PATHS) {
      test(`${name}: the path as a command goes out with one Enter`, async () => {
        const { send, pane } = ompPane(version, name);
        const answer = await send(text, { id: `path-${version.replaceAll(".", "-")}`, mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("Enter");
        expect(pane.box).toBe("");
        neverEscape(pane);
      });

      test(`${name}: with the path in the box the pane reads a draft and no list, and Submit goes out`, async () => {
        const looked = ompPane(version, name);
        looked.pane.box = text;
        const prepared = await looked.protocol.handle({ id: `path-prep-${version.replaceAll(".", "-")}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
        expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
        const { send, pane } = ompPane(version, name);
        pane.box = text;
        const answer = await send(text, { id: `path-submit-${version.replaceAll(".", "-")}`, mode: "submit" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(pane.box).toBe("");
      });
    }

    test("the same screen without the profile's notForText ends modal_cue, as the tester saw it: the rule is what lets it through", async () => {
      const [version, name, text] = PATHS[1];
      const { send, pane, deps } = ompPane(version, name, {}, (profile) => {
        const { notForText, ...list } = profile.idle.volatile.below.commandList!;
        void notForText;
        return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, commandList: list } } } };
      });
      const answer = await send(text, { id: "path-old-read", mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
      expect(deps.store.get("path-old-read")?.receipt?.detail).toBe(LIST_NOTICE);
      expect(pane.keysSeen).not.toContain("Enter");
    });

    test("a slash command is still a list: /mo under the fuzzy list ends with the list notice", async () => {
      const { send, pane, deps } = ompPane("18.12.6", "omp--v18-12-6-slash-mo-fuzzy--w120.txt");
      const answer = await send("/mo", { id: "path-not-for-mo", mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
      expect(deps.store.get("path-not-for-mo")?.receipt?.detail).toBe(LIST_NOTICE);
      expect(pane.keysSeen).not.toContain("Enter");
    });
  });

  // omp-gang gang three, tester 05 (2026-10-26, W1): on omp 18.6.1 a path-like text sent as a command (`/tmp/x`,
  // `/etc/hosts`, `/bin/sh`, `/exit/now`) draws ONE fuzzy entry under the box, `❯ ↻ loop   Loop: off`, and Enter
  // ran `/loop` ("Loop mode enabled"), receipt `sent`, journal empty, 4 of 4. The profile's `commandList.notForText`
  // says a path-like text opens no command list (the file popup stands there, 97c700c83), so the list was hidden
  // from `listPointsElsewhere`. The rule: `notForText` hides a list from the Surface's reading, never from the check
  // before a command's Enter. omp 18.12.6 draws no list for these texts and they go out. The capture is the tester's
  // own, `mx-18.6.1-path-abs-cmd-typed`, cut to its last 13 rows.
  describe("a path-like command over a pointed list that is no entry of the path (omp-gang three, W1)", () => {
    const LOOP = "omp--v18-6-1-path-like-loop-list--w120.txt";
    const TEXTS = ["/tmp/x", "/etc/hosts", "/bin/sh", "/exit/now"] as const;
    const idOf = (head: string, text: string): string => `${head}${text.replaceAll("/", "-")}`;
    /** The profile with the file popup's `path` rule gone: the popup read no longer stands in the list's way. */
    const withoutPathPopup = (profile: Profile): Profile => {
      const popups = profile.idle.volatile.below.popups!;
      return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, popups: { ...popups, rules: popups.rules.filter((rule) => rule.name !== "path") } } } } };
    };

    for (const text of TEXTS) {
      test(`18.6.1: ${text} as a command is left typed, Enter not pressed, and /loop does not run`, async () => {
        const { send, pane } = ompPane("18.6.1", LOOP);
        const answer = await send(text, { id: idOf("w1-", text), mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue", keys: ["probe", "Backspace"] });
        expect(answer.offers).toEqual(["submit", "discard", "keys"]);
        expect(pane.keysSeen).not.toContain("Enter");
        expect(pane.box).toBe(text);
        neverEscape(pane);
      });

      test(`18.6.1: ${text} with no popup rule to catch it: the pointed list is read, with the list notice and no Enter`, async () => {
        const { send, pane, deps } = ompPane("18.6.1", LOOP, {}, withoutPathPopup);
        const id = idOf("w1-list-", text);
        const answer = await send(text, { id, mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue", keys: ["probe", "Backspace"] });
        expect(answer.offers).toEqual(["submit", "discard", "keys"]);
        expect(deps.store.get(id)?.receipt?.detail).toBe(LIST_NOTICE);
        expect(pane.keysSeen).not.toContain("Enter");
        expect(pane.box).toBe(text);
        neverEscape(pane);
      });

      test(`18.6.1: Submit of ${text} typed in the box is refused while the list points at /loop`, async () => {
        const { send, pane, deps } = ompPane("18.6.1", LOOP, {}, withoutPathPopup);
        pane.box = text;
        const id = idOf("w1-submit-", text);
        const answer = await send(text, { id, mode: "submit" });
        expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
        expect(deps.store.get(id)?.receipt?.detail).toBe(SUBMIT_NOTICE);
        expect(pane.keysSeen).toEqual([]);
        expect(pane.box).toBe(text);
      });

      test(`18.12.6: ${text} draws no list and goes out with one Enter`, async () => {
        const { send, pane } = ompPane("18.12.6", "omp--v18-12-6-path-like-no-list--w120.txt");
        const answer = await send(text, { id: idOf("w1-1812-", text), mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("Enter");
        expect(pane.box).toBe("");
        neverEscape(pane);
      });
    }

    test("18.6.1: a real /loop under its own list (the pointer on loop) still goes out", async () => {
      const { send, pane } = ompPane("18.6.1", LOOP);
      const answer = await send("/loop", { id: "w1-loop-own", mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("Enter");
      expect(pane.box).toBe("");
    });

    test("an upload path under its own file popup row (the pointer on the entry that ends the path) goes out, with or without the path popup rule", async () => {
      const UPLOAD = "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/w2_p1-mvo3m20o-6e1a9e71.png";
      const bare = ompPane("18.6.1", "omp--v18-6-1-path-popup--w120.txt", {}, withoutPathPopup);
      const answer = await bare.send(UPLOAD, { id: "w1-upload-bare", mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("Enter");
      const kept = ompPane("18.6.1", "omp--v18-6-1-path-popup--w120.txt");
      expect((await kept.send(UPLOAD, { id: "w1-upload-kept", mode: "command" })).receipt).toMatchObject({ outcome: "sent" });
    });

    test("a path whose popup row names another file (pointer on x.png under /tmp/y.png) is refused", async () => {
      const { send, pane, deps } = ompPane("18.6.1", "omp--v18-6-1-path-popup--w120.txt", {}, withoutPathPopup);
      const answer = await send("/home/demo/lab1/other-file.png", { id: "w1-upload-other", mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
      expect(deps.store.get("w1-upload-other")?.receipt?.detail).toBe(LIST_NOTICE);
      expect(pane.keysSeen).not.toContain("Enter");
    });

    // The rest of W1 (2026-10-26): under load omp 18.6.1 drew the list AFTER S1's first read (80 ms), and the
    // rule above never saw it. Enter on a command now never goes out on the first read after typing: a harness
    // whose profile declares a command list needs two S1 reads, at least COMMAND_SETTLE_MS apart, that agree
    // on the rows under the box. The cost is `gapsMs.commandSettle`.
    describe("a list drawn after S1's first read", () => {
      /** The S1 reads of a request, from the protocol's row ring. */
      const s1Reads = (deps: SendDeps, id: string): number => deps.ring.of(id).filter((entry) => entry.step === "s1").length;

      for (const text of TEXTS) {
        test(`18.6.1: ${text} with the list drawn on the second read is left typed with the list notice, Enter not pressed`, async () => {
          const { send, pane, deps } = ompPane("18.6.1", LOOP, { lateFrom: 2 }, withoutPathPopup);
          const id = idOf("w1-late-", text);
          const answer = await send(text, { id, mode: "command" });
          expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue", keys: ["probe", "Backspace"] });
          expect(deps.store.get(id)?.receipt?.detail).toBe(LIST_NOTICE);
          expect(pane.keysSeen).not.toContain("Enter");
          expect(pane.box).toBe(text);
          neverEscape(pane);
        });
      }

      test("18.6.1: with the profile as shipped (the file popup rule kept), a late list under /tmp/x still gets no Enter", async () => {
        const { send, pane } = ompPane("18.6.1", LOOP, { lateFrom: 2 });
        const answer = await send("/tmp/x", { id: "w1-late-shipped", mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", keys: ["probe", "Backspace"] });
        expect(pane.keysSeen).not.toContain("Enter");
        expect(pane.box).toBe("/tmp/x");
      });

      test("a late /mo list (18.12.6, ten rows, drawn on the second read) is left typed with the list notice", async () => {
        const { send, pane, deps } = ompPane("18.12.6", "omp--v18-12-6-slash-mo-fuzzy--w120.txt", { lateFrom: 2 });
        const answer = await send("/mo", { id: "w1-late-mo", mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
        expect(deps.store.get("w1-late-mo")?.receipt?.detail).toBe(LIST_NOTICE);
        expect(pane.keysSeen).not.toContain("Enter");
      });

      test("18.12.6: a path-like command that never draws a list goes out, after one more read the settle interval later", async () => {
        const { send, pane, deps } = ompPane("18.12.6", "omp--v18-12-6-path-like-no-list--w120.txt");
        const answer = await send("/tmp/x", { id: "w1-settle-none", mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("Enter");
        expect(s1Reads(deps, "w1-settle-none")).toBe(2);
        expect(answer.receipt?.gapsMs.commandSettle).toBe(COMMAND_SETTLE_MS);
        expect(answer.receipt?.gapsMs.s1).toBe(80);
        expect(pane.box).toBe("");
      });

      test("18.6.1: a real /loop under its own list goes out once two reads agree on the list", async () => {
        const { send, pane, deps } = ompPane("18.6.1", LOOP);
        const answer = await send("/loop", { id: "w1-settle-loop", mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("Enter");
        expect(s1Reads(deps, "w1-settle-loop")).toBe(2);
        expect(answer.receipt?.gapsMs.commandSettle).toBe(COMMAND_SETTLE_MS);
        expect(pane.box).toBe("");
      });

      test("18.6.1: an upload path under its own path popup row still goes out with Enter", async () => {
        const UPLOAD = "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/w2_p1-mvo3m20o-6e1a9e71.png";
        const { send, deps } = ompPane("18.6.1", "omp--v18-6-1-path-popup--w120.txt");
        const answer = await send(UPLOAD, { id: "w1-settle-upload", mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("Enter");
        expect(s1Reads(deps, "w1-settle-upload")).toBe(2);
        expect(answer.receipt?.gapsMs.commandSettle).toBe(COMMAND_SETTLE_MS);
      });

      test("a list whose rows change on every read never gets the Enter: S1's bound ends with the rows notice", async () => {
        const moving = (n: number): readonly string[] => [`❯ ↻ loop        Loop: ${n % 2 === 0 ? "off" : "on"}`];
        const { send, pane, deps } = ompPane("18.6.1", LOOP, { underAt: moving });
        const answer = await send("/loop", { id: "w1-settle-moving", mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed", keys: ["probe", "Backspace"] });
        expect(deps.store.get("w1-settle-moving")?.receipt?.detail).toBe("The rows under the box did not hold still after the command was typed, so Enter was not pressed.");
        expect(s1Reads(deps, "w1-settle-moving")).toBe(BOUNDS.s1.reads);
        expect(pane.keysSeen).not.toContain("Enter");
        expect(pane.box).toBe("/loop");
      });

      test("a plain send on the same pane takes no settle read", async () => {
        const { send, deps } = ompPane("18.6.1", LOOP);
        const answer = await send("look at the loop", { id: "w1-settle-plain" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.gapsMs.commandSettle).toBeUndefined();
        expect(s1Reads(deps, "w1-settle-plain")).toBe(1);
      });
    });
  });
});

// omp-gang gang three, tester 5 (2026-10-26, W2): with the `/model` picker open on omp 18.6.1 a send typed the
// probe into the picker's search field, twice (`🔍 > ⌁⌁`). The picker is a full-screen Models box with a search
// row, `🔍 >`. The rule: an open picker owns the keyboard, so a send types no probe and presses no key, and the
// first tap ends `unconfirmed` as on omp 18.12.6. The picker, drawn, reads as a dialog Collie cannot read (modal
// `unreadable`, no box, a strong cue); Collie's own probe marker in its search field is not a box of probe markers,
// so the deaf-box residue rule (probe-marker.ts) never takes a character out of it. What the replay cannot show: a
// probe typed while omp has not drawn the picker yet (18.6.1 took 6 s and more to open it under load) waits in
// the terminal and lands in the search field when the picker opens; see the 1.24.1 report.
describe("omp's /model picker owns the keyboard: a send types nothing into its search field (omp-gang three, W2)", () => {
  const SURFACE_DIR = join(import.meta.dirname, "../../web/src/fixtures/surface");
  const CAPTURES = [
    ["18.6.1", readFileSync(join(SURFACE_DIR, "omp--v18-6-1-model-picker-search-probe--w120.txt"), "utf8")],
    ["18.12.6", readFileSync(join(SURFACE_DIR, "omp--v18-12-6-model-picker--w120.txt"), "utf8")],
  ] as const;
  /** The picker with `marks` probe characters in its search row, the row's width kept. */
  const withSearch = (screen: string, marks: number): string =>
    screen.replace(/(🔍 >)( ⌁*)( *)/u, (_all, head: string, text: string, pad: string) => {
      const typed = marks === 0 ? "" : ` ${"⌁".repeat(marks)}`;
      return `${head}${typed}${" ".repeat(text.length + pad.length - typed.length)}`;
    });

  for (const [version, capture] of CAPTURES) {
    for (const marks of [0, 1, 2]) {
      for (const mode of ["send", "command"] as const) {
        test(`${version}, ${String(marks)} probe character(s) in the search: a ${mode} is refused unconfirmed, no text and no key reach the pane`, async () => {
          const screen = withSearch(capture, marks);
          expect(screen).toContain("type to search");
          expect(screen.includes(`🔍 > ${"⌁".repeat(marks)}`)).toBe(true);
          const pane = new FakePane("generic");
          pane.fixed = screen;
          const made = rig({ pane, harness: "omp", version });
          const answer = await made.send(mode === "send" ? "hello there" : "/usage", { id: `picker-${version.replaceAll(".", "-")}-${mode}-${String(marks)}`, mode });
          expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
          expect(answer.receipt?.saw).toMatchObject({ turn: "unknown", modal: "unreadable", composer: "unknown" });
          // The deaf-box rule takes Collie's markers out of a BOX that holds nothing else; here no box is found,
          // so not even a Backspace is pressed in the search field.
          expect(pane.calls).toEqual([]);
          expect(pane.keysSeen).toEqual([]);
        });
      }
    }
  }
});

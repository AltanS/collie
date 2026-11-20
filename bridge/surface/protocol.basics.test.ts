// The Send Protocol against the scripted fake multiplexer: part basics. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { muxRefused, type MuxAck } from "../mux/types.ts";
import { type Profile } from "../../web/src/lib/surface/profile.ts";
import { BOUNDS, GENERIC_PROBE, SendProtocol, type SendRequest } from "./protocol.ts";
import { HoldStore } from "./holds.ts";
import { OFFERED, CODEX_WELCOME, CodexPane, DIALOG, FRAMELESS, FakePane, HerdrCodexPane, LIVE_ROW, NO_PROFILE, PROBE, type Rig, SHELL_SCREEN, dir, neverEscape, nextId, rig, shellText, steersWithNoQueueKey, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("a send that goes through", () => {
  test("free box, verified profile: one write, Enter through the gate, sent, with a full receipt", async () => {
    const { pane, send, deps } = rig();
    const answer = await send("please fix the failing test in the parser");
    expect(answer.receipt).toMatchObject({
      outcome: "sent",
      session: "main",
      paneId: "%1",
      paneGeneration: "gen-1",
      harness: "claude",
      version: "2.1.200",
      profileId: "claude",
      profileStatus: "verified",
      textLength: 41,
      keys: ["Enter"],
    });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.receipt?.s0).toMatchObject({ revision: expect.any(Number), hash: expect.any(String) });
    expect(answer.receipt?.s1).not.toBeNull();
    expect(answer.receipt?.s2).not.toBeNull();
    expect(Object.keys(answer.receipt?.gapsMs ?? {}).toSorted()).toEqual(["commit", "probe", "s0", "s1", "s2", "write"]);
    expect(answer.offers).toEqual([]);
    expect(pane.calls).toEqual(["paste:please fix the failing test in the parser"]);
    expect(pane.box).toBe("");
    expect(pane.transcript.at(-1)).toBe("> please fix the failing test in the parser");
    // The receipt is on disk, and the rows are only in memory.
    expect(deps.store.get(answer.receipt!.requestId)?.receipt).toEqual(answer.receipt);
    expect(deps.ring.size).toBeGreaterThan(0);
    neverEscape(pane);
  });

  test("a provisional profile takes the probed path: the probe, Backspace, then the text", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    const answer = await send("hello there, agent");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileStatus: "provisional", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls).toEqual([`type:${PROBE}`, "paste:hello there, agent"]);
  });

  test("a text of one to three characters takes the probed path on a verified profile", async () => {
    const { pane, send } = rig();
    const answer = await send("ok");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls[0]).toBe(`type:${PROBE}`);
  });

  test("a wrapped text is matched with white space and wrapping ignored", async () => {
    const { send } = rig();
    const text = "word ".repeat(30).trim();
    expect((await send(text)).receipt?.outcome).toBe("sent");
  });

  test("multi-line: each line is one write and the line break is the profile's newline key", async () => {
    const { pane, send } = rig();
    const answer = await send("first line\nsecond line\n");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["ctrl+j", "Enter"] });
    expect(pane.calls).toEqual(["paste:first line", "paste:second line"]);
    expect(pane.transcript.at(-1)).toBe("> first line second line");
  });

  test("a long dictation goes as ONE paste where the multiplexer frames it, and the folded row is proven", async () => {
    const { pane, send } = rig({ block: true });
    const lines = Array.from({ length: 190 }, (_, i) => `Строка ${String(i + 1)}: надиктованный текст.`);
    const answer = await send(lines.join("\n"));
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls).toEqual([`block:${lines.join("\n")}`]);
    expect(pane.keysSeen).not.toContain("ctrl+j");
    expect(pane.transcript.at(-1)).toBe("> [Pasted text #1 +189 lines]");
  });

  test("a profile that does not say its harness folds a whole paste keeps the write per line, even where the multiplexer could paste it whole", async () => {
    const { pane, send } = rig({ block: true, edit: (profile) => ({ ...profile, paste: { bracketed: true } }) });
    expect((await send("first line\nsecond line")).receipt).toMatchObject({ outcome: "sent", keys: ["ctrl+j", "Enter"] });
    expect(pane.calls).toEqual(["paste:first line", "paste:second line"]);
  });

  test("Submit and Discard find a box that holds the folded paste", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join("\n");
    const submitted = rig({ block: true });
    submitted.pane.box = "[Pasted text #1 +11 lines]";
    expect((await submitted.send(lines, { mode: "submit" })).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(submitted.pane.transcript.at(-1)).toBe("> [Pasted text #1 +11 lines]");
    const discarded = rig({ block: true });
    discarded.pane.box = "[Pasted text #1 +11 lines]";
    expect((await discarded.send(lines, { mode: "discard" })).receipt?.outcome).toBe("discarded");
    expect(discarded.pane.box).toBe("");
  });

  test("Add to a draft pastes the whole text after it, and the draft then the folded row is proven", async () => {
    const { pane, send } = rig({ block: true });
    pane.box = "draft";
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join("\n");
    expect((await send(lines, { mode: "append", rowsHash: OFFERED })).receipt).toMatchObject({ outcome: "sent" });
    expect(pane.calls.filter((call) => call.startsWith("block:"))).toEqual([`block:${lines}`]);
    expect(pane.transcript.at(-1)).toBe("> draft[Pasted text #1 +11 lines]");
  });

  test("a long dictation into a running turn is one paste and goes in queued", async () => {
    const { pane, send } = rig({ block: true });
    pane.over = [LIVE_ROW];
    const lines = Array.from({ length: 60 }, (_, i) => `dictated line ${String(i)}`).join("\n");
    expect((await send(lines)).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(pane.calls.filter((call) => call.startsWith("block:"))).toEqual([`block:${lines}`]);
    expect(pane.keysSeen).not.toContain("ctrl+j");
  });

  test("the paste is called on the multiplexer, so an adapter method that reads its own this works", async () => {
    const pane = new FakePane("claude");
    // A class method, as HerdrMux's is: torn off its object it would lose `this` (live lab, 2026-10-20).
    class Adapter {
      readonly readGrid = pane.readGrid;
      readonly typeText = pane.typeText;
      constructor(private readonly target: FakePane) {}
      pasteBlock(paneId: string, text: string): Promise<MuxAck> {
        return this.target.pasteBlock(paneId, text);
      }
    }
    const { deps } = rig({ pane });
    const own = new SendProtocol({ ...deps, mux: new Adapter(pane) });
    const answer = await own.handle({ id: nextId(), text: "one\ntwo\nthree\nfour", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.calls).toEqual(["block:one\ntwo\nthree\nfour"]);
  });

  test("one long dictated line goes as one paste too, and a short text lands literally", async () => {
    const { pane, send } = rig({ block: true });
    expect((await send("слово ".repeat(700).trim())).receipt?.outcome).toBe("sent");
    expect((await send("first line\nsecond line")).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls.map((call) => call.split(":")[0])).toEqual(["block", "block"]);
    expect(pane.transcript.at(-1)).toBe("> first line second line");
  });

  test("a folded row that claims another line count is not this text: it ends typed_not_submitted", async () => {
    const pane = new FakePane("claude");
    // The rig takes the port when it is built, so the harness that folds one line too many comes first.
    const original = pane.pasteBlock;
    pane.pasteBlock = (paneId, text) => original(paneId, `${text}\nextra`);
    const { send } = rig({ block: true, pane });
    const answer = await send(Array.from({ length: 10 }, (_, i) => `line ${String(i)}`).join("\n"));
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a short one-line message keeps the write it always had: only a long or multi-line one is one paste", async () => {
    const { pane, send } = rig({ block: true });
    expect((await send("a short message")).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect((await send("x".repeat(800))).receipt?.outcome).toBe("sent");
    expect(pane.calls.map((call) => call.split(":")[0])).toEqual(["paste", "paste"]);
    expect((await send("x".repeat(801))).receipt?.outcome).toBe("sent");
    expect(pane.calls.at(-1)).toBe(`block:${"x".repeat(801)}`);
  });

  test("a text that starts with a slash, a bang or an at keeps the write per line, so the harness reads its lead as typed", async () => {
    for (const text of [`/review ${"x".repeat(900)}`, `!echo ${"x".repeat(900)}`, `@notes.md ${"x".repeat(900)}`, "@notes.md read this\nand this"]) {
      const { pane, send } = rig({ block: true });
      await send(text);
      expect(pane.calls.filter((call) => call.startsWith("block:"))).toEqual([]);
    }
  });

  test("an image path that ends a long dictation is taken off the paste, and its image token then the folded rest is proven", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    const { send } = rig({ block: true, pane, imageFiles: [shot] });
    const text = `${"слово ".repeat(300).trim()} ${shot}`;
    expect((await send(text)).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls).toEqual([`block:${text}`]);
    expect(pane.transcript.at(-1)).toBe("> [Image #1][Pasted text #2]");
  });

  test("an image path on a line of its own is taken off a multi-line paste, and the rest folds with one line break fewer", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    const { send } = rig({ block: true, pane, imageFiles: [shot] });
    const lines = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`);
    expect((await send([...lines.slice(0, 5), shot, ...lines.slice(5)].join("\n"))).receipt?.outcome).toBe("sent");
    expect(pane.transcript.at(-1)).toBe("> [Image #1][Pasted text #2 +9 lines]");
  });

  test("an image the harness took that the protocol did not expect leaves the send typed_not_submitted", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    // The disk check says no file: the protocol expects the path as text, the harness attached it.
    const { send } = rig({ block: true, pane });
    expect((await send(`${"слово ".repeat(300).trim()} ${shot}`)).receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("an image path outside Collie's uploads stays text: the harness takes it, the box does not match, and nothing is submitted", async () => {
    const shot = "/home/me/screenshots/phone-1.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    // The file exists on this disk, but only Collie's own upload shape is taken off the paste.
    const { send } = rig({ block: true, pane, imageFiles: [shot] });
    expect((await send(`${"слово ".repeat(300).trim()} ${shot}`)).receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Submit finds a box that holds the image token and the folded paste", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const { pane, send } = rig({ block: true, imageFiles: [shot] });
    pane.box = "[Image #1][Pasted text #2]";
    expect((await send(`${"слово ".repeat(300).trim()} ${shot}`, { mode: "submit" })).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
  });

  test("Add to a draft with an image: the draft, the image token, then the folded rest", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    pane.box = "draft";
    const { send } = rig({ block: true, pane, imageFiles: [shot] });
    const lines = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`);
    expect((await send([...lines, shot].join("\n"), { mode: "append", rowsHash: OFFERED })).receipt?.outcome).toBe("sent");
    expect(pane.transcript.at(-1)).toBe("> draft[Image #1][Pasted text #2 +9 lines]");
  });

  test("a short multi-line text with an image lands literally after the image token", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    const { send } = rig({ block: true, pane, imageFiles: [shot] });
    expect((await send(`line one\n${shot}\nline three`)).receipt?.outcome).toBe("sent");
    expect(pane.transcript.at(-1)).toBe("> [Image #1]line one line three");
  });

  test("a two-paragraph message that ends its first paragraph with an upload path is sent when Claude Code keeps the path as text (2.1.312, the field case of 2026-10-29)", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    pane.imagesOnlyAlone = true;
    // Three short lines land literally in Claude Code (215 characters in the lab); the fake folds at 120 by default.
    pane.collapseOver = 1000;
    const { send } = rig({ block: true, pane, imageFiles: [shot] });
    const text = `also mobile looks off ${shot}\n\nmenu should be a bottom sheet on the phone`;
    expect((await send(text)).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe(`> ${text.replaceAll("\n", " ")}`);
  });

  test("a long message with an upload path in it folds with every typed line break when Claude Code keeps the path (2.1.312), and is sent", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    pane.imagesOnlyAlone = true;
    const { send } = rig({ block: true, pane, imageFiles: [shot] });
    const lines = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`);
    expect((await send([...lines.slice(0, 5), shot, ...lines.slice(5)].join("\n"))).receipt?.outcome).toBe("sent");
    expect(pane.transcript.at(-1)).toBe("> [Pasted text #1 +10 lines]");
  });

  test("a message that is only an upload path is sent when Claude Code attaches it as [Image #1] (2.1.312, live check 2026-10-30), on tmux and on Herdr", async () => {
    const shot = "/home/me/.local/state/collie/uploads/_0-mvu6nr4p-8ab21b25.png";
    for (const block of [false, true]) {
      const pane = new FakePane("claude");
      pane.imageFiles = [shot];
      pane.imagesOnlyAlone = true;
      const { send } = rig({ block, pane, imageFiles: [shot] });
      expect((await send(shot)).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
      expect(pane.transcript.at(-1)).toBe("> [Image #1]");
      expect(pane.calls).toEqual(block ? [`block:${shot}`] : [`paste:${shot}`]);
    }
  });

  test("a message that is only an upload path is sent when the harness keeps the path as text", async () => {
    const shot = "/home/me/.local/state/collie/uploads/_0-mvu6nr4p-8ab21b25.png";
    for (const block of [false, true]) {
      // The pane attaches nothing; the protocol still knows the file is on disk.
      const { pane, send } = rig({ block, imageFiles: [shot] });
      expect((await send(shot)).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
      expect(pane.transcript.at(-1)).toBe(`> ${shot}`);
    }
  });

  test("a message that is only an upload path stays typed when the box holds anything but the token or the path", async () => {
    const shot = "/home/me/.local/state/collie/uploads/_0-mvu6nr4p-8ab21b25.png";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    // The harness attaches the path and adds a word: neither exact form.
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.box += " x";
    };
    const { send } = rig({ pane, imageFiles: [shot] });
    expect((await send(shot)).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("an upload path that is no file on this disk is compared as text only: an attached token leaves the send typed", async () => {
    const shot = "/home/me/.local/state/collie/uploads/_0-mvu6nr4p-8ab21b25.png";
    const pane = new FakePane("claude");
    pane.imageFiles = [shot];
    const { send } = rig({ pane });
    expect((await send(shot)).receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a short one-line message with an upload path inside is compared as its literal text only", async () => {
    const shot = "/home/me/.local/state/collie/uploads/_0-mvu6nr4p-8ab21b25.png";
    const text = `menu should be centered ${shot}`;
    // 2.1.312 keeps a path among other text as text: sent.
    const kept = rig({ imageFiles: [shot] });
    expect((await kept.send(text)).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    // A box that shows the image form of that text is not what 2.1.312 draws there: no Enter.
    const pane = new FakePane("claude");
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.box = "[Image #1]menu should be centered";
    };
    const { send } = rig({ pane, imageFiles: [shot] });
    expect((await send(text)).receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Discard finds and clears a box that holds the image token and the folded paste", async () => {
    const shot = "/home/me/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const { pane, send } = rig({ block: true, imageFiles: [shot] });
    pane.box = "[Image #1][Pasted text #2 +9 lines]";
    const lines = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`);
    expect((await send([...lines, shot].join("\n"), { mode: "discard" })).receipt?.outcome).toBe("discarded");
    expect(pane.box).toBe("");
  });

  test("control bytes, tabs and paste markers never reach the pane", async () => {
    const { pane, send } = rig();
    await send("a\tb\u001b[201~c\u0007d\u007f");
    expect(pane.calls).toEqual(["paste:a bcd"]);
  });

  test("the collapse form: a long paste the harness folds still matches", async () => {
    const { pane, send } = rig();
    const long = "x".repeat(400);
    const answer = await send(long);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.calls).toEqual([`paste:${long}`]);
    expect(pane.transcript.at(-1)).toBe("> [Pasted text #1]");
  });

  test("bracketed paste off: with no paste call the text is typed", async () => {
    const { pane, send } = rig({ paste: false });
    expect((await send("typed, not pasted")).receipt?.outcome).toBe("sent");
    expect(pane.calls).toEqual(["type:typed, not pasted"]);
  });

  test("a running sign after Enter counts as taken, even with the box still full", async () => {
    const { pane, send } = rig();
    pane.enterSubmits = false;
    pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.over = ["✻ Thinking… (2s · esc to interrupt)"];
    };
    expect((await send("start the long job")).receipt?.outcome).toBe("sent");
  });

  test("a turn that starts while the text goes in stops the send before an Enter that would steer it", async () => {
    // S0 reads idle; the turn's row shows up once the text is in. Where Enter queues, it goes; where
    // Enter steers the turn (Hermes's shape), the text stays in the box and no Enter is pressed.
    const steering = rig({ edit: steersWithNoQueueKey });
    steering.pane.afterInput = (p, what) => {
      if (what.includes("then summarize the changes")) p.over = [LIVE_ROW];
    };
    const answer = await steering.send("then summarize the changes");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(answer.detail).toBe("A turn started while the text was typed, so Enter was not pressed. The text is in the box. Submit it when the turn ends.");
    expect(steering.pane.keysSeen).not.toContain("Enter");
    const queuing = rig();
    queuing.pane.afterInput = (p, what) => {
      if (what.includes("then summarize the changes")) p.over = [LIVE_ROW];
    };
    expect((await queuing.send("then summarize the changes")).receipt?.outcome).toBe("sent");
  });
});

describe("a harness that swallows a too-soon Enter takes the send with its profile settle (#507)", () => {
  // Muse on 1.4.10: the checked send wrote the text and sent Enter ~85 ms later, the box never
  // emptied, and the receipt read unknown/no_evidence with keys [probe, Backspace, Enter]. The fake
  // pane below swallows an Enter within 350 ms of the text write, the way the reply route measured
  // on Muse 1.4.4 (fails at <=50 ms, smallest success 411 ms).
  const swallowRig = (options: { edit?: (profile: Profile) => Profile } = {}) => {
    const clock = { now: 1_000_000 };
    const pane = new FakePane("claude");
    pane.now = () => clock.now;
    pane.swallowEnterWithinMs = 350;
    const rigOptions: Parameters<typeof rig>[0] = { pane, clock, harness: "muse", version: "1.4.5" };
    if (options.edit !== undefined) rigOptions.edit = options.edit;
    return rig(rigOptions);
  };

  test("muse: the settle holds Enter past the swallow window and the send goes through", async () => {
    const { pane, send } = swallowRig();
    const answer = await send("please fix the parser test");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.gapsMs.s1).toBeGreaterThanOrEqual(350);
    expect(pane.box).toBe("");
    neverEscape(pane);
  });

  test("with no settle the same pane swallows Enter: unknown/no_evidence, the text still in the box", async () => {
    const { pane, send } = swallowRig({ edit: (profile) => ({ ...profile, paste: { bracketed: true } }) });
    const answer = await send("please fix the parser test");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.box).toBe("please fix the parser test");
    neverEscape(pane);
  });
});

describe("a command whose own screen draws late (the browser leg, omp /model, 2026-10-25)", () => {
  // The leg's omp case 1 read unknown/no_evidence once: the box held `/model` with its slash list over
  // the screen for the whole S2 bound (final S2 hash equal to S1's), then the model picker opened and
  // the phone showed it. The fake pane keeps the typed command in the box after Enter, and draws the
  // picker (a dialog in the box's place) only `drawMs` after it, on the rig's clock.
  const lateScreen = (drawMs: number | null) => {
    const r = rig();
    let enteredAt: number | null = null;
    r.pane.afterInput = (p, what) => {
      if (what.endsWith("Enter")) {
        enteredAt = r.clock.now;
        p.box = "/model";
      }
    };
    r.pane.beforeRead = (p) => {
      if (enteredAt === null || drawMs === null || r.clock.now - enteredAt < drawMs) return;
      p.box = "";
      p.dialog = DIALOG;
    };
    return r;
  };

  test("a picker that draws after S2's bound but inside the request's is the evidence: sent", async () => {
    const { send } = lateScreen(4000);
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.gapsMs.s2).toBeGreaterThan(BOUNDS.s2.ms);
  });

  test("a command whose box never changes still ends unknown/no_evidence, after the second bound", async () => {
    const { pane, send } = lateScreen(null);
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(pane.box).toBe("/model");
    neverEscape(pane);
  });

  test("a plain send that leaves its text in the box gets no second bound", async () => {
    const r = lateScreen(4000);
    r.pane.afterInput = (p, what) => {
      if (what.endsWith("Enter")) p.box = "please fix the parser test";
    };
    const answer = await r.send("please fix the parser test");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(answer.receipt?.gapsMs.s2 ?? 0).toBeLessThanOrEqual(BOUNDS.s2.ms);
  });
});

describe("a pane with no profile is typed and Entered blind (a bare shell, 2026-10-17 field case)", () => {
  // On v1.22.4 both a send and a command on a plain shell were refused `unconfirmed` with `no-match`:
  // a pane with no profile took the two-tap manual Send. It takes the send the way 1.21.3 did.
  test.each([
    ["send", "claude-danger", ""],
    ["command", "/usr/bin/true", ""],
    ["send", "claude-danger", NO_PROFILE],
    ["command", "!ls", NO_PROFILE],
  ] as const)("%s %p on harness %p: no read, the text, Enter, sent, and the receipt says no-profile", async (mode, text, harness) => {
    const pane = new FakePane("generic");
    pane.fixed = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${SHELL_SCREEN}`), "utf8");
    const { send, deps } = rig({ pane, harness });
    const answer = await send(text, { mode });
    expect(answer.receipt).toMatchObject({ outcome: "sent", harness, profileId: null, profileStatus: null, keys: ["Enter"], s0: { hash: expect.any(String) }, s1: null, s2: null });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.receipt?.saw).toEqual({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-profile" });
    expect(answer.offers).toEqual([]);
    expect(answer.rowsHash).toBeUndefined();
    // One read, for the password-prompt stop only: no second S0 read, no probe, no S1, no S2.
    expect(pane.readsSeen).toBe(1);
    expect(pane.calls).toEqual([`type:${text}`]);
    expect(pane.keysSeen).toEqual(["Enter"]);
    expect(Object.keys(answer.receipt?.gapsMs ?? {}).toSorted()).toEqual(["commit", "s0", "write"]);
    // The receipt is on disk with its saw, and reads back the same.
    expect(deps.store.get(answer.receipt!.requestId)?.receipt).toEqual(answer.receipt);
    neverEscape(pane);
  });

  test("a send on a pane with no profile is never held, even with a hold queue and a screen that will not hold still", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: "", holds });
    r.pane.fixed = shellText();
    r.pane.beforeRead = (p) => {
      p.fixed = `${p.fixed ?? ""}\r\na row that came in`;
    };
    const answer = await r.send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(holds.list()).toEqual([]);
    expect(r.pane.readsSeen).toBe(1);
  });

  // The password-prompt stop (#103, ADR 0017): a prompt that does not echo would swallow the text and
  // Enter would submit it as a password. The phone's own detector reads the last rows first.
  const shellScreen = (lastRow: string): FakePane => {
    const pane = new FakePane("generic");
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${SHELL_SCREEN}`), "utf8").split("\r\n");
    rows[rows.length - 1] = lastRow;
    pane.fixed = rows.join("\r\n");
    return pane;
  };

  test("a shell at a sudo password prompt refuses the send before any key, offers the key pad, and is never held", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const pane = shellScreen("[sudo] password for dev: ");
    const { send } = rig({ pane, harness: "", holds });
    const answer = await send("claude-danger");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", profileId: null, keys: [] });
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.detail).toBe("A password prompt is waiting on the last row. Collie does not type into it from the text box. Use Type to answer it.");
    // The receipt never keeps the prompt's row: it names a user.
    expect(JSON.stringify(answer.receipt)).not.toContain("dev");
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
    expect(holds.list()).toEqual([]);
  });

  test("the same shell at its normal starship prompt is sent", async () => {
    const pane = shellScreen("❯ ");
    const { send } = rig({ pane, harness: "" });
    expect((await send("claude-danger")).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls).toEqual(["type:claude-danger"]);
    expect(pane.keysSeen).toEqual(["Enter"]);
  });

  test("an Enter the multiplexer refuses leaves the text typed, and offers only the key pad: there is no rows hash to bind a Submit to", async () => {
    const r = rig({ mode: "generic", harness: "" });
    r.pane.fixed = shellText();
    r.pane.writeKeys = () => Promise.resolve(muxRefused("no such pane"));
    const answer = await r.send("make test");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "submit_failed", keys: [] });
    expect(answer.receipt?.saw).toMatchObject({ reason: "no-profile" });
    expect(answer.offers).toEqual(["keys"]);
    expect(r.pane.calls).toEqual(["type:make test"]);
  });

  test("a pane that changed program is refused before any key", async () => {
    // The accept files gen-1; the program changed before the text went in.
    let reads = 0;
    const r = rig({ mode: "generic", harness: "", generation: () => (reads++ === 0 ? "gen-1" : "gen-2") });
    const answer = await r.send("make test");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone", keys: [] });
    expect(r.pane.calls).toEqual([]);
  });

  test("multi-line text on a pane with no profile is refused multiline: its newline key is unknown", async () => {
    const { pane, send } = rig({ mode: "generic", harness: NO_PROFILE });
    const answer = await send("a\nb");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "multiline", keys: [] });
    expect(answer.detail).toContain("one line at a time");
    expect(pane.calls).toEqual([]);
  });

  test("prepare on a pane with no profile offers nothing: the next tap is a plain send", async () => {
    const { pane, protocol } = rig({ mode: "generic", harness: "" });
    const prepared = await protocol.handle({ id: "unused-prepare", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "" });
    expect(prepared.offers).toEqual([]);
    expect(pane.calls).toEqual([]);
  });
});

describe("a profile whose frame S0 cannot find", () => {
  test("the screen is unknown(no-match): the first tap is refused unconfirmed with the rows hash", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const answer = await send("hello from the phone");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", profileId: FRAMELESS, keys: [] });
    expect(answer.rowsHash).toMatch(/^[0-9a-f]{14}$/u);
    expect(answer.surface).toMatchObject({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" });
    expect(answer.offers).toEqual(["commit", "keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("prepare reads and hands back the rows hash, and writes nothing", async () => {
    const { pane, protocol } = rig({ mode: "generic" });
    const prepared = await protocol.handle({ id: "unused-prepare", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: FRAMELESS });
    expect(prepared.receipt).toBeUndefined();
    expect(prepared.rowsHash).toMatch(/^[0-9a-f]{14}$/u);
    expect(prepared.offers).toEqual(["commit", "keys"]);
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("the commit with the rows hash takes the probed path and is sent", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const first = await send("hello from the phone");
    const answer = await send("hello from the phone", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    // No profile: never a paste, and the generic probe character.
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:hello from the phone"]);
    expect(pane.transcript.at(-1)).toBe("> hello from the phone");
  });

  test("a status row under the box that changes on submit does not hide the send (live on pi 0.87.1)", async () => {
    const { pane, send } = rig({ mode: "generic" });
    pane.footer = "0.0%/200k (auto)";
    pane.afterInput = (p, what) => {
      if (what.endsWith("Enter")) p.footer = "0.9%/200k (auto)";
    };
    const first = await send("count my tokens");
    const answer = await send("count my tokens", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("a commit whose rows moved since the person looked is refused stale_surface", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const first = await send("hello");
    pane.transcript.push("a new line arrived");
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface" });
    expect(answer.rowsHash).not.toBe(first.rowsHash);
    expect(pane.calls).toEqual([]);
  });

  test("a search field that echoes the probe and narrows its list fails the probe; one Backspace takes the probe out of the field, and no text follows", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const first = await send("hello");
    pane.echo = { field: "", changesList: true };
    pane.list = ["  first match", "  second match"];
    const again = await send("hello", { rowsHash: first.rowsHash! });
    // The rows moved (the field drew): the commit is stale first.
    expect(again.receipt?.reason).toBe("stale_surface");
    const answer = await send("hello", { rowsHash: again.rowsHash! });
    // The narrowed list is not a hint that hid, so the probe fails. Its character stands once, on the
    // row it was put into, so one Backspace removes it; nothing of the text is typed.
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(pane.keysSeen).toEqual(["Backspace"]);
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`]);
    expect(pane.echo?.field).toBe("");
  });

  test("the honest limit: a field with no cue that only echoes takes the probed text, and nothing proves it was taken", async () => {
    const { pane, send } = rig({ mode: "generic" });
    pane.echo = { field: "", changesList: false };
    const first = await send("hello");
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    // With no profile the probe's landing spot IS the box: one new run, Backspace gave it back. The
    // text lands in that field (ARCHITECTURE.md, "Honest limits": it approves nothing), the person had
    // confirmed the rows, and since the field never empties S2 has no evidence: unknown, not sent.
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.echo?.field).toBe("hello");
  });
});

describe("a pane too short to draw its input box (2026-10-30)", () => {
  test("a read of fewer rows than the box takes is refused unconfirmed with the short_pane cause and the rows named; a read of enough rows keeps the plain line", async () => {
    const pane = new FakePane("claude");
    // A Claude Code pane squeezed to two rows by the splits beside it draws only its status rows.
    pane.fixed = ["  [Fable 5.1 (1000K) effort:high thinking] ▓░░░░░░░░░ 18% | $0,00 | 5h:2% 7d:39%", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 4 agents"].join("\n");
    const { send } = rig({ pane });
    const short = await send("do it");
    expect(short.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(short.cause).toBe("short_pane");
    expect(short.offers).toEqual(["commit", "keys"]);
    expect(short.rowsHash).toBeDefined();
    expect(short.detail).toBe(
      "The read holds 2 rows, and the claude input box takes at least 3. The pane may be too short to draw it: zoom or resize it on the desktop, or close the panes beside it in its tab, then send again.",
    );
    expect(pane.calls).toEqual([]);
    // Three rows with no box: enough for the box, so the screen is one Collie cannot read, not a short pane.
    pane.fixed = ["⏺ Done.", "  [Fable 5.1 (1000K) effort:high thinking] ▓░░░░░░░░░ 18% | $0,00 | 5h:2% 7d:39%", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 4 agents"].join("\n");
    const tall = await send("do it");
    expect(tall.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed" });
    expect(tall.cause).toBeUndefined();
    expect(tall.detail).toBe("Collie cannot read this screen. Check the pane, then tap Type here.");
    expect(pane.calls).toEqual([]);
  });
});

describe("a manual send compares less (M56 send drill, 2026-10-16)", () => {
  test("Codex hides its hint row once the box holds a character: the manual Send passes the probe and is sent", async () => {
    const pane = new CodexPane();
    const { send } = rig({ pane, harness: FRAMELESS });
    const first = await send("reply with one word: ok");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", profileId: FRAMELESS, keys: [] });
    // The same words as the phone's catalog line printed above it.
    expect(first.detail).toBe("Collie cannot read this screen. Check the pane, then tap Type here.");
    const answer = await send("reply with one word: ok", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:reply with one word: ok"]);
    expect(pane.transcript.at(-1)).toBe("> reply with one word: ok");
    expect(pane.box).toBe("");
    neverEscape(pane);
  });

  test("a fresh Codex 0.163.0 hides its welcome picture once the box holds a character: the rows above only lost text, so the first message is sent", async () => {
    const pane = new CodexPane();
    pane.transcript = ["", "  >_ OpenAI Codex (v0.163.0)", "     ~/project", "", "", "", "", "", "", "", ""];
    pane.logo = CODEX_WELCOME;
    // The picture comes back when the box is empty again (seen live after the probe's Backspace),
    // and is gone for good once a message went in.
    pane.afterInput = (_p, what) => {
      if (what.endsWith("Enter")) pane.logo = [];
    };
    const { send } = rig({ pane, harness: FRAMELESS });
    const first = await send("reply with one word: hi");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    const answer = await send("reply with one word: hi", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:reply with one word: hi"]);
    expect(pane.transcript.at(-1)).toBe("> reply with one word: hi");
  });

  test("Codex on Herdr: the read is one row shorter once the hint row hides, and the first and second messages are still sent", async () => {
    const pane = new HerdrCodexPane();
    pane.afterInput = (p, what) => {
      if (what.endsWith("Enter") && p instanceof HerdrCodexPane) p.sent.push(p.transcript.at(-1)!.slice(2));
    };
    const { send } = rig({ pane, harness: FRAMELESS });
    for (const text of ["reply with one word: ok", "say ok"]) {
      const look = await send(text);
      expect(look.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      const answer = await send(text, { rowsHash: look.rowsHash! });
      expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(pane.transcript.at(-1)).toBe(`> ${text}`);
    }
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:reply with one word: ok", `type:${GENERIC_PROBE}`, "type:say ok"]);
    neverEscape(pane);
  });

  test("Codex on Herdr: a row under the box that shows other text still fails, though the read got shorter", async () => {
    const pane = new HerdrCodexPane();
    const render = pane.render.bind(pane);
    pane.render = () => (pane.box.length > 1 ? render().replace("  GPT-6-Luna medium", "  ❯ hello-world.ts") : render());
    const { send } = rig({ pane, harness: FRAMELESS });
    const look = await send("hello");
    const answer = await send("hello", { rowsHash: look.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch", keys: ["probe", "Backspace"] });
  });

  test("on the manual path a row above the box that gains text still fails the probe, with no frame and with one", async () => {
    const bare = new CodexPane();
    const noFrame = rig({ pane: bare, harness: FRAMELESS });
    const first = await noFrame.send("hello");
    bare.afterInput = (p, what) => {
      if (what === `type:${GENERIC_PROBE}`) p.transcript[5] = "• ready, and more text";
    };
    expect((await noFrame.send("hello", { rowsHash: first.rowsHash! })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(bare.calls).toEqual([`type:${GENERIC_PROBE}`]);

    const framed = rig();
    framed.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    framed.pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const look = await framed.send("carry on");
    expect(look.surface?.modal).toBe("unreadable");
    framed.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript.splice(2, 0, "a new row of output");
    };
    expect((await framed.send("carry on", { rowsHash: look.rowsHash! })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(framed.pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("on the manual path a framed transcript that only lost a row above the box still goes through", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const look = await send("carry on");
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript[2] = "";
    };
    expect((await send("carry on", { rowsHash: look.rowsHash! })).receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("with no frame, a row under the box that shows other text still fails the probe", async () => {
    const pane = new CodexPane();
    const { send } = rig({ pane, harness: FRAMELESS });
    const first = await send("hello");
    // A row under the box that turns into a list entry is not a hint that hid.
    const render = pane.render.bind(pane);
    pane.render = () => (pane.box === "" ? render() : render().replace("  GPT-6.1-Sol default · ~/project · Reply ready", "  ❯ hello-world.ts"));
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`]);
  });

  test("a manual send on a framed screen lets the rows under the box move, but a changed row above it still fails", async () => {
    const setup = (): Rig => {
      const r = rig();
      r.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
      r.pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
      return r;
    };
    const below = setup();
    below.pane.afterInput = (p, what) => {
      if (what.startsWith("type:") || what.startsWith("paste:")) p.status = [];
      if (what.endsWith("Enter")) p.status = ["  sonnet · project · main"];
    };
    const look = await below.send("carry on");
    expect(look.surface?.modal).toBe("unreadable");
    expect((await below.send("carry on", { rowsHash: look.rowsHash! })).receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });

    const above = setup();
    above.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript[3] = "a transcript row that moved";
    };
    const again = await above.send("carry on");
    const answer = await above.send("carry on", { rowsHash: again.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(above.pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("a profiled pane on a free screen keeps the strict compare where Enter does not queue: a row above the box or a hint under it that changes fails the probe", async () => {
    // On a harness that does not queue, a row above the box must stand still while Collie types.
    // (A harness that queues lets it move: the rows above the box, a sending drill below.)
    const rowAbove = rig({ version: "2.1.999", edit: (profile) => ({ ...profile, keys: { ...profile.keys, enterWhileRunning: "submits" } }) });
    // Rows close over the box are its volatile band; a transcript row above that band must stand still.
    rowAbove.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    rowAbove.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript[0] = "> a different question";
    };
    expect((await rowAbove.send("hello there")).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(rowAbove.pane.calls).toEqual([`type:${PROBE}`]);

    const hintBelow = rig({ version: "2.1.999" });
    hintBelow.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    expect((await hintBelow.send("hello there")).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(hintBelow.pane.calls).toEqual([`type:${PROBE}`]);
  });
});

describe("after a failed probe", () => {
  test("the probe character standing once in the box gets one Backspace through the gate, and the detail says the box is clean again", async () => {
    // A row above the box that shows new text while the probe goes in is text the rows gained:
    // the probe fails, and its character stands in the box.
    const pane = new CodexPane();
    const { send, deps } = rig({ pane, harness: FRAMELESS });
    const first = await send("hello");
    pane.afterInput = (p, what) => {
      if (what === `type:${GENERIC_PROBE}`) p.transcript[7] = "  Worked for 2s • 5:53 AM";
    };
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toBe("The probe character changed more than the box. One Backspace removed the probe character, so the box is clean again.");
    expect(pane.box).toBe("");
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`]);
    expect(pane.keysSeen).toEqual(["Backspace"]);
    // The Backspace went through the gate: it is in the receipt on disk too.
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.keys).toEqual(["probe", "Backspace"]);
    expect(answer.surface?.composer).not.toBe("draft");
  });

  test("a framed box that took the probe and a hint that hid under it: the strict probe fails, one Backspace cleans the box", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toContain("the box is clean again");
    expect(pane.box).toBe("");
  });

  test("a probe character that shows nowhere gets no key, and the detail says one may remain in the box", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.swallow = true;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(answer.detail).toBe(`The probe character did not show in the box. A probe character (${PROBE}) may remain in the box. Check the pane before you type.`);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a probe character that shows twice (one already on screen) gets no key, and the detail says one may remain in the box", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.transcript.push(`an earlier line that shows ${PROBE}`);
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(answer.detail).toContain("may remain in the box");
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe(PROBE);
  });
});

describe("accept", () => {
  test("the same id twice returns the same receipt and sends nothing more", async () => {
    const { pane, protocol } = rig();
    const request: SendRequest = { id: "same-id-0001", text: "only once", mode: "send" };
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = await protocol.handle(request, target);
    const second = await protocol.handle(request, target);
    expect(second.receipt).toEqual(first.receipt);
    expect(second.replayed).toBe(true);
    expect(pane.calls).toEqual(["paste:only once"]);
    expect(pane.keysSeen).toEqual(["Enter"]);
  });

  test("the same id with another text is refused id_reused and the first receipt stays", async () => {
    const { pane, protocol, deps } = rig();
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = await protocol.handle({ id: "same-id-0002", text: "first", mode: "send" }, target);
    const other = await protocol.handle({ id: "same-id-0002", text: "second", mode: "send" }, target);
    expect(other.receipt).toMatchObject({ outcome: "refused", reason: "id_reused" });
    expect(deps.store.get("same-id-0002")?.receipt).toEqual(first.receipt);
    expect(pane.calls).toEqual(["paste:first"]);
  });

  test("a retry of the same id while it runs waits and answers the same receipt", async () => {
    const { protocol } = rig();
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const request: SendRequest = { id: "same-id-0003", text: "in flight", mode: "send" };
    const [a, b] = await Promise.all([protocol.handle(request, target), protocol.handle(request, target)]);
    expect(b.receipt).toEqual(a.receipt);
  });

  test("a leading slash, bang or at is refused reserved_lead with the verb route named, before any read", async () => {
    for (const text of ["/model", "  !ls -la", "@README.md what is this"]) {
      const { pane, send } = rig();
      const answer = await send(text);
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead", s0: null });
      expect(answer.detail).toContain("mode command");
      expect(pane.readsSeen).toBe(0);
      expect(pane.calls).toEqual([]);
    }
  });
});

describe("a command (M56 spec 06)", () => {
  const SLASH_POPUP = ["  /compact     Clear the history but keep a summary", "  /config      Open the settings", "  /cost        Show the cost of this session"];

  test("a slash command goes through as a command: its popup under the box does not hold it", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:/")) p.popup = SLASH_POPUP;
      if (what.endsWith("Enter")) p.popup = null;
    };
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls).toEqual(["paste:/compact"]);
    expect(pane.transcript.at(-1)).toBe("> /compact");
    neverEscape(pane);
  });

  test("an idle command whose box holds only / under the full slash list (claude-lab--popup-slash-all--w82.txt) is sent: its own popup (review L1)", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    const capture = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/claude-lab--popup-slash-all--w82.txt"), "utf8");
    // Before the write the same screen with the box as the fake holds it and the footer under it.
    const top = capture.split("\n").slice(0, 16);
    const at = top.findIndex((row) => row.startsWith("\u276f\u00a0/"));
    const idleScreen = (box: string): string => [...top.slice(0, at), `\u276f\u00a0${box}\r`, ...top.slice(at + 1), "  ? for shortcuts"].join("\n");
    let written = false;
    let entered = false;
    let reads = 0;
    pane.afterInput = (_p, what) => {
      if (what.startsWith("paste:/") || what.startsWith("type:/")) written = true;
      if (what.endsWith("Enter")) entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) {
        p.fixed = idleScreen("");
        return;
      }
      if (!written) {
        p.fixed = idleScreen(p.box);
        return;
      }
      // The first read after the write finds the box at `/` with every command listed, then the whole command.
      reads += 1;
      p.fixed = reads === 1 ? capture : capture.replace("\u276f\u00a0/\r", "\u276f\u00a0/add-dir\r");
    };
    const answer = await send("/add-dir", { mode: "command" });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(reads).toBeGreaterThan(0);
    neverEscape(pane);
  });

  test("the same text as a plain send is still refused reserved_lead, before any read", async () => {
    const { pane, send } = rig();
    expect((await send("/compact")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead" });
    expect(pane.readsSeen).toBe(0);
  });

  test("the path of a saved upload is no command: a plain send of it is not refused reserved_lead", async () => {
    const { send } = rig();
    const path = "/home/me/.local/state/collie/uploads/w7C_pF-mvtrpn7j-e4f81595.png";
    expect((await send(path)).receipt?.reason).not.toBe("reserved_lead");
    expect((await send(`${path} what is wrong here?`)).receipt?.reason).not.toBe("reserved_lead");
    expect((await send("/usr")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead" });
  });

  test("a shell line whose bang turns into the prompt glyph matches the box without its lead", async () => {
    const { pane, send } = rig();
    pane.bangPrompt = true;
    const answer = await send("!ls -la", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
  });

  test("a shell line in the send drill's shape (a6): the box reads `! echo ok` and the row under it `! for shell mode`; sent, then Submit of the same text holds too", async () => {
    // The rows of /tmp/send-drill/shots/a6-claude-bang.png, also read live in the M56 lab on Claude
    // 2.1.301: the bang turns into the prompt glyph with a space after it, the status row turns into
    // the shell-mode hint.
    const shellMode = (p: FakePane, what: string): void => {
      if (p.box.startsWith("!")) p.status = ["  ! for shell mode"];
      if (what.endsWith("Enter")) p.status = ["  sonnet · project · main"];
    };
    // Provisional, as in the drill: the command is probed first.
    const sent = rig({ version: "2.1.999" });
    sent.pane.bangPrompt = true;
    sent.pane.afterInput = shellMode;
    const answer = await sent.send("!echo ok", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(sent.pane.transcript.at(-1)).toBe("> !echo ok");

    // Submit after a typed_not_submitted names the text with its lead; the box shows it without.
    const held = rig();
    held.pane.bangPrompt = true;
    held.pane.afterInput = shellMode;
    held.pane.box = "!echo ok";
    held.pane.status = ["  ! for shell mode"];
    const submit = await held.send("!echo ok", { mode: "submit" });
    expect(submit.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(held.pane.box).toBe("");
  });

  test("a command whose box shows a mode marker in front of the text is matched without its lead", async () => {
    const { pane, send } = rig();
    const render = pane.render.bind(pane);
    pane.render = () => render().replace("❯ !echo ok", "❯ $ echo ok");
    const answer = await send("!echo ok", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  test("a command that opens its own screen after Enter is taken: the box went away", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.endsWith("Enter")) p.dialog = DIALOG;
    };
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  test("a command into a busy screen is refused like a send: nothing typed", async () => {
    const { pane, send } = rig();
    pane.dialog = DIALOG;
    expect((await send("/compact", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(pane.calls).toEqual([]);
  });

  test("a framed screen with a strong cue above the box takes the manual Send: unconfirmed, then probed and sent", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const first = await send("carry on with the plan");
    expect(first.surface?.modal).toBe("unreadable");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    const commit = await send("carry on with the plan", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.transcript.at(-1)).toBe("> carry on with the plan");
  });

  test("a transcript that moves under a command still holds the Enter", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.transcript[0] = "> a different question";
    };
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });
});

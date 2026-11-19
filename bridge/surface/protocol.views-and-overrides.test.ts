// The Send Protocol against the scripted fake multiplexer: part views-and-overrides. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { muxUnconfirmed, type MuxAck } from "../mux/types.ts";
import { type Profile } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { BOUNDS, LEFT_TYPED_MS, VIEW_AT_DRAFT, VIEW_AT_QUESTION, VIEW_NO_PROFILE, GENERIC_PROBE, SendProtocol, type SendLedger, type SendRequest } from "./protocol.ts";
import { HEAD_CASES, NOT_HEAD_CASES } from "../agent-view/testdata/head-cases.ts";
import { AgentViewService } from "../agent-view/service.ts";
import { AgentViewStore } from "../agent-view/store.ts";
import { viewHelpWithRules, viewRulesIdOf } from "../../cli/trick-view-help.ts";
import { type JsonValue } from "../json.ts";
import { SurfaceLedger } from "./counters.ts";
import { HoldStore } from "./holds.ts";
import { AuditLog } from "../audit.ts";
import { sendRoute, type SendRouteRuntime } from "../server.ts";
import { CodexPane, DIALOG, FRAMELESS, FakePane, LIVE_ROW, NO_PROFILE, PROBE, type Rig, SHELL_SCREEN, dir, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

// ── Agent views at the Send Protocol (agent views SECURITY rules 5, 6 and 7) ──
// The protocol is the one chokepoint every door that types into a pane passes: the phone's composer, a
// steer, a held send, a crew-forwarded send (it reaches the member's own `POST /api/send`), and every
// caller of the bridge's own. Only a request the agent view route built (`view.head` true) may carry a head.
describe("agent views at the Send Protocol", () => {
  const HEAD = "[view:morph local/%1#aaaa] from operator:";
  const typedNothing = (pane: FakePane): void => {
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe("");
  };

  test.each(HEAD_CASES.map((c) => [c.name, c.text] as const))("rule 7 (composer door, shared case table): a phone send with a head is refused bad_head, and nothing is typed: %s", async (_name, text) => {
    const { pane, send } = rig();
    const answer = await send(text, { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bad_head" });
    typedNothing(pane);
  });

  test.each(NOT_HEAD_CASES.filter((c) => !c.text.includes("\u001b")).map((c) => [c.name, c.text] as const))("rule 7 (composer door, shared case table): a phone send with no head is not refused bad_head: %s", async (_name, text) => {
    const { send } = rig();
    expect((await send(text, { fromPhone: true })).receipt?.reason).not.toBe("bad_head");
  });

  test("rule 7: a head on a later line is refused too; `[view:` in the middle of a line is text, but not with `] from operator:` after it", async () => {
    const { pane, send } = rig();
    expect((await send(`first line\n${HEAD} go`, { fromPhone: true })).receipt).toMatchObject({ outcome: "refused", reason: "bad_head" });
    typedNothing(pane);
    const plain = rig();
    expect((await plain.send("see the [view:x] note in my text", { fromPhone: true })).receipt?.outcome).toBe("sent");
    const marked = rig();
    expect((await marked.send(`see the head ${HEAD} in my note`, { fromPhone: true })).receipt).toMatchObject({ outcome: "refused", reason: "bad_head" });
    typedNothing(marked.pane);
  });

  test.each(HEAD_CASES.map((c) => [c.name, c.text] as const))("rule 7 (steer door, shared case table): a steer with a head is refused bad_head, and nothing is typed: %s", async (_name, text) => {
    const { pane, send } = rig();
    pane.over = ["✻ Thinking… (12s · esc to interrupt)"];
    const answer = await send(text, { when: "steer", fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bad_head" });
    typedNothing(pane);
  });

  test.each(HEAD_CASES.map((c) => [c.name, c.text] as const))("rule 7 (hook and bridge door, shared case table): a send not from the phone, in every mode, is refused bad_head: %s", async (_name, text) => {
    for (const mode of ["send", "command", "append", "replace"] as const) {
      const { pane, send } = rig();
      const answer = await send(text, { mode });
      expect(answer.receipt, mode).toMatchObject({ outcome: "refused", reason: "bad_head" });
      typedNothing(pane);
    }
  });

  test("rule 2: the view route's own request types its head line on a free session", async () => {
    const { pane, send } = rig();
    const answer = await send(`${HEAD} tapped "Fix"`, { view: { head: true, check: () => null } });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.transcript.at(-1)).toBe(`> ${HEAD} tapped "Fix"`);
  });

  test("rule 5: a view send is refused while a dialog shows, and nothing is typed", async () => {
    const { pane, send } = rig();
    pane.dialog = DIALOG;
    const answer = await send(`${HEAD} tapped "Yes"`, { view: { head: true, check: () => null } });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("lead addition 4: a view send while a turn runs is refused busy: nothing is typed, held or steered", async () => {
    const holds = new HoldStore(join(dir, "holds"), () => 1_000_000);
    const { pane, send } = rig({ holds });
    pane.over = ["✻ Thinking… (12s · esc to interrupt)"];
    const answer = await send(`${HEAD} tapped "Fix"`, { id: "view-busy-0001", view: { head: true, check: () => null } });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    expect(pane.keysSeen).toEqual([]);
    expect(holds.get("view-busy-0001")).toBeNull();
    // A view send asking to steer is no steer either: the turn rule refuses it first.
    const steer = await send(`${HEAD} tapped "Fix"`, { id: "view-busy-0002", when: "steer", fromPhone: true, view: { head: true, check: () => null } });
    expect(steer.receipt?.outcome).toBe("refused");
    expect(pane.keysSeen).toEqual([]);
  });

  test("rule 6: the check under the pane lock refuses stale_view when the screen moved after the tap, and nothing is typed", async () => {
    const { pane, send } = rig();
    let checked = 0;
    const answer = await send(`${HEAD} tapped "Fix"`, {
      view: {
        head: true,
        check: () => {
          checked++;
          return "this screen changed";
        },
      },
    });
    expect(checked).toBe(1);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "stale_view" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("lead addition 2: a typed send that goes plain (head false) is the person's own send, and passes", async () => {
    const { send } = rig();
    const answer = await send("yes, go on", { fromPhone: true, view: { head: false, check: () => null } });
    expect(answer.receipt?.outcome).toBe("sent");
  });
});

// Review 9 M1: a pane with no profile is typed blind, with no S0 rule; a send with a view's head never goes there.
describe("review 9 M1: a view send to a pane with no profile", () => {
  const HEAD = "[view:morph local/%1#aaaa] from operator:";
  test("rule 5: a view send with a head is refused on a pane with no profile, at a dialog, in a turn and when free, and nothing is typed", async () => {
    for (const setup of ["dialog", "turn", "free"] as const) {
      const pane = new FakePane("claude");
      if (setup === "dialog") pane.dialog = DIALOG;
      if (setup === "turn") pane.over = ["✻ Thinking… (12s · esc to interrupt)"];
      const { send } = rig({ pane, harness: NO_PROFILE });
      const answer = await send(`${HEAD} tapped "Yes"`, { view: { head: true, check: () => null } });
      expect(answer.receipt, setup).toMatchObject({ outcome: "refused", reason: "not_free", detail: VIEW_NO_PROFILE });
      expect(pane.keysSeen, setup).toEqual([]);
      expect(pane.calls, setup).toEqual([]);
    }
  });

  test("the person's own plain send from the view still goes to a pane with no profile, as any send does", async () => {
    const pane = new FakePane("generic");
    pane.fixed = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${SHELL_SCREEN}`), "utf8");
    const { send } = rig({ pane, harness: NO_PROFILE });
    const answer = await send("ls", { fromPhone: true, view: { head: false, check: () => null } });
    expect(answer.receipt?.outcome).toBe("sent");
  });
});

// Review 9 R4: the view's check runs under the lock AND again right before the first key, after S0's reads.
describe("review 9 R4: a view send's check right before the write", () => {
  const HEAD = "[view:morph local/%1#aaaa] from operator:";
  test("rule 6: a screen redrawn while S0 read the pane is caught right before the first key: refused stale_view, nothing typed", async () => {
    const { pane, send } = rig();
    let calls = 0;
    const check = (): string | null => (++calls === 1 ? null : "this screen changed");
    const answer = await send(`${HEAD} tapped "Yes"`, { view: { head: true, check } });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "stale_view" });
    expect(answer.detail).toBe("this screen changed");
    expect(calls).toBe(2);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe("");
  });
});

// Review 9 R7 (rule 4): a view send whose keys landed but did not end `sent` keeps its line with its outcome.
describe("review 9 R7: a view send that typed but did not submit", () => {
  const SESSION = "local/%1#aaaa";
  const VIEW_SCREEN: JsonValue[] = [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Revert", intent: "reply" } }] }];
  const viewService = (): AgentViewService =>
    new AgentViewService({
      store: new AgentViewStore(null, () => 1),
      place: (address) => (address === SESSION ? { address } : null),
      sessionsKnown: () => true,
      crewMode: () => "solo",
      binary: "/home/op/apps/collie/bin/collie",
      gate: { check: () => ({ ok: true, name: "Morph", rules: "Draw.\n" }), fresh: async () => ({ ok: true, name: "Morph", rules: "Draw.\n" }) },
      rulesIdOf: viewRulesIdOf,
      helpOf: viewHelpWithRules,
    });

  test("rule 4: the route answers the outcome with the line, the view keeps the line with that outcome, and the screen takes no second tap", async () => {
    const pane = new FakePane("claude");
    // The harness changes what was typed, so S1 cannot prove the box: the keys landed, Enter never went.
    const original = pane.typeText;
    pane.typeText = (paneId, text) => original(paneId, `${text}!`);
    const { protocol } = rig({ pane, paste: false });
    const service = viewService();
    expect((await service.switch({ trick: "morph", session: SESSION, on: true }, "Pixel 9")).ok).toBe(true);
    const shown = await service.show("morph", SESSION, { view: VIEW_SCREEN, title: null });
    if (!shown.ok) throw new Error(shown.error);
    const rev = shown.session.view!.rev;
    const rt: SendRouteRuntime = { send: protocol, name: "main", herdr: {}, engine: { current: () => ({ agents: [{ paneId: "%1", agent: "claude" }], shellPanes: [] }), noteInput: () => undefined, pokeNow: () => undefined } };
    const context = { audit: new AuditLog(async () => undefined), device: "Pixel 9", redact: false, acceptEncoding: null, view: { service, addressOf: () => SESSION } };
    const res = await sendRoute(rt, { id: "view-r7-000001", pane: "%1", view: { trick: "morph", session: SESSION, rev, control: "v/0/0" } }, context);
    const body = await res.json();
    expect(body.receipt.outcome).toBe("typed_not_submitted");
    expect(body.view).toEqual({ line: expect.stringContaining('tapped "Revert"'), outcome: "typed_not_submitted" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(service.status("morph", SESSION).sent).toEqual([{ rid: "view-r7-000001", at: expect.any(String), kind: "tap", line: body.view.line, outcome: "typed_not_submitted" }]);
    const again = await sendRoute(rt, { id: "view-r7-000002", pane: "%1", view: { trick: "morph", session: SESSION, rev, control: "v/0/0" } }, context);
    expect(again.status).toBe(409);
  });
});

// Review 9, rule 5 tests that drive the path they name: an answer box on omp and Hermes, a draft in the box.
describe("review 9 rule 5: a view send never answers and never joins a draft", () => {
  const HEAD = "[view:morph local/%1#aaaa] from operator:";
  const capture = (name: string): string => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8");
  const view = { head: true, check: (): string | null => null };

  test.each([
    ["omp", "18.6.1", "omp--answer-editor-empty.txt"],
    ["omp", "18.6.1", "omp--answer-editor-typed.txt"],
    ["hermes", "0.22.2", "hermes--clarify-other.txt"],
  ] as const)("rule 5: on %s %s at an answer box (%s), a view send is refused not_free and nothing is typed", async (harness, version, screen) => {
    const r = rig({ harness, version });
    r.pane.fixed = capture(screen);
    const answer = await r.send(`${HEAD} tapped "Yes"`, { view });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(answer.detail).toBe(VIEW_AT_QUESTION);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("rule 5: with the person's draft in the box, a view send is refused before any key, and the draft stays as it was", async () => {
    const { pane, send } = rig();
    pane.box = "my half-written note";
    const answer = await send(`${HEAD} tapped "Yes"`, { view });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(answer.detail).toBe(VIEW_AT_DRAFT);
    expect(pane.box).toBe("my half-written note");
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("the agents panel under the box is chrome: its rows come and go on their own (2026-11-13)", () => {
  /** The field screen's rows under the box (Claude Code 2.1.323, field case): two statusline rows, the mode row, a blank row, the agents panel. */
  const STATUS = ["  CTX:19% CACHE:100% LIMITS 7d:0%/4d:07h", "  [Fable·xhigh] ~/projects/sample on main*", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 11 agents"];
  const MAIN = "  ● main";
  const agent = (task: string): string => `  ◯ general-purpose  ${task}                    1m 3s · ↓ 88.8k tokens`;
  const panel = (...tasks: string[]): string[] => [...STATUS, "", MAIN, ...tasks.map(agent)];
  const TEXT_IN = "decision 1 is good";

  test("field repro: a background agent resumes as the text goes in, in a running turn: sent (was typed_not_submitted, changed)", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.over = [LIVE_ROW];
    pane.status = panel("Waiting on the gate result");
    pane.afterInput = (p, what) => {
      if (what.includes(TEXT_IN)) p.status = panel("Waiting on the gate result", "Resumed: card sentence");
    };
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.box).toBe("");
  });

  test("an agent ends, the panel goes, or the panel first appears while the text goes in, idle or running: sent", async () => {
    const cases: [string[], string[]][] = [
      [panel("one", "two"), panel("one")],
      [panel("one"), STATUS],
      [STATUS, panel("one")],
    ];
    for (const [before, after] of cases) {
      for (const over of [[], [LIVE_ROW]]) {
        const { pane, send } = rig({ version: "2.1.302" });
        pane.over = over;
        pane.status = before;
        pane.afterInput = (p, what) => {
          if (what.includes(TEXT_IN)) p.status = after;
        };
        const answer = await send(TEXT_IN);
        expect(answer.receipt, `${String(before.length)}→${String(after.length)} ${String(over.length)}`).toMatchObject({ outcome: "sent" });
      }
    }
  });

  test("without the profile's chrome mark the same redraw stops as before: the mark is the only excuse", async () => {
    const unmarked = (profile: Profile): Profile => ({
      ...profile,
      idle: {
        ...profile.idle,
        volatile: {
          ...profile.idle.volatile,
          below: { ...profile.idle.volatile.below, footerRows: (profile.idle.volatile.below.footerRows ?? []).map(({ name, pattern }) => ({ name, pattern })) },
        },
      },
    });
    const { pane, send } = rig({ version: "2.1.302", edit: unmarked });
    pane.over = [LIVE_ROW];
    pane.status = panel("one");
    pane.afterInput = (p, what) => {
      if (what.includes(TEXT_IN)) p.status = panel("one", "two");
    };
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a dialog drawn under the box in the panel's place as the text goes in: no Enter", async () => {
    for (const over of [[], [LIVE_ROW]]) {
      const { pane, send } = rig({ version: "2.1.302" });
      pane.over = over;
      pane.status = panel("one");
      pane.afterInput = (p, what) => {
        if (what.includes(TEXT_IN)) p.status = [...STATUS, "", ...DIALOG];
      };
      const answer = await send(TEXT_IN);
      expect(answer.receipt?.outcome, String(over.length)).toBe("typed_not_submitted");
      expect(pane.keysSeen, String(over.length)).not.toContain("Enter");
      expect(pane.box).toBe(TEXT_IN);
    }
  });

  test("an agent row that only looks like one, outside an accepted panel (no blank row, no main row): it still counts, no Enter", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.over = [LIVE_ROW];
    pane.status = panel("one");
    pane.afterInput = (p, what) => {
      // Straight under the statusline, with no blank row and no main row over it: no named run.
      if (what.includes(TEXT_IN)) p.status = [...STATUS, agent("two"), "", MAIN, agent("one")];
    };
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("the panel moves and the box holds one character less than was typed: no Enter (mismatch)", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.over = [LIVE_ROW];
    pane.status = panel("one");
    pane.dropLastChar = true;
    pane.afterInput = (p, what) => {
      if (what.includes(TEXT_IN.slice(0, -1))) p.status = panel("one", "two");
    };
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("the panel moves and the frame with the text goes: no Enter (changed)", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.over = [LIVE_ROW];
    pane.status = panel("one");
    pane.afterInput = (p, what) => {
      if (what.includes(TEXT_IN)) p.fixed = ["", "  Your conversation moved to the background.", "", "  Nothing is selected."].join("\n");
    };
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

describe("the same text again onto the box an earlier send left it in: Enter only, nothing typed (2026-11-13)", () => {
  const TEXT_IN = "decision 1 is good";
  const SCREEN_GONE = ["", "  Your conversation moved to the background.", "", "  Nothing is selected."].join("\n");

  /** A rig whose first send ends typed_not_submitted with the text in the box: the screen goes for every S1 read, then comes back. */
  async function leftTyped(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
    const r = rig({ version: "2.1.302", ...options });
    let gone = false;
    r.pane.afterInput = (_pane, what) => {
      if (what.includes(TEXT_IN)) gone = true;
    };
    r.pane.beforeRead = (p) => {
      p.fixed = gone ? SCREEN_GONE : null;
    };
    const first = await r.send(TEXT_IN);
    expect(first.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(r.pane.box).toBe(TEXT_IN);
    gone = false;
    r.pane.afterInput = null;
    r.pane.beforeRead = null;
    r.pane.fixed = null;
    r.pane.calls = [];
    r.pane.keysSeen = [];
    return r;
  }

  test("the retry submits it: sent, only Enter pressed, nothing typed, and the receipt says why", async () => {
    const { pane, send } = await leftTyped();
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(answer.receipt?.detail).toBe("The box already held this text, typed by an earlier send, so only the submit key was pressed.");
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual(["Enter"]);
    expect(pane.box).toBe("");
  });

  // M100 spec 03: a text write the multiplexer did not confirm and that did not show in its wait ends
  // `unknown`. If it lands later and the person confirms "Send it again?", the box holds exactly this
  // text: the resend takes this same path (Enter only), and the text is never in the box twice.
  test("a write that was not confirmed, did not show, and landed later: the resend presses only Enter", async () => {
    const r = rig({ version: "2.1.302" });
    const writes = r.deps.mux;
    const land = writes.pasteText ?? writes.typeText;
    let lose = true;
    const losing = (paneId: string, text: string): Promise<MuxAck> => {
      if (lose && text.includes(TEXT_IN)) {
        lose = false;
        return Promise.resolve(muxUnconfirmed("Herdr did not confirm the text written to %1 in time (herdr pane.send_text: timed out after 5000ms). It may still arrive, so it was not written again."));
      }
      return land(paneId, text);
    };
    writes.typeText = losing;
    if (writes.pasteText !== undefined) writes.pasteText = losing;
    const first = await r.send(TEXT_IN);
    expect(first.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(r.pane.box).toBe("");
    // The text lands after Collie stopped looking.
    await land("%1", TEXT_IN);
    expect(r.pane.box).toBe(TEXT_IN);
    r.pane.calls = [];
    r.pane.keysSeen = [];
    const again = await r.send(TEXT_IN);
    expect(again.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual(["Enter"]);
    expect(r.pane.box).toBe("");
  });

  test("the retry in a running turn queues it the same way: sent and queued, only Enter", async () => {
    const { pane, send } = await leftTyped();
    pane.over = [LIVE_ROW];
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls).toEqual([]);
  });

  test("a person's own draft of the same words, never typed by a send: refused draft_present, no Enter", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.box = TEXT_IN;
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(TEXT_IN);
  });

  test("the left text edited in the terminal by one character: refused draft_present, no Enter", async () => {
    const { pane, send } = await leftTyped();
    pane.box = `${TEXT_IN}!`;
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(`${TEXT_IN}!`);
  });

  test("another text onto the left text: refused draft_present, as before", async () => {
    const { pane, send } = await leftTyped();
    const answer = await send("something else");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(TEXT_IN);
  });

  test("a dialog over the left text: no Enter", async () => {
    const { pane, send } = await leftTyped();
    pane.dialog = DIALOG;
    const answer = await send(TEXT_IN);
    expect(answer.receipt?.outcome).toBe("refused");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a new pane generation (another program in the pane): the left text is no longer the send's, refused draft_present", async () => {
    let generation = "gen-1";
    const { pane, send } = await leftTyped({ generation: () => generation });
    generation = "gen-2";
    const answer = await send(TEXT_IN);
    expect(answer.receipt?.outcome).toBe("refused");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("after the time limit: refused draft_present, as before", async () => {
    const { pane, send, clock } = await leftTyped();
    clock.now += LEFT_TYPED_MS + 1;
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a WalkyTalky message (draftHolds) of the same text is not finished: it is never typed onto the box", async () => {
    const { pane, send } = await leftTyped();
    const answer = await send(TEXT_IN, { draftHolds: true });
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(TEXT_IN);
  });

  test("after a bridge restart the request files say the text was the send's: the retry submits it, nothing typed", async () => {
    const storeDir = join(dir, "kept-sends");
    const clock = { now: 1_000_000 };
    const before = await leftTyped({ storeDir, clock });
    // A new protocol over the same files: nothing in memory, the same pane, box and generation.
    const after = rig({ version: "2.1.302", storeDir, clock, pane: before.pane });
    const answer = await after.send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(before.pane.calls).toEqual([]);
  });

  test("after a crash mid-send (unknown, crash, no submit key yet) the request files still prove it: the retry submits it", async () => {
    const storeDir = join(dir, "crashed-sends");
    const clock = { now: 1_000_000 };
    const first = rig({ version: "2.1.302", storeDir, clock });
    // The bridge died after the text went in: the record is accepted and never settled.
    first.deps.store.accept({ id: "crash-000001", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: TEXT_IN });
    first.deps.store.recover(SendProtocol.crashReceipt);
    first.pane.box = TEXT_IN;
    const answer = await first.send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(first.pane.calls).toEqual([]);
  });

  test("after a crash once the submit key had gone out, the request files prove nothing: refused draft_present", async () => {
    const storeDir = join(dir, "crashed-late");
    const first = rig({ version: "2.1.302", storeDir });
    first.deps.store.accept({ id: "crash-000002", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: TEXT_IN });
    first.deps.store.markSubmitSent("crash-000002");
    first.deps.store.recover(SendProtocol.crashReceipt);
    first.pane.box = TEXT_IN;
    const answer = await first.send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(first.pane.keysSeen).not.toContain("Enter");
  });

  test("once the left text was sent by Submit, the same words typed again by a person are a draft again", async () => {
    const { pane, send } = await leftTyped();
    const submitted = await send(TEXT_IN, { mode: "submit" });
    expect(submitted.receipt?.outcome).toBe("sent");
    pane.box = TEXT_IN;
    pane.keysSeen = [];
    const answer = await send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

describe("a WalkyTalky message left typed takes its own text back out of the person's box (2026-11-13)", () => {
  const MAIL = "[walky-talky wt_0001] from sample: please rebase";
  const GONE = ["", "  Your conversation moved to the background.", "", "  Nothing is selected."].join("\n");

  /** A send whose S1 never passes (the screen goes for S1's reads), then the box comes back holding the text. */
  function stopsAtS1(pane: FakePane, back: (p: FakePane) => void): void {
    let typed = false;
    let s1Reads = 0;
    pane.afterInput = (_pane, what) => {
      if (what.includes(MAIL)) typed = true;
    };
    pane.beforeRead = (p) => {
      if (!typed) return;
      s1Reads++;
      p.fixed = s1Reads <= BOUNDS.s1.reads ? GONE : null;
      if (s1Reads === BOUNDS.s1.reads + 1) back(p);
    };
  }

  test("the box holds exactly the message: it is taken out, nothing pressed but Backspace, and the send ends refused", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    stopsAtS1(pane, () => undefined);
    const answer = await send(MAIL, { draftHolds: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "changed" });
    expect(answer.receipt?.detail).toBe("Enter was not pressed, so the typed message was taken out of the box again. It waits in the inbox.");
    expect(pane.box).toBe("");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a person typed after it: nothing is taken out, the send ends typed_not_submitted as before", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    stopsAtS1(pane, (p) => {
      p.box = `${MAIL} and mine`;
    });
    const answer = await send(MAIL, { draftHolds: true });
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.box).toBe(`${MAIL} and mine`);
    expect(pane.keysSeen.filter((key) => key === "Backspace").length).toBe(1);
  });

  test("a dialog stopped it (modal_cue): no key at all, the text stays", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.afterInput = (p, what) => {
      if (what.includes(MAIL)) p.dialog = DIALOG;
    };
    const answer = await send(MAIL, { draftHolds: true });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen.filter((key) => key === "Backspace").length).toBe(1);
  });

  test("a person's own send that stops is left typed, as before: only WalkyTalky mail is taken back", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    stopsAtS1(pane, () => undefined);
    const answer = await send(MAIL);
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.box).toBe(MAIL);
  });
});

describe("chrome rows under the box tick on their own: the command settle key and the rows hash leave them out (2026-11-13)", () => {
  const STATUS = ["  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents"];
  const panelAt = (n: number): string[] => ["", "  ● main", `  ◯ general-purpose  Reading the profile                    ${String(n)}s · ↓ 88.8k tokens`];
  const LIST = ["  ❯ /model   Set the AI model", "    /mcp     Manage MCP servers"];

  test("a command with its own list open and an agent timer ticking under it on every read: sent, not 'list moving'", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    let ticks = 0;
    let typed = false;
    pane.status = [...STATUS, ...panelAt(0)];
    pane.afterInput = (_pane, what) => {
      if (what.includes("/model")) typed = true;
    };
    pane.beforeRead = (p) => {
      ticks++;
      p.popup = typed ? [...LIST, ...STATUS, ...panelAt(ticks)] : null;
      p.status = [...STATUS, ...panelAt(ticks)];
    };
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
  });

  test("the list itself changes on every read while the timer ticks: still no Enter", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    let ticks = 0;
    let typed = false;
    pane.status = [...STATUS, ...panelAt(0)];
    pane.afterInput = (_pane, what) => {
      if (what.includes("/model")) typed = true;
    };
    pane.beforeRead = (p) => {
      ticks++;
      const list = ["  ❯ /model   Set the AI model", `    /mcp     Manage MCP servers ${ticks % 2 === 0 ? "(on)" : "(off)"}`];
      p.popup = typed ? [...list, ...STATUS, ...panelAt(ticks)] : null;
    };
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("the rows hash a person confirmed holds while an agent timer ticks under the box: Submit of an edited box is not stale", async () => {
    const { pane, protocol, send } = rig({ version: "2.1.302" });
    let ticks = 0;
    pane.box = "decision 1 is goo";
    pane.beforeRead = (p) => {
      ticks++;
      p.status = [...STATUS, ...panelAt(ticks)];
    };
    const prepared = await protocol.handle({ id: "chrome-prep-01", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.rowsHash).toBeDefined();
    const answer = await send("decision 1 is good", { mode: "submit", rowsHash: prepared.rowsHash! });
    expect(answer.receipt?.reason).not.toBe("stale_surface");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
  });

  test("the rows hash still moves when a row that is no chrome changes under the box: stale_surface", async () => {
    const { pane, protocol, send } = rig({ version: "2.1.302" });
    let ticks = 0;
    pane.box = "decision 1 is goo";
    pane.beforeRead = (p) => {
      ticks++;
      p.status = [`  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← ${String(ticks)} agents`, ...panelAt(0)];
    };
    const prepared = await protocol.handle({ id: "chrome-prep-02", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    const answer = await send("decision 1 is good", { mode: "submit", rowsHash: prepared.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

// Field case 2026-11-13 (request e86fd78e), as frame fixtures: Claude Code 2.1.323 in a running turn, the agents
// panel under the box. The session resumed a background agent inside S1's window, and the panel gained a row
// between the probe's read and S1's reads. Hand-built from the field screen's layout (its rows under the box
// read from the pane the same evening; the transcript, model and path replaced), plain text.
describe("Claude Code 2.1.323, the agents panel gains a row while the text goes in (field case 2026-11-13, frame fixtures)", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const capture = (name: string): string => readFileSync(join(FIXTURES, `claude--v2323-agents-panel-${name}--w120.txt`), "utf8");
  const TEXT_IN = "decision 1 is good";
  const replay = (typed: string): FakePane => {
    const pane = new FakePane("claude");
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) p.fixed = capture("running");
      else if (p.box === "") p.fixed = capture("running");
      else if (p.box === PROBE) p.fixed = capture("probe");
      else if (p.box === TEXT_IN) p.fixed = typed;
      else throw new Error(`the field never showed the box holding ${JSON.stringify(p.box)}`);
    };
    return pane;
  };
  /** The Claude profile as shipped before the fix: the agents panel's rows carry no chrome mark. */
  const unmarked = (profile: Profile): Profile => ({
    ...profile,
    idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, footerRows: (profile.idle.volatile.below.footerRows ?? []).map(({ name, pattern }) => ({ name, pattern })) } } },
  });

  test("the cause: without the chrome mark the grown panel ends the send exactly as the field receipt did", async () => {
    const pane = replay(capture("grown"));
    const answer = await rig({ pane, version: "2.1.302", edit: unmarked }).send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed", keys: ["probe", "Backspace"], s2: null, saw: { turn: "running", modal: "none", composer: "draft" } });
    expect(answer.receipt?.detail).toBe("The frame with the typed text was gone, or the rows under the box changed, so Enter was not pressed.");
    // The same send with the panel unchanged went out before the fix too: the panel's one new row is the whole cause.
    const unchanged = replay(capture("typed"));
    expect((await rig({ pane: unchanged, version: "2.1.302", edit: unmarked }).send(TEXT_IN)).receipt?.outcome).toBe("sent");
  });

  test("the fix: the grown panel is chrome, the box holds the text, one Enter", async () => {
    const pane = replay(capture("grown"));
    const answer = await rig({ pane, version: "2.1.302" }).send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("the grown panel with one character off in the box: no Enter", async () => {
    const pane = replay(capture("grown").replace("❯ decision 1 is good", "❯ decision 1 is goo"));
    const answer = await rig({ pane, version: "2.1.302" }).send(TEXT_IN);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

describe("the person's word on a receipt (M102 spec 01)", () => {
  /** A commit the person tapped on a screen Collie could not read, on the frameless profile's two-tap Send. */
  const commit = async (r: Rig, over: Partial<SendRequest> = {}): Promise<{ first: SendAnswer; answer: SendAnswer }> => {
    const first = await r.send("hello from the phone");
    const answer = await r.send("hello from the phone", { rowsHash: first.rowsHash!, ...over });
    return { first, answer };
  };

  test("the commit of a manual Send from the phone with override records word override beside the outcome, stored and listed", async () => {
    const r = rig({ mode: "generic" });
    const { first, answer } = await commit(r, { override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent", word: "override" });
    expect(first.receipt?.word).toBeUndefined();
    expect(r.deps.store.get(answer.receipt!.requestId)?.receipt?.word).toBe("override");
    expect(r.protocol.recent("%1").find((row) => row.requestId === answer.receipt!.requestId)?.word).toBe("override");
  });

  test("the word stays on an end that is not sent: a probe the screen failed still says the person overrode", async () => {
    const bare = new CodexPane();
    const r = rig({ pane: bare, harness: FRAMELESS });
    const first = await r.send("hello");
    bare.afterInput = (p, what) => {
      if (what === `type:${GENERIC_PROBE}`) p.transcript[5] = "• ready, and more text";
    };
    const answer = await r.send("hello", { rowsHash: first.rowsHash!, override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", word: "override" });
  });

  test("a commit without override carries no word", async () => {
    const { answer } = await commit(rig({ mode: "generic" }), { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.word).toBeUndefined();
  });

  test("a request that is not the phone's own never carries a word, whatever it says", async () => {
    const { answer } = await commit(rig({ mode: "generic" }), { override: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.word).toBeUndefined();
  });

  test("override on the first tap, with no rows hash, is the same refusal as before and carries no word", async () => {
    const r = rig({ mode: "generic" });
    const answer = await r.send("hello from the phone", { override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed" });
    expect(answer.receipt?.word).toBeUndefined();
  });

  test("a commit whose rows moved is refused stale_surface and carries no word: the person typed past nothing", async () => {
    const r = rig({ mode: "generic" });
    const first = await r.send("hello");
    r.pane.transcript.push("a new line arrived");
    const answer = await r.send("hello", { rowsHash: first.rowsHash!, override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface" });
    expect(answer.receipt?.word).toBeUndefined();
  });

  test("a plain send on a free screen carries no word even when the request says override: nothing was typed past", async () => {
    const r = rig();
    const answer = await r.send("please fix the failing test", { override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.word).toBeUndefined();
  });

  test("the word is replayed with the receipt for the same request id", async () => {
    const r = rig({ mode: "generic" });
    const first = await r.send("hello from the phone");
    const request = { id: "person-word-replay-1", rowsHash: first.rowsHash!, override: true, fromPhone: true } as const;
    const once = await r.send("hello from the phone", request);
    const twice = await r.send("hello from the phone", request);
    expect(once.receipt?.word).toBe("override");
    expect(twice.receipt?.word).toBe("override");
  });

  test("markArrived marks an unknown receipt on its pane once, and the list and the counters carry the word", async () => {
    const dayDir = join(dir, "counters");
    const ledger = new SurfaceLedger(dayDir);
    const r = rig({ mode: "generic", ledger });
    const unknown = await settledUnknown(r, "person-word-unknown-1");
    expect(r.protocol.markArrived("main", "%1", unknown)).toBe("marked");
    expect(r.deps.store.get(unknown)?.receipt).toMatchObject({ outcome: "unknown", word: "arrived" });
    expect(r.protocol.recent("%1").find((row) => row.requestId === unknown)).toMatchObject({ outcome: "unknown", word: "arrived" });
    const arrived = (): number => ledger.rows().reduce((sum, row) => sum + row.arrived, 0);
    expect(arrived()).toBe(1);
    expect(r.protocol.markArrived("main", "%1", unknown)).toBe("already");
    expect(arrived()).toBe(1);
  });

  test("markArrived refuses another pane's id, an id nobody sent and a receipt that did not end unknown", async () => {
    const r = rig({ mode: "generic" });
    const unknown = await settledUnknown(r, "person-word-unknown-2");
    expect(r.protocol.markArrived("main", "%2", unknown)).toBe("not_found");
    expect(r.protocol.markArrived("main", "%1", "person-word-nobody-1")).toBe("not_found");
    const sent = await r.send("a send that goes through");
    expect(r.protocol.markArrived("main", "%1", sent.receipt!.requestId)).toBe("not_unknown");
    expect(r.deps.store.get(unknown)?.receipt?.word).toBeUndefined();
    expect(r.deps.store.get(sent.receipt!.requestId)?.receipt?.word).toBeUndefined();
  });

  test("a counters ledger that throws never blocks the mark", async () => {
    const ledger: SendLedger = {
      send: () => undefined,
      noteManual: () => undefined,
      capState: () => ({ count: 0, limit: 5, reached: false }),
      inbox: () => undefined,
      example: () => undefined,
      arrived: () => {
        throw new Error("disk full");
      },
    };
    const r = rig({ mode: "generic" });
    const unknown = await settledUnknown(r, "person-word-unknown-3");
    const guarded = new SendProtocol({ ...r.deps, ledger });
    expect(guarded.markArrived("main", "%1", unknown)).toBe("marked");
    expect(r.deps.store.get(unknown)?.receipt?.word).toBe("arrived");
  });

  /** A send whose submit key went out and whose receipt the screen could not prove: `unknown`, settled on disk. */
  async function settledUnknown(r: Rig, id: string): Promise<string> {
    const accepted = r.deps.store.accept({ id, session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "was it typed" });
    r.deps.store.settle(id, { ...SendProtocol.crashReceipt(accepted.record), reason: "no_evidence", harness: "claude", version: "2.1.200", profileId: "claude", profileStatus: "verified" });
    expect(r.deps.store.get(id)?.receipt?.outcome).toBe("unknown");
    return id;
  }
});

describe("an override is never held, and goes into a turn as the manual commit does (M102 spec 01)", () => {
  // The orchestrator, 2026-11-16: an override is never HELD by Collie, but where the harness itself
  // queues a message in a running turn it goes in exactly as today's manual commit does, plus the word.

  test("override: Claude at a running turn on a free box queues the send exactly as a plain send does, with no word (no stop was passed)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const plain = rig({ holds });
    plain.pane.over = [LIVE_ROW];
    const control = await plain.send("then give it a title");
    expect(control.receipt).toMatchObject({ outcome: "sent", queued: true });
    const r = rig({ holds });
    r.pane.over = [LIVE_ROW];
    const answer = await r.send("then give it a title", { override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: control.receipt!.keys });
    expect(answer.receipt?.word).toBeUndefined();
    expect(r.pane.keysSeen).toEqual(plain.pane.keysSeen);
    expect(holds.list()).toEqual([]);
  });

  test("override: a refusal the hold queue would take (a running turn on an unread version) is not held", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const control = rig({ version: "no version here", holds });
    control.pane.over = [LIVE_ROW];
    expect((await control.send("then give it a title")).receipt).toMatchObject({ outcome: "held" });
    const { pane, send } = rig({ version: "no version here", holds: new HoldStore(join(dir, "held-two")) });
    pane.over = [LIVE_ROW];
    const answer = await send("then give it a title", { override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running" });
    expect(pane.calls).toEqual([]);
  });

  test("override: Codex on a screen with no box and a running row takes the Tab queue byte for byte like today's manual commit, plus the word", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const codexNoBox = (): ReturnType<typeof rig> => {
      const r = rig({ pane: new FakePane("codex"), harness: "codex", version: "0.159.2", holds });
      r.pane.over = ["• Working (4s • esc to interrupt)"];
      r.pane.codexStatus = "  something the profile does not know";
      r.pane.codexHint = "  ? for shortcuts";
      return r;
    };
    const plain = codexNoBox();
    const firstPlain = await plain.send("then add a short summary");
    const control = await plain.send("then add a short summary", { rowsHash: firstPlain.rowsHash! });
    expect(control.receipt).toMatchObject({ outcome: "sent" });
    expect(control.receipt?.word).toBeUndefined();
    expect(plain.pane.queued).toEqual(["then add a short summary"]);

    const r = codexNoBox();
    const first = await r.send("then add a short summary");
    const answer = await r.send("then add a short summary", { rowsHash: first.rowsHash!, override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: control.receipt!.outcome, keys: control.receipt!.keys, word: "override" });
    expect(answer.receipt?.queued).toBe(control.receipt?.queued);
    expect(r.pane.keysSeen).toEqual(plain.pane.keysSeen);
    expect(r.pane.queued).toEqual(plain.pane.queued);
    expect(holds.list()).toEqual([]);
  });

  test("override: a turn that starts while the text is typed ends as a plain send does", async () => {
    const arm = (pane: FakePane): void => {
      pane.afterInput = (p, what) => {
        if (what.endsWith("then give it a title")) p.over = [LIVE_ROW];
      };
    };
    const plain = rig();
    arm(plain.pane);
    const control = await plain.send("then give it a title");
    expect(control.receipt).toMatchObject({ outcome: "sent" });

    const { pane, send } = rig();
    arm(pane);
    const answer = await send("then give it a title", { override: true, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: control.receipt!.outcome, keys: control.receipt!.keys });
    expect(answer.receipt?.queued).toBe(control.receipt?.queued);
    expect(pane.keysSeen).toEqual(plain.pane.keysSeen);
  });
});

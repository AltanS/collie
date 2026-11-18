import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ItemView } from "@/components/chat-cards";
import { SessionTrickCards } from "@/components/session-trick-card";
import { WalkyLogProvider, WalkyOpenProvider } from "@/components/walky-log";
import type { ChatItem } from "@/lib/chat-items";
import { clockTime } from "@/lib/format";
import { __resetHill, __settleHill, noteHillAnswer, syncHill } from "@/lib/hill/store";
import { forgetSessionLater } from "@/lib/hill/session-later";
import type { HillDecision } from "@/lib/hill/wire";
import type { WalkyRow } from "@/lib/walky";
import { fixtureWalkyOperator, fixtureWalkySelf } from "@/test/handlers";
import { collieCard, hillDecision, hillReceipt } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// THE ANSWER TO A TRICK APPROVAL IS ONE ROW IN CHAT (Altan, 2026-11-18), AND THE CARD'S OWN LINE STEPS ASIDE FOR IT. The
// row: the tricks glyph, "Collie tricks", the trick's name and the result, the time and where it was signed, muted at the
// right; it opens the Messages sheet where the message card did. The duplicate: the collapsed line of the same decision is
// not drawn while the row is on the screen, and stays when no row is.

const ID = "dc_5k9vtcwnrp3z";
const MSG = "wt_answer000001";

/** A trick approval, answered with `intent`, as the bridge serves it closed. */
function answered(intent: string, over: Partial<HillDecision> = {}): HillDecision {
  // The bridge posts a new version as a proposal too (bridge/tricks/proposal-card.ts): its title and labels tell them apart.
  return collieCard("proposal", "hadoken", {
    id: ID,
    replyTo: fixtureWalkySelf,
    state: "answered",
    answer: { rid: "r1", intent, label: null, text: null, by: "phone-dev", at: 1, delivery: "typed", trick: "none" },
    ...over,
  });
}

const VERSION = { title: "Use the new version of hadoken?", options: [{ intent: "on", label: "Use the new version" }, { intent: "later", label: "Keep the old version" }] };

/**
 * The operator message the bridge types for this answer, as the log holds it: the poster's form of `answerMessage`
 * (bridge/hill/service.ts). The web program may not import the bridge's code (its types would join the web type check), so
 * the lines are spelled here, and bridge/hill/answer-turn.test.ts pins the reader to the writer's own output.
 */
function typed(decision: HillDecision, intent: string, label: string | null, over: Partial<WalkyRow> = {}): WalkyRow {
  const body = `Answer to ${decision.id} "${decision.title}"\nOption: ${intent} (${label ?? intent})`;
  return { ...fixtureWalkyOperator, id: MSG, replyTo: null, body, receipt: { ...fixtureWalkyOperator.receipt, id: MSG, state: "delivered", reason: undefined }, ...over };
}

function turn(row: WalkyRow, kind: "agent" | "operator" = "operator"): ChatItem {
  return { id: "u1", kind: "user", text: `[walky-talky ${row.id}] from operator ${row.from.label}\n${row.body}`, ts: "2026-10-17T09:30:00Z", walky: { id: row.id, kind, replyTo: null } };
}

async function holds(closed: HillDecision[], open: HillDecision[] = [], rev = 1) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev, open, closed })));
  await act(async () => {
    syncHill(rev, "tricks");
    await __settleHill();
  });
}

function chat(rows: WalkyRow[], item: ChatItem, open: ((id: string) => void) | null = null) {
  return render(
    <WalkyLogProvider rows={rows}>
      <WalkyOpenProvider open={open} self={fixtureWalkySelf}>
        <ItemView item={item} />
        <SessionTrickCards self={fixtureWalkySelf} />
      </WalkyOpenProvider>
    </WalkyLogProvider>,
  );
}

const row = () => document.querySelector<HTMLElement>('[data-slot="trick-answer-row"]');
const line = () => document.querySelector<HTMLElement>('[data-slot="chat-approval-line"]');
const walkyCard = () => document.querySelector('[data-slot="walky-card"]');

beforeEach(() => {
  __resetHill();
  forgetSessionLater();
});
afterEach(() => {
  __resetHill();
  vi.restoreAllMocks();
});

describe("the answer to a trick approval draws as one row", () => {
  it.each([
    ["a new trick, switched on", {}, "on", "Switch it on", "hadoken: switched on", "approved"],
    ["a new trick, declined", {}, "later", "Not now", "hadoken: not switched on", "declined"],
    ["a new version, in use", VERSION, "on", "Use the new version", "hadoken: new version in use", "approved"],
    ["a new version, kept the old one", VERSION, "later", "Keep the old version", "hadoken: kept the old version", "declined"],
  ])("%s", async (_, over, intent, label, words, outcome) => {
    const decision = answered(intent, over);
    const message = typed(decision, intent, label);
    await holds([decision]);
    chat([message], turn(message));
    const drawn = row()!;
    expect(drawn).not.toBeNull();
    expect(drawn.dataset.outcome).toBe(outcome);
    expect(drawn.dataset.message).toBe(MSG);
    // The look of the answered card's line: the glyph on its 16px tile, the label, the name and the result.
    expect(drawn.querySelector('[data-slot="decision-trick-mark"]')!.className).toContain("size-4");
    expect(drawn).toHaveTextContent("Collie tricks");
    expect(drawn).toHaveTextContent(words);
    // Right side: the time and where it was signed, as the card said it.
    expect(drawn.querySelector('[data-slot="trick-answer-meta"]')).toHaveTextContent(clockTime(message.at));
    expect(drawn.querySelector('[data-slot="walky-verified"]')).toHaveTextContent("this machine");
    // Not the message card: no "Message from", no operator chip, none of the answer's English.
    expect(walkyCard()).toBeNull();
    expect(drawn).not.toHaveTextContent("Message from");
    expect(drawn).not.toHaveTextContent("operator");
    expect(drawn).not.toHaveTextContent("Answer to");
    expect(drawn.querySelector('[data-slot="walky-body"]')).toBeNull();
  });

  it("is one button that opens the Messages sheet on this message, where the card did", async () => {
    const decision = answered("on");
    const message = typed(decision, "on", "Switch it on");
    const open = vi.fn();
    await holds([decision]);
    chat([message], turn(message), open);
    const button = screen.getByRole("button", { name: /Collie tricks/u });
    expect(button).toBe(row());
    expect(button.className).toContain("min-h-11");
    await userEvent.click(button);
    expect(open).toHaveBeenCalledExactlyOnceWith(MSG);
  });

  it("is a plain line where there is no sheet to open", async () => {
    const decision = answered("on");
    const message = typed(decision, "on", "Switch it on");
    await holds([decision]);
    chat([message], turn(message), null);
    expect(row()!.tagName).toBe("P");
    expect(document.querySelector("button")).toBeNull();
  });

  it("names a device that signed the message", async () => {
    const decision = answered("on");
    const message = typed(decision, "on", "Switch it on");
    await holds([decision]);
    chat([{ ...message, signer: "pixel", receipt: { ...message.receipt, verified: "origin", by: "pixel" } }], turn(message));
    expect(row()!.querySelector('[data-slot="walky-verified"]')).toHaveTextContent("signed by pixel");
  });
});

describe("the card's own line steps aside only for the row", () => {
  /** This phone answered: it holds the receipt, so the card draws its collapsed line. */
  function heldAnswer(intent: string) {
    noteHillAnswer(ID, { receipt: hillReceipt({ state: "answered" }), intent, text: null });
  }

  it("is drawn alone while no answer was typed into a session", async () => {
    const decision = answered("on");
    await holds([decision]);
    heldAnswer("on");
    render(<SessionTrickCards self={fixtureWalkySelf} />);
    expect(line()).toHaveTextContent("hadoken: switched on");
    expect(row()).toBeNull();
  });

  it("is not drawn while the row is: the result shows once", async () => {
    const decision = answered("on");
    const message = typed(decision, "on", "Switch it on");
    await holds([decision]);
    heldAnswer("on");
    chat([message], turn(message));
    expect(row()).not.toBeNull();
    expect(line()).toBeNull();
    expect(screen.getAllByText(/Collie tricks/u)).toHaveLength(1);
  });

  it("is drawn again when the row leaves", async () => {
    const decision = answered("on");
    const message = typed(decision, "on", "Switch it on");
    await holds([decision]);
    heldAnswer("on");
    const view = chat([message], turn(message));
    expect(line()).toBeNull();
    view.rerender(
      <WalkyLogProvider rows={[message]}>
        <SessionTrickCards self={fixtureWalkySelf} />
      </WalkyLogProvider>,
    );
    expect(row()).toBeNull();
    expect(line()).not.toBeNull();
  });

  it("is not drawn for another decision's row", async () => {
    const decision = answered("on");
    const other = answered("on", { id: "dc_aaaaaaaaaaaa", replyTo: "lodge/w9:p9" });
    const message = typed(other, "on", "Switch it on");
    await holds([decision, other]);
    heldAnswer("on");
    chat([message], turn(message));
    expect(row()!.dataset.id).toBe("dc_aaaaaaaaaaaa");
    expect(line()).not.toBeNull();
  });
});

describe("every other message keeps its card", () => {
  it("an answer to a question that is no trick approval", async () => {
    const decision = hillDecision({ id: "dc_bbbbbbbbbbbb", state: "answered", answer: { rid: "r", intent: "yes", label: "Yes, Edge first", text: null, by: "phone-dev", at: 1, delivery: "typed", trick: "none" } });
    const message = typed(decision, "yes", "Yes, Edge first");
    await holds([decision]);
    chat([message], turn(message));
    expect(row()).toBeNull();
    expect(walkyCard()).toHaveTextContent("Message from");
    expect(walkyCard()).toHaveTextContent("operator");
    expect(walkyCard()).toHaveTextContent(`Answer to dc_bbbbbbbbbbbb`);
  });

  it("an answer to a Collie card that is no trick approval", async () => {
    const decision = collieCard("proposal", "hadoken", { id: "dc_cccccccccccc", state: "answered", answer: { rid: "r", intent: "on", label: null, text: null, by: "p", at: 1, delivery: "typed", trick: "none" } });
    const other = { ...decision, from: { ...decision.from, ref: undefined } };
    const message = typed(other, "on", "Switch it on");
    await holds([other]);
    chat([message], turn(message));
    expect(row()).toBeNull();
    expect(walkyCard()).not.toBeNull();
  });

  it("a plain operator message", async () => {
    await holds([answered("on")]);
    chat([fixtureWalkyOperator], turn(fixtureWalkyOperator));
    expect(row()).toBeNull();
    expect(walkyCard()).toHaveTextContent("Stop and report what you changed.");
  });

  it("an answer whose Decision this phone does not hold", async () => {
    const decision = answered("on");
    const message = typed(decision, "on", "Switch it on");
    await holds([]);
    chat([message], turn(message));
    expect(row()).toBeNull();
    expect(walkyCard()).not.toBeNull();
  });

  it("a message from an agent that prints the same first line", async () => {
    const decision = answered("on");
    const message = typed(decision, "on", "Switch it on", { kind: "agent", from: { memberId: "lodge", address: "lodge/w6:p3", harness: "claude", label: "repo#fix" } });
    await holds([decision]);
    chat([message], turn(message, "agent"));
    expect(row()).toBeNull();
    expect(walkyCard()).toHaveAttribute("data-kind", "agent");
  });
});

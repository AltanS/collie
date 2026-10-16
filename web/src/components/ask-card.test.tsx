import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { resetCacheClockForTests } from "@/lib/cache-clock";
import { asJsonObject, type JsonObject } from "@/lib/json";
import { noteServerDate, resetServerClockForTests } from "@/lib/server-clock";
import { __resetSessionCards, noteSessionCards } from "@/lib/session-cards";
import type { ProgramContractAsk } from "@/lib/program-ask";
import { programContract } from "@/lib/surface/program";
import type { Ask } from "@/lib/types";
import { AskCard } from "./ask-card";

// The ask card against a stubbed answer route: one case per outcome the route can give, what the
// request carried, and the rule that only a tap posts (ADR 0100).

const ASK: Ask = {
  id: "ask-1",
  kind: "permission",
  toolCallId: "call-1",
  revision: 4,
  title: "Run npm test?",
  itemId: "tool-1",
  reason: "The program wants to run the tests.",
  tool: { name: "bash", summary: "npm test" },
  options: [
    { id: "yes", label: "Run it", effect: "allow" },
    { id: "always", label: "Always allow", effect: "allow-always" },
    { id: "no", label: "Do not run", effect: "deny" },
    { id: "stop", label: "Cancel the turn", effect: "cancel" },
  ],
};

type Sent = { url: string; body: JsonObject };

/** Serve the answer route with `reply`, and record what each request carried. */
function stubAnswer(reply: () => Response): Sent[] {
  const seen: Sent[] = [];
  server.use(
    http.post<never, JsonObject>(/\/api\/pane\/[^/]+\/answer$/, async ({ request }) => {
      seen.push({ url: request.url, body: asJsonObject(await request.json()) ?? {} });
      return reply();
    }),
  );
  return seen;
}

/** A button by Collie's own wording (the effect), whatever second line the program's label adds. */
function wording(main: string): RegExp {
  return new RegExp(`^${main}`, "u");
}

function draw(over: Partial<React.ComponentProps<typeof AskCard>> = {}) {
  const onSettled = vi.fn();
  const view = render(<AskCard ask={ASK} paneId="w1:p1" onSettled={onSettled} {...over} />);
  return { onSettled, ...view };
}

describe("the card as data", () => {
  it("draws the title, the reason, the tool summary and one button per option", () => {
    draw();
    expect(screen.getByText("Run npm test?")).toBeInTheDocument();
    expect(screen.getByText("The program wants to run the tests.")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    for (const main of ["Allow", "Always allow", "Deny", "Cancel"]) {
      expect(screen.getByRole("button", { name: wording(main) })).toBeEnabled();
    }
  });

  it("each button leads with Collie's wording for the effect and shows the program's label as the second line", () => {
    draw();
    const allow = screen.getByRole("button", { name: wording("Allow") });
    expect(allow.querySelectorAll("span.block")[0]).toHaveTextContent(/^Allow$/u);
    expect(allow.querySelectorAll("span.block")[1]).toHaveTextContent("Run it");
    expect(allow.querySelectorAll("span.block")[1]).toHaveClass("text-muted-foreground");
    expect(screen.getByRole("button", { name: wording("Deny") })).toHaveTextContent("Do not run");
    expect(screen.getByRole("button", { name: wording("Cancel") })).toHaveTextContent("Cancel the turn");
    // The program's label does not name the button on its own.
    expect(screen.queryByRole("button", { name: "Run it" })).toBeNull();
  });

  it("a label that only repeats the effect's wording draws no second line", () => {
    draw();
    // The fixture's "Always allow" option carries the label "Always allow".
    expect(screen.getByRole("button", { name: "Always allow" }).querySelectorAll("span.block")).toHaveLength(1);
  });

  it("only an allow wears the primary tone; deny and cancel do not", () => {
    draw();
    const primary = (main: string) => screen.getByRole("button", { name: wording(main) }).classList.contains("border-primary");
    expect(primary("Allow")).toBe(true);
    expect(primary("Always allow")).toBe(false);
    expect(primary("Deny")).toBe(false);
    expect(primary("Cancel")).toBe(false);
  });

  it("draws at most six options", () => {
    const options = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Choice ${i}`, effect: "allow" as const }));
    draw({ ask: { ...ASK, options } });
    expect(screen.getAllByRole("button")).toHaveLength(6);
  });

  it("an ask of another kind shows its words and no buttons", () => {
    draw({ ask: { ...ASK, kind: "dial" } });
    expect(screen.getByText("Run npm test?")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("This ask cannot be answered from the phone.")).toBeInTheDocument();
  });

  it("nothing posts until a person taps", async () => {
    const seen = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    const { rerender } = draw();
    rerender(<AskCard ask={{ ...ASK, revision: 5 }} paneId="w1:p1" />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(0);
  });
});

describe("a tap", () => {
  it("posts the ask id, the revision, the option and a request id minted for the tap", async () => {
    const seen = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    const { onSettled } = draw({ scope: { host: "workshop" } });
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(new URL(seen[0]!.url).searchParams.get("host")).toBe("workshop");
    expect(new URL(seen[0]!.url).pathname).toBe("/api/pane/w1%3Ap1/answer");
    expect(seen[0]!.body).toMatchObject({ askId: "ask-1", revision: 4, optionId: "yes" });
    expect(String(seen[0]!.body.requestId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
  });

  it("taken closes the card", async () => {
    stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    const { container } = draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("the buttons are off while the tap is on its way", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(/\/api\/pane\/[^/]+\/answer$/, async () => {
        await gate;
        return HttpResponse.json({ ok: true, outcome: "taken" });
      }),
    );
    draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(screen.getByRole("button", { name: wording("Deny") })).toBeDisabled();
    release();
  });

  it("too late says not taken and that the question may come back, with no buttons, and asks the pane to be read again", async () => {
    stubAnswer(() => HttpResponse.json({ ok: false, outcome: "too-late" }));
    const { onSettled } = draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText("Not taken. The question may show again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText(/Already answered/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
    expect(onSettled).toHaveBeenCalled();
  });

  it.each([
    ["program", "Decided in the durable agent."],
    ["timeout", "Timed out before an answer."],
    ["phone", "Already answered. This card goes away on the next update."],
  ])("too late decided by %s says so, and the card stays frozen", async (by, words) => {
    stubAnswer(() => HttpResponse.json({ ok: false, outcome: "too-late", decided: { by, at: "2026-10-15T09:30:00.000Z" } }));
    const { onSettled } = draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByText(/Not taken/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
    expect(onSettled).toHaveBeenCalled();
  });

  it("too late with a decided this phone cannot read falls back to not taken", async () => {
    stubAnswer(() => HttpResponse.json({ ok: false, outcome: "too-late", decided: { by: "someone", at: "never" } }));
    draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText("Not taken. The question may show again in a moment.")).toBeInTheDocument();
  });

  it("stale replaces the card with the returned ask and asks for a fresh tap, with a new request id", async () => {
    const newer: Ask = { ...ASK, revision: 5, title: "Run npm test as root?" };
    const seen = stubAnswer(() => HttpResponse.json({ ok: false, outcome: "stale", ask: newer }, { status: 409 }));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText("Run npm test as root?")).toBeInTheDocument();
    expect(screen.getByText(/This ask changed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: wording("Allow") }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.body).toMatchObject({ revision: 5 });
    expect(seen[1]!.body.requestId).not.toBe(seen[0]!.body.requestId);
  });

  it("unknown offers Try again, and Try again carries the SAME request id and option", async () => {
    let calls = 0;
    const seen = stubAnswer(() => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json({ ok: false, outcome: "unknown", detail: "no reply" }, { status: 504 })
        : HttpResponse.json({ ok: true, outcome: "taken", replayed: true });
    });
    const { container } = draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: wording("Deny") }));
    expect(await screen.findByText(/Not sure the answer arrived/)).toBeInTheDocument();
    // The other options are off: a different choice could double up with the one that may have landed.
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.body.requestId).toBe(seen[0]!.body.requestId);
    expect(seen[1]!.body.optionId).toBe("no");
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("a lost connection reads as unknown too", async () => {
    server.use(http.post(/\/api\/pane\/[^/]+\/answer$/, () => HttpResponse.error()));
    draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("maybe-applied turns every button off, says it may be applied, and asks the pane to be read again", async () => {
    stubAnswer(() => HttpResponse.json({ ok: false, outcome: "maybe-applied" }));
    const { onSettled } = draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText("May already be applied. Check the chat.")).toBeInTheDocument();
    for (const main of ["Allow", "Always allow", "Deny", "Cancel"]) {
      expect(screen.getByRole("button", { name: wording(main) })).toBeDisabled();
    }
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(onSettled).toHaveBeenCalled();
  });

  it("refused shows the bridge's detail and leaves nothing to tap", async () => {
    stubAnswer(() =>
      HttpResponse.json({ ok: false, outcome: "refused", reason: "unsupported", detail: "This pane takes no answers." }, { status: 409 }),
    );
    draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText("This pane takes no answers.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a machine too old for the route (404) reads as stale and says it needs an update", async () => {
    server.use(http.post(/\/api\/pane\/[^/]+\/answer$/, () => HttpResponse.json({ error: "not found" }, { status: 404 })));
    draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText(/older Collie/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
  });
});

describe("Always allow", () => {
  it("does not post on the first tap, names the tool, and posts on the second", async () => {
    const seen = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: wording("Always allow") }));
    expect(await screen.findByRole("button", { name: /Tap again to always allow bash/ })).toBeEnabled();
    expect(seen).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Tap again to always allow bash/ }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body).toMatchObject({ optionId: "always", askId: "ask-1", revision: 4 });
  });

  it("any other tap disarms it and posts only that tap", async () => {
    const seen = stubAnswer(() => HttpResponse.json({ ok: false, outcome: "too-late" }));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: wording("Always allow") }));
    await user.click(screen.getByRole("button", { name: wording("Deny") }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body).toMatchObject({ optionId: "no" });
    expect(screen.queryByRole("button", { name: /Tap again to always allow/ })).toBeNull();
  });

  it("a newer revision from the poll disarms it", async () => {
    const seen = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    const { rerender } = draw();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Always allow") }));
    expect(screen.getByRole("button", { name: /Tap again to always allow bash/ })).toBeInTheDocument();
    rerender(<AskCard ask={{ ...ASK, revision: 5 }} paneId="w1:p1" />);
    expect(screen.queryByRole("button", { name: /Tap again to always allow/ })).toBeNull();
    expect(screen.getByRole("button", { name: wording("Always allow") })).toBeEnabled();
    expect(seen).toHaveLength(0);
  });

  it("is not offered on an ask whose text the bridge cut or changed", () => {
    draw({ ask: { ...ASK, cleaned: true } });
    expect(screen.queryByRole("button", { name: wording("Always allow") })).toBeNull();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeInTheDocument();
  });

  it("is not offered on an ask with no tool to name", () => {
    const { tool: _tool, ...bare } = ASK;
    draw({ ask: bare });
    expect(screen.queryByRole("button", { name: wording("Always allow") })).toBeNull();
    expect(screen.getByRole("button", { name: wording("Deny") })).toBeInTheDocument();
  });
});

describe("a cleaned ask", () => {
  it("says the text was shortened", () => {
    draw({ ask: { ...ASK, cleaned: true } });
    expect(screen.getByText("Text shortened")).toBeInTheDocument();
  });

  it("says nothing of the kind for an ask the bridge left whole", () => {
    draw();
    expect(screen.queryByText("Text shortened")).toBeNull();
  });
});

describe("a card that may not act", () => {
  it("is off for a device that may not write", async () => {
    const seen = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    draw({ disabled: true });
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(seen).toHaveLength(0);
  });

  it("is off on saved data, and says to reconnect", () => {
    draw({ offline: true });
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
    expect(screen.getByText("Reconnect to answer.")).toBeInTheDocument();
  });
});

describe("a newer revision from the poll", () => {
  it("replaces an idle card", () => {
    const { rerender } = draw();
    rerender(<AskCard ask={{ ...ASK, revision: 6, title: "Run npm test twice?" }} paneId="w1:p1" />);
    expect(screen.getByText("Run npm test twice?")).toBeInTheDocument();
  });
});

// ── More kinds of ask (WIRE.md 7.14) ─────────────────────────────────────────────────────────────

const QUEUES = [
  { id: "billing", label: "Billing" },
  { id: "access", label: "Access" },
  { id: "other", label: "Other" },
];
const CHOICE: Ask = { id: "ask-c", kind: "choice", toolCallId: "tc-c", revision: 2, title: "Which queue?", itemId: "item-c", options: QUEUES };
const TEXT: Ask = { id: "ask-t", kind: "text", toolCallId: "tc-t", revision: 1, title: "One line for the customer", itemId: "item-t", options: [], placeholder: "We are looking into it", maxLength: 20 };
const FORM: Ask = {
  id: "ask-f",
  kind: "form",
  toolCallId: "tc-f",
  revision: 3,
  title: "Open a ticket",
  itemId: "item-f",
  options: [],
  fields: [
    { id: "summary", label: "Summary", kind: "text", required: true, maxLength: 40 },
    { id: "queue", label: "Queue", kind: "choice", options: QUEUES },
    { id: "urgent", label: "Urgent", kind: "toggle" },
  ],
};
const taken = () => HttpResponse.json({ ok: true, outcome: "taken" });

describe("a choice ask", () => {
  it("draws its options as plain rows, with no effect wording", () => {
    draw({ ask: CHOICE });
    expect(screen.getByRole("button", { name: "Billing" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Access" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Allow|Deny/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("one tap on a row posts optionIds with that one id, once, and closes on taken", async () => {
    const seen = stubAnswer(taken);
    const { container } = draw({ ask: CHOICE });
    await userEvent.setup().click(screen.getByRole("button", { name: "Access" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body).toMatchObject({ askId: "ask-c", revision: 2, optionIds: ["access"] });
    expect(seen[0]!.body).not.toHaveProperty("optionId");
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(seen).toHaveLength(1);
  });

  it("the rows go off while the tap is on its way, so a second tap cannot double up", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let posts = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/answer$/, async () => {
        posts += 1;
        await gate;
        return taken();
      }),
    );
    draw({ ask: CHOICE });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Billing" }));
    expect(screen.getByRole("button", { name: "Other" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Other" }));
    release();
    await waitFor(() => expect(posts).toBe(1));
  });

  it("with multiple, the rows toggle and nothing posts until Send, which posts the set", async () => {
    const seen = stubAnswer(taken);
    draw({ ask: { ...CHOICE, multiple: true } });
    const user = userEvent.setup();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Other" }));
    await user.click(screen.getByRole("button", { name: "Access" }));
    await user.click(screen.getByRole("button", { name: "Access" })); // off again
    expect(screen.getByRole("button", { name: "Billing" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Access" })).toHaveAttribute("aria-pressed", "false");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(0);
    await user.click(send);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body.optionIds).toEqual(["billing", "other"]);
  });

  it("a choice with no options is not answerable", () => {
    draw({ ask: { ...CHOICE, options: [] } });
    expect(screen.getByText("This ask cannot be answered from the phone.")).toBeInTheDocument();
  });

  it("an unknown outcome keeps the same request id and the same pick for Try again", async () => {
    let calls = 0;
    const seen = stubAnswer(() => {
      calls += 1;
      return calls === 1 ? HttpResponse.json({ ok: false, outcome: "unknown" }, { status: 504 }) : taken();
    });
    draw({ ask: CHOICE });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Other" }));
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.body.requestId).toBe(seen[0]!.body.requestId);
    expect(seen[1]!.body.optionIds).toEqual(["other"]);
  });
});

describe("a text ask", () => {
  it("draws one field with the placeholder and a Send that stays off while the field is empty", () => {
    draw({ ask: TEXT });
    expect(screen.getByRole("textbox", { name: "One line for the customer" })).toHaveAttribute("placeholder", "We are looking into it");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("0 of 20")).toBeInTheDocument();
  });

  it("Send posts the trimmed line as text, once", async () => {
    const seen = stubAnswer(taken);
    const { container } = draw({ ask: TEXT });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "  On it.  ");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body).toMatchObject({ askId: "ask-t", revision: 1, text: "On it." });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(seen).toHaveLength(1);
  });

  it("Enter sends too, but nothing posts without a person pressing it", async () => {
    const seen = stubAnswer(taken);
    draw({ ask: TEXT });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "Hello");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(0);
    await user.type(screen.getByRole("textbox"), "{Enter}");
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("a line over maxLength turns Send off and the count red; the default limit is 500", async () => {
    draw({ ask: TEXT });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "x".repeat(21));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("21 of 20")).toHaveClass("text-destructive");
  });

  it("with no maxLength the limit is 500", () => {
    draw({ ask: { ...TEXT, maxLength: undefined } });
    expect(screen.getByText("0 of 500")).toBeInTheDocument();
  });

  it("a spaces-only line cannot be sent", async () => {
    draw({ ask: TEXT });
    await userEvent.setup().type(screen.getByRole("textbox"), "   ");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("a stale answer shows the new ask with an empty field and asks for a fresh tap", async () => {
    const newer: Ask = { ...TEXT, revision: 2, title: "One line, politely" };
    const seen = stubAnswer(() => HttpResponse.json({ ok: false, outcome: "stale", ask: newer }, { status: 409 }));
    draw({ ask: TEXT });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "Old words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("One line, politely")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    await user.type(screen.getByRole("textbox"), "New words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.body).toMatchObject({ revision: 2, text: "New words" });
  });
});

describe("a form ask", () => {
  it("draws each field by its kind under one Send", () => {
    draw({ ask: FORM });
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Queue/u })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Urgent/u })).toHaveAttribute("aria-checked", "false");
    expect(screen.getAllByRole("button", { name: "Send" })).toHaveLength(1);
    expect(screen.getByText(/Required/u)).toBeInTheDocument();
  });

  it("Send stays off until the required field has a value", async () => {
    draw({ ask: FORM });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await userEvent.setup().type(screen.getByRole("textbox", { name: "Summary" }), "Cannot log in");
    expect(send).toBeEnabled();
  });

  it("Send posts values: filled fields, the picked option id, and every toggle with its boolean", async () => {
    const seen = stubAnswer(taken);
    const { container } = draw({ ask: FORM });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Summary" }), "  Cannot log in ");
    await user.selectOptions(screen.getByRole("combobox", { name: /Queue/u }), "access");
    await user.click(screen.getByRole("switch", { name: /Urgent/u }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body).toMatchObject({ askId: "ask-f", revision: 3, values: { summary: "Cannot log in", queue: "access", urgent: true } });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(seen).toHaveLength(1);
  });

  it("an untouched optional field is left out, and an untouched toggle goes as false", async () => {
    const seen = stubAnswer(taken);
    draw({ ask: FORM });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Summary" }), "Only this");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body.values).toEqual({ summary: "Only this", urgent: false });
  });

  it("a form with no fields, or a choice field with no options, is not answerable", () => {
    const { unmount } = draw({ ask: { ...FORM, fields: [] } });
    expect(screen.getByText("This ask cannot be answered from the phone.")).toBeInTheDocument();
    unmount();
    draw({ ask: { ...FORM, fields: [{ id: "q", label: "Queue", kind: "choice", options: [] }] } });
    expect(screen.getByText("This ask cannot be answered from the phone.")).toBeInTheDocument();
  });

  it("the controls go off while the tap is on its way", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(/\/api\/pane\/[^/]+\/answer$/, async () => {
        await gate;
        return taken();
      }),
    );
    draw({ ask: FORM });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Summary" }), "x");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Send/u })).toBeDisabled(); // its name carries the spinner's "Sending"
    release();
  });
});

describe("a card of a kind this version cannot answer", () => {
  it("draws its words and no controls, even with options", () => {
    draw({ ask: { ...CHOICE, kind: "dial" } });
    expect(screen.getByText("Which queue?")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("the receipts (M55 spec 14)", () => {
  afterEach(() => {
    __resetSessionCards();
    resetCacheClockForTests();
    vi.useRealTimers();
  });

  it("a program's ask names the program in the caption; a terminal pane's keeps the plain caption", () => {
    noteSessionCards(
      [
        { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0, kind: "terminal" },
        { name: "desk", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 1, kind: "program", state: "ready" },
      ],
      undefined,
    );
    const { unmount } = draw({ scope: { session: "desk" } });
    expect(screen.getByText("Needs your answer · desk")).toBeInTheDocument();
    unmount();
    draw();
    expect(screen.getByText("Needs your answer")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it("an ask with an expiry shows the time left under the title, and one without shows none", () => {
    resetCacheClockForTests();
    const { unmount } = draw({ ask: { ...ASK, expiresAt: new Date(Date.now() + 4 * 60_000 + 30_000).toISOString() } });
    expect(screen.getByText("Expires in 4 min")).toBeInTheDocument();
    unmount();
    draw();
    expect(document.querySelector('[data-slot="ask-expiry"]')).toBeNull();
  });

  it("the line ticks on the page clock, into seconds under a minute", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    resetCacheClockForTests();
    draw({ ask: { ...ASK, expiresAt: new Date(Date.now() + 61_000).toISOString() } });
    expect(screen.getByText("Expires in 1 min")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(screen.getByText("Expires in 40 s")).toBeInTheDocument();
  });

  it("past its expiry the line says Expired and the buttons stay: the program answers the tap", () => {
    resetCacheClockForTests();
    draw({ ask: { ...ASK, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeEnabled();
  });
});

describe("the countdown counts on the bridge's clock", () => {
  // The bridge drops an ask at `expiresAt` by its own clock, so the card counts against the bridge's
  // clock as the `Date` header tells it (lib/server-clock.ts), not against the phone's.
  const BRIDGE = Date.UTC(2026, 9, 15, 10, 0, 0);
  const FIVE_MIN = 5 * 60_000;
  const IN_FOUR_AND_A_HALF = new Date(BRIDGE + 4 * 60_000 + 30_000).toISOString();

  /** How far the phone's clock is off the bridge's. */
  let phoneAhead = 0;

  /** The phone's clock `offset` ms off the bridge's, on the page clock too. */
  function phoneOff(offset: number): void {
    phoneAhead = offset;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(BRIDGE + offset);
    resetCacheClockForTests();
  }

  /** One poll's answer: the bridge says its time in the `Date` header, after a quick round trip. */
  function polledBridge(): void {
    const sent = Date.now();
    noteServerDate(new Date(sent - phoneAhead).toUTCString(), sent, sent + 40);
  }

  afterEach(() => {
    resetServerClockForTests();
    resetCacheClockForTests();
    vi.useRealTimers();
  });

  it("a phone five minutes ahead shows the time the bridge has left, not Expired", () => {
    phoneOff(FIVE_MIN);
    polledBridge();
    draw({ ask: { ...ASK, expiresAt: IN_FOUR_AND_A_HALF } });
    expect(screen.getByText("Expires in 4 min")).toBeInTheDocument();
  });

  it("a phone five minutes behind shows the time the bridge has left, not nine minutes", () => {
    phoneOff(-FIVE_MIN);
    polledBridge();
    draw({ ask: { ...ASK, expiresAt: IN_FOUR_AND_A_HALF } });
    expect(screen.getByText("Expires in 4 min")).toBeInTheDocument();
  });

  it("when the phone says Expired and the bridge still lists the ask, a tap still posts", async () => {
    // No sample yet: the phone, five minutes ahead, counts on its own clock and calls the ask expired.
    phoneOff(FIVE_MIN);
    const seen = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    draw({ ask: { ...ASK, expiresAt: new Date(BRIDGE + 30_000).toISOString() } });
    expect(screen.getByText("Expired")).toBeInTheDocument();
    const allow = screen.getByRole("button", { name: wording("Allow") });
    expect(allow).toBeEnabled();
    await userEvent.click(allow);
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("the first poll that tells the bridge's time corrects the line on the next tick", () => {
    phoneOff(FIVE_MIN);
    draw({ ask: { ...ASK, expiresAt: new Date(BRIDGE + 30_000).toISOString() } });
    expect(screen.getByText("Expired")).toBeInTheDocument();
    polledBridge();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/^Expires in \d+ s$/u)).toBeInTheDocument();
  });

  it("a card with no expiry never subscribes to the page clock", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    resetCacheClockForTests();
    const before = vi.getTimerCount();
    const { unmount } = draw();
    expect(vi.getTimerCount()).toBe(before);
    unmount();
    draw({ ask: { ...ASK, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    expect(vi.getTimerCount()).toBe(before + 1);
  });
});

describe("a program on this machine answers through POST /api/ask (M56 spec 14)", () => {
  function contractOf(ask: Ask): ProgramContractAsk {
    const shown = programContract(ask)!;
    return {
      oldest: ask.id,
      ask: { id: "ask-0123456789abcd", kind: shown.kind, options: shown.labels.map((label, i) => ({ id: String(i + 1), label })), channel: "program", hash: shown.hash },
    };
  }

  /** Serve the Send Protocol's ask route with `reply`, and record each request. */
  function stubAsk(reply: () => Response): Sent[] {
    const seen: Sent[] = [];
    server.use(
      http.post<never, JsonObject>(/\/api\/ask\/[^/]+$/, async ({ request }) => {
        seen.push({ url: request.url, body: asJsonObject(await request.json()) ?? {} });
        return reply();
      }),
    );
    return seen;
  }

  it("a tap posts the contract ask's id, hash and numbered option, and the answer route is not asked", async () => {
    const asked = stubAsk(() => HttpResponse.json({ receipt: { outcome: "sent", channel: "program" } }));
    const old = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    const contract = contractOf(ASK);
    const { container, onSettled } = draw({ contract });
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Deny") }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(new URL(asked[0]!.url).pathname).toBe("/api/ask/ask-0123456789abcd");
    expect(asked[0]!.body).toEqual({ pane: "w1:p1", hash: contract.ask.hash, optionId: "2", origin: "person_tap" });
    expect(old).toHaveLength(0);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(onSettled).toHaveBeenCalled();
  });

  it("Always allow stays on the program's answer route, with its two taps", async () => {
    const asked = stubAsk(() => HttpResponse.json({ receipt: { outcome: "sent" } }));
    const old = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    draw({ contract: contractOf(ASK) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: wording("Always allow") }));
    await user.click(await screen.findByRole("button", { name: /Tap again to always allow bash/ }));
    await waitFor(() => expect(old).toHaveLength(1));
    expect(old[0]!.body).toMatchObject({ optionId: "always", askId: "ask-1" });
    expect(asked).toHaveLength(0);
  });

  it("a later ask than the one the contract stands for keeps the answer route", async () => {
    const asked = stubAsk(() => HttpResponse.json({ receipt: { outcome: "sent" } }));
    const old = stubAnswer(() => HttpResponse.json({ ok: true, outcome: "taken" }));
    draw({ contract: { ...contractOf(ASK), oldest: "ask-0" } });
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    await waitFor(() => expect(old).toHaveLength(1));
    expect(asked).toHaveLength(0);
  });

  it("a question closed before the answer reads as too late, and the card freezes", async () => {
    stubAsk(() => HttpResponse.json({ receipt: { outcome: "refused", reason: "ask_gone" }, detail: "The question is closed." }));
    const { onSettled } = draw({ contract: contractOf(ASK) });
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText("Not taken. The question may show again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: wording("Allow") })).toBeDisabled();
    expect(onSettled).toHaveBeenCalled();
  });

  it("another refusal shows the bridge's words", async () => {
    stubAsk(() => HttpResponse.json({ receipt: { outcome: "refused", reason: "busy" }, detail: "Another send or answer on this conversation is still running." }));
    draw({ contract: contractOf(ASK) });
    await userEvent.setup().click(screen.getByRole("button", { name: wording("Allow") }));
    expect(await screen.findByText("Another send or answer on this conversation is still running.")).toBeInTheDocument();
  });
});

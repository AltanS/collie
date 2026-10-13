import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { asJsonObject, type JsonObject } from "@/lib/json";
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
    draw({ ask: { ...ASK, kind: "form" } });
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

import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, onTestFinished, vi } from "vitest";

import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";
import type { HillDecision, HillReceipt } from "@/lib/hill/wire";
import { hillDecision, hillReceipt, trickDecision } from "@/test/hill-fixtures";

import { DecisionCard } from "./decision-card";

// The Decision card (M96): what it shows, that nothing is chosen for the person, the numbered options,
// More and Add a note, the arm on a confirm option and on Dismiss, the gate on a required answer, and
// what it says after each tap.
// Cases read the card through its data-slot hooks inside the render's own container (DESIGN.md §9).

function renderCard(decision: HillDecision, answer: HillAnswerState = HILL_IDLE) {
  const onSend = vi.fn<(intent: string, text: string | null) => void>();
  const view = render(<DecisionCard decision={decision} answer={answer} onSend={onSend} />);
  const slot = (name: string) => view.container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const option = (intent: string) => {
    const el = view.container.querySelector<HTMLButtonElement>(`[data-slot="decision-option"][data-intent="${intent}"]`);
    if (el === null) throw new Error(`no option ${intent}`);
    return el;
  };
  /** Opens an optional note by its "Add a note" tap, the way a person does, and hands back the field. */
  const openNote = () => {
    fireEvent.click(slot("decision-note")!);
    return slot("decision-text")!;
  };
  return { ...view, onSend, slot, option, openNote };
}

const answered = (receipt: HillReceipt, intent = "yes", text: string | null = null): HillAnswerState => ({ phase: "answered", intent, text, receipt });

const withConfirm = () =>
  hillDecision({
    options: [
      { intent: "keep", label: "Keep it as it is" },
      { intent: "reset", label: "Reset to main", detail: "Drops the two local commits.", confirm: "Reset now" },
    ],
  });

describe("the Decision card, at rest", () => {
  it("shows the meta line, the title and the summary", () => {
    const { slot } = renderCard(hillDecision({ priority: "now", title: "Merge it?", summary: "CI is green." }));
    expect(slot("decision-priority")).toHaveTextContent("Now");
    // The three peaks, all filled, named with the priority's word.
    const glyph = slot("decision-priority")!.querySelector('[data-slot="peak-glyph"]')!;
    expect(glyph).toHaveAttribute("data-filled", "3");
    expect(glyph).toHaveAttribute("aria-label", "Now");
    expect(slot("decision-meta")).toHaveTextContent("collie lead");
    expect(slot("decision-meta")).toHaveTextContent("bluefin");
    expect(slot("decision-title")).toHaveTextContent("Merge it?");
    expect(slot("decision-summary")).toHaveTextContent("CI is green.");
  });

  it("marks the recommended option but never selects or focuses it", () => {
    const { slot, option, container } = renderCard(hillDecision({ recommends: { intent: "yes", why: "Edge reaches testers first." } }));
    expect(slot("decision-recommends")).toHaveTextContent("collie lead suggests Yes, Edge first");
    expect(slot("decision-recommends")).toHaveTextContent("“Edge reaches testers first.”");
    // A screen reader hears which option it is beside the options.
    expect(slot("decision-options")).toHaveTextContent("Recommended: Yes, Edge first");
    // A neutral mark, never the caution ink: amber on the card says `now`.
    const mark = option("yes").querySelector('[data-slot="decision-recommended-mark"]')!;
    expect(mark.closest("span")?.className).toContain("text-foreground");
    expect(container.querySelector('[data-slot="decision-recommends"]')?.innerHTML).not.toContain("status-working");
    expect(option("yes").querySelector('[data-slot="decision-recommended-mark"]')).not.toBeNull();
    expect(option("no").querySelector('[data-slot="decision-recommended-mark"]')).toBeNull();
    for (const intent of ["yes", "no"]) {
      expect(option(intent)).not.toHaveAttribute("aria-pressed", "true");
      expect(option(intent)).not.toHaveAttribute("aria-checked", "true");
      expect(option(intent)).not.toHaveFocus();
    }
  });

  it("opens the body and the links, each with its label and host, behind More", () => {
    const { slot, container } = renderCard(
      hillDecision({ body: "What **changes**.", links: [{ label: "CI run 4821", href: "https://ci.example.com/runs/4821" }] }),
    );
    const more = slot("decision-more")!;
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(slot("decision-body")).toHaveTextContent("What changes.");
    const link = container.querySelector<HTMLAnchorElement>('[data-slot="decision-link"]')!;
    expect(link).toHaveAttribute("href", "https://ci.example.com/runs/4821");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("CI run 4821");
    expect(link).toHaveTextContent("ci.example.com");
  });

  it("has no More without a body or links", () => {
    expect(renderCard(hillDecision()).slot("decision-more")).toBeNull();
  });

  it("numbers the options 1, 2, 3 like the terminal menu, for the eye only", () => {
    const { option } = renderCard(withConfirm());
    expect(option("keep").querySelector('[aria-hidden="true"]')).toHaveTextContent("1");
    expect(option("reset").querySelector('[aria-hidden="true"]')).toHaveTextContent("2");
    // The number is not part of the button's name.
    expect(option("keep")).not.toHaveAttribute("aria-label");
  });

  it("says where the answer goes, and that the target runs without prompts", () => {
    const { slot } = renderCard(hillDecision({ target: { label: "m96-hill", host: "minibuch", unattended: true } }));
    expect(slot("decision-target")).toHaveTextContent("Your answer goes to m96-hill on minibuch");
    expect(slot("decision-target")).toHaveTextContent("runs without prompts");
  });

  it("turns spellcheck off and says the placeholder for the mode", () => {
    const optional = renderCard(hillDecision());
    const note = optional.openNote();
    expect(note).toHaveAttribute("spellcheck", "false");
    expect(note).toHaveAttribute("placeholder", "Add a note");
    optional.unmount();
    const required = renderCard(hillDecision({ text: "required" }));
    expect(required.slot("decision-text")).toHaveAttribute("placeholder", "Write your answer");
  });

  it("draws no field when the decision takes no words", () => {
    const { slot } = renderCard(hillDecision({ text: "none" }));
    expect(slot("decision-text")).toBeNull();
    expect(slot("decision-note")).toBeNull();
  });
});

describe("Add a note", () => {
  it("keeps an optional note behind its tap, and opens the field, the hint and Send", () => {
    const { slot } = renderCard(hillDecision());
    const toggle = slot("decision-note")!;
    expect(toggle).toHaveTextContent("Add a note");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(slot("decision-text")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", slot("decision-note-panel")!.id);
    expect(slot("decision-text")).not.toBeNull();
    expect(slot("decision-note-hint")).toHaveTextContent("The note goes with the option you tap.");
    expect(slot("decision-send")).toBeDisabled();
  });

  it("keeps a note with words in it open, so the words never ride on a tap unseen", () => {
    const { slot, openNote } = renderCard(hillDecision());
    fireEvent.change(openNote(), { target: { value: "after the leg" } });
    expect(slot("decision-note")).toBeDisabled();
    fireEvent.change(slot("decision-text")!, { target: { value: "  " } });
    expect(slot("decision-note")).toBeEnabled();
  });

  it("draws a required answer open, with no tap in front of it", () => {
    const { slot } = renderCard(hillDecision({ text: "required" }));
    expect(slot("decision-note")).toBeNull();
    expect(slot("decision-text")).not.toBeNull();
  });

  it("draws the words of a Decision with no options open: they are the answer", () => {
    const { slot } = renderCard(hillDecision({ options: [], text: "optional" }));
    expect(slot("decision-note")).toBeNull();
    expect(slot("decision-text")).not.toBeNull();
    expect(slot("decision-send")).toHaveTextContent("Send answer");
  });

  it("takes no note on a card that takes no answers", () => {
    const { slot } = renderCard(hillDecision(), { phase: "sending", intent: "yes", text: null });
    expect(slot("decision-note")).toBeDisabled();
  });
});

describe("answering", () => {
  it("sends an option without a confirm on the first tap, with the note", () => {
    const { option, openNote, onSend } = renderCard(hillDecision());
    fireEvent.change(openNote(), { target: { value: "  after the leg  " } });
    fireEvent.click(option("no"));
    expect(onSend).toHaveBeenCalledWith("no", "after the leg");
  });

  it("sends words alone with Send answer, which waits for words", () => {
    const { slot, onSend } = renderCard(hillDecision({ options: [], text: "required" }));
    expect(slot("decision-send")).toBeDisabled();
    fireEvent.change(slot("decision-text")!, { target: { value: "Lead with the zoom fix." } });
    expect(slot("decision-send")).toBeEnabled();
    fireEvent.click(slot("decision-send")!);
    expect(onSend).toHaveBeenCalledWith("answer", "Lead with the zoom fix.");
  });

  it("holds the options while a required answer has no words, and says why", () => {
    const { option, slot, onSend } = renderCard(hillDecision({ text: "required" }));
    expect(slot("decision-required-hint")).toHaveTextContent("Write your answer first.");
    expect(option("yes")).toBeDisabled();
    expect(option("yes")).toHaveAttribute("aria-describedby", slot("decision-required-hint")!.id);
    fireEvent.click(option("yes"));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(slot("decision-text")!, { target: { value: "Because main builds." } });
    expect(option("yes")).toBeEnabled();
    fireEvent.click(option("yes"));
    expect(onSend).toHaveBeenCalledWith("yes", "Because main builds.");
  });
});

describe("lists the card keys by place and value", () => {
  it("draws two options and two links that repeat a value without a key collision", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const same = { label: "CI", href: "https://ci.example.com/a" };
    const { container, slot } = renderCard(
      hillDecision({
        options: [
          { intent: "yes", label: "Yes" },
          { intent: "yes", label: "Yes, again" },
        ],
        links: [same, same],
        body: "More.",
      }),
    );
    fireEvent.click(slot("decision-more")!);
    expect(container.querySelectorAll('[data-slot="decision-option"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="decision-link"]')).toHaveLength(2);
    expect(error.mock.calls.filter(([message]) => String(message).includes("same key"))).toEqual([]);
    error.mockRestore();
  });
});

describe("arm, then send", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms a confirm option on the first tap, with the confirm word and the armed tint", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    expect(option("reset")).toHaveTextContent("Reset now");
    expect(option("reset")).toHaveAttribute("aria-label", "Reset now: tap again to confirm");
    expect(option("reset").className).toContain("border-destructive/40");
  });

  it("ignores a second tap inside the dwell, and sends on one after it", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS - 100));
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(option("reset"));
    expect(onSend).toHaveBeenCalledWith("reset", null);
  });

  it("lapses after ARM_MS, back to the label", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    act(() => vi.advanceTimersByTime(ARM_MS));
    expect(option("reset")).toHaveTextContent("Reset to main");
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    expect(option("reset")).toHaveTextContent("Reset now");
  });

  it("drops the arm when another option is tapped", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    fireEvent.click(option("keep"));
    expect(onSend).toHaveBeenCalledWith("keep", null);
    expect(option("reset")).toHaveTextContent("Reset to main");
  });

  it("drops the arm when the answer's words change, so the second tap needs a new first one", () => {
    const { slot, option, openNote, onSend } = renderCard(withConfirm());
    fireEvent.change(openNote(), { target: { value: "Because." } });
    fireEvent.click(option("reset"));
    expect(option("reset")).toHaveTextContent("Reset now");
    fireEvent.change(slot("decision-text")!, { target: { value: "Because main builds." } });
    expect(option("reset")).toHaveTextContent("Reset to main");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    expect(option("reset")).toHaveTextContent("Reset now");
  });

  it("asks for a second tap on Dismiss too", () => {
    const { slot, onSend } = renderCard(hillDecision());
    const dismiss = slot("decision-dismiss")!;
    fireEvent.click(dismiss);
    expect(onSend).not.toHaveBeenCalled();
    expect(dismiss.className).toContain("text-destructive");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(dismiss);
    expect(onSend).toHaveBeenCalledWith("dismiss", null);
  });

  it("sends a dismiss with no text even when the field holds words: the bridge refuses a dismiss that carries text", () => {
    const { slot, openNote, onSend } = renderCard(hillDecision());
    fireEvent.change(openNote(), { target: { value: "never mind, not now" } });
    const dismiss = slot("decision-dismiss")!;
    fireEvent.click(dismiss);
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(dismiss);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("dismiss", null);
  });
});

describe("after the tap", () => {
  it("says Sending… and locks the card while the answer is in flight", () => {
    const { slot, option } = renderCard(hillDecision(), { phase: "sending", intent: "yes", text: null });
    expect(slot("decision-status")).toHaveTextContent("Sending…");
    expect(option("yes")).toBeDisabled();
    expect(slot("decision-dismiss")).toBeDisabled();
  });

  it.each<[string, HillReceipt, string, string]>([
    ["typed", hillReceipt(), "yes", "Sent to collie lead"],
    ["held", hillReceipt({ delivery: "held" }), "yes", "Sent. collie lead gets it when its turn ends"],
    ["unknown delivery", hillReceipt({ delivery: "unknown" }), "yes", "Sent, not confirmed"],
    ["unknown", hillReceipt({ code: "unknown", state: null, delivery: null }), "yes", "Sent, not confirmed"],
    ["dismissed", hillReceipt({ delivery: "none", state: "dismissed" }), "dismiss", "Dismissed"],
    ["rejected", hillReceipt({ code: "rejected", state: null, delivery: null, reason: "text is required" }), "yes", "Not accepted: an answer in words is required"],
    ["gone, ended", hillReceipt({ code: "gone", state: null, delivery: null, reason: "target session ended" }), "yes", "The session that asked has ended"],
    ["denied", hillReceipt({ code: "denied", state: null, delivery: null }), "yes", "This device may not answer"],
  ])("says the %s receipt in words", (_name, receipt, intent, words) => {
    const { slot } = renderCard(hillDecision(), answered(receipt, intent));
    expect(slot("decision-receipt")).toHaveTextContent(words);
  });

  it("locks the card after an answer that landed, and keeps it open after a refusal", () => {
    const landed = renderCard(hillDecision(), answered(hillReceipt()));
    expect(landed.option("yes")).toBeDisabled();
    landed.unmount();
    const refused = renderCard(hillDecision(), answered(hillReceipt({ code: "rejected", state: null, delivery: null })));
    expect(refused.option("yes")).toBeEnabled();
  });

  it("keeps the card answerable after a denied answer, with the notice that says it was not accepted", () => {
    const denied = renderCard(hillDecision(), answered(hillReceipt({ code: "denied", state: null, delivery: null })));
    expect(denied.slot("decision-receipt")).toHaveTextContent("This device may not answer");
    expect(denied.option("yes")).toBeEnabled();
    expect(denied.slot("decision-dismiss")).toBeEnabled();
  });

  it("keeps the words of a gone answer on screen with Copy", () => {
    // Copy draws only where the page can copy; jsdom has no clipboard of its own.
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    onTestFinished(() => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    });
    const { slot } = renderCard(hillDecision(), answered(hillReceipt({ code: "gone", state: null, delivery: null }), "yes", "Not before the leg."));
    const kept = slot("decision-kept")!;
    expect(kept).toHaveTextContent("Your answer, not delivered");
    expect(kept).toHaveTextContent("Not before the leg.");
    expect(within(kept).getByRole("button", { name: "Copy your answer" })).toBeInTheDocument();
  });

  it("keeps nothing for a gone answer without words", () => {
    const { slot } = renderCard(hillDecision(), answered(hillReceipt({ code: "gone", state: null, delivery: null })));
    expect(slot("decision-kept")).toBeNull();
  });

  it("says Not sent. and retries the same attempt", () => {
    const { slot, onSend } = renderCard(hillDecision(), { phase: "failed", intent: "no", text: "later" });
    expect(slot("decision-status")).toHaveTextContent("Not sent.");
    fireEvent.click(slot("decision-retry")!);
    expect(onSend).toHaveBeenCalledWith("no", "later");
  });
});

describe("a trick's decision", () => {
  const m96 = { label: "m96-hill", host: "bluefin", unattended: false } as const;

  it("names the trick and the word trick on the meta line, in the poster's slot", () => {
    const { slot } = renderCard(trickDecision());
    expect(slot("decision-meta")?.textContent).toMatch(/Look\s*·\s*trick/);
    expect(slot("decision-meta")).not.toHaveTextContent("collie lead");
  });

  it("shows the machine's name on the meta line, never the routing host", () => {
    const base = trickDecision();
    const { slot } = renderCard({ ...base, from: { ...base.from, host: "bluefin", trickHost: "collie-04rj6a" } });
    expect(slot("decision-meta")?.textContent).toMatch(/Look\s*·\s*trick\s*bluefin/);
    expect(slot("decision-host")).toHaveTextContent("bluefin");
    expect(slot("decision-meta")).not.toHaveTextContent("collie-04rj6a");
  });

  it("leaves an agent's meta line without the word trick", () => {
    const { slot } = renderCard(hillDecision());
    expect(slot("decision-meta")?.textContent).not.toContain("trick");
  });

  it("says the answer goes to the trick when nothing else gets it", () => {
    const { slot } = renderCard(trickDecision());
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to the Look trick");
  });

  it("names the target and the trick when the trick set a reply target", () => {
    const { slot } = renderCard(trickDecision({ target: m96 }));
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to m96-hill on bluefin and to the Look trick");
  });

  it("drops the machine when the bridge names none", () => {
    const { slot } = renderCard(trickDecision({ target: { ...m96, host: null } }));
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to m96-hill and to the Look trick");
  });

  it("keeps an agent's target line as it was", () => {
    const { slot } = renderCard(hillDecision());
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to collie lead on bluefin");
  });

  it.each<[string, HillDecision, HillReceipt, string, string]>([
    ["typed and ran", trickDecision({ target: m96 }), hillReceipt({ trick: "ran" }), "yes", "Sent to m96-hill · recorded by Look"],
    ["held and ran", trickDecision({ target: m96 }), hillReceipt({ delivery: "held", trick: "ran" }), "yes", "Sent. m96-hill gets it when its turn ends · recorded by Look"],
    ["unconfirmed and ran", trickDecision({ target: m96 }), hillReceipt({ delivery: "unknown", trick: "ran" }), "yes", "Sent, not confirmed · recorded by Look"],
    ["no target and ran", trickDecision(), hillReceipt({ delivery: "none", trick: "ran" }), "yes", "Recorded by Look"],
    ["dismissed and ran", trickDecision({ target: m96 }), hillReceipt({ delivery: "none", state: "dismissed", trick: "ran" }), "dismiss", "Recorded by Look"],
    ["failed, with a target", trickDecision({ target: m96 }), hillReceipt({ trick: "failed" }), "yes", "Sent, but Look did not take it"],
    ["failed, no target", trickDecision(), hillReceipt({ delivery: "none", trick: "failed" }), "yes", "Sent, but Look did not take it"],
    ["an agent's, typed", hillDecision(), hillReceipt(), "yes", "Sent to collie lead"],
    ["an agent's, dismissed", hillDecision(), hillReceipt({ delivery: "none", state: "dismissed" }), "dismiss", "Dismissed"],
  ])("says the receipt of %s", (_name, decision, receipt, intent, words) => {
    const { slot } = renderCard(decision, answered(receipt, intent));
    expect(slot("decision-receipt")?.textContent).toBe(words);
  });

  it("still names a refusal the way it did", () => {
    const refused = hillReceipt({ code: "rejected", state: null, delivery: null, trick: null, reason: "text is required" });
    const { slot } = renderCard(trickDecision(), answered(refused));
    expect(slot("decision-receipt")?.textContent).toBe("Not accepted: an answer in words is required");
  });
});

describe("who asks, on the first line", () => {
  it("tints the machine's glyph on a crew, and only the glyph", () => {
    const { container } = render(<DecisionCard decision={hillDecision()} answer={HILL_IDLE} onSend={() => {}} hostSlot={6} />);
    const host = container.querySelector('[data-slot="decision-host"]')!;
    expect(host.querySelector('[data-icon="machine"]')?.getAttribute("class")).toContain("text-host-6");
    expect(host.className).not.toContain("text-host");
  });

  it("leaves the glyph muted on a solo install", () => {
    const { container } = render(<DecisionCard decision={hillDecision()} answer={HILL_IDLE} onSend={() => {}} />);
    expect(container.querySelector('[data-slot="decision-host"] [data-icon="machine"]')?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("draws a trick's own icon on a tile, and the default icon for a word it does not know", () => {
    const known = render(<DecisionCard decision={trickDecision()} answer={HILL_IDLE} onSend={() => {}} trickIcon="search" />);
    expect(known.container.querySelector('[data-slot="decision-trick-mark"] [data-icon]')).toHaveAttribute("data-icon", "mod-icon-search");
    known.unmount();
    const unknown = render(<DecisionCard decision={trickDecision()} answer={HILL_IDLE} onSend={() => {}} trickIcon="no-such-word" />);
    expect(unknown.container.querySelector('[data-slot="decision-trick-mark"] svg')).not.toBeNull();
  });
});

import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, onTestFinished, vi } from "vitest";

import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";
import type { HillDecision, HillReceipt } from "@/lib/hill/wire";
import { hillDecision, hillReceipt } from "@/test/hill-fixtures";

import { DecisionCard } from "./decision-card";

// The Decision card (M96): what it shows, that nothing is chosen for the person, the arm on a
// confirm option and on Dismiss, the gate on a required answer, and what it says after each tap.
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
  return { ...view, onSend, slot, option };
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
    expect(slot("decision-meta")).toHaveTextContent("collie lead");
    expect(slot("decision-meta")).toHaveTextContent("bluefin");
    expect(slot("decision-title")).toHaveTextContent("Merge it?");
    expect(slot("decision-summary")).toHaveTextContent("CI is green.");
  });

  it("marks the recommended option but never selects or focuses it", () => {
    const { slot, option } = renderCard(hillDecision({ recommends: { intent: "yes", why: "Edge reaches testers first." } }));
    expect(slot("decision-recommends")).toHaveTextContent("Recommended: Yes, Edge first");
    expect(slot("decision-recommends")).toHaveTextContent("Edge reaches testers first.");
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

  it("says where the answer goes, and that the target runs without prompts", () => {
    const { slot } = renderCard(hillDecision({ target: { label: "m96-hill", host: "minibuch", unattended: true } }));
    expect(slot("decision-target")).toHaveTextContent("Your answer goes to m96-hill on minibuch");
    expect(slot("decision-target")).toHaveTextContent("runs without prompts");
  });

  it("turns spellcheck off and says the placeholder for the mode", () => {
    const optional = renderCard(hillDecision());
    expect(optional.slot("decision-text")).toHaveAttribute("spellcheck", "false");
    expect(optional.slot("decision-text")).toHaveAttribute("placeholder", "Add a note");
    optional.unmount();
    const required = renderCard(hillDecision({ text: "required" }));
    expect(required.slot("decision-text")).toHaveAttribute("placeholder", "Write your answer");
  });

  it("draws no field when the decision takes no words", () => {
    expect(renderCard(hillDecision({ text: "none" })).slot("decision-text")).toBeNull();
  });
});

describe("answering", () => {
  it("sends an option without a confirm on the first tap, with the note", () => {
    const { option, slot, onSend } = renderCard(hillDecision());
    fireEvent.change(slot("decision-text")!, { target: { value: "  after the leg  " } });
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
    const { slot, onSend } = renderCard(hillDecision());
    fireEvent.change(slot("decision-text")!, { target: { value: "never mind, not now" } });
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

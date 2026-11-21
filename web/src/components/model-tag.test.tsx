import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatCost, hasFigure, hasGauge, isHot, MODEL_TAG_ROOM, ModelTag, modelTagShows } from "./model-tag";
import type { StatusItem } from "./trick-status-item";
import { UsageRowControl } from "./usage-row-control";

afterEach(() => localStorage.clear());

describe("ModelTag", () => {
  it("draws the short model name, named for a screen reader, and takes no touch", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    // The eye reads the short name; the screen reader reads the sentence from the dictionary.
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5");
    expect(tag?.className).toContain("pointer-events-none");
    // Absolute and owning no line, so it arriving or leaving moves nothing (DESIGN.md §2).
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("draws the effort after the model, in the harness's own word, for the eye and the screen reader", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · high");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5 · high");
  });

  it("an empty or hostile effort draws the model alone, and an effort never draws without a model", () => {
    const alone = (effort: string | undefined) =>
      render(<ModelTag model="claude-opus-5-5" effort={effort} />).container.querySelector("[aria-hidden]")?.textContent;
    expect(alone(undefined)).toBe("Opus 5.5");
    expect(alone("  ")).toBe("Opus 5.5");
    expect(alone("\u001b[31m\u0007")).toBe("Opus 5.5");
    expect(alone(`  ${"x".repeat(40)} `)).toBe(`Opus 5.5 · ${"x".repeat(15)}…`);
    expect(render(<ModelTag model={undefined} effort="high" />).container.innerHTML).toBe("");
  });

  it("draws nothing at all without a model", () => {
    expect(render(<ModelTag model={undefined} />).container.innerHTML).toBe("");
    expect(render(<ModelTag model="  " />).container.innerHTML).toBe("");
  });
});

describe("isHot, the one red rule", () => {
  it("is the whole percentage as written, 80 or more, for every gauge and both modes", () => {
    expect([0, 79, 79.4].map(isHot)).toEqual([false, false, false]);
    expect([79.5, 80, 81, 100, 130].map(isHot)).toEqual([true, true, true, true, true]);
    expect([-4, Number.NaN].map(isHot)).toEqual([false, false]);
  });

  it("turns the number and the lit dots red together, in ctx, 5h and 7d", () => {
    const usage = { context: 79.6, limits: [{ window: "5h" as const, used: 80 }, { window: "7d" as const, used: 79 }] };
    for (const mode of ["percent", "dots"] as const) {
      const { container } = render(<ModelTag model={undefined} usage={usage} usageRow={mode} />);
      const hot = [...container.querySelectorAll("[data-gauge]")].map((g) => g.querySelector("[data-hot]") !== null);
      expect(hot).toEqual([true, true, false]);
    }
    const { container } = render(<ModelTag model={undefined} usage={{ context: 85 }} usageRow="dots" />);
    const lit = [...container.querySelectorAll("[data-slot='usage-dots'] > span")];
    expect(lit.filter((d) => d.className.includes("bg-status-blocked"))).toHaveLength(4);
    expect(lit.some((d) => d.className.includes("bg-status-working"))).toBe(false);
  });
});

describe("ModelTag usage dots (the Dots choice)", () => {
  const usage = { context: 42, limits: [{ window: "5h" as const, used: 58 }, { window: "7d" as const, used: 81 }] };

  it("draws a gauge per reported number after the model, five dots each, and says the figures", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" usage={usage} usageRow="dots" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · highctx5h7d");
    const gauges = [...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"));
    expect(gauges).toEqual(["context", "5h", "7d"]);
    const dots = [...container.querySelectorAll("[data-slot='usage-dots']")];
    expect(dots.map((d) => d.getAttribute("data-lit"))).toEqual(["2", "2", "4"]);
    expect(dots.every((d) => d.children.length === 5)).toBe(true);
    // 80% and up is red; under it is not.
    expect(dots.map((d) => d.hasAttribute("data-hot"))).toEqual([false, false, true]);
    expect(tag?.querySelector(".sr-only")?.textContent).toBe(
      "Model Opus 5.5 · high. Context 42% used. 5-hour limit 58% used. 7-day limit 81% used",
    );
    // Still absolute and still no touch with the dots in it (DESIGN.md §2).
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).toContain("pointer-events-none");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("draws the dots alone while the screen names the model, and only the gauges reported", () => {
    const { container } = render(<ModelTag model={undefined} effort="high" usage={{ context: 7 }} usageRow="dots" />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("ctx");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Context 7% used");
  });

  it("draws nothing for an empty reading", () => {
    expect(render(<ModelTag model={undefined} usage={{}} />).container.innerHTML).toBe("");
    expect(render(<ModelTag model={undefined} usage={{ limits: [] }} />).container.innerHTML).toBe("");
  });

  it("lights one dot per full fifth, so only 100% lights the fifth", () => {
    const lit = (context: number) =>
      render(<ModelTag model={undefined} usage={{ context }} usageRow="dots" />).container.querySelector("[data-slot='usage-dots']")?.getAttribute("data-lit");
    // One dot per FULL fifth: only a full window lights the fifth dot.
    expect(lit(0)).toBe("0");
    expect(lit(19)).toBe("0");
    expect(lit(20)).toBe("1");
    expect(lit(81)).toBe("4");
    expect(lit(99)).toBe("4");
    expect(lit(100)).toBe("5");
  });
});

describe("ModelTag draws the windows the agent reports (M101 spec 02)", () => {
  const text = (container: HTMLElement) => container.querySelector("[aria-hidden]")?.textContent;
  const spoken = (container: HTMLElement) => container.querySelector(".sr-only")?.textContent;

  it("draws a plan that reports one window as one window", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ limits: [{ window: "7d", used: 12 }] }} />);
    expect(text(container)).toBe("7d12%");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["7d"]);
    expect(spoken(container)).toBe("7-day limit 12% used");
  });

  it("draws a model-scoped weekly window as 7d and its label, and says both", () => {
    const usage = { limits: [{ window: "5h", used: 10 }, { window: "7d", used: 20 }, { window: "7d:opus", used: 30, label: "Opus" }] };
    const { container } = render(<ModelTag model={undefined} usage={usage} />);
    expect(text(container)).toBe("5h10%7d20%7d Opus30%");
    expect(spoken(container)).toBe("5-hour limit 10% used. 7-day limit 20% used. 7-day Opus limit 30% used");
  });

  it("falls back to the key after 7d: when the label is missing, and cuts a long label", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ limits: [{ window: "7d:sonnet-4.6", used: 5 }, { window: "7d:x", used: 6, label: "A very long model name" }] }} />);
    expect(text(container)).toBe("7d sonnet-4.65%7d A very lo\u20266%");
    expect(spoken(container)).toContain("7-day A very long model name limit 6% used");
  });

  it("draws any other window by its label, else its key, and no longer skips it", () => {
    const usage = { limits: [{ window: "30d", used: 50 }, { window: "spend", used: 61, label: "Spend" }] };
    const { container } = render(<ModelTag model={undefined} usage={usage} />);
    expect(text(container)).toBe("30d50%Spend61%");
    expect(spoken(container)).toBe("30d limit 50% used. Spend limit 61% used");
  });

  it("words an unlabelled spend or credits window, and keeps a label the agent sent", () => {
    const usage = { limits: [{ window: "spend", used: 61 }, { window: "credits", used: 5 }, { window: "other", used: 7, label: "Mine" }] };
    const { container } = render(<ModelTag model={undefined} usage={usage} />);
    expect(text(container)).toBe("Spend61%Credits5%Mine7%");
  });

  it("holds the row to three windows and counts the rest, while the screen reader hears every one", () => {
    const limits = [
      { window: "5h", used: 10 },
      { window: "7d", used: 20 },
      { window: "7d:opus", used: 30, label: "Opus" },
      { window: "7d:sonnet", used: 40, label: "Sonnet" },
    ];
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" usage={{ context: 5, limits }} />);
    expect(text(container)).toBe("Opus 5.5 · highctx5%5h10%7d20%7d Opus30%+1");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["context", "5h", "7d", "7d:opus"]);
    expect(container.querySelector("[data-slot='usage-more']")?.textContent).toBe("+1");
    expect(spoken(container)).toBe(
      "Model Opus 5.5 · high. Context 5% used. 5-hour limit 10% used. 7-day limit 20% used. 7-day Opus limit 30% used. 7-day Sonnet limit 40% used",
    );
    // Three windows draw no counter.
    const three = render(<ModelTag model={undefined} usage={{ limits: limits.slice(0, 3) }} />);
    expect(three.container.querySelector("[data-slot='usage-more']")).toBeNull();
  });

  it("counts a window past the third in dots mode as well", () => {
    const limits = Array.from({ length: 5 }, (_, i) => ({ window: `w${String(i)}`, used: i * 10 }));
    const { container } = render(<ModelTag model={undefined} usage={{ limits }} usageRow="dots" />);
    expect(container.querySelectorAll("[data-slot='usage-dots']")).toHaveLength(3);
    expect(container.querySelector("[data-slot='usage-more']")?.textContent).toBe("+2");
  });

  it("is red from 80% on a scoped or unknown window just as on 5h and 7d", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ limits: [{ window: "7d:opus", used: 90, label: "Opus" }, { window: "30d", used: 10 }] }} />);
    expect([...container.querySelectorAll("[data-slot='usage-percent']")].map((f) => f.hasAttribute("data-hot"))).toEqual([true, false]);
  });

  it("counts any window as a gauge for the caller", () => {
    expect(hasGauge({ limits: [{ window: "30d", used: 50 }] })).toBe(true);
  });
});

describe("ModelTag usage percent (the default)", () => {
  const usage = { context: 19, limits: [{ window: "5h" as const, used: 58 }, { window: "7d" as const, used: 83 }] };
  const figures = (container: HTMLElement) => [...container.querySelectorAll("[data-slot='usage-percent']")];

  it("draws a whole percentage per gauge, in the same labels and order, and no dots", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="medium" usage={usage} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · mediumctx19%5h58%7d83%");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["context", "5h", "7d"]);
    expect(figures(container).map((f) => f.textContent)).toEqual(["19%", "58%", "83%"]);
    expect(container.querySelector("[data-slot='usage-dots']")).toBeNull();
    expect(figures(container).every((f) => f.className.includes("tabular-nums"))).toBe(true);
    // The screen reader keeps the sentence it always had.
    expect(tag?.querySelector(".sr-only")?.textContent).toBe(
      "Model Opus 5.5 · medium. Context 19% used. 5-hour limit 58% used. 7-day limit 83% used",
    );
  });

  it("rounds to a whole number and holds it to 0 to 100", () => {
    const text = (context: number) =>
      render(<ModelTag model={undefined} usage={{ context }} />).container.querySelector("[data-slot='usage-percent']")?.textContent;
    expect(text(0)).toBe("0%");
    expect(text(18.6)).toBe("19%");
    expect(text(41.4)).toBe("41%");
    expect(text(100)).toBe("100%");
    expect(text(130)).toBe("100%");
    expect(text(-4)).toBe("0%");
  });

  it("turns red from 80% and not before, on the number as written", () => {
    const tone = (context: number) => {
      const el = render(<ModelTag model={undefined} usage={{ context }} />).container.querySelector("[data-slot='usage-percent']");
      return [el?.hasAttribute("data-hot"), el?.className.includes("text-status-blocked"), el?.className.includes("text-status-working")];
    };
    expect(tone(79)).toEqual([false, false, false]);
    expect(tone(79.4)).toEqual([false, false, false]);
    expect(tone(79.5)).toEqual([true, true, false]);
    expect(tone(80)).toEqual([true, true, false]);
    expect(tone(100)).toEqual([true, true, false]);
  });

  it("draws nothing for a gauge that is not reported, and never NaN% or 0% for it", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ context: Number.NaN, limits: [{ window: "7d", used: Number.POSITIVE_INFINITY }, { window: "5h", used: 12 }] }} />);
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["5h"]);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(figures(container).map((f) => f.textContent)).toEqual(["12%"]);
    expect(render(<ModelTag model={undefined} usage={{ context: Number.NaN }} />).container.innerHTML).toBe("");
    expect(hasGauge({ context: Number.NaN })).toBe(false);
  });
});

describe("ModelTag context with no stated window: the token count", () => {
  const usage = { contextTokens: 222_200, limits: [{ window: "5h" as const, used: 58 }] };

  it("draws the count in the context's place in Percent, in the same label and type, and says it", () => {
    const { container } = render(<ModelTag model="claude-fable-5-2" usage={usage} usageRow="percent" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Fable 5.2ctx222k5h58%");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["context", "5h"]);
    const count = container.querySelector("[data-slot='usage-tokens'] .tabular-nums");
    expect(count?.textContent).toBe("222k");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Fable 5.2. Context 222k tokens. 5-hour limit 58% used");
  });

  it("is never red, whatever the count", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ contextTokens: 950_000 }} usageRow="percent" />);
    expect(container.querySelector("[data-slot='usage-tokens']")?.textContent).toBe("ctx950k");
    expect(container.querySelector("[data-hot]")).toBeNull();
    expect(container.innerHTML).not.toContain("text-status-blocked");
  });

  it("draws no dot in Dots, since there is no window to take a fifth of, and still says the count", () => {
    const { container } = render(<ModelTag model="claude-fable-5-2" usage={usage} usageRow="dots" />);
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["5h"]);
    expect(container.querySelector("[data-slot='usage-tokens']")).toBeNull();
    expect(container.querySelector(".sr-only")?.textContent).toContain("Context 222k tokens");
    expect(render(<ModelTag model={undefined} usage={{ contextTokens: 5 }} usageRow="dots" />).container.innerHTML).toBe("");
  });

  it("a share wins over the count, and a count that is no number draws nothing", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ context: 22.2, contextTokens: 222_200 }} usageRow="percent" />);
    expect(container.querySelector("[data-slot='usage-percent']")?.textContent).toBe("22%");
    expect(container.querySelector("[data-slot='usage-tokens']")).toBeNull();
    expect(render(<ModelTag model={undefined} usage={{ contextTokens: Number.NaN }} usageRow="percent" />).container.innerHTML).toBe("");
  });

  it("counts as a figure for the caller, so the model name stays beside it", () => {
    expect(hasFigure({ contextTokens: 222_200 })).toBe(true);
    expect(hasGauge({ contextTokens: 222_200 })).toBe(false);
    expect(modelTagShows({ model: undefined, usage: { contextTokens: 222_200 } })).toBe(true);
  });
});

describe("The Usage row setting reaches the tag", () => {
  const usage = { context: 42, limits: [{ window: "7d" as const, used: 81 }] };
  const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

  it("is Percent on a device that never chose, and on a stored value it does not know", () => {
    expect(render(<ModelTag model={undefined} usage={usage} />).container.querySelector("[data-slot='usage-percent']")).not.toBeNull();
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ usageRow: "bars" }));
    expect(render(<ModelTag model={undefined} usage={usage} />).container.querySelector("[data-slot='usage-dots']")).toBeNull();
  });

  it("draws dots when the device stored Dots", () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ usageRow: "dots" }));
    const { container } = render(<ModelTag model={undefined} usage={usage} />);
    expect(container.querySelectorAll("[data-slot='usage-dots']")).toHaveLength(2);
    expect(container.querySelector("[data-slot='usage-percent']")).toBeNull();
  });

  it("switches a tag that stays mounted when the choice is made in Settings, and stores it", async () => {
    const { container } = render(
      <>
        <ModelTag model={undefined} usage={usage} />
        <UsageRowControl />
      </>,
    );
    expect(screen.getByRole("radiogroup", { name: "Context and limits" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Percent" })).toHaveAttribute("aria-checked", "true");
    expect(stored().usageRow).toBeUndefined();
    await userEvent.click(screen.getByRole("radio", { name: "Dots" }));
    expect(stored().usageRow).toBe("dots");
    expect(screen.getByRole("radio", { name: "Dots" })).toHaveAttribute("aria-checked", "true");
    expect(container.querySelectorAll("[data-slot='usage-dots']")).toHaveLength(2);
    expect(container.querySelector("[data-slot='usage-percent']")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Percent" }));
    expect(stored().usageRow).toBe("percent");
    expect(container.querySelectorAll("[data-slot='usage-percent']")).toHaveLength(2);
  });
});

// The caller keeps the model beside the dots while the screen names it, so "a gauge to draw" is one
// answer in one place.
describe("hasGauge", () => {
  it("is true for a context or a window this build draws, false for nothing", () => {
    expect(hasGauge({ context: 0 })).toBe(true);
    expect(hasGauge({ limits: [{ window: "7d", used: 5 }] })).toBe(true);
    expect(hasGauge({})).toBe(false);
    expect(hasGauge(undefined)).toBe(false);
  });
});

describe("formatCost", () => {
  it("writes under a cent as <$0.01, two decimals under $100, whole dollars from there", () => {
    expect(formatCost(0)).toBe("<$0.01");
    expect(formatCost(0.0099)).toBe("<$0.01");
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.114)).toBe("$0.11");
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(99.99)).toBe("$99.99");
    expect(formatCost(100)).toBe("$100");
    expect(formatCost(123.45)).toBe("$123");
    expect(formatCost(1234.5)).toBe("$1235");
  });

  it("never writes $100.00, and reads a value that is no amount as under a cent", () => {
    expect(formatCost(99.996)).toBe("$100");
    expect(formatCost(Number.NaN)).toBe("<$0.01");
    expect(formatCost(-3)).toBe("<$0.01");
  });
});

describe("ModelTag session cost", () => {
  it("draws the cost after the last gauge, as a figure and not a gauge, and says it", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ context: 42, cost: 0.1137 }} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5ctx42%$0.11");
    const cost = container.querySelector("[data-slot='usage-cost']");
    expect(cost?.textContent).toBe("$0.11");
    expect(cost?.className).toContain("tabular-nums");
    expect(cost?.className).not.toContain("status-working");
    expect(cost?.querySelector("[data-slot='usage-dots']")).toBeNull();
    expect(container.querySelectorAll("[data-gauge]")).toHaveLength(1);
    expect(cost?.previousElementSibling?.getAttribute("data-gauge")).toBe("context");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5. Context 42% used. Session cost $0.11");
  });

  it("draws <$0.01 for a cost under a cent", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ cost: 0.002 }} />);
    expect(container.querySelector("[data-slot='usage-cost']")?.textContent).toBe("<$0.01");
  });

  it("draws no cost span when none is reported, or when the number is not an amount", () => {
    for (const usage of [undefined, { context: 5 }, { cost: Number.NaN }, { cost: -1 }]) {
      const { container } = render(<ModelTag model="claude-opus-5-5" usage={usage} />);
      expect(container.querySelector("[data-slot='usage-cost']")).toBeNull();
      expect(container.querySelector(".sr-only")?.textContent).not.toContain("Session cost");
    }
  });

  it("draws a tag for a cost alone while the screen names the model, and hasGauge ignores the cost", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ cost: 12.5 }} />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("$12.50");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Session cost $12.50");
    expect(hasGauge({ cost: 12.5 })).toBe(false);
  });

  it("a cost counts like a gauge for the caller: hasFigure keeps the model name beside it", () => {
    expect(hasFigure({ cost: 0.11 })).toBe(true);
    expect(hasFigure({ context: 3 })).toBe(true);
    expect(hasFigure({ cost: Number.NaN })).toBe(false);
    expect(hasFigure({})).toBe(false);
    expect(hasFigure(undefined)).toBe(false);
    // The caller (agent-chat.tsx) passes the model whenever hasFigure is true, so the cost never floats alone.
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ cost: 0.11 }} />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5$0.11");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5. Session cost $0.11");
  });
});

describe("ModelTag trick status items", () => {
  const items: StatusItem[] = ["a", "b", "c"].map((id) => ({ id, trick: id, face: <span data-w="60">{`item ${id}`}</span> }));

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of ["offsetWidth", "scrollWidth", "clientWidth"]) Reflect.deleteProperty(HTMLElement.prototype, name);
  });

  /** jsdom has no layout: each element is as wide as its `data-w`, else 5px a character, else its first child's. */
  function stubLayout() {
    const width = (el: HTMLElement): number => {
      const own = el.dataset.w;
      if (own !== undefined) return Number(own);
      const child = el.firstElementChild;
      if (child instanceof HTMLElement && child.dataset.w !== undefined) return Number(child.dataset.w);
      return (el.textContent ?? "").length * 5;
    };
    for (const name of ["offsetWidth", "scrollWidth", "clientWidth"]) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return width(this); } });
    }
  }
  const hidden = (container: HTMLElement) => [...container.querySelectorAll("[data-status-item]")].filter((el) => el.hasAttribute("data-hidden")).map((el) => el.getAttribute("data-status-item"));

  it("draws the items at the left end, before Collie's own, in order, and a lone item draws the tag with no model", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" trailing={items} />);
    const row = container.querySelector("[data-slot='model-tag']")?.textContent;
    expect(row).toContain("item aitem bitem cOpus 5.5");
    expect(container.querySelectorAll("[data-status-item]")).toHaveLength(3);
    expect(render(<ModelTag model={undefined} trailing={items.slice(0, 1)} />).container.querySelector("[data-slot='model-tag']")?.textContent).toBe("item a");
    expect(render(<ModelTag model={undefined} trailing={[]} />).container.innerHTML).toBe("");
  });

  it("keeps the tag a box of no line and the tag itself touch-free", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" trailing={items} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.className).toContain("pointer-events-none");
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("hides the newest items first when the row is wider than its room, inert and invisible, still in the tree", () => {
    stubLayout();
    // The mirror box is 250px: the row is 24 less and the two ends' padding 16, so 210. The name stands down to its
    // floor of 24, each item is 60, gaps of 4 between items and 8 between the ends: 24 + 8 + 60 + 4 + 60 = 156 fits
    // two; the third makes 220.
    const { container } = render(
      <div data-w="250">
        <ModelTag model="claude-opus-5-5" trailing={items} />
      </div>,
    );
    expect(hidden(container)).toEqual(["c"]);
    const c = container.querySelector("[data-status-item='c']");
    expect(c?.className).toContain("invisible");
    expect(c?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("[data-status-item='a']")?.hasAttribute("inert")).toBe(false);
  });

  it("keeps every item and lets the model name give way first, and hides none with room to spare", () => {
    stubLayout();
    // A 100px box: 70% is 70, less 8, 62. "Opus 5.5" is 40; one 60px item would need 40 + 4 + 60 = 104, but the
    // name stands down to its floor (24): 24 + 4 + 60 = 88 is still over, so the item hides. The name is not the
    // thing that moved: it stays whole, and no item is hidden to make room for a name.
    const narrow = render(
      <div data-w="100">
        <ModelTag model="claude-opus-5-5" trailing={items} />
      </div>,
    );
    expect(hidden(narrow.container)).toEqual(["a", "b", "c"]);
    expect(narrow.container.querySelector("[data-slot='usage-own']")?.textContent).toBe("Opus 5.5");
    const wide = render(
      <div data-w="600">
        <ModelTag model="claude-opus-5-5" trailing={items} />
      </div>,
    );
    expect(hidden(wide.container)).toEqual([]);
  });

  describe("a full row: the chips at the left end, the model and the usage at the right end", () => {
    const usage = { context: 19, limits: [{ window: "5h" as const, used: 12 }, { window: "7d" as const, used: 3 }], cost: 0.11 };
    const chip = (width: number): StatusItem[] => [{ id: "crew-cpu", trick: "crew-cpu", face: <span data-w={String(width)}>Crew CPU</span> }];
    const label = (container: HTMLElement) => container.querySelector("[data-slot='usage-label']");
    const effortHidden = (container: HTMLElement) => container.querySelector("[data-slot='usage-effort']")?.hasAttribute("data-hidden");
    const tag = (container: HTMLElement) => container.querySelector("[data-slot='model-tag']");

    it("puts the chips first and pins the model and the usage to the right end, as two separate grounds", () => {
      const { container } = render(<ModelTag model="claude-opus-5-5" usage={usage} trailing={chip(70)} />);
      const row = tag(container)?.firstElementChild;
      const [left, right] = [...(row?.children ?? [])];
      expect(left?.getAttribute("data-slot")).toBe("usage-trick-items");
      expect(right?.getAttribute("data-slot")).toBe("usage-own");
      // The right end is pinned and never shrinks for a chip; the left end clips instead of pushing it.
      expect(right?.className).toMatch(/\bml-auto\b/);
      expect(right?.className).toMatch(/\bshrink-0\b/);
      expect(left?.className).toMatch(/\bmin-w-0\b/);
      expect(left?.className).toMatch(/\boverflow-x-clip\b/);
      // Under the row nothing takes a ground of its own: the empty space between the ends shows the mirror.
      expect(tag(container)?.className).not.toMatch(/\bbg-/);
      expect(tag(container)?.className).toMatch(/\binset-x-3\b/);
      expect(tag(container)?.className).toContain("pointer-events-none");
    });

    // The row at 360px is 336 wide, less 16 of padding: room 320. The model with its effort (85) and the figures
    // (30 + 25 + 20 + 25, three gaps of 4: 112) are 201 at the right end, and 8 stand between the ends. A chip of
    // 115 makes 324, over 320. Without the effort it is 279. At 390px the room is 350 and a chip of 145 makes 354.
    it.each([
      [360, 115],
      [390, 145],
    ])("at %ipx the chip stays and the effort leaves the name first", (width, chipWidth) => {
      stubLayout();
      const { container } = render(
        <div data-w={String(width)}>
          <ModelTag model="claude-opus-5-5" effort="medium" usage={usage} trailing={chip(chipWidth)} />
        </div>,
      );
      expect(hidden(container)).toEqual([]);
      expect(effortHidden(container)).toBe(true);
      expect(container.querySelector("[data-status-item='crew-cpu']")?.hasAttribute("inert")).toBe(false);
      // The figures are all still there, and the screen reader still hears the whole effort.
      expect(container.querySelectorAll("[data-gauge]")).toHaveLength(3);
      expect(container.querySelector("[data-slot='usage-cost']")?.textContent).toBe("$0.11");
      expect(container.querySelector(".sr-only")?.textContent).toContain("Model Opus 5.5 · medium");
      expect(label(container)?.className).toContain("truncate");
    });

    it("keeps the whole name with the effort while the empty space between the ends is there", () => {
      stubLayout();
      // 360px with the 70px chip: 201 + 8 + 70 = 279, under the room of 320. The space between shrinks first.
      const { container } = render(
        <div data-w="360">
          <ModelTag model="claude-opus-5-5" effort="medium" usage={usage} trailing={chip(70)} />
        </div>,
      );
      expect(hidden(container)).toEqual([]);
      expect(effortHidden(container)).toBe(false);
    });

    it("keeps the chip while the name is cut, and hides the last chips only when they alone fill the row", () => {
      stubLayout();
      // 220px: room 180. The name's floor (24) and the figures (112) make 140 with their gap, and 8 and 70 more
      // for the chip make 218: the chip cannot stay.
      const small = render(
        <div data-w="220">
          <ModelTag model="claude-opus-5-5" effort="medium" usage={usage} trailing={chip(70)} />
        </div>,
      );
      expect(hidden(small.container)).toEqual(["crew-cpu"]);
      // 340px: room 300. Two chips of 60 make 140 + 8 + 60 + 4 + 60 = 272, so both stay; the name has 52 left, the
      // short form (40) fits and the full one (85) does not.
      const two = render(
        <div data-w="340">
          <ModelTag model="claude-opus-5-5" effort="medium" usage={usage} trailing={items.slice(0, 2)} />
        </div>,
      );
      expect(hidden(two.container)).toEqual([]);
      expect(effortHidden(two.container)).toBe(true);
      // Three of them make 336: the last one gives way, the first two stay.
      const three = render(
        <div data-w="340">
          <ModelTag model="claude-opus-5-5" effort="medium" usage={usage} trailing={items} />
        </div>,
      );
      expect(hidden(three.container)).toEqual(["c"]);
    });
  });
});

// THE ROOM THE TAG TAKES FROM THE TAIL (#759): the scrollers under it keep this much clear below the last
// line while a tag shows. `modelTagShows` is the caller's copy of the tag's own "nothing to say" test.
describe("modelTagShows", () => {
  it("agrees with the tag: it shows for a model, a figure or a trick item, and for nothing else", () => {
    const shows = (props: Parameters<typeof modelTagShows>[0]): boolean => render(<ModelTag {...props} />).container.innerHTML !== "";
    const item: StatusItem = { id: "t", trick: "t", face: <span>x</span> };
    const cases: Parameters<typeof modelTagShows>[0][] = [
      { model: undefined },
      { model: "  " },
      { model: "claude-opus-5-5" },
      { model: undefined, usage: { context: 40 } },
      { model: undefined, usage: { cost: 0.5 } },
      { model: undefined, usage: {} },
      { model: undefined, trailing: [item] },
      { model: undefined, trailing: [] },
    ];
    for (const props of cases) expect(modelTagShows(props), JSON.stringify(props)).toBe(shows(props));
  });

  it("the room is the tag's top edge above the box bottom (bottom-1 plus its 12px line) and a little air", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.className).toContain("bottom-1");
    expect(tag?.className).toContain("text-[10px]/3");
    expect(MODEL_TAG_ROOM).toBeGreaterThanOrEqual(4 + 12);
  });
});

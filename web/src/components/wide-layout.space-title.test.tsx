import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SpaceTitle } from "@/components/wide-layout";

// THE SPACE'S NAME IN THE BAR GIVES WAY IN ORDER (e2e/wide-space-title.spec.ts measures the boxes). jsdom
// lays nothing out, so this holds the classes that decide the order: one line, the machine shrinks first
// and to nothing, the name then truncates, the whole line rides in `title`, a third of the row beside tabs,
// and a gap before the tabs.

const parts = (machine: string | undefined, besideTabs = true, widthClass: "medium" | "expanded" = "expanded") => {
  const { container } = render(<SpaceTitle label="a-long-space-name" machine={machine} widthClass={widthClass} besideTabs={besideTabs} />);
  const title = container.querySelector<HTMLElement>('[data-slot="space-title"]')!;
  return {
    title,
    name: title.querySelector<HTMLElement>('[data-slot="space-title-name"]')!,
    machine: title.querySelector<HTMLElement>('[data-slot="space-title-machine"]'),
  };
};

describe("SpaceTitle", () => {
  it("is one line with a gap before the tabs, and takes at most a third of the row beside tabs", () => {
    const { title } = parts("lodge");
    expect(title.className).toContain("whitespace-nowrap");
    expect(title.className).toContain("mr-3");
    expect(title.className).toContain("max-w-1/3");
    expect(title.className).toContain("min-w-0");
    expect(parts("lodge", false).title.className).toContain("max-w-[45%]");
    expect(parts("lodge", true, "medium").title.className).toContain("max-w-[30%]");
  });

  it("lets the machine give way first and wholly, then the name ends in an ellipsis", () => {
    const { name, machine } = parts("lodge");
    // The machine: shrinks 999 times as fast as the name, down to nothing.
    expect(machine!.className).toContain("shrink-[999]");
    expect(machine!.className).toContain("min-w-0");
    expect(machine!.className).toContain("truncate");
    // The name: the default shrink of 1, so it loses letters only once the machine is gone, with an ellipsis.
    expect(name.className).not.toMatch(/shrink-/);
    expect(name.className).toContain("min-w-0");
    expect(name.className).toContain("truncate");
    // Name before machine, in that order on the line.
    expect(name.nextElementSibling).toBe(machine);
  });

  it("carries the whole line in title, with or without a machine", () => {
    expect(parts("lodge").title.getAttribute("title")).toBe("a-long-space-name · lodge");
    const lone = parts(undefined);
    expect(lone.title.getAttribute("title")).toBe("a-long-space-name");
    expect(lone.machine).toBeNull();
    expect(lone.title.textContent).toBe("a-long-space-name");
  });
});

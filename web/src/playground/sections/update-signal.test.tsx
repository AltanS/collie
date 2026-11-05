import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UpdateSignalSection } from "./update-signal";

const SLOW = { timeout: 12_000 } as const;

function option(container: HTMLElement, n: number): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-state="update-signal-option-${n}"]`);
  if (found === null) throw new Error(`no option ${n}`);
  return found;
}

describe("the update signal round", () => {
  it(
    "shows the bead lines for the case, and none when quiet",
    async () => {
      const { container } = render(<UpdateSignalSection />);
      await waitFor(() => expect(option(container, 3).querySelector('[data-slot="collie-mark"]')).not.toBeNull(), SLOW);

      expect(within(option(container, 1)).queryByText(/Update ready/)).toBeNull();

      fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name: "Both" }));
      await waitFor(() => expect(within(option(container, 1)).getByText("Update ready: 1.27.1, 2 fixes")).toBeInTheDocument(), SLOW);
      expect(within(option(container, 1)).getByText("bluefin: CPU above 90% for 12 min")).toBeInTheDocument();
      expect(within(option(container, 0)).queryByText(/Update ready/)).toBeNull();
      expect(within(option(container, 0)).getByText("Collie 1.27.1 available")).toBeInTheDocument();
    },
    30_000,
  );

  it(
    "scrolls option 3 to its footer on a tap of the mark",
    async () => {
      const scrollTo = vi.fn();
      Element.prototype.scrollTo = scrollTo;
      const { container } = render(<UpdateSignalSection />);
      await waitFor(() => expect(option(container, 3).querySelector('[data-slot="collie-mark"]')).not.toBeNull(), SLOW);
      const mark = option(container, 3).querySelector('[data-slot="collie-mark"]')!;
      fireEvent.click(mark.closest("button")!);
      expect(scrollTo).toHaveBeenCalled();
    },
    30_000,
  );
});

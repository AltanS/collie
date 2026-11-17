import { act, render } from "@testing-library/react";
import { useState } from "react";

import { useFloatingClear } from "./use-floating-clear";

function Probe({ card }: { card: boolean }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const clear = useFloatingClear(slot);
  return (
    <>
      <p data-testid="clear">{clear}</p>
      <div ref={setSlot} data-testid="slot">
        {card && <div>Draft in terminal</div>}
      </div>
    </>
  );
}

describe("useFloatingClear", () => {
  const rect = (height: number) => ({ height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}) });

  it("is the slot's height while a card floats in it, and 0 once the slot is empty", async () => {
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(63.4));
    const { getByTestId, rerender } = render(<Probe card />);
    expect(getByTestId("clear").textContent).toBe("64");
    rerender(<Probe card={false} />);
    await act(async () => {});
    expect(getByTestId("clear").textContent).toBe("0");
    spy.mockRestore();
  });
});

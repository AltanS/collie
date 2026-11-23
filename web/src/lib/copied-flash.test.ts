import { FLASH_MS, flashCopied } from "./copied-flash";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("flashCopied", () => {
  it("sets data-copied at once and clears it after the flash time", () => {
    const el = document.createElement("div");
    flashCopied(el);
    expect(el).toHaveAttribute("data-copied");
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(el).toHaveAttribute("data-copied");
    vi.advanceTimersByTime(1);
    expect(el).not.toHaveAttribute("data-copied");
  });

  it("restarts on a second copy: the attribute goes off and on, and lasts the full time again", () => {
    const el = document.createElement("div");
    const off = vi.spyOn(el, "removeAttribute");
    flashCopied(el);
    vi.advanceTimersByTime(FLASH_MS - 100);
    expect(off).not.toHaveBeenCalled();
    flashCopied(el);
    // Off and on again, so the CSS fade starts over.
    expect(off).toHaveBeenCalledWith("data-copied");
    expect(el).toHaveAttribute("data-copied");
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(el).toHaveAttribute("data-copied");
    vi.advanceTimersByTime(1);
    expect(el).not.toHaveAttribute("data-copied");
  });

  it("does nothing for a thing that is not on the page", () => {
    expect(() => flashCopied(null)).not.toThrow();
  });
});

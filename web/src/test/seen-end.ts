import { vi } from "vitest";

/**
 * An IntersectionObserver that reports every watched mark as on screen the moment it is watched, so a card's
 * code counts as read. jsdom has none, and a card's end mark is always watched (no height shortcut, security
 * read of package I, 2026-11-17), so a test that is not about reading the code stubs this. A test about it
 * stubs its own observer after this one. The stub is removed by `vi.unstubAllGlobals()`.
 */
export function stubAllSeen(): void {
  class AllSeen {
    private readonly callback: (entries: readonly { isIntersecting: boolean }[]) => void;
    constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void) {
      this.callback = callback;
    }
    observe(): void {
      this.callback([{ isIntersecting: true }]);
    }
    disconnect(): void {}
    unobserve(): void {}
  }
  vi.stubGlobal("IntersectionObserver", AllSeen);
}

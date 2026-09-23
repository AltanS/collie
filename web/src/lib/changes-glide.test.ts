import { afterEach, describe, expect, it, vi } from "vitest";

import { GLIDE_CLASS, glideInto } from "./changes-glide";

function row(): HTMLElement {
  const button = document.createElement("button");
  button.innerHTML = '<span data-glide="label">webapp</span><span data-glide="count">5 files</span>';
  document.body.append(button);
  return button;
}

/** Give the document a `startViewTransition` of the test's own, or take it away. */
function setStart(fn: (...args: never[]) => object | undefined) {
  Object.defineProperty(document, "startViewTransition", { configurable: true, writable: true, value: fn });
}

afterEach(() => {
  Reflect.deleteProperty(document, "startViewTransition");
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("glideInto", () => {
  it("just navigates where the browser has no view transitions", () => {
    const go = vi.fn();
    glideInto(row(), go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(GLIDE_CLASS)).toBe(false);
  });

  it("just navigates under reduced motion, even where the API exists", () => {
    const start = vi.fn();
    setStart(start);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const go = vi.fn();
    glideInto(row(), go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("names the row's two parts for one transition, navigates inside it, and cleans up after", async () => {
    let finish = () => {};
    const finished = new Promise<void>((r) => (finish = r));
    let update: (() => Promise<void>) | null = null;
    setStart((cb: () => Promise<void>) => {
      update = cb;
      return { ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve() };
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const el = row();
    const go = vi.fn(() => {
      // The arriving header, as the Changes route draws it.
      document.body.innerHTML += '<div data-slot="header-row"><span data-glide="label">webapp</span></div>';
    });
    glideInto(el, go);
    expect(document.documentElement.classList.contains(GLIDE_CLASS)).toBe(true);
    expect(el.querySelector<HTMLElement>('[data-glide="label"]')!.style.viewTransitionName).toBe("changes-glide-label");
    expect(el.querySelector<HTMLElement>('[data-glide="count"]')!.style.viewTransitionName).toBe("changes-glide-count");
    expect(go).not.toHaveBeenCalled();
    await update!();
    expect(go).toHaveBeenCalledTimes(1);
    finish();
    await finished;
    await Promise.resolve();
    expect(document.documentElement.classList.contains(GLIDE_CLASS)).toBe(false);
  });
});

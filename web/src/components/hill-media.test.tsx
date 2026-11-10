import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, vi } from "vitest";

import { HILL_IDLE } from "@/hooks/use-hill-answer";
import type { HillDecision, HillMedia } from "@/lib/hill/wire";
import { setDeviceToken } from "@/lib/pairing";
import { hillDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

import { DecisionCard } from "./decision-card";
import type { HillMediaSource } from "./hill-media";

// Images on the Decision card (M96): every image in one sideways row under the summary, a tap opening
// one at full size, the bytes fetched with the pairing token and only near the screen, and a quiet
// placeholder in the image's own box when one does not load.

const media = (n: number, caption?: string): HillMedia => {
  const base: HillMedia = { id: `im_${String(n).repeat(16)}`, kind: "image", mime: "image/png", bytes: 10, width: 390, height: 240 };
  return caption === undefined ? base : { ...base, caption };
};

/** A tiny PNG as a data URL: it passes the authed loader untouched, so no route is asked. */
const DATA: HillMediaSource = (_decision, item) => `data:image/png;base64,${btoa(item.id)}`;

function renderCard(decision: HillDecision, source?: HillMediaSource) {
  const view = render(<DecisionCard decision={decision} answer={HILL_IDLE} onSend={vi.fn()} mediaSource={source} />);
  const slot = (name: string) => view.container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const all = (name: string) => [...view.container.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`)];
  return { ...view, slot, all };
}

describe("a Decision with images", () => {
  it("shows no image row when there is none", () => {
    const { slot } = renderCard(hillDecision());
    expect(slot("image-strip")).toBeNull();
  });

  it("shows every image in one row under the summary, in order, each with its caption", () => {
    const { slot, all } = renderCard(hillDecision({ media: [media(1, "Before"), media(2), media(3, "After")] }), DATA);
    const strip = slot("image-strip")!;
    expect(strip).toHaveAttribute("aria-label", "Images");
    const items = all("image-strip-item");
    expect(items.map((f) => f.querySelector("img")?.getAttribute("src"))).toEqual([media(1), media(2), media(3)].map((m) => DATA("", m)));
    expect(items.map((f) => f.querySelector("figcaption")?.textContent ?? null)).toEqual(["Before", null, "After"]);
    // An image with no caption is named by its place.
    expect(items[1]!.querySelector("img")?.getAttribute("alt")).toBe("Image 2 of 3");
    // It sits after the summary, before the options.
    const summary = slot("decision-summary")!;
    expect(summary.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(slot("decision-options")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The row scrolls sideways inside the house fade, with no chevron of its own.
    expect(strip.querySelector("[data-overflow]")).not.toBeNull();
    expect(strip.querySelector('[data-icon="scroll-hint-right"]')).toBeNull();
  });

  it("opens an image at full size in the picture sheet on a tap", () => {
    const { all } = renderCard(hillDecision({ media: [media(1, "Before"), media(2)] }), DATA);
    fireEvent.click(all("image-strip-item")[1]!.querySelector("button")!);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Image 2 of 2");
    expect(dialog.querySelector("img")).toHaveAttribute("src", DATA("", media(2)));
  });

  it("picks one height for the row from the images' shapes (2026-11-10)", () => {
    const phone = (n: number): HillMedia => ({ ...media(n), width: 390, height: 844 });
    // Two phone screenshots: the tall row, so a phone shot reads.
    const tall = renderCard(hillDecision({ media: [phone(1), phone(2)] }), DATA);
    expect(tall.all("image-strip-item").map((item) => item.dataset.size)).toEqual(["tall", "tall"]);
    tall.unmount();
    // A phone shot beside a wide one: the short row, where the wide one reads.
    const mixed = renderCard(hillDecision({ media: [phone(1), media(2)] }), DATA);
    expect(mixed.all("image-strip-item").map((item) => item.dataset.size)).toEqual(["short", "short"]);
    mixed.unmount();
    // One image, any shape: tall, and as wide as the card lets it be.
    const single = renderCard(hillDecision({ media: [media(1)] }), DATA);
    const item = single.all("image-strip-item")[0]!;
    expect(item.dataset.size).toBe("tall");
    expect(item.style.getPropertyValue("--strip-item-w")).toContain("100%");
  });

  it("makes no More for images alone: the row shows them all", () => {
    const { slot } = renderCard(hillDecision({ media: [media(1), media(2)] }), DATA);
    expect(slot("decision-more")).toBeNull();
  });

  it("an image that does not decode shows the quiet placeholder in its own box", () => {
    const { slot, all } = renderCard(hillDecision({ media: [media(1)] }), DATA);
    const item = all("image-strip-item")[0]!;
    const width = item.style.getPropertyValue("--strip-item-w");
    expect(width).not.toBe("");
    fireEvent.error(item.querySelector("img")!);
    expect(item.querySelector("img")).toBeNull();
    expect(slot("hill-media-unavailable")).toHaveTextContent("Image not available");
    expect(item.style.getPropertyValue("--strip-item-w")).toBe(width);
  });

  it("fetches the bytes from the bridge's route with the pairing token, and a refused load shows the placeholder", async () => {
    const seen: { path: string; auth: string | null }[] = [];
    server.use(
      http.get("/api/hill/media/:decision/:media", ({ request, params }) => {
        seen.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization") });
        if (params.media === media(2).id) return new HttpResponse("no such image", { status: 404 });
        return new HttpResponse(new Uint8Array([0x89, 0x50]), { headers: { "content-type": "image/png" } });
      }),
    );
    setDeviceToken("tok-test-placeholder");
    const decision = hillDecision({ media: [media(1), media(2)] });
    const { all } = renderCard(decision);
    await waitFor(() => expect(all("image-strip-item")[0]!.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
    expect(seen).toContainEqual({ path: `/api/hill/media/${decision.id}/${media(1).id}`, auth: "Bearer tok-test-placeholder" });
    await waitFor(() => expect(all("image-strip-item")[1]!.querySelector('[data-slot="hill-media-unavailable"]')).not.toBeNull());
    expect(all("image-strip-item")[1]).toHaveTextContent("Image not available");
    expect(seen).toContainEqual({ path: `/api/hill/media/${decision.id}/${media(2).id}`, auth: "Bearer tok-test-placeholder" });
  });
});

describe("an image is fetched only near the screen", () => {
  /** An observer the test drives: it records what it watches and reports when told. */
  class FakeObserver {
    static all: FakeObserver[] = [];
    readonly margin: string | undefined;
    readonly report: (entries: { isIntersecting: boolean }[]) => void;
    disconnected = false;
    constructor(report: (entries: { isIntersecting: boolean }[]) => void, options?: IntersectionObserverInit) {
      this.report = report;
      this.margin = options?.rootMargin;
      FakeObserver.all.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    see(isIntersecting: boolean) {
      this.report([{ isIntersecting }]);
    }
  }

  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks the bridge for nothing while the card is far from the screen, and draws the reserved box", () => {
    const asked: string[] = [];
    server.use(
      http.get("/api/hill/media/:decision/:media", ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return new HttpResponse(new Uint8Array([0x89, 0x50]), { headers: { "content-type": "image/png" } });
      }),
    );
    setDeviceToken("tok-test-placeholder");
    const { all } = renderCard(hillDecision({ media: [media(1), media(2)] }));
    // Each image's box is reserved from its known shape: 390 x 240 at the row's 112 px is 182 px wide.
    for (const box of all("image-strip-item")) {
      expect(box.style.getPropertyValue("--strip-item-w")).toBe("182px");
      expect(box.querySelector("img")).toBeNull();
    }
    expect(asked).toEqual([]);
    // One observer for the row, not one per image: the row scrolls on its own.
    expect(FakeObserver.all).toHaveLength(1);
    // The margin is one screen height, above and below.
    expect(FakeObserver.all[0]!.margin).toMatch(/^\d+px 0px$/);
  });

  it("draws the images once the row comes within a screen of the visible part, and stays drawn when it leaves", async () => {
    const { all } = renderCard(hillDecision({ media: [media(1), media(2)] }), DATA);
    expect(all("image-strip-item")[0]!.querySelector("img")).toBeNull();
    act(() => FakeObserver.all[0]!.see(false));
    expect(all("image-strip-item")[0]!.querySelector("img")).toBeNull();
    act(() => FakeObserver.all[0]!.see(true));
    await waitFor(() => expect(all("image-strip-item").every((item) => item.querySelector("img") !== null)).toBe(true));
    expect(FakeObserver.all[0]!.disconnected).toBe(true);
  });

  it("loads at once where the page has no IntersectionObserver", () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
    const { all } = renderCard(hillDecision({ media: [media(1)] }), DATA);
    expect(all("image-strip-item")[0]!.querySelector("img")).not.toBeNull();
  });
});

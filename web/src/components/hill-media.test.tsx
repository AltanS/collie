import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, vi } from "vitest";

import { HILL_IDLE } from "@/hooks/use-hill-answer";
import type { HillDecision, HillMedia } from "@/lib/hill/wire";
import { setDeviceToken } from "@/lib/pairing";
import { hillDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

import { DecisionCard } from "./decision-card";
import type { HillMediaSource } from "./hill-media";

// Images on the Decision card (M96): the first under the summary with a count when there are more,
// every image in the body after a tap, the bytes fetched with the pairing token, and a quiet
// placeholder when one does not load.

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
  it("shows no image slot when there is none", () => {
    const { slot } = renderCard(hillDecision());
    expect(slot("hill-card-image")).toBeNull();
  });

  it("shows the first image under the summary, with no count for one image", () => {
    const { slot } = renderCard(hillDecision({ media: [media(1, "The card after")] }), DATA);
    const card = slot("hill-card-image")!;
    expect(card.querySelector("img")?.getAttribute("src")).toBe(DATA("", media(1)));
    expect(card.querySelector("img")?.getAttribute("alt")).toBe("The card after");
    expect(slot("hill-media-count")).toBeNull();
    // It sits after the summary, before the options.
    const summary = slot("decision-summary")!;
    expect(summary.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(slot("decision-options")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks one of three, and a tap opens the body with every image in order and its caption", () => {
    const { slot, all } = renderCard(hillDecision({ media: [media(1, "Before"), media(2), media(3, "After")] }), DATA);
    expect(slot("hill-media-count")).toHaveTextContent("1 / 3");
    expect(slot("decision-more")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(slot("hill-card-image")!);
    expect(slot("decision-more")).toHaveAttribute("aria-expanded", "true");
    const figures = all("hill-body-image");
    expect(figures.map((f) => f.querySelector("img")?.getAttribute("src"))).toEqual([media(1), media(2), media(3)].map((m) => DATA("", m)));
    expect(figures.map((f) => f.querySelector("figcaption")?.textContent ?? null)).toEqual(["Before", null, "After"]);
    // An image with no caption is named by its place.
    expect(figures[1]!.querySelector("img")?.getAttribute("alt")).toBe("Image 2 of 3");
  });

  it("an image that does not decode shows the quiet placeholder instead", () => {
    const { slot } = renderCard(hillDecision({ media: [media(1)] }), DATA);
    fireEvent.error(slot("hill-card-image")!.querySelector("img")!);
    expect(slot("hill-card-image")!.querySelector("img")).toBeNull();
    expect(slot("hill-media-unavailable")).toHaveTextContent("Image not available");
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
    const { slot, all } = renderCard(decision);
    await waitFor(() => expect(slot("hill-card-image")!.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
    expect(seen).toContainEqual({ path: `/api/hill/media/${decision.id}/${media(1).id}`, auth: "Bearer tok-test-placeholder" });
    fireEvent.click(slot("hill-card-image")!);
    await waitFor(() => expect(all("hill-body-image")[1]!.querySelector('[data-slot="hill-media-unavailable"]')).not.toBeNull());
    expect(all("hill-body-image")[1]).toHaveTextContent("Image not available");
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
    const { slot } = renderCard(hillDecision({ media: [media(1)] }));
    const box = slot("hill-card-image")!;
    expect(box.className).toContain("h-[200px]");
    expect(box.querySelector("img")).toBeNull();
    expect(asked).toEqual([]);
    expect(FakeObserver.all).toHaveLength(1);
    // The margin is one screen height, above and below.
    expect(FakeObserver.all[0]!.margin).toMatch(/^\d+px 0px$/);
  });

  it("draws the image once the card comes within a screen of the visible part, and stays drawn when it leaves", async () => {
    const { slot } = renderCard(hillDecision({ media: [media(1)] }), DATA);
    expect(slot("hill-card-image")!.querySelector("img")).toBeNull();
    act(() => FakeObserver.all[0]!.see(false));
    expect(slot("hill-card-image")!.querySelector("img")).toBeNull();
    act(() => FakeObserver.all[0]!.see(true));
    await waitFor(() => expect(slot("hill-card-image")!.querySelector("img")).not.toBeNull());
    expect(FakeObserver.all[0]!.disconnected).toBe(true);
  });

  it("loads at once where the page has no IntersectionObserver", () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
    const { slot } = renderCard(hillDecision({ media: [media(1)] }), DATA);
    expect(slot("hill-card-image")!.querySelector("img")).not.toBeNull();
  });
});

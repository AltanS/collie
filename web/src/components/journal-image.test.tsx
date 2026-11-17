import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { JournalImage } from "@/components/journal-image";
import { authedObjectUrl } from "@/lib/authed-url";
import { server } from "@/test/setup";

// Row 1 of the calm-load survey: a picture in the Chat thread used to enter from nothing. While its
// bytes load a quiet box of `PagerPicture`'s height holds the place, and a picture the page already
// fetched is there on the first render. The reserve goes when the picture comes and never stays.

const BLOB = `/api/blobs/${"b".repeat(64)}`;
const RESERVE = '[data-slot="journal-image-reserve"]';

function slowBytes() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get("/api/blobs/:hash", async () => {
      await gate;
      return new HttpResponse(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    }),
  );
  return release;
}

function thread(ref: string) {
  return render(
    <div>
      <p>before</p>
      <JournalImage ref_={ref} alt="Shot" />
      <p>after</p>
    </div>,
  );
}

/** The thread as the order of what is in it: the two paragraphs and the one thing between them. */
const order = (container: HTMLElement) =>
  [...container.firstElementChild!.children].map((el) => (el.tagName === "P" ? el.textContent : el.getAttribute("data-slot") ?? el.tagName));

describe("JournalImage — a place held while the bytes load", () => {
  it("holds a box of the pager picture's size, then swaps the picture in without moving the neighbours", async () => {
    const release = slowBytes();
    const { container } = thread(BLOB);

    const reserve = container.querySelector(RESERVE);
    expect(reserve).not.toBeNull();
    for (const cls of ["block", "h-40", "w-full"]) expect(reserve?.classList.contains(cls)).toBe(true);
    expect(reserve?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("img")).toBeNull();
    expect(order(container)).toEqual(["before", "journal-image-reserve", "after"]);

    release();
    await screen.findByAltText("Shot");
    expect(container.querySelector(RESERVE)).toBeNull();
    // Same place in the thread: the button that holds the picture stands between the same two lines.
    expect(order(container)).toEqual(["before", "BUTTON", "after"]);
  });

  it("draws the picture on the first render when the page already holds it, with no box at all", async () => {
    server.use(
      http.get("/api/blobs/:hash", () => new HttpResponse(new Uint8Array([1]), { headers: { "content-type": "image/png" } })),
    );
    await authedObjectUrl(BLOB);
    const { container } = thread(BLOB);
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
    expect(container.querySelector(RESERVE)).toBeNull();
  });

  it("lets the box go when the load fails, leaving no empty band", async () => {
    server.use(http.get("/api/blobs/:hash", () => new HttpResponse("nope", { status: 404 })));
    const { container } = thread(BLOB);
    expect(container.querySelector(RESERVE)).not.toBeNull();
    await waitFor(() => expect(container.querySelector(RESERVE)).toBeNull());
    expect(order(container)).toEqual(["before", "after"]);
  });

  it("draws no box for a reference the app will not load", () => {
    const { container } = thread("https://example.com/shot.png");
    expect(container.querySelector(RESERVE)).toBeNull();
    expect(order(container)).toEqual(["before", "after"]);
  });
});

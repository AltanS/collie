import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { AuthedImageCard } from "@/components/authed-image-card";
import { authedObjectUrl } from "@/lib/authed-url";
import { server } from "@/test/setup";

// Row 20 of the calm-load survey: in the mirror the "[Image]" badge used to go, then nothing, then the
// card, because the card returned `null` until its bytes were here. The caller's `pending` now stands
// in, and a picture the page already fetched is the card on the first render.

const BLOB = `/api/blobs/${"c".repeat(64)}`;

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

const card = (props: Partial<React.ComponentProps<typeof AuthedImageCard>> = {}) => (
  <div>
    <AuthedImageCard src={BLOB} alt="Shot" caption="from the log" pending={<span>[Image]</span>} {...props} />
    <p>after</p>
  </div>
);

describe("AuthedImageCard — the badge stays until the bytes", () => {
  it("shows the pending badge while the bytes load, then the card in its place", async () => {
    const release = slowBytes();
    const { container } = render(card());
    expect(screen.getByText("[Image]")).toBeInTheDocument();
    expect(container.querySelector("[data-slot='image-card']")).toBeNull();
    expect(container.firstElementChild?.children[1]?.textContent).toBe("after");

    release();
    await screen.findByAltText("Shot");
    expect(screen.queryByText("[Image]")).toBeNull();
    expect(container.firstElementChild?.firstElementChild?.getAttribute("data-slot")).toBe("image-card");
    expect(container.firstElementChild?.children[1]?.textContent).toBe("after");
  });

  it("is the card on the first render when the page already holds the bytes", async () => {
    server.use(
      http.get("/api/blobs/:hash", () => new HttpResponse(new Uint8Array([1]), { headers: { "content-type": "image/png" } })),
    );
    await authedObjectUrl(BLOB);
    const { container } = render(card());
    expect(container.querySelector("[data-slot='image-card']")).not.toBeNull();
    expect(screen.queryByText("[Image]")).toBeNull();
  });

  it("keeps the badge when the load fails, and reports the failure once", async () => {
    server.use(http.get("/api/blobs/:hash", () => new HttpResponse("nope", { status: 404 })));
    const onError = vi.fn();
    render(card({ onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByText("[Image]")).toBeInTheDocument();
  });

  it("draws nothing while loading when the caller gave no stand-in", () => {
    slowBytes();
    const { container } = render(card({ pending: undefined }));
    expect(container.firstElementChild?.children).toHaveLength(1);
  });
});

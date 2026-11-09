import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MathControl } from "@/components/math-control";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { __resetDesign, designPrefs, mathEngineOf, setDesignMath } from "@/lib/design";
import { t } from "@/lib/i18n";
import { __resetMathPack, MATH_PACK_POLL_MS } from "@/lib/math-pack";
import type { MathPackStatus } from "@/lib/types";
import { server } from "@/test/setup";

// The Math card: Off by default, the three choices in a fixed order, and a pick that writes the store
// with a note under it that names what the choice costs. Every note stays in the cell and only the
// active one shows, so the card keeps the height of the longest (ui/one-of.tsx).
//
// The engines are a pack on the host (ADR 0132): the card reads `GET /api/math` when it opens, offers
// the download while the host has none, shows its progress, and applies the engine that was chosen
// once the pack is in.

vi.mock("@/lib/math/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/math/engine")>()),
  loadMathEngine: vi.fn(async () => null),
}));

/** The note on top of the cell, the one a person reads. */
const shownNote = () => document.querySelector("[data-active]")?.textContent;

const READY: MathPackStatus = { state: "ready", version: "1.29.0", source: "store", bytes: 3_994_976 };
const ABSENT: MathPackStatus = { state: "absent" };

function renderCard(opts: { readOnly?: boolean } = {}) {
  // A device that may only read is one whose root data says the device gate refused it.
  const loader = opts.readOnly === true ? () => ({ device: { enforced: true, authorized: false } }) : undefined;
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/settings/appearance", element: <MathControl />, loader }], {
    initialEntries: ["/settings/appearance"],
  });
  return render(<RouterProvider router={router} />);
}

/** The host answers `status` to every read, and counts the POSTs and DELETEs. */
function host(initial: MathPackStatus) {
  const state = { status: initial, posts: 0, deletes: 0 };
  server.use(
    http.get("/api/math", () => HttpResponse.json(state.status)),
    http.post("/api/math", () => {
      state.posts++;
      state.status = { state: "downloading", received: 0, total: null };
      return HttpResponse.json(state.status, { status: 202 });
    }),
    http.delete("/api/math", () => {
      state.deletes++;
      state.status = ABSENT;
      return HttpResponse.json(state.status);
    }),
  );
  return state;
}

const select = () => screen.getByLabelText(t("settings.math.engine"));

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
  __resetMathPack();
});

describe("MathControl with the pack on the host", () => {
  it("offers Off, KaTeX and MathJax, with Off selected on a device that never chose", async () => {
    host(READY);
    renderCard();
    expect(within(select()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      t("settings.math.off"),
      "KaTeX",
      "MathJax",
    ]);
    expect(select()).toHaveValue("off");
    expect(shownNote()).toBe(t("settings.math.note.off"));
    for (const key of ["settings.math.note.katex", "settings.math.note.mathjax"] as const) {
      expect(screen.getByText(t(key)).closest("[aria-hidden]")).not.toBeNull();
    }
    expect(await screen.findByRole("button", { name: t("settings.appearance.math.remove") })).toBeInTheDocument();
  });

  it("writes the choice to the store and swaps the note", async () => {
    host(READY);
    renderCard();
    await screen.findByRole("button", { name: t("settings.appearance.math.remove") });
    await userEvent.selectOptions(select(), "katex");
    expect(mathEngineOf(designPrefs())).toBe("katex");
    expect(shownNote()).toBe(t("settings.math.note.katex"));
    await userEvent.selectOptions(select(), "off");
    expect(designPrefs().math).toBeUndefined();
  });

  it("removing the pack returns the card to the download and sets Off", async () => {
    const state = host(READY);
    setDesignMath("mathjax");
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: t("settings.appearance.math.remove") }));
    // The confirm replaced the button that had the focus: the focus is on Cancel, the safe answer.
    expect(screen.getByRole("button", { name: t("settings.appearance.math.remove.cancel") })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: t("settings.appearance.math.remove.action") }));
    expect(state.deletes).toBe(1);
    expect(await screen.findByRole("button", { name: /Download the math engines/ })).toBeInTheDocument();
    expect(designPrefs().math).toBeUndefined();
    expect(select()).toHaveValue("off");
  });

  it("offers no remove for the engines a source build carries", async () => {
    host({ ...READY, source: "build", bytes: null });
    renderCard();
    await waitFor(() => expect(select()).not.toBeDisabled());
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: t("settings.appearance.math.remove") })).toBeNull();
  });
});

describe("MathControl with no pack on the host", () => {
  it("shows Off, offers the download with its size, and fetches nothing before a tap", async () => {
    const state = host(ABSENT);
    setDesignMath("katex");
    renderCard();
    expect(await screen.findByRole("button", { name: /Download the math engines \(about 4\.0\sMB\)/ })).toBeInTheDocument();
    expect(select()).toHaveValue("off");
    expect(state.posts).toBe(0);
  });

  it("choosing an engine downloads the pack, shows the progress, and applies the engine when it is in", async () => {
    const state = host(ABSENT);
    renderCard();
    await screen.findByRole("button", { name: /Download the math engines/ });
    await userEvent.selectOptions(select(), "mathjax");
    expect(state.posts).toBe(1);
    // While it downloads, the choice does not change and the engines cannot be picked again.
    expect(await screen.findByText(t("settings.appearance.math.downloading"))).toBeInTheDocument();
    expect(select()).toHaveValue("off");
    expect(within(select()).getByRole("option", { name: "KaTeX" })).toBeDisabled();
    expect(mathEngineOf(designPrefs())).toBe("off");

    state.status = { state: "downloading", received: 1_000_000, total: 4_000_000 };
    expect(await screen.findByText("1.0 MB of 4.0 MB", {}, { timeout: MATH_PACK_POLL_MS * 3 })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: t("settings.appearance.math.progressAria") })).toHaveAttribute("aria-valuenow", "25");

    state.status = READY;
    await waitFor(() => expect(mathEngineOf(designPrefs())).toBe("mathjax"), { timeout: MATH_PACK_POLL_MS * 3 });
    expect(select()).toHaveValue("mathjax");
    expect(screen.getByRole("button", { name: t("settings.appearance.math.remove") })).toBeInTheDocument();
  });

  it("the button downloads without choosing an engine", async () => {
    const state = host(ABSENT);
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /Download the math engines/ }));
    expect(state.posts).toBe(1);
    state.status = READY;
    await waitFor(() => expect(screen.getByRole("button", { name: t("settings.appearance.math.remove") })).toBeInTheDocument(), {
      timeout: MATH_PACK_POLL_MS * 3,
    });
    expect(mathEngineOf(designPrefs())).toBe("off");
  });

  it("names a failed download in one line and offers the download again", async () => {
    host({ state: "absent", error: "hash-mismatch" });
    renderCard();
    expect(await screen.findByText(t("settings.appearance.math.error.hashMismatch"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download the math engines/ })).toBeEnabled();
  });

  it.each([
    ["a refusal", () => HttpResponse.json({ error: "secret upstream words" }, { status: 403 }), "settings.appearance.math.refused.denied"],
    ["a host failure", () => HttpResponse.json({ error: "secret upstream words" }, { status: 502 }), "settings.appearance.math.refused.server"],
    ["a lost connection", () => HttpResponse.error(), "settings.appearance.math.refused.offline"],
  ] as const)("%s on the download is one line of Collie's own, never the body", async (_label, answer, key) => {
    host(ABSENT);
    server.use(http.post("/api/math", answer));
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /Download the math engines/ }));
    expect(await screen.findByText(t(key))).toBeInTheDocument();
    expect(screen.queryByText(/secret upstream words|Failed to fetch/)).toBeNull();
    expect(screen.getByRole("button", { name: /Download the math engines/ })).toBeEnabled();
    expect(select()).toHaveValue("off");
  });

  it("a 409 says nothing of its own: the host's status says there is nothing to offer", async () => {
    const state = host(ABSENT);
    server.use(
      http.post("/api/math", () => {
        state.status = { state: "unavailable", reason: "no-pack" };
        return HttpResponse.json(state.status, { status: 409 });
      }),
    );
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /Download the math engines/ }));
    expect(await screen.findByText(t("settings.appearance.math.unavailable.noPack"))).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a download that answered nothing but did start shows the progress, no red line, and keeps the choice", async () => {
    const state = host(ABSENT);
    server.use(
      http.post("/api/math", () => {
        state.status = { state: "downloading", received: 0, total: 3_994_976 };
        return HttpResponse.error();
      }),
    );
    renderCard();
    await screen.findByRole("button", { name: /Download the math engines/ });
    await userEvent.selectOptions(select(), "katex");
    expect(await screen.findByText(t("settings.appearance.math.downloading"))).toBeInTheDocument();
    expect(screen.queryByText(t("settings.appearance.math.refused.offline"))).toBeNull();
    state.status = READY;
    await waitFor(() => expect(mathEngineOf(designPrefs())).toBe("katex"), { timeout: MATH_PACK_POLL_MS * 3 });
  });

  it("the chosen engine survives leaving Settings while the host downloads", async () => {
    const state = host(ABSENT);
    const first = renderCard();
    await screen.findByRole("button", { name: /Download the math engines/ });
    await userEvent.selectOptions(select(), "mathjax");
    await screen.findByText(t("settings.appearance.math.downloading"));
    first.unmount();
    state.status = READY;
    renderCard();
    await waitFor(() => expect(mathEngineOf(designPrefs())).toBe("mathjax"));
  });

  it("a host that does not answer the first read leaves the engines disabled, says so, and recovers", async () => {
    const state = host(ABSENT);
    let fail = true;
    server.use(http.get("/api/math", () => (fail ? HttpResponse.error() : HttpResponse.json(state.status))));
    renderCard();
    expect(await screen.findByText(t("settings.appearance.math.unreachable"))).toBeInTheDocument();
    expect(within(select()).getByRole("option", { name: "KaTeX" })).toBeDisabled();
    fail = false;
    state.status = READY;
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(within(select()).getByRole("option", { name: "KaTeX" })).toBeEnabled());
  });

  it("an older bridge (404) leaves the three choices open and draws no pack row", async () => {
    server.use(http.get("/api/math", () => new HttpResponse("not found", { status: 404 })));
    renderCard();
    await act(async () => undefined);
    await waitFor(() => expect(within(select()).getByRole("option", { name: "KaTeX" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: /Download the math engines/ })).toBeNull();
    expect(screen.queryByText(t("settings.appearance.math.unreachable"))).toBeNull();
  });

  it("a read-only device is told it cannot download, and its engines stay closed", async () => {
    const state = host(ABSENT);
    renderCard({ readOnly: true });
    expect(await screen.findByText(t("settings.appearance.math.readOnly"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download the math engines/ })).toBeNull();
    expect(within(select()).getByRole("option", { name: "KaTeX" })).toBeDisabled();
    expect(state.posts).toBe(0);
  });

  it("a second device that opens the card mid-download shows the progress, then the engine it chose before", async () => {
    const state = host({ state: "downloading", received: 0, total: null });
    setDesignMath("katex");
    renderCard();
    expect(await screen.findByText(t("settings.appearance.math.downloading"))).toBeInTheDocument();
    // The total is not known yet: a bar that claims no value.
    expect(screen.getByRole("progressbar", { name: t("settings.appearance.math.progressAria") })).not.toHaveAttribute("aria-valuenow");
    expect(select()).toHaveValue("off");
    expect(state.posts).toBe(0);
    state.status = READY;
    await waitFor(() => expect(select()).toHaveValue("katex"), { timeout: MATH_PACK_POLL_MS * 3 });
  });

  it("a build with no pack disables the engines and says why", async () => {
    const state = host({ state: "unavailable", reason: "dev-build" });
    renderCard();
    expect(await screen.findByText(t("settings.appearance.math.unavailable.devBuild"))).toBeInTheDocument();
    expect(within(select()).getByRole("option", { name: "KaTeX" })).toBeDisabled();
    expect(within(select()).getByRole("option", { name: "MathJax" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Download the math engines/ })).toBeNull();
    expect(state.posts).toBe(0);
  });
});

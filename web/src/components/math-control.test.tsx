import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MathControl } from "@/components/math-control";
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

function renderCard() {
  const router = createMemoryRouter([{ path: "/settings/appearance", element: <MathControl /> }], {
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

  it("a refused download is said in the card, and the download is offered again", async () => {
    host(ABSENT);
    server.use(http.post("/api/math", () => HttpResponse.json({ error: "device is read-only" }, { status: 403 })));
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /Download the math engines/ }));
    expect(await screen.findByText(/read-only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download the math engines/ })).toBeEnabled();
    expect(select()).toHaveValue("off");
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

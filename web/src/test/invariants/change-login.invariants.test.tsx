// M102 spec 15, the Change login page (staging 09fc73204, feat/change-login, M101): its buttons under
// every bridge answer. The page is the real route under a memory router; msw answers its requests.
//
//   I2  Change login (POST /api/launch): every answer ends in the sign-in screen (Open sign-in, Finish)
//       or in readable words on the page; never the same page with nothing new.
//       Finish (POST /api/pane/:id/close, then GET /api/accounts up to four times): every pair of
//       answers ends in the result screen, with words and one way back.
//       Open sign-in and Back move to another page.
//
// Each seed takes a sample of the answers for Finish (each failing read waits 1.5 s on a fake clock).

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountIdentity, AccountRow } from "@/lib/accounts";
import { forgetFlow, rememberFlow } from "@/lib/change-login";
import { SettingsChangeLoginRoute } from "@/routes/settings-change-login";
import { body, defaultRow, HARNESS_CLAUDE, workRow } from "@/test/accounts-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { commonAnswers, json, type Answer } from "./bridge-answers";
import { replayHint, rngOf, runSeeds, sample } from "./seed";

const ME: AccountIdentity = { signedIn: true, email: "me@example.com", plan: "max" };
const OTHER: AccountIdentity = { signedIn: true, email: "other@example.com", plan: "pro" };
const CLAUDE = { ...HARNESS_CLAUDE, reachesRunningSessions: true as const };
const PANE = { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "sign-in", tabId: "w9:t1", cwd: "/home/op/sign-in" };
const PAGE = "/settings/accounts/acc-work/login";
const SEEDS = runSeeds();

afterEach(() => {
  cleanup();
  forgetFlow("acc-work");
  vi.useRealTimers();
});

function mount() {
  const router = createMemoryRouter(
    [
      { path: "/settings/accounts/:id", element: <div data-testid="account" /> },
      { path: "/settings/accounts/:id/login", element: withHeaderHost(<SettingsChangeLoginRoute />) },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
    ],
    { initialEntries: ["/settings/accounts/acc-work", PAGE], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** An msw answer for one generated answer. A thrown fetch is a dropped link to the page. */
function reply(answer: Answer): Response {
  if (answer.kind === "throw") return HttpResponse.error();
  const html = answer.body.startsWith("<");
  return new HttpResponse(answer.body === "" ? null : answer.body, { status: answer.status, headers: { "content-type": html ? "text/html" : "application/json" } });
}

function accounts(rows: AccountRow[]): Answer {
  return { kind: "status", status: 200, body: JSON.stringify(body({ harnesses: [CLAUDE], accounts: rows })), label: "200 accounts" };
}

const LAUNCH_ANSWERS: readonly Answer[] = [
  { kind: "status", status: 200, body: json({ ok: true, pane: PANE }), label: "200 launched" },
  { kind: "status", status: 200, body: json({ ok: true }), label: "200 ok, no pane (older bridge)" },
  { kind: "status", status: 200, body: json({ ok: false, error: "Sign-in is not allowed on a member.", code: "sign_in_member" }), label: "200 ok:false" },
  { kind: "status", status: 409, body: json({ ok: false, error: "A sign-in already runs.", code: "sign_in_running" }), label: "409 sign_in_running" },
  ...commonAnswers(),
];

/** The text `after` has that `before` did not: the middle left once the shared start and end are cut. */
function newText(before: string, after: string): string {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return after.slice(start, after.length - end);
}

/** Words a person can read: no HTML page, no JSON, no route path. */
function unreadable(text: string): string | null {
  if (/<\/?[a-z][^>]*>/iu.test(text)) return "an HTML page";
  if (/\{"|\["/u.test(text)) return "JSON";
  if (/\/api\//u.test(text)) return "a route path";
  return null;
}

const CLOSE_ANSWERS: readonly Answer[] = [{ kind: "status", status: 200, body: json({ ok: true }), label: "200 closed" }, ...commonAnswers()];
const READ_ANSWERS: readonly Answer[] = [
  accounts([defaultRow(), workRow({ identity: OTHER })]),
  accounts([defaultRow(), workRow({ identity: ME })]),
  accounts([defaultRow(), workRow({ identity: { signedIn: false } })]),
  accounts([defaultRow(), workRow({})]),
  accounts([defaultRow()]),
  ...commonAnswers(),
];

/** One Finish: the close answer, then the list answer for every read after it. What breaks I2, or null. */
async function finishCase(close: Answer, read: Answer): Promise<string | null> {
  // The page's first list read shows the account; the reads after the close get the generated answer.
  let closed = false;
  server.use(
    http.get("/api/accounts", () => (closed ? reply(read) : HttpResponse.json(body({ harnesses: [CLAUDE], accounts: [defaultRow(), workRow({ identity: ME })] })))),
    http.post("/api/pane/:paneId/close", () => {
      closed = true;
      return reply(close);
    }),
  );
  rememberFlow({ account: "acc-work", paneId: PANE.paneId, before: ME, from: null });
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"], shouldAdvanceTime: true });
  try {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    let back: HTMLElement | null = null;
    for (let i = 0; i < 12 && back === null; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      back = screen.queryByRole("button", { name: /Back to the/ });
    }
    if (/Unexpected Application Error/u.test(document.body.textContent ?? "")) return "the page crashed (the router's error screen)";
    if (back === null) return "no result screen";
    const words = document.querySelector("[data-slot='change-login-result']")?.textContent ?? "";
    if (words.replace(back.textContent ?? "", "").trim() === "") return "a result with no words";
    return null;
  } finally {
    cleanup();
    vi.useRealTimers();
    forgetFlow("acc-work");
  }
}

let launchCache: readonly string[] | null = null;
/** Every launch answer through Change login, once per file: the breaks, raw words included. */
async function launchBreaks(): Promise<readonly string[]> {
  if (launchCache !== null) return launchCache;
  const broken: string[] = [];
  for (const answer of LAUNCH_ANSWERS) {
    server.use(
      http.get("/api/accounts", () => HttpResponse.json(body({ harnesses: [CLAUDE], accounts: [defaultRow(), workRow({ identity: ME })] }))),
      http.post("/api/launch", () => reply(answer)),
    );
    mount();
    const button = await screen.findByRole("button", { name: "Change login" });
    const before = document.body.textContent ?? "";
    fireEvent.click(button);
    // The start ends when the button is free again, or gone because the sign-in screen took its place.
    await waitFor(() => expect(button.isConnected && button.hasAttribute("aria-busy")).toBe(false), { timeout: 3000 });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    const after = document.body.textContent ?? "";
    const signIn = screen.queryByRole("button", { name: "Finish" }) !== null;
    if (!signIn && after === before) broken.push(`${answer.label}: the same page, nothing new`);
    const added = newText(before, after);
    const bad = signIn ? null : unreadable(added);
    if (bad !== null) broken.push(`${answer.label}: ${bad} at the thumb: ${added.slice(0, 100)}`);
    cleanup();
    forgetFlow("acc-work");
  }
  launchCache = broken;
  return broken;
}

describe("M102-15, the Change login page under every bridge answer", () => {
  it(`I2: Change login ends in the sign-in screen or in readable words, on every launch answer (${String(LAUNCH_ANSWERS.length)} answers)`, async () => {
    const broken = await launchBreaks();
    console.info(`[invariants.change-login] launch: ${String(LAUNCH_ANSWERS.length)} answers, ${String(broken.length)} breaks`);
    expect(broken.filter((line) => !line.includes("HTML page") && !line.includes("route path") && !line.includes("JSON"))).toEqual([]);
  }, 30_000);

  for (const seed of SEEDS) {
    it(`I2: Finish ends in the result screen with words and a way back, on every close and read answer (${replayHint(seed, "finish")})`, async () => {
      const pairs = sample(
        CLOSE_ANSWERS.flatMap((close) => READ_ANSWERS.map((read) => [close, read] as const)),
        8,
        rngOf(seed),
      );
      const broken: string[] = [];
      for (const [close, read] of pairs) {
        const why = await finishCase(close, read);
        // A crashed page is the known red below; every other break fails here.
        if (why !== null && !why.includes("the page crashed")) broken.push(`${close.label} / ${read.label}: ${why}; ${replayHint(seed, "finish")}`);
      }
      expect(broken).toEqual([]);
    }, 60_000);
  }

  it("I2: a list answer with no accounts field after Finish leaves the page standing", async () => {
    const close = CLOSE_ANSWERS[0];
    if (close === undefined) throw new Error("no close answer");
    expect(await finishCase(close, { kind: "status", status: 200, body: json({ surprise: true, version: 99 }), label: "200 unknown fields only" })).toBeNull();
  }, 20_000);

  it(`I2: Change login puts no proxy page and no route path at the thumb`, async () => {
    expect((await launchBreaks()).filter((line) => line.includes("HTML page") || line.includes("route path") || line.includes("JSON"))).toEqual([]);
  }, 30_000);

  it("I2: Open sign-in and Back each move to another page", async () => {
    server.use(http.get("/api/accounts", () => HttpResponse.json(body({ harnesses: [CLAUDE], accounts: [defaultRow(), workRow({ identity: ME })] }))));
    rememberFlow({ account: "acc-work", paneId: PANE.paneId, before: ME, from: null });
    const router = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open sign-in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/pane/${encodeURIComponent(PANE.paneId)}`));
    cleanup();
    let closed = false;
    server.use(
      http.get("/api/accounts", () => HttpResponse.json(body({ harnesses: [CLAUDE], accounts: [defaultRow(), workRow({ identity: closed ? OTHER : ME })] }))),
      http.post("/api/pane/:paneId/close", () => {
        closed = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const again = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    fireEvent.click(await screen.findByRole("button", { name: /Back to the/ }, { timeout: 8000 }));
    await waitFor(() => expect(again.state.location.pathname).toBe("/settings/accounts/acc-work"));
  }, 20_000);
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page, Route } from "@playwright/test";

import { IMAGE_PLACEHOLDER } from "@/lib/mirror-images";
import type { SnapshotResponse } from "@/lib/types";
import {
  fixtureSnapshot,
  fixtureTranscriptWithImage,
  paneTextWithDraft,
} from "@/test/handlers";

// The terminal-graphics world for the `app` target: a pane whose mirror carries image placeholders,
// a journal that holds one picture, and three ways for the blob behind it to answer.
//
// Every payload is the unit layer's own fixture with ONE field patched — the snapshot's agents, the
// pane's text, the history's entries. Nothing here invents a shape: a wire change breaks
// `src/test/handlers.ts` and this module with it, which is the point of the one-fixture-source rule.

/** The pane every mirror case drives. `fixtureAgents[0]`, a `claude` pane, so the grammars run. */
export const MIRROR_PANE_ID = "w1:p1";

/** The word the find case searches for. Twice on screen, once on each side of the image. */
export const MIRROR_NEEDLE = "needle";

/**
 * A run of Kitty placeholder cells — twelve, so a cluster is plainly wider than the word beside it.
 *
 * A real capture carries combining marks on each cell (the image id and the cell's row/column). They
 * are omitted here on purpose: `PLACEHOLDER_RUN` takes `\p{Mn}*`, so the count of marks changes the
 * run's LENGTH and nothing else, and the offset case is sharper when the run's length is a number
 * this file states rather than one a corpus happens to hold.
 */
const PLACEHOLDER_ROW = IMAGE_PLACEHOLDER.repeat(12);

/**
 * The screen: two placeholder clusters, two rows each, with ordinary text above, between and below.
 *
 * TWO clusters and ONE image in the journal is the arrangement that shows both halves of the
 * feature at once — the alignment runs from the end, so the lower cluster takes the picture and the
 * upper one takes the badge.
 *
 * The two `needle`s sit on opposite sides of a cluster, which is what makes this text a find case as
 * well: a placeholder-only row is NOT rendered, but its characters still occupy the search
 * coordinate space (`components/ansi-output.tsx` § renderBlock), so the second highlight lands on
 * the wrong characters the moment that stops being true.
 */
export const MIRROR_SCREEN = [
  `above the image, ${MIRROR_NEEDLE} one`,
  PLACEHOLDER_ROW,
  PLACEHOLDER_ROW,
  "between the two images",
  PLACEHOLDER_ROW,
  PLACEHOLDER_ROW,
  `below the image, ${MIRROR_NEEDLE} two`,
].join("\n");

/**
 * The snapshot with `hasSession` on every agent.
 *
 * `fixtureSnapshot` is the solo world and says nothing about sessions, so `agent-chat.tsx:670`
 * reads `historyAvailable` as false and the image hook never asks the journal anything. One patched
 * field turns the read on; everything else is the fixture.
 */
const SNAPSHOT_WITH_SESSION: SnapshotResponse = {
  ...fixtureSnapshot,
  agents: fixtureSnapshot.agents.map((agent) => Object.assign({}, agent, { hasSession: true })),
};

function fulfillJson<T>(route: Route, body: T): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Real PNG bytes, off disk: `web/public/badge-96x96.png`, one of the app's own shipped icons.
 *
 * A hand-written base64 blob would be a second fixture nobody can look at. This is a file the repo
 * already carries, it decodes, and it is big enough that a load either plainly worked or plainly
 * did not.
 */
const PNG_PATH = fileURLToPath(new URL("../../public/badge-96x96.png", import.meta.url));
const PNG_BYTES = readFileSync(PNG_PATH);

/**
 * A device that chose the terminal view, which is what every case here is about. Chat is the default
 * body of an agent pane since 1.17.0 (ADR 0082), and these cases read the mirror, so each pins the
 * per-device choice the way a device that had chosen Terminal before the flip still holds it.
 */
async function pinTerminalView(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" }));
  });
}

/**
 * Point the pane, the journal and the snapshot at the image world. Call AFTER `installApiStub`:
 * Playwright checks the newest handler first, so these three win over the default table.
 */
export async function installMirrorWorld(page: Page): Promise<void> {
  await pinTerminalView(page);
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => fulfillJson(route, SNAPSHOT_WITH_SESSION),
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+$/.test(url.pathname),
    (route) =>
      fulfillJson(route, {
        paneId: MIRROR_PANE_ID,
        // The real fixture's input box, drawn under the real fixture's screen — a mirror with no box
        // is not a shape a live Claude pane ever has.
        text: paneTextWithDraft(MIRROR_SCREEN),
        truncated: false,
        revision: 1,
      }),
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/history$/.test(url.pathname),
    (route) =>
      fulfillJson(route, {
        paneId: MIRROR_PANE_ID,
        available: true,
        entries: fixtureTranscriptWithImage,
        hasMore: false,
        total: fixtureTranscriptWithImage.length,
        fileTruncated: false,
      }),
  );
}

/**
 * How the blob behind the journal's picture answers. SCOPED TO `**\/blobs/**` and nothing else: the
 * API stub keeps answering every other route, so a case that changes the bytes changes only the
 * bytes.
 *
 *  * `bytes` — the PNG, so the picture renders.
 *  * `notFound` — 404, which a member running a build without the additive-optional `blobs/<hash>`
 *    route really does answer (CREW_PROTOCOL.md §9.1).
 *  * `truncated` — a PNG header with the image data cut off, so the request succeeds and the DECODE
 *    fails. That is the other path into the badge, and it is the `onError` one.
 */
export type BlobAnswer = "bytes" | "notFound" | "truncated";

/** The device token a case seeds with `pairDevice`; the blob fetch must carry it (ADR 0086). */
export const E2E_DEVICE_TOKEN = "e2e-device-token";

/**
 * Stand in for a paired phone: store a device token before the page's own scripts run, so the
 * bridge subresource fetches (`lib/authed-url.ts`) carry `Authorization: Bearer <token>`. The API
 * stub answers reads without a token, so only a case that asserts the header needs this.
 */
export async function pairDevice(page: Page): Promise<void> {
  await page.addInitScript((token) => localStorage.setItem("collie:device-token", token), E2E_DEVICE_TOKEN);
}

/** One request the blob route answered: its path and the `Authorization` header it carried. */
export interface BlobRequest {
  path: string;
  authorization: string | undefined;
}

/**
 * Answers the blob route and returns the log of what it was asked, in order. The page loads a blob
 * with `fetch` + the token into an object URL (an `<img src>` cannot send a header), so the log is
 * where a case sees the bridge-facing half of that: the path and the `Authorization` header.
 */
export async function stubBlob(page: Page, answer: BlobAnswer): Promise<BlobRequest[]> {
  const requests: BlobRequest[] = [];
  await page.route("**/blobs/**", async (route) => {
    requests.push({
      path: new URL(route.request().url()).pathname,
      authorization: route.request().headers()["authorization"],
    });
    if (answer === "notFound") {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "no such blob" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      // 24 bytes is the signature plus most of the IHDR chunk: enough that the browser accepts the
      // response as an image and then fails to decode it, which is exactly the state a half-written
      // file on the owning machine leaves behind.
      body: answer === "truncated" ? PNG_BYTES.subarray(0, 24) : PNG_BYTES,
    });
  });
  return requests;
}

// ── #292: a pi pane, which draws its picture with no placeholder at all ──────────────────────────
//
// pi 0.87.1 draws by direct Kitty placement, which leaves only the blank rows it keeps for the
// picture (read live on 2026-09-26: 32 blank rows between `read ./dot.png` and the reply). pi runs
// inline, so a real read also carries the conversation above it; the scrollback here is what makes
// the bottom pin matter, because the card has to be found at the tail, not at the top.

/** The pi screen: scrollback, the tool row, the rows pi kept for the picture, the reply, pi's box. */
export const PI_SCREEN = [
  ...Array.from({ length: 80 }, (_, i) => `earlier output, line ${i + 1}`),
  " read ./dot.png",
  ...Array.from({ length: 20 }, () => ""),
  " Here is the screen.",
  "",
  "─".repeat(40),
  "",
  "─".repeat(40),
  "/home/you/webapp",
].join("\n");

/** The epoch ms the pi pane's last status transition carries. Any value: it is the turn's key. */
const PI_TURN_AT = 1_758_900_000_000;

/**
 * Point the snapshot, the pane and the journal at a pi pane whose finished turn holds a picture.
 *
 * `fixtureAgents[0]` with the fields that make it a pi pane patched: `agent`, `hasSession`,
 * `status` and `lastActiveAt`. The journal is `fixtureTranscriptWithImage`, whose newest turn ends
 * with the picture. Call AFTER `installApiStub`.
 */
export async function installPiPictureWorld(
  page: Page,
  { status }: { status: "done" | "working" },
): Promise<void> {
  await pinTerminalView(page);
  const snapshot: SnapshotResponse = {
    ...fixtureSnapshot,
    agents: fixtureSnapshot.agents.map((agent) =>
      agent.paneId === MIRROR_PANE_ID
        ? Object.assign({}, agent, { agent: "pi", hasSession: true, status, lastActiveAt: PI_TURN_AT })
        : agent,
    ),
  };
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => fulfillJson(route, snapshot),
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+$/.test(url.pathname),
    (route) => fulfillJson(route, { paneId: MIRROR_PANE_ID, text: PI_SCREEN, truncated: false, revision: 1 }),
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/history$/.test(url.pathname),
    (route) =>
      fulfillJson(route, {
        paneId: MIRROR_PANE_ID,
        available: true,
        entries: fixtureTranscriptWithImage,
        hasMore: false,
        total: fixtureTranscriptWithImage.length,
        fileTruncated: false,
      }),
  );
}

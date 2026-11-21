import type { Page } from "@playwright/test";

import { partKey, type TricksReply, type WireTrickPart } from "@/lib/tricks/schema";
import type { SnapshotResponse } from "@/lib/types";
import { hillDecision } from "@/test/hill-fixtures";

// THE LARGE-SCREEN DASHBOARD'S HEADER, ITS WORLDS (ADR 0158, addendum 2026-11-21): a Hill with open Decisions, and
// tricks with `tabbar` items, for the views control and the Hill button in the header. Call after `installApiStub`
// and before the first `page.goto`; the snapshot handed in is served as it is, with the two revs set on it.

/** Trick ids for `count` tabbar items. Labels long enough to give way in a narrow window. */
export function trickNames(count: number): string[] {
  const base = ["Deploys", "Coverage", "Tickets", "Builds", "Releases", "Inbox"];
  return base.slice(0, count);
}

/** Serve `snapshot` with a Hill of `open` Decisions and `tricks` tabbar items. */
export async function installHeadWorld(page: Page, snapshot: SnapshotResponse, opts: { hill?: number; tricks?: number } = {}) {
  const served: SnapshotResponse = { ...snapshot };
  if (opts.hill !== undefined) served.hillRev = 1;
  if (opts.tricks !== undefined && opts.tricks > 0) served.tricksRev = 1;
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(served) }),
  );
  if (opts.hill !== undefined) {
    const open = Array.from({ length: opts.hill }, (_, n) => hillDecision({ title: `Decision ${n + 1}` }));
    await page.route(
      (url) => url.pathname === "/api/hill",
      (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, rev: 1, open, closed: [] }) }),
    );
  }
  if (opts.tricks !== undefined && opts.tricks > 0) {
    const names = trickNames(opts.tricks);
    const parts: WireTrickPart[] = names.map((name) => ({
      host: "lodge",
      trick: name.toLowerCase(),
      part: "tabbar",
      rev: 1,
      asOf: new Date().toISOString(),
      value: { at: "tabbar", id: "tabbar", item: { label: name } },
    }));
    const reply: TricksReply = {
      rev: 1,
      tricks: names.map((name) => ({ host: "lodge", id: name.toLowerCase(), name, icon: "flask", on: true, state: "ok", places: ["tabbar"] })),
      parts,
      present: parts.map(partKey),
    };
    await page.route(
      (url) => url.pathname === "/api/tricks",
      (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) }),
    );
  }
}

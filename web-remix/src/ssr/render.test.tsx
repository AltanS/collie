// The server document's render on Bun (S1): it draws, it draws under a mount, and no request ever
// sees another's panes, back to back or interleaved (ACTION-PLAN.md B, "no request-to-request leak").
import { describe, expect, test } from "bun:test";

import type { BridgeConfig, SnapshotResponse } from "@web/lib/types";

import { CONFIG, SNAPSHOT } from "../../e2e/fixtures";
import { config, snapshot } from "../lib/data";
import { onServer } from "../lib/server-render";
import { isDocumentRoute, renderAppBody, renderAppDocument, rendersRemixJsx, snapshotApiPath, spliceDocument, type DocumentInput } from "./render";

/** SNAPSHOT with every workspace and tab label and every pane id tagged, so an output names its source. */
function tagged(tag: string): SnapshotResponse {
  const snap = structuredClone(SNAPSHOT);
  for (const p of snap.agents) {
    p.paneId = `${tag}-${p.paneId}`;
    p.workspaceLabel = `${tag}-${p.workspaceLabel}`;
    p.tabLabel = `${tag}-${p.tabLabel ?? "tab"}`;
  }
  for (const p of snap.shellPanes ?? []) {
    p.paneId = `${tag}-${p.paneId}`;
    p.workspaceLabel = `${tag}-${p.workspaceLabel}`;
  }
  return snap;
}

/** The drawn markup alone, without the `rmx-data` block (which carries the whole snapshot as props). */
function markup(body: string): string {
  const at = body.indexOf('<script type="application/json" id="rmx-data">');
  return at === -1 ? body : body.slice(0, at);
}

const ALPHA = tagged("alpha");
const BRAVO = tagged("bravo");

function input(snap: SnapshotResponse, path = "/", over: Partial<DocumentInput> = {}): DocumentInput {
  return {
    url: new URL(path, "http://collie.test"),
    base: "/",
    snapshot: snap,
    snapshotAt: SNAPSHOT.ts,
    config: CONFIG,
    prefs: null,
    now: SNAPSHOT.ts,
    ...over,
  };
}

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta name="collie-base" content="/collie/" />
    <title>Collie</title>
    <script type="module" src="/collie/assets/index-x.js"></script>
  </head>
  <body>
    <div id="splash">splash</div>
  </body>
</html>
`;

describe("server document render", () => {
  test("the renderer under test was compiled with Remix JSX", () => {
    expect(rendersRemixJsx()).toBe(true);
  });

  test("home draws the snapshot's workspaces inside one AppRoot island", async () => {
    const { body } = await renderAppBody(input(ALPHA));
    expect(markup(body)).toContain("alpha-collie");
    expect(markup(body)).toContain("alpha-website");
    // One island and its data block, and no splash: the static boot's marks are not in it.
    expect(body.match(/<!-- rmx:h:/g)?.length).toBe(1);
    expect(body).toContain('<script type="application/json" id="rmx-data">');
    expect(body).toContain('"collie:app"');
    expect(body).not.toContain("rmx:flush");
  });

  test("a pane draws its own screen", async () => {
    const { body } = await renderAppBody(input(ALPHA, `/pane/${encodeURIComponent("alpha-w1:p1")}`));
    // The pane's own view with its sibling chips. Its screen is a skeleton until the first pane read:
    // the snapshot carries panes, not their text.
    expect(markup(body)).toContain('data-testid="pane-view"');
    expect(markup(body)).toContain("some-new-harness");
    expect(markup(body)).toContain('data-slot="screen-skeleton"');
  });

  test("two snapshots back to back: neither output names the other's panes", async () => {
    const a = (await renderAppBody(input(ALPHA))).body;
    const b = (await renderAppBody(input(BRAVO))).body;
    expect(a).toContain("alpha-");
    expect(a).not.toContain("bravo-");
    expect(b).toContain("bravo-");
    expect(b).not.toContain("alpha-");
  });

  test("interleaved with awaits: neither output names the other's panes", async () => {
    const pa = renderAppBody(input(ALPHA, `/pane/${encodeURIComponent("alpha-w1:p1")}`));
    await Promise.resolve();
    const pb = renderAppBody(input(BRAVO));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pc = renderAppBody(input(ALPHA));
    const [a, b, c] = await Promise.all([pa, pb, pc]);
    for (const out of [a.body, c.body]) {
      expect(out).toContain("alpha-");
      expect(out).not.toContain("bravo-");
    }
    expect(b.body).toContain("bravo-");
    expect(b.body).not.toContain("alpha-");
  });

  test("the tree is built inside the call: on return the switch is off and every store is empty again", () => {
    const pending = renderAppBody(input(ALPHA));
    expect(onServer()).toBe(false);
    expect(snapshot.get().data).toBeUndefined();
    expect(config.get().data).toBeUndefined();
    return pending;
  });

  test("a render leaves the process's fetch alone (the busy tracker is browser only)", async () => {
    const before = globalThis.fetch;
    await renderAppBody(input(ALPHA));
    await renderAppBody(input(ALPHA, `/pane/${encodeURIComponent("alpha-w1:p1")}`));
    expect(globalThis.fetch).toBe(before);
  });

  test("a link the render draws carries the mount", async () => {
    // SAFETY: the header reads only `name` and `logoUrl` of the multiplexer block (shell/header.tsx).
    const withLogo: BridgeConfig = { ...CONFIG, mux: { name: "herdr", logoUrl: "/api/mux/logo.svg" } as BridgeConfig["mux"] };
    const mountedBody = (await renderAppBody(input(ALPHA, "/", { base: "/collie/", config: withLogo }))).body;
    expect(mountedBody).toContain('src="/collie/api/mux/logo.svg"');
    const rootBody = (await renderAppBody(input(ALPHA, "/", { config: withLogo }))).body;
    expect(rootBody).toContain('src="/api/mux/logo.svg"');
  });

  test("the document keeps the head byte for byte and replaces the body's children", async () => {
    const html = await renderAppDocument(INDEX, input(ALPHA, "/", { base: "/collie/" }));
    const head = INDEX.slice(0, INDEX.indexOf("</head>"));
    expect(html.startsWith(head)).toBe(true);
    expect(html).not.toContain("splash");
    expect(html).toContain("alpha-collie");
    expect(html.endsWith("</body>\n</html>\n")).toBe(true);
  });

  test("render styles go at the end of the head", () => {
    const html = spliceDocument(INDEX, { head: "<style>.x{}</style>", body: "<main>hi</main>" });
    expect(html).toContain("<style>.x{}</style></head>");
    expect(html).toContain("<body><main>hi</main></body>");
  });

  test("only home and a pane are document routes", () => {
    const at = (path: string): URL => new URL(path, "http://collie.test");
    expect(isDocumentRoute(at("/"))).toBe(true);
    expect(isDocumentRoute(at("/pane/w1%3Ap1"))).toBe(true);
    expect(isDocumentRoute(at("/settings"))).toBe(false);
    expect(isDocumentRoute(at("/pane/w1%3Ap1/history"))).toBe(false);
    expect(isDocumentRoute(at("/space/w1"))).toBe(false);
  });

  test("the snapshot read follows the page's scope", () => {
    const at = (path: string): URL => new URL(path, "http://collie.test");
    expect(snapshotApiPath(at("/"))).toBe("/api/snapshot");
    expect(snapshotApiPath(at("/?s=work"))).toContain("session=work");
    expect(snapshotApiPath(at("/?all=1"))).toContain("sessions=all");
  });
});

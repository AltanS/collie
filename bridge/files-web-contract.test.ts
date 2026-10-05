import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RootSnapshot } from "./changes-root.ts";
import { loadConfig } from "./config.ts";
import { guard, paneFiles, workspaceFiles } from "./server.ts";
import type { AgentView, WorkspaceView } from "./types.ts";
import { fetchFileText, fetchFilesDir } from "../web/src/lib/api.ts";

// THE FILES VIEW'S TWO HALVES, ASKED OF EACH OTHER (ADR 0083).
//
// The phone's fetchers (`web/src/lib/api.ts`) were written against fixtures, and the bridge's routes
// against their own tests. This file runs the bridge's REAL answers (`paneFiles`, `workspaceFiles`,
// `guard`) through the phone's REAL fetchers, so a renamed query key, a changed refusal word or a
// moved field fails here and not on a phone. Like `auth-path-contract.test.ts`, it imports across the
// boundary on purpose.

let base: string;
let home: string;
let root: string;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

// The phone's transport reads the mount off the page's `<meta>` and the device token out of
// `localStorage`. There is no page here: a root mount and no token is what a bare bridge sees.
Object.defineProperty(globalThis, "document", { value: { querySelector: () => null }, configurable: true });
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  configurable: true,
});

function pane(paneId: string, workspaceId: string, cwd: string): AgentView {
  // SAFETY: the Files routes read `paneId`, `workspaceId` and `cwd` off a view and nothing else.
  return { paneId, workspaceId, cwd } as AgentView;
}

function space(workspaceId: string, label: string): WorkspaceView {
  return { workspaceId, number: 1, label, focused: false, activeTabId: "", tabCount: 1, paneCount: 1 };
}

/** What the phone asks of a bridge: the bridge's own handlers answer, and the URL is the phone's. */
function serveFromBridge(handler: (url: URL) => Promise<Response>): void {
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo): Promise<Response> => {
        const raw = input instanceof Request ? input.url : String(input);
        return handler(new URL(raw, "http://bridge.test"));
      },
      // Bun's `fetch` type carries `preconnect`; a stand-in has nothing to connect to.
      { preconnect: () => {} },
    ),
  );
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "collie-files-contract-")));
  home = join(base, "home");
  root = join(home, "ws");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Hello\n");
  writeFileSync(join(root, "docs", "guide.md"), "guide\n");
  writeFileSync(join(root, "logo.bin"), new Uint8Array([0x89, 0x50, 0, 1, 2]));
});

afterAll(() => {
  fetchSpy?.mockRestore();
  rmSync(base, { recursive: true, force: true });
});

describe("the phone's Files fetchers read the bridge's real answers", () => {
  const snap: () => RootSnapshot = () => ({
    agents: [pane("w1:p1", "w1", root)],
    shellPanes: [],
    workspaces: [space("w1", "ws")],
  });
  const engine = { current: snap };
  const asked = (url: URL) => new Request(url);
  const bridge = (url: URL): Promise<Response> => {
    const byPane = /^\/api\/pane\/([^/]+)\/files$/.exec(url.pathname);
    if (byPane) return paneFiles(engine, decodeURIComponent(byPane[1]!), url, asked(url), [], home);
    const ws = /^\/api\/workspace\/([^/]+)\/files$/.exec(url.pathname);
    if (ws) return workspaceFiles(engine, decodeURIComponent(ws[1]!), url, asked(url), [], home);
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  test("a folder, by pane and by workspace, with the query the bridge reads", async () => {
    serveFromBridge(bridge);
    const top = await fetchFilesDir({ kind: "pane", paneId: "w1:p1" }, "");
    expect(top.outcome).toBe("body");
    if (top.outcome !== "body" || !top.body.available) throw new Error("expected a listing");
    expect(top.body).toMatchObject({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "ws", root, dir: "", truncated: false });
    expect(top.body.entries.map((e) => `${e.kind}:${e.name}`)).toEqual(["dir:docs", "file:logo.bin", "file:README.md"]);

    const docs = await fetchFilesDir({ kind: "space", spaceId: "w1" }, "docs");
    if (docs.outcome !== "body" || !docs.body.available) throw new Error("expected a listing");
    expect(docs.body).toMatchObject({ workspaceId: "w1", dir: "docs" });
    expect(docs.body.entries).toEqual([{ name: "guide.md", kind: "file", size: 6 }]);
  });

  test("a file, as text and as binary", async () => {
    serveFromBridge(bridge);
    const text = await fetchFileText({ kind: "pane", paneId: "w1:p1" }, "docs/guide.md");
    if (text.outcome !== "body" || !text.body.available) throw new Error("expected a file");
    expect(text.body).toMatchObject({ path: "docs/guide.md", size: 6, binary: false, truncated: false, text: "guide\n" });
    const bin = await fetchFileText({ kind: "pane", paneId: "w1:p1" }, "logo.bin");
    if (bin.outcome !== "body" || !bin.body.available) throw new Error("expected a file");
    expect(bin.body).toMatchObject({ binary: true, text: "", size: 5 });
  });

  test("the bridge's 404 for a refused path reads as unknown-path, and a bare 404 as a stale member", async () => {
    serveFromBridge(bridge);
    expect(await fetchFileText({ kind: "pane", paneId: "w1:p1" }, "../outside")).toEqual({ outcome: "unknown-path" });
    expect(await fetchFilesDir({ kind: "space", spaceId: "w1" }, "nope")).toEqual({ outcome: "unknown-path" });
    // A member one release behind has no `files` segment and answers the generic not-found body.
    serveFromBridge(() => Promise.resolve(new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    expect(await fetchFilesDir({ kind: "pane", paneId: "w1:p1" }, "")).toEqual({ outcome: "stale" });
  });

  test("an unavailable answer is a body the view reads the reason of", async () => {
    serveFromBridge(bridge);
    const gone = await fetchFilesDir({ kind: "pane", paneId: "nope" }, "");
    expect<unknown>(gone).toEqual({ outcome: "body", body: { paneId: "nope", available: false, reason: "no-pane" } });
    const nowhere = await fetchFilesDir({ kind: "space", spaceId: "nope" }, "");
    expect<unknown>(nowhere).toEqual({ outcome: "body", body: { workspaceId: "nope", available: false, reason: "no-workspace" } });
  });

  test("the gate's two plain-text 403s read as not-paired and not-authorised", async () => {
    const unauthorised = {
      ...loadConfig({ COLLIE_DEVICE_HEADER: "x-device-id", COLLIE_DEVICE_ALLOWLIST: "phone" }),
      allowAnyHost: true,
    };
    const gate = { enforced: () => true, resolve: () => null };
    // The headers a same-origin phone sends, so only the device half of the gate is under test.
    const headers = { host: "collie.test", "x-device-id": "phone" };
    serveFromBridge((url) => {
      const denied = guard(new Request(url, { headers }), unauthorised, "device-read", gate);
      return Promise.resolve(denied ?? new Response("{}", { status: 200 }));
    });
    expect(await fetchFilesDir({ kind: "pane", paneId: "w1:p1" }, "")).toEqual({ outcome: "not-paired" });
    serveFromBridge((url) => {
      const denied = guard(new Request(url, { headers: { host: "collie.test", "x-device-id": "intruder" } }), unauthorised, "device-read", gate);
      return Promise.resolve(denied ?? new Response("{}", { status: 200 }));
    });
    expect(await fetchFilesDir({ kind: "pane", paneId: "w1:p1" }, "")).toEqual({ outcome: "not-authorised" });
  });

  test("a crew scope rides as ?host=, after the folder, and the bridge's query reading is unaffected", async () => {
    const seen: URL[] = [];
    serveFromBridge((url) => {
      seen.push(url);
      return bridge(url);
    });
    const got = await fetchFilesDir({ kind: "pane", paneId: "w1:p1" }, "docs", { host: "laptop" });
    expect(got.outcome).toBe("body");
    expect(seen[0]!.searchParams.get("dir")).toBe("docs");
    expect(seen[0]!.searchParams.get("host")).toBe("laptop");
  });
});

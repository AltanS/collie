// The Changes and Files part of the stub bridge (ADR 0065, 0083). A `StubHandler` for
// `installRoutesApi`: it answers `/api/pane/:id/{changes,files}` and `/api/workspace/:id/{changes,files}`
// the way the bridge does, with a small workspace of its own. Shaped like web/src/test/handlers.ts
// (which pulls msw, so it is not imported here). Names of harnesses and multiplexers appear nowhere.
import type {
  ChangeCommitDiffResponse,
  ChangeCommitResponse,
  ChangeDiffResponse,
  ChangedFile,
  ChangesResponse,
  FileEntry,
  FileReadResponse,
  FilesListResponse,
} from "@web/lib/types";

import type { StubHandler } from "./routes-api";

export interface ChangesStubOptions {
  /** The list answers with no changed repo and one clean repo that has a last commit. */
  clean?: boolean;
}

const ROOT = "/home/you/webapp";
const HEAD = { workspaceId: "w1", workspaceLabel: "webapp" } as const;

const FILES: ChangedFile[] = [
  { path: "src/routes/checkout.tsx", status: "M", added: 2, removed: 1, binary: false },
  { path: "src/lib/cart.ts", status: "A", added: 3, removed: 0, binary: false },
];

const DIFFS = new Map<string, string>([
  [
    "src/routes/checkout.tsx",
    [
      "diff --git a/src/routes/checkout.tsx b/src/routes/checkout.tsx",
      "--- a/src/routes/checkout.tsx",
      "+++ b/src/routes/checkout.tsx",
      "@@ -1,3 +1,4 @@",
      " export function Checkout() {",
      "-  return <h1>Checkout</h1>;",
      "+  const total = cartTotal([]);",
      "+  return <h1>Checkout {total}</h1>;",
      " }",
      "",
    ].join("\n"),
  ],
  [
    "src/lib/cart.ts",
    [
      "diff --git a/src/lib/cart.ts b/src/lib/cart.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/lib/cart.ts",
      "@@ -0,0 +1,3 @@",
      "+export function cartTotal(items: { price: number }[]): number {",
      "+  return items.reduce((sum, item) => sum + item.price, 0);",
      "+}",
      "",
    ].join("\n"),
  ],
]);

const FOLDERS = new Map<string, FileEntry[]>([
  [
    "",
    [
      { name: "src", kind: "dir" },
      { name: "README.md", kind: "file", size: 120 },
      { name: "package.json", kind: "file", size: 90 },
    ],
  ],
  [
    "src",
    [
      { name: "lib", kind: "dir" },
      { name: "routes", kind: "dir" },
    ],
  ],
  ["src/lib", [{ name: "cart.ts", kind: "file", size: 120 }]],
  ["src/routes", [{ name: "checkout.tsx", kind: "file", size: 90 }]],
]);

const TEXTS = new Map<string, string>([
  ["README.md", "# Webapp\n\nA small shop. **Run it** with `bun dev`.\n\n- carts\n- checkout\n"],
  ["package.json", `${JSON.stringify({ name: "webapp", version: "1.2.0", scripts: { dev: "vite" } }, null, 2)}\n`],
  ["src/routes/checkout.tsx", "export function Checkout() {\n  const total = cartTotal([]);\n  return <h1>Checkout {total}</h1>;\n}\n"],
  ["src/lib/cart.ts", "export function cartTotal(items: { price: number }[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n"],
]);

function list(clean: boolean): ChangesResponse {
  const answer: ChangesResponse = {
    ...HEAD,
    available: true,
    root: ROOT,
    truncated: false,
    repos: clean ? [] : [{ relPath: ".", name: "webapp", files: FILES }],
  };
  if (clean && answer.available) answer.clean = [{ relPath: ".", name: "webapp" }];
  return answer;
}

function diff(repo: string, path: string): ChangeDiffResponse {
  const file = FILES.find((f) => f.path === path);
  if (file === undefined) return { ...HEAD, available: false, reason: "unknown-path" };
  return { ...HEAD, available: true, repo, path, status: file.status, binary: false, directory: false, truncated: false, diff: DIFFS.get(path) ?? "" };
}

const COMMIT_HASH = "3f2a9c1e5b7d4f60a8e2c4b6d8f0a1c3e5b7d9f1";

function commit(repo: string): ChangeCommitResponse {
  return {
    ...HEAD,
    available: true,
    repo,
    name: "webapp",
    commit: { hash: COMMIT_HASH, shortHash: "3f2a9c1", subject: "Move the cart total into its own helper", author: "Claude", time: 1_790_000_000 },
    truncated: false,
    files: FILES,
  };
}

function commitDiff(repo: string, path: string): ChangeCommitDiffResponse {
  const file = FILES.find((f) => f.path === path);
  if (file === undefined) return { ...HEAD, available: false, reason: "unknown-path" };
  return { ...HEAD, available: true, repo, path, status: file.status, binary: false, directory: false, truncated: false, diff: DIFFS.get(path) ?? "", hash: COMMIT_HASH };
}

function folder(dir: string): FilesListResponse | null {
  const entries = FOLDERS.get(dir);
  return entries === undefined ? null : { ...HEAD, available: true, root: ROOT, dir, entries, truncated: false };
}

function read(path: string): FileReadResponse | null {
  const text = TEXTS.get(path);
  return text === undefined ? null : { ...HEAD, available: true, root: ROOT, path, size: text.length, binary: false, truncated: false, text };
}

/** The handler. Asked by pane or by workspace, the answer is the same (ADR 0065). */
export function changesStub(options: ChangesStubOptions = {}): StubHandler {
  return async (ctx) => {
    const hit = /^\/api\/(?:pane|workspace)\/[^/]+\/(changes|files)$/u.exec(ctx.url.pathname);
    if (hit === null || ctx.method !== "GET") return false;
    const q = ctx.url.searchParams;
    const repo = q.get("repo");
    const path = q.get("path");
    if (hit[1] === "changes") {
      if (q.get("view") === "commit") {
        await ctx.json(200, repo !== null && path !== null ? commitDiff(repo, path) : commit(repo ?? "."));
      } else if (repo !== null && path !== null) await ctx.json(200, diff(repo, path));
      else await ctx.json(200, list(options.clean === true));
      return true;
    }
    const found = path !== null ? read(path) : folder(q.get("dir") ?? "");
    await ctx.json(found === null ? 404 : 200, found ?? { error: "unknown-path" });
    return true;
  };
}

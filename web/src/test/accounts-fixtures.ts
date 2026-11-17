import { http, HttpResponse } from "msw";

import type { AccountHarness, AccountRow, AccountsBody, FoundFolder } from "@/lib/accounts";
import { server } from "@/test/setup";

// Fixtures for the Accounts tests (M101). Made-up labels and folders only.

export const HARNESS_CLAUDE: AccountHarness = {
  id: "claude",
  label: "Claude Code",
  select: "CLAUDE_CONFIG_DIR",
  kinds: ["shared", "own"],
  newFolder: "~/.claude-{slug}",
  binary: "claude",
};

export const HARNESS_CODEX: AccountHarness = {
  id: "codex",
  label: "Codex",
  select: "CODEX_HOME",
  kinds: ["own"],
  newFolder: "~/.codex-{slug}",
  binary: "codex",
};

export function defaultRow(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "claude:default",
    harness: "claude",
    label: "",
    kind: "default",
    folder: "~/.claude",
    startLine: "claude",
    windows: [],
    seenAt: null,
    live: false,
    ...over,
  };
}

export function workRow(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-work",
    harness: "claude",
    label: "Work",
    kind: "shared",
    folder: "~/.claude-work",
    startLine: "CLAUDE_CONFIG_DIR=~/.claude-work claude",
    windows: [],
    seenAt: null,
    live: false,
    ...over,
  };
}

export function body(over: Partial<AccountsBody> = {}): AccountsBody {
  return { harnesses: [HARNESS_CLAUDE], accounts: [defaultRow()], found: [], ...over };
}

export const FOUND_ALT: FoundFolder = { harness: "claude", folder: "~/.claude-alt", path: "/home/op/.claude-alt", why: "reported" };

/** Answer GET /api/accounts with `answer`, noting each query string in `seen`. */
export function serveAccounts(answer: AccountsBody, seen: string[] = []): void {
  server.use(
    http.get("/api/accounts", ({ request }) => {
      seen.push(new URL(request.url).search);
      return HttpResponse.json(answer);
    }),
  );
}

/** Answer GET /api/accounts with a refusal of that status (404 is `accounts.unavailable`). */
export function serveAccountsStatus(status: number): void {
  server.use(http.get("/api/accounts", () => HttpResponse.json({ ok: false, error: "no", code: "accounts.unavailable" }, { status })));
}

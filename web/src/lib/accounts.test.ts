import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { body, defaultRow, HARNESS_CLAUDE, HARNESS_CODEX, serveAccounts, serveAccountsStatus, workRow } from "@/test/accounts-fixtures";
import { server } from "@/test/setup";
import { addAccount, createWorktreeAt, fetchAccounts, removeAccount, startLaunch } from "./api";
import {
  accountName,
  addedCount,
  addedOf,
  folderTextInvalid,
  groupAccounts,
  isHot,
  nameFromFolder,
  newFolderFor,
  planWords,
  rememberStartError,
  listSeenLine,
  sameLoginAs,
  sameLoginLine,
  seenLine,
  signedInText,
  slugOf,
  startLineFor,
  takeStartError,
  useAccounts,
  windowDetail,
  windowFigure,
  windowName,
  type AccountRow,
} from "./accounts";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

describe("accounts: the windows are the harness's own", () => {
  it("names the two known keys, a scoped week, a labelled key, and a bare key", () => {
    expect(windowName({ window: "5h", usedPct: 1, resetsAt: null })).toBe("5 hours");
    expect(windowName({ window: "7d", usedPct: 1, resetsAt: null })).toBe("Week");
    expect(windowName({ window: "7d:sonnet", label: "Sonnet", usedPct: 1, resetsAt: null })).toBe("Week · Sonnet");
    expect(windowName({ window: "7d:opus", usedPct: 1, resetsAt: null })).toBe("Week · opus");
    expect(windowName({ window: "spend", label: "Spend", usedPct: 1, resetsAt: null })).toBe("Spend");
    expect(windowName({ window: "spend", label: "Gateway", usedPct: 1, resetsAt: null })).toBe("Gateway");
    expect(windowName({ window: "spend", usedPct: 1, resetsAt: null })).toBe("Spend");
    expect(windowName({ window: "credits", usedPct: 1, resetsAt: null })).toBe("Credits");
    expect(windowName({ window: "30d", usedPct: 1, resetsAt: null })).toBe("30d");
  });

  it("refuses a typed folder the bridge would refuse, by character and by length", () => {
    expect(folderTextInvalid("~/.claude-alt")).toBe(false);
    expect(folderTextInvalid("/home/op/my folder")).toBe(false);
    for (const bad of ["/a'b", '/a"b', "/a\\b", "/a`b", "/a$b", "/a\nb", "/a\u0007b", "/a\u202eb", "/a\u0085b"]) {
      expect(folderTextInvalid(bad), JSON.stringify(bad)).toBe(true);
    }
    expect(folderTextInvalid(`/${"a".repeat(199)}`)).toBe(false);
    expect(folderTextInvalid(`/${"a".repeat(200)}`)).toBe(true);
  });

  it("draws used percent, hot from 80, and a reset window as 'reset' with the long form", () => {
    expect(windowFigure({ window: "5h", usedPct: 42, resetsAt: null })).toBe("42% used");
    expect(isHot({ window: "5h", usedPct: 79, resetsAt: null })).toBe(false);
    expect(isHot({ window: "5h", usedPct: 80, resetsAt: null })).toBe(true);
    const over = { window: "7d", usedPct: null, resetsAt: NOW - 1000 };
    expect(windowFigure(over)).toBe("reset");
    expect(isHot(over)).toBe(false);
    expect(windowDetail(over, NOW)).toBe("over, not read since");
    expect(windowDetail({ window: "7d", usedPct: 5, resetsAt: null }, NOW)).toBe("");
  });

  it("says in use now, else the age of the reading, else nothing", () => {
    expect(seenLine(workRow({ live: true, seenAt: NOW }), NOW)).toBe("In use now");
    expect(seenLine(workRow({ seenAt: NOW - 5 * 60_000 }), NOW)).toMatch(/^Last seen 5.*m.* ago$/);
    expect(seenLine(workRow(), NOW)).toBeNull();
  });
});

describe("listSeenLine", () => {
  it("counts the sessions that run, one and many, ahead of 'In use now'", () => {
    expect(listSeenLine(workRow({ live: true, running: 1 }), NOW)).toBe("1 session");
    expect(listSeenLine(workRow({ live: true, running: 2 }), NOW)).toBe("2 sessions");
  });

  it("keeps 'In use now' while only a sign-in session runs, and the age of the reading otherwise", () => {
    expect(listSeenLine(workRow({ live: true, running: 0 }), NOW)).toBe("In use now");
    expect(listSeenLine(workRow({ live: true }), NOW)).toBe("In use now");
    expect(listSeenLine(workRow({ seenAt: NOW - 5 * 60_000 }), NOW)).toMatch(/^Last seen 5.*m.* ago$/);
    expect(listSeenLine(workRow(), NOW)).toBeNull();
  });
});

describe("sameLoginAs", () => {
  const ME = { signedIn: true, email: "me@example.com" };
  const rowOf = (id: string, label: string, identity: AccountRow["identity"], over: Partial<AccountRow> = {}) => workRow({ id, label, identity, ...over });

  it("finds another profile of the agent with the same email, in any letter case", () => {
    const rows = [defaultRow({ identity: ME }), rowOf("acc-work", "Work", { signedIn: true, email: "ME@Example.com" })];
    expect(sameLoginAs(rows, rows[0]!)?.id).toBe("acc-work");
    expect(sameLoginAs(rows, rows[1]!)?.id).toBe("claude:default");
    expect(sameLoginLine(rows, rows[1]!)).toBe("Same login as Default.");
    expect(sameLoginLine(rows, rows[0]!)).toBe("Same login as Work.");
  });

  it("gives nothing for a different email, another agent, a profile not signed in, or no email", () => {
    const base = defaultRow({ identity: ME });
    expect(sameLoginAs([base, rowOf("a", "A", { signedIn: true, email: "other@example.com" })], base)).toBeUndefined();
    expect(sameLoginAs([base, rowOf("b", "B", ME, { harness: "codex" })], base)).toBeUndefined();
    expect(sameLoginAs([base, rowOf("c", "C", { signedIn: false, email: "me@example.com" })], base)).toBeUndefined();
    expect(sameLoginAs([base, rowOf("d", "D", { signedIn: true })], base)).toBeUndefined();
    expect(sameLoginAs([{ ...base, identity: { signedIn: false, email: "me@example.com" } }, rowOf("e", "E", ME)], { ...base, identity: { signedIn: false, email: "me@example.com" } })).toBeUndefined();
    expect(sameLoginAs([base, rowOf("f", "F", undefined)], base)).toBeUndefined();
    expect(sameLoginAs([base], base)).toBeUndefined();
    expect(sameLoginLine([base], base)).toBeNull();
  });

  it("with three rows each names the first OTHER match, and a third with another login has none", () => {
    const one = defaultRow({ identity: ME });
    const two = rowOf("acc-work", "Work", ME);
    const three = rowOf("acc-lodge", "Lodge", ME);
    const apart = rowOf("acc-shop", "Workshop", { signedIn: true, email: "shop@example.com" });
    const rows = [one, two, three, apart];
    expect(sameLoginLine(rows, one)).toBe("Same login as Work.");
    expect(sameLoginLine(rows, two)).toBe("Same login as Default.");
    expect(sameLoginLine(rows, three)).toBe("Same login as Default.");
    expect(sameLoginLine(rows, apart)).toBeNull();
  });
});

describe("accounts: the list", () => {
  it("writes the app's own word for a Default row and keeps the label of an added one", () => {
    expect(accountName(defaultRow())).toBe("Default");
    expect(accountName(workRow())).toBe("Work");
  });

  it("counts and lists only added accounts, per agent", () => {
    const b = body({ accounts: [defaultRow(), workRow(), defaultRow({ id: "codex:default", harness: "codex" })] });
    expect(addedCount(b)).toBe(1);
    expect(addedOf(b, "claude").map((a) => a.label)).toEqual(["Work"]);
    expect(addedOf(b, "codex")).toEqual([]);
    expect(addedOf(null, "claude")).toEqual([]);
  });

  it("groups by the bridge's agent order and keeps an agent the bridge no longer lists", () => {
    const b = body({
      harnesses: [HARNESS_CODEX, HARNESS_CLAUDE],
      accounts: [defaultRow(), workRow(), defaultRow({ id: "codex:default", harness: "codex" }), defaultRow({ id: "x:default", harness: "x" })],
    });
    expect(groupAccounts(b).map((g) => [g.harness, g.label, g.rows.length])).toEqual([
      ["codex", "Codex", 1],
      ["claude", "Claude Code", 2],
      ["x", "x", 1],
    ]);
  });
});

describe("accounts: Add", () => {
  it("slugs a label the way the bridge does", () => {
    expect(slugOf("  My Work  ")).toBe("my-work");
    expect(slugOf("Büro 2")).toBe("bro-2");
    expect(slugOf("***")).toBe("");
  });

  it("shows the new folder from the harness's own pattern, 'name' while the label is empty", () => {
    expect(newFolderFor(HARNESS_CLAUDE, "Work")).toBe("~/.claude-work");
    expect(newFolderFor(HARNESS_CODEX, "")).toBe("~/.codex-name");
  });

  it("builds the terminal line from the selector: a variable before the command, a flag after it", () => {
    expect(startLineFor(HARNESS_CLAUDE, "~/.claude-work")).toBe("CLAUDE_CONFIG_DIR=~/.claude-work claude");
    expect(startLineFor({ ...HARNESS_CLAUDE, id: "tool", select: "--profile", binary: "tool" }, "work")).toBe("tool --profile work");
  });

  it("names the command by the bridge's binary, and by the id when an older bridge sends none", () => {
    expect(startLineFor({ ...HARNESS_CODEX, id: "codex-cli", binary: "codex" }, "~/.codex-work")).toBe("CODEX_HOME=~/.codex-work codex");
    expect(startLineFor({ ...HARNESS_CLAUDE, id: "tool", select: "--profile", binary: "tool-bin" }, "work")).toBe("tool-bin --profile work");
    const { binary: _gone, ...older } = { ...HARNESS_CODEX, binary: "x" };
    expect(startLineFor(older, "~/.codex-work")).toBe("CODEX_HOME=~/.codex-work codex");
  });

  it("prefills a name from a found folder: no dot, no agent word, a capital", () => {
    expect(nameFromFolder("~/.claude-work", "claude")).toBe("Work");
    expect(nameFromFolder("~/.config/claude-team", "claude")).toBe("Team");
    expect(nameFromFolder("~/personal_login", "claude")).toBe("Personal login");
    expect(nameFromFolder("~/.claude", "claude")).toBe("Claude");
    expect(nameFromFolder("/", "claude")).toBe("");
  });

  it("keeps a failed sign-in start for the account's page, once", () => {
    rememberStartError("acc-1", "no screen");
    expect(takeStartError("acc-1")).toBe("no screen");
    expect(takeStartError("acc-1")).toBeNull();
  });
});

describe("accounts: the read hook", () => {
  it("reads the machine's accounts and says which scope the answer belongs to", async () => {
    const seen: string[] = [];
    serveAccounts(body({ accounts: [defaultRow(), workRow()] }), seen);
    const { result } = renderHook(() => useAccounts({ host: "mini" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(seen).toEqual(["?host=mini"]);
    expect(result.current.body?.accounts).toHaveLength(2);
    expect(result.current.loadedFor).toBe("mini\u0000");
  });

  it("a 404 means no feature: unavailable, no body", async () => {
    serveAccountsStatus(404);
    const { result } = renderHook(() => useAccounts());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.body).toBeNull();
  });

  it("a crew member that cannot answer the list reads as no feature, never as failed (M101 spec 06)", async () => {
    // Through the lead: a 1.28.x member's peer surface answers its own `not found`, a Windows member
    // its own `accounts.unavailable`. Both are a 404 at the phone, so the pick hides quietly.
    for (const answer of [{ error: "not found" }, { ok: false, error: "this machine offers no accounts", code: "accounts.unavailable" }]) {
      server.use(http.get("/api/accounts", () => HttpResponse.json(answer, { status: 404 })));
      const { result, unmount } = renderHook(() => useAccounts({ host: "old-member" }));
      await waitFor(() => expect(result.current.status).toBe("unavailable"));
      expect(result.current.body).toBeNull();
      expect(result.current.loadedFor).toBe("old-member\u0000");
      unmount();
    }
  });

  it("any other failure is a failed read that also hides the feature", async () => {
    serveAccountsStatus(500);
    const { result } = renderHook(() => useAccounts());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.body).toBeNull();
  });

  it("reads nothing while disabled", async () => {
    const seen: string[] = [];
    serveAccounts(body(), seen);
    const { result } = renderHook(() => useAccounts(undefined, false));
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.status).toBe("loading");
    expect(seen).toEqual([]);
  });
});

describe("accounts: the request bodies", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("a start without an account is built byte for byte as before", async () => {
    const bodies: string[] = [];
    server.use(
      http.post("/api/launch", async ({ request }) => {
        bodies.push(await request.text());
        return HttpResponse.json({ ok: true, pane: { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "x", tabId: "w1:t1", cwd: "/x" } });
      }),
    );
    await startLaunch({ kind: "harness", id: "claude" }, { cwd: "~/src", requestId: ID });
    await startLaunch({ kind: "harness", id: "claude" }, { cwd: "~/src", requestId: ID, account: undefined, signIn: undefined });
    await startLaunch({ kind: "row", command: "htop" }, { requestId: ID, account: "a1", signIn: true });
    expect(bodies[0]).toBe(`{"requestId":"${ID}","harness":"claude","cwd":"~/src"}`);
    expect(bodies[1]).toBe(bodies[0]);
    // An account and a sign-in belong to an agent started by id; a row carries neither.
    expect(bodies[2]).toBe(`{"requestId":"${ID}","command":"htop"}`);
  });

  it("an agent started by id carries its account and the sign-in flag", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/launch", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, pane: { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "x", tabId: "w1:t1", cwd: "/x" } });
      }),
    );
    await startLaunch({ kind: "harness", id: "claude" }, { requestId: ID, account: "acc-work", signIn: true });
    await startLaunch({ kind: "harness", id: "claude" }, { requestId: ID, signIn: true });
    expect(bodies).toEqual([
      { requestId: ID, harness: "claude", account: "acc-work", signIn: true },
      { requestId: ID, harness: "claude", signIn: true },
    ]);
  });

  it("a worktree start carries the account only with an agent by id", async () => {
    const bodies: string[] = [];
    server.use(
      http.post("/api/worktree", async ({ request }) => {
        bodies.push(await request.text());
        return HttpResponse.json({ ok: false, error: "x" }, { status: 400 });
      }),
    );
    const ask = { cwd: "~/src", branch: "b", base: { kind: "default" }, folder: { kind: "default" }, requestId: ID } as const;
    await createWorktreeAt({ ...ask, what: { kind: "harness", id: "claude" } }).catch(() => undefined);
    await createWorktreeAt({ ...ask, what: { kind: "harness", id: "claude" }, account: "acc-work" }).catch(() => undefined);
    await createWorktreeAt({ ...ask, what: { kind: "shell" }, account: "acc-work" }).catch(() => undefined);
    expect(bodies[0]).not.toContain("account");
    expect(JSON.parse(bodies[1]!)).toMatchObject({ harness: "claude", account: "acc-work" });
    expect(bodies[2]).not.toContain("account");
  });

  it("add and remove send the contract's bodies to the lead, with no host on the wire", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    server.use(
      http.post("/api/accounts", async ({ request }) => {
        seen.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ account: workRow() });
      }),
      http.post("/api/accounts/remove", async ({ request }) => {
        seen.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ ok: true });
      }),
    );
    await addAccount({ harness: "claude", label: "Work", kind: "shared" }, ID);
    await addAccount({ harness: "claude", label: "Alt", kind: "own", path: "~/.claude-alt" }, ID);
    await removeAccount("acc-work", ID);
    expect(seen.map((s) => new URL(s.url).search)).toEqual(["", "", ""]);
    expect(seen.map((s) => s.body)).toEqual([
      { harness: "claude", label: "Work", kind: "shared", requestId: ID },
      { harness: "claude", label: "Alt", kind: "own", path: "~/.claude-alt", requestId: ID },
      { requestId: ID, id: "acc-work" },
    ]);
  });
});

describe("accounts: who is signed in", () => {
  it("reads a plan in plain words", () => {
    expect(planWords("max")).toBe("Max");
    expect(planWords("pro")).toBe("Pro");
    expect(planWords("team_plus")).toBe("Team Plus");
  });

  it("gives the email with the plan after it, either alone, or nothing", () => {
    expect(signedInText({ signedIn: true, email: "someone@example.com", plan: "max" })).toBe("someone@example.com · Max");
    expect(signedInText({ signedIn: true, email: "someone@example.com" })).toBe("someone@example.com");
    expect(signedInText({ signedIn: true, plan: "max" })).toBe("Max");
    expect(signedInText({ signedIn: true })).toBeNull();
  });
});

describe("the accounts read, an answer with no usable accounts list", () => {
  it("is a failed read for every caller, not a body that throws on `.accounts`", async () => {
    for (const answer of [{ version: 99 }, { accounts: null }, { accounts: {} }, [], null]) {
      server.use(http.get("/api/accounts", () => HttpResponse.json(answer)));
      await expect(fetchAccounts()).rejects.toThrow();
    }
  });

  it("fills a missing harnesses or found part with an empty list", async () => {
    server.use(http.get("/api/accounts", () => HttpResponse.json({ accounts: [defaultRow()] })));
    expect(await fetchAccounts()).toEqual({ harnesses: [], accounts: [defaultRow()], found: [] });
  });

  it("makes the hook read `failed`, with no body", async () => {
    server.use(http.get("/api/accounts", () => HttpResponse.json({ version: 99 })));
    const { result } = renderHook(() => useAccounts());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.body).toBeNull();
  });
});

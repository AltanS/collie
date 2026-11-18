import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetFileSuggestionsCache } from "@/hooks/use-file-suggestions";
import { clearDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus, useStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import { fixtureFilesDir, FIXTURE_FILES_UNKNOWN, recordedSends } from "@/test/handlers";
import { server } from "@/test/setup";
import { Composer } from "./composer";

const ROOT = "/home/you/webapp";
const IDLE_SURFACE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  clearStatus();
  clearDraft(undefined, "w1:p1");
  resetLiveness();
  __resetOperatorCommands();
  __resetFileSuggestionsCache();
  markLive("w1:p1");
});

afterEach(() => {
  cleanup();
  __resetFileSuggestionsCache();
});

function StatusProbe() {
  const status = useStatus();
  return status === null ? null : <output data-slot="test-status">{status.text}</output>;
}

const DEFAULT_PREFS: ComponentProps<typeof Composer>["prefs"] = {
  wrap: true,
  fontSize: 11,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
  stretchText: false,
};

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    cwd: ROOT,
    gone: false,
    readOnly: false,
    surface: IDLE_SURFACE,
    text: "❯ ",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: DEFAULT_PREFS,
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <StatusProbe />
          <Composer {...props} />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return props;
}

const box = () => screen.getByPlaceholderText<HTMLTextAreaElement>(/type a reply/i);
const FILE_STRIP = { name: "File suggestions" };

function fileStripState(): "open" | "closed" | "absent" {
  const strip = screen.queryByRole("group", FILE_STRIP);
  if (strip === null) return "absent";
  return strip.closest('[data-slot="collapse"]')?.getAttribute("data-state") === "open" ? "open" : "closed";
}

describe("Composer @ file suggestions (#757)", () => {
  it("lists folders before files on `@`, hides git-ignored entries, drills into folders without closing, and adds a trailing space on file pick", async () => {
    const user = userEvent.setup();
    renderComposer();

    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();

    await user.type(box(), "@");
    const list = await screen.findByRole("group", FILE_STRIP);
    expect(list).toHaveAttribute("data-slot", "file-suggestions");
    expect(list).toHaveClass("h-11");

    const labels = Array.from(list.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "@docs/",
      "@packages/",
      "@public/",
      "@src/",
      "@current",
      "@index.html",
      "@logo.png",
      "@package.json",
      "@README.md",
    ]);
    expect(within(list).queryByRole("button", { name: /node_modules/i })).toBeNull();
    expect(within(list).queryByRole("button", { name: /debug\.log/i })).toBeNull();

    // Tapping a folder stages `@src/` without trailing space, keeps focus, sends nothing, and lists children.
    await user.click(within(list).getByRole("button", { name: "@src/" }));
    expect(box()).toHaveValue("@src/");
    expect(box()).toHaveFocus();
    expect(recordedSends()).toEqual([]);

    await waitFor(() =>
      expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@src/routes/" })).toBeInTheDocument(),
    );
    await user.click(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@src/routes/" }));
    expect(box()).toHaveValue("@src/routes/");

    await waitFor(() =>
      expect(
        within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@src/routes/checkout.tsx" }),
      ).toBeInTheDocument(),
    );
    await user.type(box(), "ch");
    const fileChip = within(screen.getByRole("group", FILE_STRIP)).getByRole("button", {
      name: "@src/routes/checkout.tsx",
    });
    expect(fileChip.querySelector(".font-bold")?.textContent).toBe("ch");

    // Tapping a file appends a trailing space, keeps focus, sends nothing, and closes the strip.
    await user.click(fileChip);
    expect(box()).toHaveValue("@src/routes/checkout.tsx ");
    expect(box()).toHaveFocus();
    expect(recordedSends()).toEqual([]);
    await waitFor(() => expect(fileStripState()).toBe("closed"));
  });

  it("tracks mid-sentence `@` tokens via caret movement without doubling spaces, and arbitrates cleanly with `/` commands", async () => {
    const user = userEvent.setup();
    renderComposer();

    // `/` opens command suggestions; adding ` @` switches the single strip to file suggestions.
    await user.type(box(), "/compact");
    expect(await screen.findByRole("group", { name: "Agent commands" })).toBeInTheDocument();
    await user.type(box(), " @re");
    const list = await screen.findByRole("group", FILE_STRIP);
    expect(within(list).getByRole("button", { name: "@README.md" })).toBeInTheDocument();

    // Mid-sentence replacement before existing text never produces a double space.
    await user.clear(box());
    await user.type(box(), "compare @ and @doc");
    await waitFor(() =>
      expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@docs/" })).toBeInTheDocument(),
    );

    // Move caret back right after the first `@` (`index 9`).
    const textarea = box();
    textarea.setSelectionRange(9, 9);
    fireEvent.select(textarea);

    await waitFor(() =>
      expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@README.md" })).toBeInTheDocument(),
    );
    await user.click(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@README.md" }));
    expect(textarea).toHaveValue("compare @README.md and @doc");
    await waitFor(() => expect(textarea.selectionStart).toBe("compare @README.md ".length));
    await waitFor(() => expect(fileStripState()).toBe("closed"));
  });

  it("resolves paths relative to a subfolder `cwd` (and `../` within the Files root), and caches folder reads for 30s", async () => {
    const askedDirs: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => {
        const dir = new URL(request.url).searchParams.get("dir") ?? "";
        askedDirs.push(dir);
        const answer = fixtureFilesDir(dir);
        return answer === null
          ? HttpResponse.json(FIXTURE_FILES_UNKNOWN, { status: 404 })
          : HttpResponse.json(answer);
      }),
    );

    const user = userEvent.setup();
    renderComposer({ cwd: `${ROOT}/packages/api`, filesDir: "packages/api" });

    await user.type(box(), "@");
    const list = await screen.findByRole("group", FILE_STRIP);
    const labels = Array.from(list.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["@server/", "@notes.md"]);
    expect(askedDirs).toEqual(["packages/api"]);

    // Typing further characters in the same folder uses the 30s cache without another request.
    await user.type(box(), "no");
    expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@notes.md" })).toBeInTheDocument();
    expect(askedDirs).toEqual(["packages/api"]);

    // Climbing `../` stays inside the workspace root (`packages`), folded before hitting the bridge.
    await user.clear(box());
    await user.type(box(), "@../");
    await waitFor(() =>
      expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@../api/" })).toBeInTheDocument(),
    );
    expect(askedDirs).toEqual(["packages/api", "packages"]);

    // `@../../` reaches the workspace root (`""`), and `@../../../` climbs past it — sending no `..` to the bridge and closing quietly.
    await user.clear(box());
    await user.type(box(), "@../../../");
    await waitFor(() => expect(fileStripState()).not.toBe("open"));
    expect(askedDirs).toEqual(["packages/api", "packages", ""]);

    // When `filesDir` is omitted (before launchers `home` arrives or on a non-POSIX host), the first
    // read's `root` resolves `cwd` to `packages/api` automatically.
    cleanup();
    clearDraft(undefined, "w1:p1");
    __resetFileSuggestionsCache();
    askedDirs.length = 0;
    markLive("w1:p1");
    renderComposer({ cwd: `${ROOT}/packages/api` });
    await user.type(box(), "@");
    const fallbackList = await screen.findByRole("group", FILE_STRIP);
    expect(Array.from(fallbackList.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual([
      "@server/",
      "@notes.md",
    ]);
    expect(askedDirs).toEqual(["", "packages/api"]);
  });

  it("stays quietly hidden on `no-folder` and 403 refusal without raising a status error", async () => {
    let noFolderCalls = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, () => {
        noFolderCalls += 1;
        return HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-folder" });
      }),
    );
    const user = userEvent.setup();
    renderComposer({ cwd: "/home/you" });
    await user.type(box(), "@re");
    await waitFor(() => expect(noFolderCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
    expect(document.querySelector('[data-slot="test-status"]')).toBeNull();
    cleanup();
    clearDraft(undefined, "w1:p1");

    __resetFileSuggestionsCache();
    let forbiddenCalls = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, () => {
        forbiddenCalls += 1;
        return new HttpResponse("device not authorised", { status: 403 });
      }),
    );
    markLive("w1:p1");
    renderComposer();
    await user.type(box(), "@re");
    await waitFor(() => expect(forbiddenCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
    expect(document.querySelector('[data-slot="test-status"]')).toBeNull();
  });

  it("never shows `@` file suggestions or fetches `/api/pane/.../files` on a sign-in secret field", async () => {
    let fileRequests = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => {
        fileRequests += 1;
        const dir = new URL(request.url).searchParams.get("dir") ?? "";
        const answer = fixtureFilesDir(dir);
        return answer === null
          ? HttpResponse.json(FIXTURE_FILES_UNKNOWN, { status: 404 })
          : HttpResponse.json(answer);
      }),
    );

    const user = userEvent.setup();
    renderComposer({
      surface: { ...IDLE_SURFACE, field: "secret" },
    });

    const codeInput = screen.getByPlaceholderText("Not saved. Sent once.");
    await user.type(codeInput, "@re");
    expect(document.querySelector('[data-slot="file-suggestions"]')).toBeNull();
    expect(fileRequests).toBe(0);

    await user.click(screen.getByRole("button", { name: "Close the code field" }));
    const secretInput = screen.getByPlaceholderText("Sign-in code. Not saved as a draft.");
    await user.type(secretInput, "@re");
    expect(document.querySelector('[data-slot="file-suggestions"]')).toBeNull();
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
    expect(fileRequests).toBe(0);
  });

  it("suppresses `@` file suggestions on shell panes, Type mode, dialog cards, and blur", async () => {
    server.use(
      http.get(/\/api\/sent$/, () =>
        HttpResponse.json({ entries: [], more: false, off: false, machines: [] }),
      ),
    );
    const user = userEvent.setup();

    // Shell pane never opens `@` file suggestions.
    renderComposer({ isShell: true, agent: undefined, text: "$ " });
    await user.type(screen.getByRole("textbox"), "@re");
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
    cleanup();
    clearDraft(undefined, "w1:p1");

    // Dialog card suppresses `@` file suggestions.
    markLive("w1:p1");
    renderComposer({ dialogCard: true });
    await user.type(box(), "@re");
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
    cleanup();
    clearDraft(undefined, "w1:p1");

    // Type into terminal suppresses `@` file suggestions.
    markLive("w1:p1");
    renderComposer();
    await user.click(screen.getByRole("button", { name: /^type into terminal$/i }));
    await user.type(screen.getByRole("textbox"), "@re");
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
    cleanup();
    clearDraft(undefined, "w1:p1");

    // Blur closes an open strip.
    markLive("w1:p1");
    renderComposer();
    await user.type(box(), "@re");
    expect(await screen.findByRole("group", FILE_STRIP)).toBeInTheDocument();
    fireEvent.blur(box());
    await waitFor(() => expect(fileStripState()).toBe("closed"));
  });

  it("re-fetches and renders the new repo's files when `cwd` changes on the same `paneId`", async () => {
    let activeRepo: "a" | "b" = "a";
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, () =>
        HttpResponse.json(
          activeRepo === "a"
            ? {
                paneId: "w1:p1",
                available: true,
                root: "/work/repo-a",
                dir: "",
                entries: [{ name: "alpha.ts", kind: "file" }],
                truncated: false,
              }
            : {
                paneId: "w1:p1",
                available: true,
                root: "/work/repo-b",
                dir: "",
                entries: [{ name: "beta.ts", kind: "file" }],
                truncated: false,
              },
        ),
      ),
    );

    function CwdHarness() {
      const [cwd, setCwd] = useState("/work/repo-a");
      return (
        <>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setCwd("/work/repo-b")}
          >
            switch-cwd
          </button>
          <Composer
            paneId="w1:p1"
            agent="claude"
            isShell={false}
            cwd={cwd}
            gone={false}
            readOnly={false}
            surface={IDLE_SURFACE}
            text="❯ "
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={DEFAULT_PREFS}
            display={{ open: false, onToggle: vi.fn() }}
            onSent={vi.fn()}
          />
        </>
      );
    }

    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/", element: <CwdHarness /> }]);
    render(<RouterProvider router={router} />);

    await user.type(box(), "@");
    const firstList = await screen.findByRole("group", FILE_STRIP);
    expect(within(firstList).getByRole("button", { name: "@alpha.ts" })).toBeInTheDocument();

    activeRepo = "b";
    fireEvent.click(screen.getByRole("button", { name: "switch-cwd" }));

    await waitFor(() =>
      expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@beta.ts" })).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("group", FILE_STRIP)).queryByRole("button", { name: "@alpha.ts" })).toBeNull();
  });

  it("discovers a Windows subfolder's Files root before resolving `@../`, and offers nothing when `cwd` lies outside the returned root", async () => {
    const askedDirs: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => {
        const dir = new URL(request.url).searchParams.get("dir") ?? "";
        askedDirs.push(dir);
        if (dir === "") {
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            root: "C:\\repo",
            dir: "",
            entries: [{ name: "packages", kind: "dir" }],
            truncated: false,
          });
        }
        if (dir === "packages") {
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            root: "C:\\repo",
            dir: "packages",
            entries: [
              { name: "api", kind: "dir" },
              { name: "README.md", kind: "file" },
            ],
            truncated: false,
          });
        }
        return HttpResponse.json(FIXTURE_FILES_UNKNOWN, { status: 404 });
      }),
    );

    const user = userEvent.setup();
    renderComposer({ cwd: "C:\\repo\\packages\\api", filesDir: null });

    await user.click(box());
    await user.paste("@../README");

    const list = await screen.findByRole("group", FILE_STRIP);
    expect(within(list).getByRole("button", { name: "@../README.md" })).toBeInTheDocument();
    expect(askedDirs).toEqual(["", "packages"]);

    cleanup();
    clearDraft(undefined, "w1:p1");
    __resetFileSuggestionsCache();
    let outsideCalls = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, () => {
        outsideCalls += 1;
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          root: ROOT,
          dir: "",
          entries: [{ name: "README.md", kind: "file" }],
          truncated: false,
        });
      }),
    );

    markLive("w1:p1");
    renderComposer({ cwd: "/other/place", filesDir: null });
    await user.type(box(), "@re");
    await waitFor(() => expect(outsideCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
  });

  it("keeps `[data-slot=\"file-suggestions\"]` mounted on Shift+Tab focus and inserts the focused chip on Enter", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(box(), "@re");
    const strip = await screen.findByRole("group", FILE_STRIP);
    await waitFor(() => expect(fileStripState()).toBe("open"));
    const readmeChip = within(strip).getByRole("button", { name: "@README.md" });
    const currentChip = within(strip).getByRole("button", { name: "@current" });

    // First Shift+Tab moves from textarea into the strip's last chip; second Shift+Tab moves between chips.
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.querySelector('[data-slot="file-suggestions"]')).toBeInTheDocument();
    expect(fileStripState()).toBe("open");
    expect(currentChip).toHaveFocus();

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(fileStripState()).toBe("open");
    expect(readmeChip).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(box()).toHaveValue("@README.md ");
    await waitFor(() => expect(box()).toHaveFocus());
    await waitFor(() => expect(fileStripState()).toBe("closed"));
  });

  it("falls back to `dir=\"\"` and resolves against the authoritative bridge root when `filesDir` disagrees", async () => {
    const askedDirs: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => {
        const dir = new URL(request.url).searchParams.get("dir") ?? "";
        askedDirs.push(dir);
        if (dir === "") {
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            root: "/outside/real-target",
            dir: "",
            entries: [
              { name: "sub", kind: "dir" },
              { name: "real.ts", kind: "file" },
            ],
            truncated: false,
          });
        }
        if (dir === "sub") {
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            root: "/outside/real-target",
            dir: "sub",
            entries: [{ name: "leaf.ts", kind: "file" }],
            truncated: false,
          });
        }
        return HttpResponse.json(FIXTURE_FILES_UNKNOWN, { status: 404 });
      }),
    );

    const user = userEvent.setup();
    renderComposer({ cwd: "/outside/real-target", filesDir: "link" });

    await user.type(box(), "@");
    const list = await screen.findByRole("group", FILE_STRIP);
    expect(within(list).getByRole("button", { name: "@real.ts" })).toBeInTheDocument();
    expect(askedDirs).toEqual(["link", ""]);

    await user.click(within(list).getByRole("button", { name: "@sub/" }));
    await waitFor(() =>
      expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@sub/leaf.ts" })).toBeInTheDocument(),
    );
    expect(askedDirs).toEqual(["link", "", "sub"]);
  });

  it("keeps the strip open and non-inert when typing immediately while a folder drill is still in flight", async () => {
    let releaseSrc: (() => void) | undefined;
    const srcGate = new Promise<void>((resolve) => {
      releaseSrc = resolve;
    });
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, async ({ request }) => {
        const dir = new URL(request.url).searchParams.get("dir") ?? "";
        if (dir === "src") {
          await srcGate;
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            root: ROOT,
            dir: "src",
            entries: [
              { name: "config.ts", kind: "file" },
              { name: "checkout.tsx", kind: "file" },
            ],
            truncated: false,
          });
        }
        const answer = fixtureFilesDir(dir);
        return answer === null
          ? HttpResponse.json(FIXTURE_FILES_UNKNOWN, { status: 404 })
          : HttpResponse.json(answer);
      }),
    );

    const user = userEvent.setup();
    renderComposer();

    await user.type(box(), "@");
    const list = await screen.findByRole("group", FILE_STRIP);
    await waitFor(() => expect(fileStripState()).toBe("open"));
    await user.click(within(list).getByRole("button", { name: "@src/" }));
    expect(box()).toHaveValue("@src/");
    expect(fileStripState()).toBe("open");
    expect(screen.getByRole("group", FILE_STRIP).closest("[inert]")).toBeNull();

    await user.type(box(), "co");
    expect(box()).toHaveValue("@src/co");
    expect(fileStripState()).toBe("open");
    expect(screen.getByRole("group", FILE_STRIP).closest("[inert]")).toBeNull();

    releaseSrc?.();
    await waitFor(() =>
      expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@src/config.ts" })).toBeInTheDocument(),
    );
  });

  it("does not poison the 30s cache on a transient network error and retries when `@` is reopened", async () => {
    let failNetwork = true;
    let calls = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => {
        calls += 1;
        if (failNetwork) return HttpResponse.error();
        const dir = new URL(request.url).searchParams.get("dir") ?? "";
        const answer = fixtureFilesDir(dir);
        return answer === null
          ? HttpResponse.json(FIXTURE_FILES_UNKNOWN, { status: 404 })
          : HttpResponse.json(answer);
      }),
    );

    const user = userEvent.setup();
    renderComposer();

    await user.type(box(), "@");
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();

    failNetwork = false;
    await user.clear(box());
    await user.type(box(), "@");
    const list = await screen.findByRole("group", FILE_STRIP);
    expect(within(list).getByRole("button", { name: "@README.md" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("expires cached folder listings after 30s and ignores pre-reset in-flight responses", async () => {
    const baseNow = Date.now();
    let offsetMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => baseNow + offsetMs);
    try {
      let ttlCalls = 0;
      server.use(
        http.get(/\/api\/pane\/[^/]+\/files$/, () => {
          ttlCalls += 1;
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            root: ROOT,
            dir: "",
            entries: [{ name: `README-${ttlCalls}.md`, kind: "file" }],
            truncated: false,
          });
        }),
      );

      const user = userEvent.setup();
      renderComposer();

      await user.type(box(), "@");
      const firstList = await screen.findByRole("group", FILE_STRIP);
      expect(within(firstList).getByRole("button", { name: "@README-1.md" })).toBeInTheDocument();
      expect(ttlCalls).toBe(1);

      offsetMs += 10_000;
      await user.type(box(), "r");
      expect(ttlCalls).toBe(1);

      offsetMs += 21_000;
      await user.type(box(), "e");
      await waitFor(() =>
        expect(within(screen.getByRole("group", FILE_STRIP)).getByRole("button", { name: "@README-2.md" })).toBeInTheDocument(),
      );
      expect(ttlCalls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }

    cleanup();
    clearDraft(undefined, "w1:p1");
    __resetFileSuggestionsCache();

    let epochCalls = 0;
    let releaseStale: (() => void) | undefined;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, async () => {
        epochCalls += 1;
        const callNumber = epochCalls;
        if (callNumber === 1) {
          await staleGate;
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            root: ROOT,
            dir: "",
            entries: [{ name: "stale-before-reset.ts", kind: "file" }],
            truncated: false,
          });
        }
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          root: ROOT,
          dir: "",
          entries: [{ name: "fresh-after-reset.ts", kind: "file" }],
          truncated: false,
        });
      }),
    );

    const user = userEvent.setup();
    markLive("w1:p1");
    renderComposer();
    await user.type(box(), "@");
    await waitFor(() => expect(epochCalls).toBe(1));

    cleanup();
    clearDraft(undefined, "w1:p1");
    __resetFileSuggestionsCache();
    releaseStale?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    markLive("w1:p1");
    renderComposer();
    await user.type(box(), "@");
    const freshList = await screen.findByRole("group", FILE_STRIP);
    expect(within(freshList).getByRole("button", { name: "@fresh-after-reset.ts" })).toBeInTheDocument();
    expect(within(freshList).queryByRole("button", { name: "@stale-before-reset.ts" })).toBeNull();
    expect(epochCalls).toBe(2);
  });

  it("hides `@` file suggestions while the pane is starting (`startHeld`)", async () => {
    let calls = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files$/, () => {
        calls += 1;
        return HttpResponse.json(fixtureFilesDir(""));
      }),
    );

    const { saveDraft } = await import("@/lib/drafts");
    saveDraft(undefined, "w1:p1", "@re");
    renderComposer({ starting: true });

    const field = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(field).toHaveValue("@re");
    expect(field).toHaveAttribute("readonly");
    fireEvent.focus(field);
    field.setSelectionRange(3, 3);
    fireEvent.select(field);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(screen.queryByRole("group", FILE_STRIP)).toBeNull();
    expect(calls).toBe(0);
    expect(field).toHaveValue("@re");
  });
});

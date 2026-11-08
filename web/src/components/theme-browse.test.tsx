import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeBrowseSheet, acceptedThemes } from "@/components/theme-browse";
import { en } from "@/lib/i18n/messages/en";
import type { JsonValue } from "@/lib/json";
import { isRepoSlug, reportUrl } from "@/lib/theme/registry";
import type { ThemeRegistryStatus } from "@/lib/types";
import { server } from "@/test/setup";

// The community Browse sheet (M59 spec 06): the host's copy of the registry, drawn only after the
// phone has checked every entry itself, Install handed to the card, and Refresh as the one write.

const SHA = "0123456789abcdef0123456789abcdef01234567";

function themeText(id: string, name: string, extra: Record<string, JsonValue> = {}): string {
  return JSON.stringify({ version: 1, id, name, author: "Sam", light: { background: "#fdfaf3" }, dark: { background: "#101418" }, ...extra });
}

function entry(id: string, name: string, over: Record<string, JsonValue> = {}): JsonValue {
  return { repo: `sam/${id}`, sha: SHA, path: "collie-theme.json", text: themeText(id, name), ...over };
}

function status(themes: JsonValue[], over: Partial<ThemeRegistryStatus> = {}): ThemeRegistryStatus {
  return { fetchedAt: "2026-11-07T10:00:00.000Z", ageMs: 2 * 60 * 60 * 1000, generated: "2026-11-07T06:00:00Z", themes, dropped: 0, fetching: false, ...over };
}

/** The host: answers `current` to every read, and `onPost` to a refresh. */
function host(current: ThemeRegistryStatus, onPost?: () => Response) {
  const calls = { gets: 0, posts: 0 };
  server.use(
    http.get("/api/themes/registry", () => {
      calls.gets += 1;
      return HttpResponse.json(current);
    }),
    http.post("/api/themes/registry", () => {
      calls.posts += 1;
      return onPost?.() ?? HttpResponse.json(current);
    }),
  );
  return calls;
}

/** Text a person reads: the page samples draw the name too, but hidden from assistive tech. */
const SEEN = { ignore: '[aria-hidden="true"] *, script, style' };

function open(onInstall = vi.fn()) {
  render(<ThemeBrowseSheet open onClose={() => {}} onInstall={onInstall} />);
  return { onInstall, sheet: screen.getByRole("dialog", { name: en["theme.browse.title"] }) };
}

describe("ThemeBrowseSheet", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists the host's themes with name, author and repo link, and fetches nothing beyond its own origin", async () => {
    const fetching = vi.spyOn(globalThis, "fetch");
    const calls = host(status([entry("my-day", "My day"), entry("night", "Night")]));
    const { sheet } = open();
    expect(await within(sheet).findByText("My day", SEEN)).toBeInTheDocument();
    expect(within(sheet).getByText("Night", SEEN)).toBeInTheDocument();
    expect(within(sheet).getAllByText(en["theme.preview.by"].replace("{author}", "Sam"))).toHaveLength(2);
    const link = within(sheet).getByRole("link", { name: "sam/my-day" });
    expect(link).toHaveAttribute("href", "https://github.com/sam/my-day");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(sheet).getByText(/List fetched/)).toBeInTheDocument();
    expect(calls).toEqual({ gets: 1, posts: 0 });
    for (const call of fetching.mock.calls) expect(String(call[0])).not.toMatch(/^https?:\/\/(?!localhost)/);
  });

  it("re-checks every entry on the phone and leaves out the ones that fail", async () => {
    host(
      status(
        [
          entry("ok", "Kept"),
          entry("bad", "Bad colour", { text: themeText("bad", "Bad colour", { light: { background: "url(x)" } }) }),
          entry("slug", "Bad slug", { repo: "https://evil.example/x" }),
          entry("ship", "Shipped id", { text: themeText("harbour", "Shipped id") }),
          "not an entry",
        ],
        { dropped: 2 },
      ),
    );
    const { sheet } = open();
    expect(await within(sheet).findByText("Kept", SEEN)).toBeInTheDocument();
    expect(within(sheet).queryByText("Bad colour", SEEN)).toBeNull();
    expect(within(sheet).queryByText("Bad slug", SEEN)).toBeNull();
    expect(within(sheet).queryByText("Shipped id", SEEN)).toBeNull();
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(1);
    expect(within(sheet).getByText(en["theme.browse.dropped"].replace("{count}", "6"))).toBeInTheDocument();
  });

  it("shows the maker as @owner from the slug and the star count, and no star part without a good count", async () => {
    host(
      status([
        entry("my-day", "My day", { stars: 12 }),
        entry("night", "Night", { stars: -1 }),
        entry("noon", "Noon", { stars: 1.5, owner: "someone-else" }),
        entry("dusk", "Dusk", { stars: 10_000_001 }),
      ]),
    );
    const { sheet } = open();
    await within(sheet).findByText("My day", SEEN);
    const row = (name: string) => within(sheet).getByText(name, SEEN).closest("li");
    expect(row("My day")).toHaveTextContent("@sam");
    expect(row("My day")).toHaveTextContent("★ 12");
    expect(within(row("My day") ?? sheet).getByText("Stars on GitHub: 12")).toBeInTheDocument();
    for (const name of ["Night", "Noon", "Dusk"]) {
      expect(row(name)).toHaveTextContent("@sam");
      expect(row(name)).not.toHaveTextContent("★");
    }
    // An `owner` field is never read: the maker is always the slug's own first half.
    expect(within(sheet).queryByText("@someone-else")).toBeNull();
  });

  it("draws a name that holds markup as text", async () => {
    host(status([entry("x", "<img src=x onerror=alert(1)>")]));
    const { sheet } = open();
    expect(await within(sheet).findByText("<img src=x onerror=alert(1)>", SEEN)).toBeInTheDocument();
    expect(sheet.querySelector("img")).toBeNull();
  });

  it("Install hands the parsed theme and its checked entry to the card", async () => {
    host(status([entry("my-day", "My day")]));
    const { sheet, onInstall } = open();
    await within(sheet).findByText("My day", SEEN);
    await userEvent.click(within(sheet).getByRole("button", { name: en["theme.browse.install"] }));
    expect(onInstall).toHaveBeenCalledOnce();
    expect(onInstall.mock.calls[0]?.[0]).toMatchObject({
      theme: { id: "my-day", name: "My day", author: "Sam" },
      entry: { repo: "sam/my-day", path: "collie-theme.json", sha: SHA },
    });
  });

  it("offers a Report link to a prefilled issue on collie, built from the slug", async () => {
    host(status([entry("my-day", "My day")]));
    const { sheet } = open();
    await within(sheet).findByText("My day", SEEN);
    const report = within(sheet).getByRole("link", { name: en["theme.browse.reportAria"].replace("{name}", "My day") });
    const url = new URL(report.getAttribute("href") ?? "");
    expect(url.origin + url.pathname).toBe("https://github.com/AltanS/collie/issues/new");
    expect(url.searchParams.get("title")).toBe("Theme report: sam/my-day");
    expect(url.searchParams.get("body")).toContain(SHA);
  });

  it("says when the host never fetched the list, and Refresh is the one call that asks it to", async () => {
    let current = status([], { fetchedAt: null, ageMs: null, generated: null });
    const calls = host(current, () => {
      current = status([entry("fresh", "Fresh")], { ageMs: 0 });
      return HttpResponse.json(current);
    });
    const { sheet } = open();
    expect(await within(sheet).findByText(en["theme.browse.never"])).toBeInTheDocument();
    expect(within(sheet).getByText(en["theme.browse.empty"])).toBeInTheDocument();
    expect(calls.posts).toBe(0);
    await userEvent.click(within(sheet).getByRole("button", { name: en["theme.browse.refresh"] }));
    expect(await within(sheet).findByText("Fresh", SEEN)).toBeInTheDocument();
    expect(calls.posts).toBe(1);
  });

  it("shows the old list and the host's word after a failed refresh", async () => {
    const old = status([entry("old", "Old")]);
    let current = old;
    host(current, () => {
      current = { ...old, error: "fetch-failed" };
      server.use(http.get("/api/themes/registry", () => HttpResponse.json(current)));
      return HttpResponse.json(current, { status: 502 });
    });
    const { sheet } = open();
    await within(sheet).findByText("Old", SEEN);
    await userEvent.click(within(sheet).getByRole("button", { name: en["theme.browse.refresh"] }));
    expect(await within(sheet).findByText(en["theme.browse.error.fetch-failed"])).toBeInTheDocument();
    expect(within(sheet).getByText("Old", SEEN)).toBeInTheDocument();
  });

  it("tells a read-only device that a refresh needs a write device", async () => {
    host(status([]), () => new HttpResponse("forbidden", { status: 403 }));
    const { sheet } = open();
    await within(sheet).findByText(en["theme.browse.empty"]);
    await userEvent.click(within(sheet).getByRole("button", { name: en["theme.browse.refresh"] }));
    expect(await within(sheet).findByText(en["theme.browse.error.write"])).toBeInTheDocument();
  });

  it("says an older host has no list, and offers no Refresh", async () => {
    server.use(http.get("/api/themes/registry", () => new HttpResponse("not found", { status: 404 })));
    const { sheet } = open();
    expect(await within(sheet).findByText(en["theme.browse.older"])).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: en["theme.browse.refresh"] })).toBeNull();
  });

  it("says when the host cannot be read", async () => {
    server.use(http.get("/api/themes/registry", () => HttpResponse.error()));
    const { sheet } = open();
    await waitFor(() => expect(within(sheet).getByText(en["theme.browse.error.read"])).toBeInTheDocument());
  });
});

describe("the registry entry rules on the phone", () => {
  it("accepts a plain slug and refuses a URL, a path and a dot half", () => {
    expect(isRepoSlug("sam/my-day")).toBe(true);
    expect(isRepoSlug("Sam-1/my.day_2")).toBe(true);
    for (const bad of ["https://github.com/sam/x", "sam", "sam/x/y", "../x", "sam/..", "./x", "sam/x?y", "sam /x", "Sam_1/x", "-sam/x", ".sam/x"]) {
      expect(isRepoSlug(bad), bad).toBe(false);
    }
  });

  it("keeps stars, ignores any other extra field, and leaves the entry intact (today's reader picks named fields)", () => {
    const [kept] = acceptedThemes(status([entry("a", "A", { stars: 3, owner: "x", avatar: "https://x/y.png", future: { v: 2 } })]));
    expect(Object.keys(kept?.entry ?? {}).toSorted()).toEqual(["path", "repo", "sha", "stars", "text"]);
    expect(kept?.entry.stars).toBe(3);
  });

  it("keeps the registry's order", () => {
    const kept = acceptedThemes(status([entry("b", "B"), entry("a", "A")]));
    expect(kept.map((item) => item.theme.id)).toEqual(["b", "a"]);
  });

  it("builds the report link on GitHub's own new-issue form, nothing else", () => {
    expect(reportUrl({ repo: "sam/x", sha: SHA, path: "themes/a.collie-theme.json" })).toMatch(/^https:\/\/github\.com\/AltanS\/collie\/issues\/new\?/);
  });
});

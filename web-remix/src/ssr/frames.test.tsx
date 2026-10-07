// The pane frames on Bun (S2): each frame draws, rows carry `data-rmx-key`, two reads never leak into
// each other, the poll answer round-trips, and a pane document draws its frames inline from its read.
import { describe, expect, test } from "bun:test";

import type { PaneReadResponse } from "@web/lib/types";

import { CONFIG, SNAPSHOT } from "../../e2e/fixtures";
import { paneFramePath, paneFrameParams, parsePollAnswer, pollAnswer, pollHeader, pollTargets, pollWantsText } from "../routes/pane/frames";
import { FRAME_TAIL_ROWS, pollRead, renderPaneFrames } from "./frames";
import { documentPaneReadPath, paneReadApiPath, renderAppBody, type DocumentInput } from "./render";

function screenOf(tag: string, rows = 6): string {
  return Array.from({ length: rows }, (_, i) => `${tag} row ${String(i)} see https://example.com/${tag}/${String(i)}`).join("\n");
}

function read(tag: string): PaneReadResponse {
  return { paneId: `${tag}-w1:p1`, text: screenOf(tag), truncated: false, revision: 1 };
}

describe("pane frames", () => {
  test("each frame draws: keyed screen rows, the status band", async () => {
    const out = await renderPaneFrames({ text: screenOf("alpha"), agent: undefined }, ["pane-screen", "pane-status"]);
    const screen = out["pane-screen"] ?? "";
    expect(screen.match(/data-rmx-key="/g)?.length).toBe(6);
    expect(screen).toContain("alpha row 5");
    // Autolinks come from the server too.
    expect(screen).toContain('href="https://example.com/alpha/0"');
    expect(out["pane-status"]).toBeDefined();
  });

  test("only the asked frames are drawn", async () => {
    const out = await renderPaneFrames({ text: screenOf("alpha"), agent: undefined }, ["pane-status"]);
    expect(Object.keys(out)).toEqual(["pane-status"]);
  });

  test("a row's key is its content: the same row keeps its key when the screen scrolls by one", async () => {
    const keys = (html: string): string[] => [...html.matchAll(/data-rmx-key="([^"]+)"/g)].map((m) => m[1] ?? "");
    const lines = screenOf("alpha", 21).split("\n");
    const a = keys((await renderPaneFrames({ text: lines.slice(0, 20).join("\n"), agent: undefined }, ["pane-screen"]))["pane-screen"] ?? "");
    const b = keys((await renderPaneFrames({ text: lines.slice(1, 21).join("\n"), agent: undefined }, ["pane-screen"]))["pane-screen"] ?? "");
    const above = 20 - FRAME_TAIL_ROWS;
    expect(a.slice(1, above)).toEqual(b.slice(0, above - 1));
  });

  test("the tail rows are keyed by their place from the bottom, so a changed last line keeps its key", async () => {
    const keys = (html: string): string[] => [...html.matchAll(/data-rmx-key="([^"]+)"/g)].map((m) => m[1] ?? "");
    const a = keys((await renderPaneFrames({ text: `${screenOf("alpha", 12)}\ntick 1`, agent: undefined }, ["pane-screen"]))["pane-screen"] ?? "");
    const b = keys((await renderPaneFrames({ text: `${screenOf("alpha", 12)}\ntick 2`, agent: undefined }, ["pane-screen"]))["pane-screen"] ?? "");
    expect(a).toEqual(b);
    expect(a.slice(-FRAME_TAIL_ROWS)).toEqual(Array.from({ length: FRAME_TAIL_ROWS }, (_, i) => `tail-${String(FRAME_TAIL_ROWS - 1 - i)}`));
    expect(new Set(a).size).toBe(a.length);
  });

  test("two reads back to back and interleaved: no fragment names the other's text", async () => {
    const a = await renderPaneFrames({ text: screenOf("alpha"), agent: undefined }, ["pane-screen"]);
    const b = await renderPaneFrames({ text: screenOf("bravo"), agent: undefined }, ["pane-screen"]);
    const [c, d] = await Promise.all([
      renderPaneFrames({ text: screenOf("alpha"), agent: "claude" }, ["pane-screen", "pane-status"]),
      renderPaneFrames({ text: screenOf("bravo"), agent: "claude" }, ["pane-screen", "pane-status"]),
    ]);
    for (const out of [a, c]) {
      expect(JSON.stringify(out)).toContain("alpha");
      expect(JSON.stringify(out)).not.toContain("bravo");
    }
    for (const out of [b, d]) {
      expect(JSON.stringify(out)).toContain("bravo");
      expect(JSON.stringify(out)).not.toContain("alpha");
    }
  });

  test("the poll answer round-trips, and text that looks like a closer stays inside", () => {
    const body: PaneReadResponse = { ...read("alpha"), text: "</script></template><b>x</b>" };
    const answer = pollAnswer(body, { "pane-screen": "<div>&lt;/template&gt;</div>", "pane-status": "" });
    const parsed = parsePollAnswer(answer);
    expect(parsed?.read).toEqual(body);
    expect(parsed?.frames["pane-screen"]).toBe("<div>&lt;/template&gt;</div>");
    expect(parsed?.frames["pane-status"]).toBe("");
    expect(parsePollAnswer("<!doctype html><html>")).toBeNull();
  });

  test("the poll header names known frames only, and `text` is a token that is not a frame", () => {
    expect(pollTargets("pane-screen, pane-status, evil")).toEqual(["pane-screen", "pane-status"]);
    expect(pollTargets("pane-screen,pane-status,text")).toEqual(["pane-screen", "pane-status"]);
    expect(pollTargets(null)).toEqual([]);
    expect(pollWantsText("pane-screen,pane-status,text")).toBe(true);
    expect(pollWantsText(" text ")).toBe(true);
    expect(pollWantsText("pane-screen,pane-status")).toBe(false);
    expect(pollWantsText("texture")).toBe(false);
    expect(pollWantsText(null)).toBe(false);
    expect(pollHeader(["pane-screen", "pane-status"], false)).toBe("pane-screen,pane-status");
    expect(pollHeader(["pane-status"], true)).toBe("pane-status,text");
  });

  test("a read without its text round-trips: the browser holds text '' and the model", () => {
    const whole: PaneReadResponse = { ...read("alpha"), logicalText: "alpha row 0 https://example.com/alpha/0" };
    const lite = pollRead(whole, undefined, { text: false });
    if (!("screen" in lite)) throw new Error("expected a read with a screen model");
    expect("text" in lite).toBe(false);
    expect("logicalText" in lite).toBe(false);
    const parsed = parsePollAnswer(pollAnswer(lite, { "pane-screen": "<div></div>" }));
    expect(parsed?.read.text).toBe("");
    expect(parsed?.read.screen).toEqual(JSON.parse(JSON.stringify(lite.screen)));
    expect(parsed?.read.paneId).toBe(whole.paneId);
    expect(parsed?.read.revision).toBe(1);
    // Asked for the text, the read goes through untouched.
    expect(pollRead(whole, undefined, { text: true })).toBe(whole);
  });

  test("the src carries the window and the agent; the bridge reads the pane with the page's scope", () => {
    const src = paneFramePath("w1:p1", { host: "beta", session: undefined }, 600, "claude");
    const url = new URL(src, "http://collie.test");
    expect(paneFrameParams(url)).toEqual({ lines: 600, agent: "claude" });
    const api = paneReadApiPath(url, "w1:p1");
    expect(api.startsWith("/api/pane/w1%3Ap1?")).toBe(true);
    expect(api).toContain("lines=600");
    expect(api).toContain("host=beta");
    expect(documentPaneReadPath(new URL("/pane/w1%3Ap1", "http://collie.test"))).toBe("/api/pane/w1%3Ap1?lines=600");
    expect(documentPaneReadPath(new URL("/", "http://collie.test"))).toBeNull();
  });
});

describe("a pane document with its read", () => {
  const paneId = SNAPSHOT.agents[0]?.paneId ?? "";
  // Frames are on by default (lib/prefs.ts `PANE_FRAMES_DEFAULT`); these documents come from a device
  // whose prefs cookie says so.
  const FRAMES_ON = JSON.stringify({ "collie:pane-frames:v1": "1" });
  const input = (text: string, prefs: string | null = FRAMES_ON): DocumentInput => ({
    url: new URL(`/pane/${encodeURIComponent(paneId)}`, "http://collie.test"),
    base: "/",
    snapshot: SNAPSHOT,
    snapshotAt: SNAPSHOT.ts,
    config: CONFIG,
    prefs,
    now: SNAPSHOT.ts,
    pane: { read: { paneId, text, truncated: false, revision: 1 }, etag: '"e1"' },
  });

  test("draws the screen frame's rows inline, with no skeleton", async () => {
    const { body } = await renderAppBody(input(screenOf("alpha")));
    const at = body.indexOf('<script type="application/json" id="rmx-data">');
    const markup = at === -1 ? body : body.slice(0, at);
    expect(markup).toContain('data-frame="pane-screen"');
    expect(markup).toContain("alpha row 5");
    expect(markup).not.toContain('data-slot="screen-skeleton"');
    expect(markup).toContain("<!-- rmx:f:");
    expect(markup.match(/data-rmx-key="/g)?.length ?? 0).toBeGreaterThan(0);
  });

  test("two documents back to back: neither draws the other's rows", async () => {
    const a = (await renderAppBody(input(screenOf("alpha")))).body;
    const b = (await renderAppBody(input(screenOf("bravo")))).body;
    expect(a).not.toContain("bravo row");
    expect(b).not.toContain("alpha row");
  });

  test("the document tells the browser which mode it drew, from the prefs cookie", async () => {
    const on = (await renderAppBody(input(screenOf("alpha")))).body;
    expect(on).toContain('"frames":true');
    const off = (await renderAppBody({ ...input(screenOf("alpha")), prefs: JSON.stringify({ "collie:pane-frames:v1": "0" }) })).body;
    expect(off).toContain('"frames":false');
    expect(off).not.toContain('data-frame="pane-screen"');
    const fresh = (await renderAppBody(input(screenOf("alpha"), null))).body;
    expect(fresh).toContain('"frames":true');
    expect(fresh).toContain('data-frame="pane-screen"');
    expect(fresh).toContain("alpha row 5");
  });

  test("?frames=0 draws the browser's own rows, no frame", async () => {
    const off = input(screenOf("alpha"));
    off.url = new URL(`${off.url.pathname}?frames=0`, off.url);
    const { body } = await renderAppBody(off);
    expect(body).not.toContain('data-frame="pane-screen"');
    expect(body).toContain("alpha row 5");
  });
});

// A REAL SEND, driven over captures — which is why it is not in `src/lib/harness/`.
//
// The adapter tests next door are pure: text in, blocks out, no clock and no network. These two put
// a screen through `sendGuardedReply`, which fetches, so they need an origin and a document and they
// run in the `dom` project (see `vitest.config.ts`). Leaving them under `src/lib/harness/` meant that
// folder needed a two-file exception list to run in the fast project, and an exception list is what
// silently dropped both files from BOTH projects on the first attempt. One path, no exceptions.
//
// The captures they read are still the omp adapter's own (`src/fixtures/omp-pi-shape/`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw";
import { sendGuardedReply } from "../reply-action";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { composerPrompt, extractInputDraft, extractStatusLines, hasComposer, stripChrome } from "../harness/omp/index";

// M46 spec 11 turns every send off for a pane the bridge has not answered lately (lib/liveness.ts).
// These suites drive sends against a mocked network and never poll first, so they pin the pane live;
// the gating itself is covered by liveness.test.ts and the *-offline suites.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const dir = join(import.meta.dirname, "../../fixtures/omp-pi-shape");
const idle = readFileSync(join(dir, "idle.txt"), "utf8");
const parse = (text: string) => splitLines(parseAnsi(text));
const withDraft = (draft: string) => idle.split("\n").map((row, i) => i === 1 ? ` ${draft}` : row).join("\n");

// The pi shape with its slash palette up, from the corpus (omp 18.8.0, 2026-10-07). The palette
// REPLACES the status row on this shape, and the draft lives on the filter row the locator reads as
// the editor's own — which is what lets a `/…` send verify at all.
const corpus = join(import.meta.dirname, "../../fixtures/panes");
const palette = readFileSync(join(corpus, "omp--v18-8-slash-palette.txt"), "utf8");
const paletteW48 = readFileSync(join(corpus, "omp--v18-8-slash-palette-w48.txt"), "utf8");

describe("OMP 18.1.13 pi-shaped editor (live captures, 2026-09-07)", () => {
  it("recognises the idle editor and moves its footer into the status strip", () => {
    expect(hasComposer(parse(idle))).toBe(true);
    expect(extractInputDraft(parse(idle))).toBeNull();
    expect(extractStatusLines(parse(idle))).toHaveLength(2);
    expect(stripChrome(parse(idle))).toEqual([]);
  });
  it("extracts Korean and multiline drafts and binds the draft, not just a rule", () => {
    const draft = "한글 전송 테스트\n second line";
    const screen = parse(withDraft(draft));
    expect(extractInputDraft(screen)).toBe("한글 전송 테스트 second line");
    expect(composerPrompt(screen)).toContain("한글 전송 테스트");
  });
  it("submits only after the real Korean draft capture verifies the typed message", async () => {
    const text = "파일이나 도구를 사용하지 말고 COLLIE_E2E_OK 라고만 답해 주세요.";
    const captured = readFileSync(join(dir, "korean-draft.txt"), "utf8");
    expect(extractInputDraft(parse(captured))).toBe(text);
    let screen = idle;
    const calls: Array<{ text: string; submit: boolean }> = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: "test:p1", text: screen })),
      http.post<never, { text: string; submit: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        calls.push(await request.json());
        screen = captured;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await sendGuardedReply({ paneId: "test:p1", agent: "omp", text, requestedLines: 200, sleep: async () => {} });
    expect(result.status).toBe("sent");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ text, submit: false });
    expect(calls[1]).toMatchObject({ text: "", submit: true });
  });
  it("rejects the real model picker and a dialog covering the editor", () => {
    const menu = readFileSync(join(dir, "model-menu.txt"), "utf8");
    expect(hasComposer(parse(menu))).toBe(false);
    expect(hasComposer(parse(`${idle}\n${menu}`))).toBe(false);
    expect(hasComposer(parse(`${idle}\nApprove this action?`))).toBe(false);
  });
  it("excludes an unaccepted Korean inline completion from the live draft", () => {
    const capture = readFileSync(join(dir, "korean-ghost.txt"), "utf8");
    const draft = extractInputDraft(parse(capture));
    expect(draft).toContain("검사 항목 3번째 한글 내용");
    expect(draft).not.toContain("한글 내용을");
    expect(draft?.endsWith("한글 내용")).toBe(true);
  });
  it("rejects unstyled separators and missing or changed borders", () => {
    const plain = parse(idle).map((line) => line.segments.map((s) => s.text).join("")).join("\n");
    expect(hasComposer(parse(plain))).toBe(false);
    expect(hasComposer(parse(idle.split("\n").slice(1).join("\n")))).toBe(false);
    expect(hasComposer(parse(idle.replace("─", "━")))).toBe(false);
  });
});

describe("OMP 18.8 pi-shaped editor with the slash palette up (live captures, 2026-10-07)", () => {
  it.each([
    ["wide", palette],
    ["48 columns", paletteW48],
  ])("%s: reads the typed slash command off the palette's filter row", (_name, capture) => {
    const screen = parse(capture);
    expect(hasComposer(screen)).toBe(true);
    // The command the operator typed — and the reason this shape has to be recognised at all: the
    // reply guard withholds the submit key until it can read the text back off the screen.
    expect(extractInputDraft(screen)).toBe("/resume");
    // The palette stands where the statusline would be: there is none to lift for the status strip.
    expect(extractStatusLines(screen)).toEqual([]);
    // …and the run of palette rows between the composer and the tail is too long for the bridge's
    // 6-row window, so the destructive pre-clear goes out UNBOUND rather than 409ing forever.
    expect(composerPrompt(screen)).toBeNull();
  });

  it("peels the composer AND the palette off the mirror, keeping the transcript above them", () => {
    const flushed = stripChrome(parse(palette)).map((line) => line.segments.map((s) => s.text).join(""));
    expect(flushed.join("\n")).not.toContain("/resume");
    expect(flushed.join("\n")).not.toContain("Resume a different session");
    expect(flushed.join("\n")).toContain("Update Available");
  });

  it("binds the composer's rows again once the palette is short enough for the tail window", () => {
    // One entry instead of eight: the named region ends inside the bridge's window, so the sweep
    // keeps its binding. Built by dropping the other palette rows, the way the draft tests build
    // their screens.
    const rows = palette.split("\n");
    const selection = rows.findIndex((row) => row.includes("❯ 🕘 resume"));
    expect(selection).toBeGreaterThan(0);
    const screen = parse([...rows.slice(0, selection + 1), ""].join("\n"));
    const region = composerPrompt(screen);
    expect(region).toContain("/resume");
    expect(region?.split("\n").length).toBe(3); // top rule, filter row, bottom rule
  });

  it("sends `/resume` — types it, sees the palette screen, and only then fires the submit key", async () => {
    // The 2026-10-07 report reproduced end to end: Collie types the harness bar's `/resume` into an
    // omp pane, omp answers with the palette, and the guard's verification read has to find the text
    // there. Before this shape was recognised the read found no composer, no submit key ever went
    // out, and the command sat on the filter row.
    let screen = idle;
    const calls: Array<{ text: string; submit: boolean }> = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: "test:p1", text: screen })),
      http.post<never, { text: string; submit: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        calls.push(await request.json());
        screen = palette; // the palette is what the pane answers with after the type lands
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await sendGuardedReply({
      paneId: "test:p1",
      agent: "omp",
      text: "/resume",
      requestedLines: 200,
      sleep: async () => {},
    });
    expect(result.status).toBe("sent");
    expect(calls).toEqual([
      { text: "/resume", submit: false },
      { text: "", submit: true },
    ]);
  });

  it("declines an ordinary output row under the palette", () => {
    expect(hasComposer(parse(`${palette}\nplain transcript line`))).toBe(false);
  });
});

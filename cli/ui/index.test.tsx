import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import type { DoctorView, StatusView, TonedLine } from "../render.ts";
import { Doctor, Members, Status } from "./index.tsx";

// The components, drawn into a string. These do NOT pin the layout — a box-drawing character or a
// column width is not a contract, and asserting one would make every visual tweak a test edit. What
// is pinned is the thing a rewrite could quietly lose: every piece of information the plain path
// prints must still be on screen, because the rich view is the plain view plus colour, never minus
// a line. The plain lines themselves are pinned in each verb's own suite.

/** Strip SGR escapes: what a reader would see. */
const plain = (frame: string | undefined): string => (frame ?? "").replace(/\[[0-9;]*m/g, "");

describe("the doctor table", () => {
  const view: DoctorView = {
    heading: "collie doctor — 9.9.9 · mode lead",
    local: [
      { check: "web-dist", status: "ok", detail: "14 entries", remedy: null },
      { check: "front-door", status: "warn", detail: "nothing published", remedy: "`collie serve`" },
      { check: "restart-pending", status: "skipped", detail: "no version recorded", remedy: "`collie restart`" },
    ],
    packTitle: "pack: herd",
    pack: [{ check: "reach", status: "error", detail: "1 of 2 unreachable", remedy: "`collie reconnect`" }],
    packNote: [],
  };

  test("every finding keeps its status word, identifier, detail and remedy", () => {
    const frame = plain(render(<Doctor view={view} />).lastFrame());
    expect(frame).toContain(view.heading);
    for (const f of [...view.local, ...view.pack]) {
      expect(frame).toContain(f.check);
      expect(frame).toContain(f.detail);
      if (f.remedy !== null) expect(frame).toContain(f.remedy);
      if (f.status !== "ok") expect(frame).toContain(`${f.status}:`);
    }
    expect(frame).toContain("✓");
    expect(frame).toContain(view.packTitle);
  });

  test("a solo collie gets the note instead of an empty pack table — and no bare `pack:` heading", () => {
    const solo: DoctorView = {
      ...view,
      packTitle: "pack:",
      pack: [],
      packNote: ["pack: none — this collie is not in a pack.", "  `collie pack invite` here"],
    };
    const frame = plain(render(<Doctor view={solo} />).lastFrame());
    for (const n of solo.packNote) expect(frame).toContain(n);
    expect(frame).not.toMatch(/^\s*pack:\s*$/m);
  });
});

describe("the status banner", () => {
  const rows = [
    { label: "service", value: "systemd --user: collie" },
    { label: "local", value: "http://127.0.0.1:8787" },
    { label: "tailnet", value: "https://laptop.tail.ts.net" },
  ];

  test("carries the verdict and every row the plain banner carries", () => {
    const view: StatusView = { running: true, headline: "✓ Collie is running  ·  v9.9.9", rows };
    const frame = plain(render(<Status view={view} />).lastFrame());
    expect(frame).toContain(view.headline);
    for (const r of rows) {
      expect(frame).toContain(r.label);
      expect(frame).toContain(r.value);
    }
  });

  test("a bridge that isn't answering says so in the same words", () => {
    const view: StatusView = { running: false, headline: "⚠ Collie isn't answering on :8787 yet", rows };
    expect(plain(render(<Status view={view} />).lastFrame())).toContain("isn't answering");
  });
});

describe("the pack members block", () => {
  test("prints each line verbatim — the tone is colour, never a rewrite", () => {
    const lines: TonedLine[] = [
      { text: "members:", tone: "dim" },
      { text: "  laptop  (peer)  https://laptop.tail.ts.net", tone: "plain" },
      { text: "    link    unreachable · connect timed out", tone: "bad" },
    ];
    const frame = plain(render(<Members lines={lines} />).lastFrame());
    for (const l of lines) expect(frame).toContain(l.text);
  });
});

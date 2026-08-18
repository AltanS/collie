import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import type { DoctorView, StatusView, TonedLine, UpdateEvent } from "../render.ts";
import { Doctor, Members, Status } from "./index.tsx";
import { createUpdateStore, PackUpdate } from "./pack-update.tsx";

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

describe("the pack update surface", () => {
  /** The events a one-member run emits, up to and including its table. */
  const RUN: UpdateEvent[] = [
    { kind: "title", version: "1.2.3", commit: "abc123def4567890" },
    { kind: "plan", memberId: "nas", state: "ready", detail: "1.2.2 at 0000feed0000" },
    { kind: "plan", memberId: "pi", state: "skipped", detail: "no ssh record" },
    { kind: "member-start", memberId: "nas" },
    { kind: "leg-done", memberId: "nas", leg: "push", ok: true, detail: "1.2.3 at /home/pat/.collie" },
    { kind: "line", text: "warn: nas answers as 9.9.9", tone: "warn", stream: "err" },
    { kind: "member-done", memberId: "nas", outcome: "updated" },
    {
      kind: "summary",
      rows: [
        { memberId: "nas", outcome: "updated", detail: "1.2.2 → 1.2.3" },
        { memberId: "pi", outcome: "skipped", detail: "no ssh record" },
      ],
      verdict: "1 updated, 1 skipped",
      ok: true,
    },
  ];

  test("every member, every leg and every line the plain replay prints is on screen", () => {
    const store = createUpdateStore();
    const frame = plain(render(<PackUpdate store={store} />).lastFrame());
    // Drawn from a store that has the whole run in it: the surface is a fold, not a stream reader.
    for (const event of RUN) store.emit(event);
    const finished = plain(render(<PackUpdate store={store} />).lastFrame());
    expect(frame).toContain("pack update");
    for (const needle of [
      "1.2.3",
      "nas",
      "pi",
      "push",
      "1.2.3 at /home/pat/.collie",
      "warn: nas answers as 9.9.9",
      "no ssh record",
      "1 updated, 1 skipped",
    ]) {
      expect(finished).toContain(needle);
    }
  });

  test("a leg's progress line is drawn under THAT leg, never below the ones that came after it", () => {
    const store = createUpdateStore();
    for (const event of [
      { kind: "title", version: "1.2.3", commit: "abc123def4567890" },
      { kind: "member-start", memberId: "nas" },
      { kind: "leg-start", memberId: "nas", leg: "push" },
      { kind: "line", text: "  pushing abc123def456 (10831 KiB base64) to /home/pat/.collie…", tone: "info", stream: "out" },
      { kind: "leg-done", memberId: "nas", leg: "push", ok: true, detail: "1.2.3 at /home/pat/.collie" },
      { kind: "leg-start", memberId: "nas", leg: "restart" },
      { kind: "leg-done", memberId: "nas", leg: "restart", ok: true, detail: "its bridge came back" },
      { kind: "leg-start", memberId: "nas", leg: "verify" },
      { kind: "leg-done", memberId: "nas", leg: "verify", ok: true, detail: "answers at 100.64.0.9:8787 · 1.2.3" },
      { kind: "member-done", memberId: "nas", outcome: "updated" },
    ] satisfies UpdateEvent[]) {
      store.emit(event);
    }
    const frame = plain(render(<PackUpdate store={store} />).lastFrame());
    expect(frame).toContain("pushing abc123def456");
    // The field bug, as an ordering assertion: it belongs above `restart`, not below `verify`.
    expect(frame.indexOf("pushing abc123def456")).toBeLessThan(frame.indexOf("restart"));
    expect(frame.indexOf("1.2.3 at /home/pat/.collie")).toBeLessThan(frame.indexOf("pushing abc123def456"));
  });

  test("the one question is drawn IN the app — nothing is written to ask it", () => {
    const store = createUpdateStore();
    const answered = store.confirm("update 1 member to 1.2.3?");
    const frame = plain(render(<PackUpdate store={store} />).lastFrame());
    expect(frame).toContain("update 1 member to 1.2.3?");
    expect(frame).toContain("y / N");
    store.answer(true);
    expect(answered).resolves.toBe(true);
  });
});

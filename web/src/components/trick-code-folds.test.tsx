import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TrickAboutSheet } from "@/components/trick-about-sheet";
import { CodeFailure, type TrickCodeReader } from "@/components/trick-code-folds";
import { readCodeFile, readCodeIndex, type WireCodeFile, type WireCodeIndex } from "@/lib/tricks/code-wire";
import { markWord, spanWords, timerLine } from "@/lib/tricks/code-words";
import { WATCH_WINDOW_MS } from "@/lib/tricks/limits";
import { TRICK_WARNING_KINDS, type WireTrickInfo } from "@/lib/tricks/schema";
import { readTrick } from "@/lib/tricks/wire";

// "Read the code" in a trick's About sheet: one fold for each file, one tap to open, the code wrapped and never
// sideways, a mark with a word on each flagged line, and the run line and the timer in plain words.

afterEach(cleanup);

const TRICK: WireTrickInfo = {
  host: "lodge",
  id: "legs",
  name: "Browser leg",
  icon: "flask",
  on: true,
  state: "ok",
  places: ["belt"],
  provenance: { via: "folder" },
  run: "./legs.sh",
  everyMs: 5 * 60_000,
  approves: "a".repeat(64),
};

const HASH = "a".repeat(64);
const INDEX: WireCodeIndex = {
  hash: HASH,
  copy: "approved",
  files: [
    { file: "trick.toml", size: 120, flagged: 0 },
    { file: "legs.sh", size: 2048, flagged: 2 },
    { file: "tool.bin", size: 52_224, binary: true, flagged: 0 },
  ],
};
const LEGS: WireCodeFile = {
  file: "legs.sh",
  size: 2048,
  lines: ["#!/bin/sh", "curl https://example.test/data", "", "echo done " + "x".repeat(300)],
  leftOut: 0,
  masked: 0,
  marks: [{ line: 2, kinds: ["network", "spawn"] }],
  marksLeft: 0,
};

function reader(over: Partial<TrickCodeReader> = {}) {
  const index = vi.fn(async () => INDEX);
  const file = vi.fn(async (name: string): Promise<WireCodeFile> => (name === "legs.sh" ? LEGS : { file: name, size: 120, lines: ["id = \"legs\""], leftOut: 0, masked: 0, marks: [], marksLeft: 0 }));
  return { reader: { index, file, ...over } satisfies TrickCodeReader, index, file };
}

function open(trick: WireTrickInfo, r: TrickCodeReader | undefined) {
  return render(<TrickAboutSheet trick={trick} open onClose={vi.fn()} readCode={r} />);
}

const toggleOf = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`, "u") });

describe("the folds", () => {
  it("draws no section without a reader, and one fold row for each text file with a reader", async () => {
    const { unmount } = open(TRICK, undefined);
    expect(screen.getByRole("dialog").querySelector('[data-section="code"]')).toBeNull();
    unmount();
    const r = reader();
    open(TRICK, r.reader);
    const list = await screen.findByRole("list", { name: "Read the code" });
    expect([...list.querySelectorAll("li[data-code-file]")].map((li) => li.getAttribute("data-code-file"))).toEqual(["trick.toml", "legs.sh", "tool.bin"]);
    expect(r.index).toHaveBeenCalledTimes(1);
    // No code before a fold opens.
    expect(r.file).not.toHaveBeenCalled();
    // It shows for a trick that is on and for one that is off.
    expect(TRICK.on).toBe(true);
  });

  it("shows for a trick that is off too, and says which copy it is", async () => {
    const next: WireCodeIndex = { ...INDEX, copy: "next" };
    open({ ...TRICK, on: false, state: "off" }, reader({ index: async () => next }).reader);
    expect(await screen.findByText(/Not approved yet\. This is the code in the folder now/u)).toBeInTheDocument();
  });

  it("says the approved copy is the code that runs", async () => {
    open(TRICK, reader().reader);
    expect(await screen.findByText(/This is the approved copy: the code that runs\./u)).toBeInTheDocument();
  });

  it("each file row is a button at least 44 px tall, closed, with the flag count and the size", async () => {
    open(TRICK, reader().reader);
    await screen.findByRole("list", { name: "Read the code" });
    const legs = toggleOf("legs.sh");
    expect(legs).toHaveAttribute("aria-expanded", "false");
    expect(legs.className).toContain("min-h-11");
    expect(within(legs).getByText("2 flagged")).toBeInTheDocument();
    expect(within(legs).getByText("2 KB")).toBeInTheDocument();
    expect(within(toggleOf("trick.toml")).queryByText(/flagged/u)).toBeNull();
  });

  it("opens with one tap and asks for that file once; a second tap closes it and does not ask again", async () => {
    const user = userEvent.setup();
    const r = reader();
    open(TRICK, r.reader);
    await screen.findByRole("list", { name: "Read the code" });
    await user.click(toggleOf("legs.sh"));
    expect(toggleOf("legs.sh")).toHaveAttribute("aria-expanded", "true");
    await screen.findByText("#!/bin/sh");
    expect(r.file).toHaveBeenCalledTimes(1);
    expect(r.file).toHaveBeenCalledWith("legs.sh");
    await user.click(toggleOf("legs.sh"));
    expect(toggleOf("legs.sh")).toHaveAttribute("aria-expanded", "false");
    await user.click(toggleOf("legs.sh"));
    expect(r.file).toHaveBeenCalledTimes(1);
  });

  it("wraps: monospace, pre-wrap, break-all, and nothing that scrolls to the side", async () => {
    const user = userEvent.setup();
    open(TRICK, reader().reader);
    await screen.findByRole("list", { name: "Read the code" });
    await user.click(toggleOf("legs.sh"));
    await screen.findByText("#!/bin/sh");
    const block = screen.getByRole("dialog").querySelector('[data-slot="trick-code-lines"]');
    expect(block?.className).toContain("font-mono");
    expect(block?.outerHTML).not.toContain("overflow-x-auto");
    expect(block?.outerHTML).not.toContain("whitespace-pre ");
    const longest = [...(block?.querySelectorAll("[data-code-line]") ?? [])].at(-1)?.querySelector("span.flex-1");
    expect(longest?.className).toContain("whitespace-pre-wrap");
    expect(longest?.className).toContain("break-all");
    expect(longest?.className).toContain("min-w-0");
    // The text is the line as sent, whole.
    expect(longest?.textContent).toBe(LEGS.lines?.[3]);
  });

  it("numbers the lines, keeps an empty line, and marks a flagged line with the glyph, the word of each kind and a tint", async () => {
    const user = userEvent.setup();
    open(TRICK, reader().reader);
    await screen.findByRole("list", { name: "Read the code" });
    await user.click(toggleOf("legs.sh"));
    await screen.findByText("#!/bin/sh");
    const dialog = screen.getByRole("dialog");
    const flagged = dialog.querySelectorAll("[data-code-line][data-flagged]");
    expect([...flagged].map((li) => li.getAttribute("data-code-line"))).toEqual(["2"]);
    const marks = flagged[0]?.querySelector("[data-code-marks]");
    expect([...(marks?.querySelectorAll("[data-mark]") ?? [])].map((m) => [m.getAttribute("data-mark"), m.textContent])).toEqual([
      ["network", "Network"],
      ["spawn", "Starts"],
    ]);
    expect(marks?.querySelector("svg")).not.toBeNull();
    expect(flagged[0]?.className).toContain("bg-status-working");
    // A line with no flag has no mark row; an empty line still takes its row.
    expect(dialog.querySelectorAll("[data-code-marks]").length).toBe(1);
    expect(dialog.querySelectorAll("[data-code-line]").length).toBe(4);
  });

  it("says once that the marks are a text search and that code can hide more", async () => {
    open(TRICK, reader().reader);
    await screen.findByRole("list", { name: "Read the code" });
    const notes = screen.getByRole("dialog").querySelectorAll('[data-line="code-note"]');
    expect(notes.length).toBe(1);
    expect(notes[0]).toHaveTextContent("The marks come from a text search. It is not a proof: code can hide more than a search finds. Docs, data and tests are not searched.");
  });

  it("a binary file is a row of its name and size with no fold and no read", async () => {
    const r = reader();
    open(TRICK, r.reader);
    await screen.findByRole("list", { name: "Read the code" });
    const row = screen.getByRole("dialog").querySelector('li[data-code-file="tool.bin"]');
    expect(row?.hasAttribute("data-binary")).toBe(true);
    expect(row?.querySelector("button")).toBeNull();
    expect(row).toHaveTextContent("51 KB");
    expect(row).toHaveTextContent("Not text. Only the name and the size are shown.");
    expect(r.file).not.toHaveBeenCalled();
  });

  it("says how much of a long file is left out, the flags in that part, and the masked lines", async () => {
    const user = userEvent.setup();
    const long: WireCodeFile = { file: "legs.sh", size: 90_000, lines: ["echo ••••"], leftOut: 61_440, masked: 3, marks: [], marksLeft: 2 };
    open(TRICK, reader({ file: async () => long }).reader);
    await screen.findByRole("list", { name: "Read the code" });
    await user.click(toggleOf("legs.sh"));
    expect(await screen.findByText("60 KB more is not shown. Read the rest on the machine.")).toBeInTheDocument();
    expect(screen.getByText("Flagged lines in the part not shown: 2.")).toBeInTheDocument();
    expect(screen.getByText("Masked lines: 3. A key or a hidden character shows as dots or ?.")).toBeInTheDocument();
  });

  it("says a failed read in a muted line, for the index and for a file, and the rest of the sheet stays", async () => {
    const user = userEvent.setup();
    const { unmount } = open(TRICK, reader({ index: async () => Promise.reject(new CodeFailure("otherMachine")) }).reader);
    expect(await screen.findByText("This trick is on another machine. Its code is not shown here.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "What it does" })).toBeInTheDocument();
    unmount();
    open(TRICK, reader({ index: async () => Promise.reject(new Error("boom")) }).reader);
    expect(await screen.findByText("The code could not be read. Close this sheet and open it again.")).toBeInTheDocument();
    cleanup();
    open(TRICK, reader({ file: async () => Promise.reject(new CodeFailure("moved")) }).reader);
    await screen.findByRole("list", { name: "Read the code" });
    await user.click(toggleOf("legs.sh"));
    expect(await screen.findByText("The code changed while it was read. Close this sheet and open it again.")).toBeInTheDocument();
  });

  it("asks for the index again when the row moves under an open sheet", async () => {
    const r = reader();
    const { rerender } = open(TRICK, r.reader);
    await screen.findByRole("list", { name: "Read the code" });
    rerender(<TrickAboutSheet trick={{ ...TRICK, on: false, state: "off" }} open onClose={vi.fn()} readCode={r.reader} />);
    await waitFor(() => expect(r.index).toHaveBeenCalledTimes(2));
  });
});

describe("the word of a mark", () => {
  it("has a phone word for every warning kind the bridge can send, the API kind included", () => {
    for (const kind of TRICK_WARNING_KINDS) expect(markWord(kind)).not.toBe(kind);
    expect(markWord("api")).toBe("API");
    expect(markWord("unheard-of")).toBe("unheard-of");
  });
});

describe("the run line and the timer", () => {
  it("shows the run line whole in monospace, wrapped, and the timer in plain words, for a trick with a timer", () => {
    open(TRICK, undefined);
    const does = screen.getByRole("list", { name: "What it does" });
    const run = does.querySelector('[data-line="run"]');
    expect(run?.tagName).toBe("CODE");
    expect(run).toHaveTextContent("./legs.sh");
    expect(run?.className).toContain("font-mono");
    expect(run?.className).toContain("whitespace-pre-wrap");
    expect(does.querySelector('[data-line="timer"]')).toHaveTextContent("Runs when it starts, then every 5 min after the last run. It runs only while a phone has looked in the last 5 min.");
  });

  it("says a trick with no timer runs once and on a tap, and a trick with no program has neither row", () => {
    const { unmount } = open({ ...TRICK, everyMs: undefined }, undefined);
    expect(screen.getByRole("dialog").querySelector('[data-line="timer"]')).toHaveTextContent("Runs once when it starts, and when you tap it. It has no timer.");
    unmount();
    open({ ...TRICK, run: undefined, everyMs: undefined }, undefined);
    expect(screen.getByRole("dialog").querySelector('[data-line="run"]')).toBeNull();
    expect(screen.getByRole("dialog").querySelector('[data-line="timer"]')).toBeNull();
  });

  it("names the spans in the unit a person reads, and the watch window is the bridge's number", () => {
    expect(spanWords(5_000)).toBe("5 s");
    expect(spanWords(90_000)).toBe("90 s");
    expect(spanWords(60_000)).toBe("1 min");
    expect(spanWords(30 * 60_000)).toBe("30 min");
    expect(spanWords(3_600_000)).toBe("1 h");
    expect(spanWords(24 * 3_600_000)).toBe("24 h");
    expect(WATCH_WINDOW_MS).toBe(5 * 60_000);
    expect(timerLine(undefined)).toContain("no timer");
  });
});

describe("the wire", () => {
  it("reads the index and a file as the bridge sends them, and leaves out any other shape", () => {
    expect(readCodeIndex(JSON.parse(JSON.stringify(INDEX)))).toEqual(INDEX);
    expect(readCodeFile(JSON.parse(JSON.stringify(LEGS)))).toEqual(LEGS);
    expect(readCodeFile({ file: "tool.bin", size: 9, binary: true })).toEqual({ file: "tool.bin", size: 9, binary: true });
    for (const bad of [undefined, null, [], {}, { ...INDEX, hash: "short" }, { ...INDEX, copy: "other" }, { ...INDEX, files: [{ file: "", size: 1, flagged: 0 }] }, { ...INDEX, files: [{ file: "a", size: -1, flagged: 0 }] }]) {
      // SAFETY: a deliberately wrong shape, to see the reader refuse it.
      expect(readCodeIndex(bad as never)).toBeUndefined();
    }
    for (const bad of [{ ...LEGS, lines: "x" }, { ...LEGS, lines: [1] }, { ...LEGS, marks: [{ line: 0, kinds: ["network"] }] }, { ...LEGS, marks: [{ line: 1, kinds: [] }] }, { ...LEGS, leftOut: -1 }]) {
      // SAFETY: a deliberately wrong shape, to see the reader refuse it.
      expect(readCodeFile(bad as never)).toBeUndefined();
    }
  });

  it("draws a hidden or control character in a line as ?, so a line cannot be turned around", () => {
    // SAFETY: the lines are strings; the cast only lets the object through the reader's JSON type.
    const read = readCodeFile({ ...LEGS, lines: ["a\u202eb", "tab\u0007bell"] } as never);
    expect(read?.lines).toEqual(["a?b", "tab?bell"]);
  });

  it("the trick row reads the run line and the timer, and drops a timer that is out of bounds or a run that is not text", () => {
    const sent = JSON.parse(JSON.stringify(TRICK));
    expect(readTrick(sent)).toMatchObject({ run: "./legs.sh", everyMs: 300_000 });
    expect(readTrick({ ...sent, everyMs: 10 })?.everyMs).toBeUndefined();
    expect(readTrick({ ...sent, everyMs: 90_000_000 })?.everyMs).toBeUndefined();
    expect(readTrick({ ...sent, everyMs: 1.5 })?.everyMs).toBeUndefined();
    expect(readTrick({ ...sent, run: 5 })?.run).toBeUndefined();
    expect(readTrick({ ...sent, run: "a\nb" })?.run).toBeUndefined();
    expect(readTrick({ ...sent, run: "x".repeat(1025) })?.run).toBeUndefined();
  });
});

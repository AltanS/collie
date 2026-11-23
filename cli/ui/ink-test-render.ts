// Shared by the cli tests that draw an ink app: `ink-testing-library`'s render, with a stdout that knows
// its size. Not a test file.
//
// Why not the library itself: its fake stdout has `columns` and no `rows`. Ink reads the size on every
// commit (`getWindowSize`) and, missing either, asks `terminal-size`, which spawns `tput cols` and
// `tput lines` (500 ms limit each) whenever the test's own stdout is not a terminal, as in CI. That is
// two real processes per commit: one `crew add` run made 38 of them here, and on GitHub's Windows runner
// the run took 5.4 s and timed out with "killed 1 dangling process" (2026-11-22). With both sizes set,
// ink never asks. Ink reads `rows` only for a TTY, so the drawn frames are the same.

import { EventEmitter } from "node:events";
import { render as inkRender, type Instance } from "ink";
import type { ReactElement } from "react";

/** An output ink draws into, and every frame it wrote. */
interface FakeOutput {
  readonly stream: NodeJS.WriteStream;
  readonly frames: string[];
}

/** What ink uses of its input: the reads, raw mode and the events. */
type FakeInput = EventEmitter & {
  readonly isTTY: boolean;
  write(data: string): boolean;
  read(): string | null;
  setEncoding(): void;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  ref(): void;
  unref(): void;
};

function fakeOutput(): FakeOutput {
  const frames: string[] = [];
  const fake = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 24,
    write: (frame: string): boolean => {
      frames.push(frame);
      return true;
    },
  });
  // SAFETY: ink reads only `columns`, `rows`, `write` and the events of its output (the set
  // `ink-testing-library` fakes); a real terminal stream is exactly what this test must not need.
  return { stream: fake as NodeJS.WriteStream, frames };
}

function fakeInput(): FakeInput {
  let data: string | null = null;
  const fake: FakeInput = Object.assign(new EventEmitter(), {
    isTTY: true,
    write: (typed: string): boolean => {
      data = typed;
      fake.emit("readable");
      fake.emit("data", typed);
      return true;
    },
    read: (): string | null => {
      const taken = data;
      data = null;
      return taken;
    },
    setEncoding: () => {},
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  });
  return fake;
}

export interface TestRender {
  readonly lastFrame: () => string | undefined;
  readonly frames: readonly string[];
  readonly stdin: { write(data: string): void };
  readonly unmount: Instance["unmount"];
  readonly rerender: Instance["rerender"];
}

/** Draw `tree` into memory, as `ink-testing-library`'s `render` does (debug mode, no console patch). */
export function render(tree: ReactElement): TestRender {
  const stdout = fakeOutput();
  const stdin = fakeInput();
  // SAFETY: the input ink reads, as `ink-testing-library` fakes it (see `FakeInput`).
  const input = stdin as NodeJS.ReadStream;
  const instance = inkRender(tree, { stdout: stdout.stream, stderr: fakeOutput().stream, stdin: input, debug: true, exitOnCtrlC: false, patchConsole: false });
  return { lastFrame: () => stdout.frames.at(-1), frames: stdout.frames, stdin, unmount: instance.unmount, rerender: instance.rerender };
}

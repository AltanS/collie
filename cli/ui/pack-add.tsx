import { Box, render, Text, useInput } from "ink";
import React from "react";

import {
  projectAdd,
  type AddEvent,
  type AddLeg,
  type AddNote,
  type AddSurface,
  type AddView,
} from "../render.ts";
import type { Io } from "../io.ts";

// `collie pack add`'s surface — the one place in `cli/ui/` that stays mounted while a verb works.
//
// ── ONE WRITER, FOR THE WHOLE RUN ────────────────────────────────────────────
// The rule it has to keep is in `cli/render.ts`: while this is mounted, NOTHING else may write to
// the terminal. That is what {@link createAddStore} is for — its `io` is not a writer at all, it is
// an `AddEvent` factory, and `cli/remote.ts` swaps it in for `deps.io` (which every nested call,
// including `collie restart`, writes through) for exactly the length of the run. The two questions
// are answered by {@link Question} below rather than by Bun's `confirm()`/`prompt()`, because those
// two write their own prompt to the same tty ink is drawing on, which is precisely how the first
// attempt at this surface tore.
//
// The store is deliberately dumb: it keeps the event list and hands it to `projectAdd`, which lives
// in `cli/render.ts` and is pure. Everything this file decides is how the model LOOKS.

/** What the app is waiting for an answer to. */
export interface Question {
  readonly mode: "confirm" | "text";
  readonly text: string;
}

interface State {
  readonly events: readonly AddEvent[];
  readonly question: Question | null;
}

export interface AddStore {
  subscribe(listener: () => void): () => void;
  state(): State;
  /** The view's answer to the pending question — a `boolean` for confirm, a `string` for text. */
  answer(value: boolean | string): void;
  readonly io: Io;
  emit(event: AddEvent): void;
  confirm(question: string): Promise<boolean | null>;
  prompt(question: string): Promise<string | null>;
}

/**
 * The event sink the verb writes into.
 *
 * `io.err` classifies by the line's own first word rather than by its stream: `warn:` on stderr is
 * the CLI's normal spelling for "this is not fatal", and rendering the whole of it in red would
 * misreport a run that succeeded. That is a colour decision made from a prefix the CLI itself
 * writes — it is not parsing the line for content, which the structured events carry instead.
 */
export function createAddStore(): AddStore {
  let state: State = { events: [], question: null };
  const listeners = new Set<() => void>();
  let pending: ((value: boolean | string) => void) | null = null;

  const set = (next: State): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const emit = (event: AddEvent): void => set({ ...state, events: [...state.events, event] });
  const askFor = <T,>(question: Question, read: (value: boolean | string) => T): Promise<T> =>
    new Promise<T>((resolve) => {
      pending = (value) => {
        pending = null;
        set({ ...state, question: null });
        resolve(read(value));
      };
      set({ ...state, question });
    });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: () => state,
    answer(value) {
      pending?.(value);
    },
    emit,
    io: {
      out: (text) => emit({ kind: "line", text, tone: "info", stream: "out" }),
      err: (text) =>
        emit({ kind: "line", text, tone: text.trimStart().startsWith("warn") ? "warn" : "error", stream: "err" }),
    },
    confirm: (question) => askFor({ mode: "confirm", text: question }, (v) => v === true),
    // A text question is answered with text; the boolean half of the answer channel belongs to
    // `confirm`, and an answer arriving on it here is not one this prompt can read.
    prompt: (question) =>
      askFor({ mode: "text", text: question }, (v) => (v === true || v === false ? "" : v)),
  };
}

// ── The view ─────────────────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const LEG_WIDTH = 10;

const TONE_COLOR = {
  info: undefined,
  warn: "yellow",
  error: "red",
} satisfies Record<AddNote["tone"], string | undefined>;

function Notes({ notes, indent }: { notes: readonly AddNote[]; indent: number }): React.ReactElement | null {
  if (notes.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={indent}>
      {notes.map((note, i) => (
        // Never re-indented: a line's own leading spaces are what align a wrapped `usage:` block and
        // an `error:`'s continuation rows, exactly as they do on the plain path.
        <Text key={`${i}:${note.text}`} color={TONE_COLOR[note.tone]} dimColor={note.tone === "info"}>
          {note.text}
        </Text>
      ))}
    </Box>
  );
}

/** The leg's own glyph. A pending leg is drawn, dimmed — the shape of the run is visible from row 1. */
function legMark(status: AddView["legs"][number]["status"], frame: number): React.ReactElement {
  if (status === "active") return <Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text>;
  if (status === "done") return <Text color="green">✓</Text>;
  if (status === "failed") return <Text color="red">✗</Text>;
  return <Text dimColor>·</Text>;
}

const LEG_NAME = {
  probe: "probe",
  install: "install",
  configure: "configure",
  enroll: "enroll",
} satisfies Record<AddLeg, string>;

function Legs({ legs, frame }: { legs: AddView["legs"]; frame: number }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {legs.map((leg) => (
        <Box key={leg.leg} flexDirection="column">
          <Box>
            <Box width={2} flexShrink={0}>
              {legMark(leg.status, frame)}
            </Box>
            <Box width={LEG_WIDTH} flexShrink={0}>
              <Text bold dimColor={leg.status === "pending"}>
                {LEG_NAME[leg.leg]}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor={leg.status === "pending"}>{leg.detail}</Text>
            </Box>
          </Box>
          <Notes notes={leg.notes} indent={3} />
        </Box>
      ))}
    </Box>
  );
}

/** The probe's name/value pairs — the same facts the plain `✓` rows carry, aligned by the engine. */
function Facts({ facts }: { facts: AddView["facts"] }): React.ReactElement | null {
  if (facts.length === 0) return null;
  const width = Math.max(...facts.map((f) => f.name.length)) + 2;
  return (
    <Box flexDirection="column" paddingLeft={3}>
      {facts.map((fact) => (
        <Box key={fact.name}>
          <Box width={width} flexShrink={0}>
            <Text dimColor>{fact.name}</Text>
          </Box>
          <Text dimColor>{fact.value}</Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * The prompt, inside the app. Shared with `pack update`, whose one question is the same `[y/N]`.
 *
 * `Enter` is No, which is what the `[y/N]` this replaces meant — the default must not change just
 * because the rendering did. Nothing is written to the terminal to ask: this IS the ask.
 */
export function Ask({ question, onAnswer }: { question: Question; onAnswer: (v: boolean | string) => void }): React.ReactElement {
  const [typed, setTyped] = React.useState("");
  useInput((input, key) => {
    if (question.mode === "confirm") {
      if (input === "y" || input === "Y") onAnswer(true);
      else if (input === "n" || input === "N" || key.return || key.escape) onAnswer(false);
      return;
    }
    if (key.return) onAnswer(typed);
    else if (key.escape) onAnswer("");
    else if (key.backspace || key.delete) setTyped((t) => t.slice(0, -1));
    else if (input !== "" && !key.ctrl && !key.meta) setTyped((t) => t + input);
  });
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="yellow" bold>
        ? {question.text}
      </Text>
      <Text>
        {question.mode === "confirm" ? (
          <Text dimColor>  y / N (Enter keeps it as it is)</Text>
        ) : (
          <Text>
            {"  > "}
            {typed}
            <Text dimColor>▏</Text>
          </Text>
        )}
      </Text>
    </Box>
  );
}

export function PackAdd({ store }: { store: AddStore }): React.ReactElement {
  const state = React.useSyncExternalStore(store.subscribe, store.state, store.state);
  const view = projectAdd(state.events);
  const running = view.legs.some((l) => l.status === "active") && view.verdict === null;
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 90);
    // Never leaves a timer behind: an interval that outlives the app keeps the process alive, which
    // for a CLI verb means it never exits.
    return () => clearInterval(timer);
  }, [running]);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>pack add {view.host ?? ""}</Text>
      <Notes notes={view.preamble} indent={2} />
      <Facts facts={view.facts} />
      <Legs legs={view.legs} frame={frame} />
      {state.question === null ? null : <Ask question={state.question} onAnswer={store.answer} />}
      {view.verdict === null ? null : (
        <Box marginTop={1}>
          <Text bold color={view.verdict.ok ? "green" : "red"}>
            {view.verdict.ok ? "✓" : "✗"} {view.verdict.text}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Mount the surface. `patchConsole: true` here and nowhere else in `cli/ui/`: this app is on screen
 * while a verb works, so a stray `console` write from anywhere in the tree has somewhere to go other
 * than through the middle of a frame. Nothing in `pack add` should reach it — that is what the
 * `io` swap is for — but the guard costs nothing and the failure it prevents is the one that made
 * this surface get deleted once already.
 */
export function createAddSurface(): AddSurface {
  const store = createAddStore();
  const instance = render(<PackAdd store={store} />, { patchConsole: true });
  return {
    io: store.io,
    emit: store.emit,
    confirm: store.confirm,
    prompt: store.prompt,
    async close() {
      // Let React flush the frame the last event produced BEFORE unmounting: ink writes the final
      // frame on unmount, and unmounting in the same tick would print the previous one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

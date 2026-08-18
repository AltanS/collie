import { Box, render, Text } from "ink";
import React from "react";

import { Ask, type Question } from "./pack-add.tsx";
import {
  projectUpdate,
  type AddNote,
  type UpdateEvent,
  type UpdateMemberView,
  type UpdateSurface,
  type UpdateView,
} from "../render.ts";
import type { Io } from "../io.ts";

// `collie pack update`'s surface — the second of the two mounted-while-working views in `cli/ui/`,
// held to the same rule as the first (`cli/render.ts`): while it is up, NOTHING else writes to the
// terminal. `cli/pack-update.ts` swaps `deps.io` and `deps.confirm` for this store's for the whole
// run, and the one question is answered by {@link Ask} — shared with `pack add`, because it is
// literally the same `[y/N]` — rather than by Bun's `confirm()`, which writes its own prompt to the
// tty ink is drawing on.
//
// The store is dumb on purpose: it keeps the event list and hands it to `projectUpdate`, which is
// pure and lives next to the plain replay. Everything this file decides is how the model LOOKS.

interface State {
  readonly events: readonly UpdateEvent[];
  readonly question: Question | null;
}

export interface UpdateStore {
  subscribe(listener: () => void): () => void;
  state(): State;
  answer(value: boolean | string): void;
  readonly io: Io;
  emit(event: UpdateEvent): void;
  confirm(question: string): Promise<boolean | null>;
}

/**
 * The event sink the verb writes into. `io.err` classifies by the line's own first word, exactly as
 * `pack add`'s does: `warn:` on stderr is this CLI's spelling for "not fatal", and painting the whole
 * of it red would misreport a run that worked.
 */
export function createUpdateStore(): UpdateStore {
  let state: State = { events: [], question: null };
  const listeners = new Set<() => void>();
  let pending: ((value: boolean | string) => void) | null = null;

  const set = (next: State): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const emit = (event: UpdateEvent): void => set({ ...state, events: [...state.events, event] });

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
    confirm: (question) =>
      new Promise<boolean | null>((resolve) => {
        pending = (value) => {
          pending = null;
          set({ ...state, question: null });
          resolve(value === true);
        };
        set({ ...state, question: { mode: "confirm", text: question } });
      }),
  };
}

// ── The view ─────────────────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const LEG_WIDTH = 9;

const TONE_COLOR: Record<AddNote["tone"], string | undefined> = {
  info: undefined,
  warn: "yellow",
  error: "red",
};

const PLAN_COLOR: Record<NonNullable<UpdateMemberView["plan"]>["state"], string | undefined> = {
  ready: "cyan",
  current: undefined,
  skipped: undefined,
  blocked: "red",
};

const OUTCOME_COLOR: Record<NonNullable<UpdateMemberView["outcome"]>, string> = {
  updated: "green",
  current: "gray",
  skipped: "gray",
  failed: "red",
};

function Notes({ notes, indent = 2 }: { notes: readonly AddNote[]; indent?: number }): React.ReactElement | null {
  if (notes.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={indent}>
      {notes.map((note, i) => (
        // Never re-indented: a line's own leading spaces align its continuation rows, as on the
        // plain path.
        <Text key={`${i}:${note.text}`} color={TONE_COLOR[note.tone]} dimColor={note.tone === "info"}>
          {note.text}
        </Text>
      ))}
    </Box>
  );
}

function legMark(status: "pending" | "active" | "done" | "failed", frame: number): React.ReactElement {
  if (status === "active") return <Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text>;
  if (status === "done") return <Text color="green">✓</Text>;
  if (status === "failed") return <Text color="red">✗</Text>;
  return <Text dimColor>·</Text>;
}

function Member({ member, frame }: { member: UpdateMemberView; frame: number }): React.ReactElement {
  const plan = member.plan;
  const head =
    member.outcome === null
      ? (plan?.detail ?? "")
      : member.outcome === "updated"
        ? "updated"
        : (plan?.detail ?? "");
  return (
    <Box flexDirection="column" marginTop={member.legs === null ? 0 : 1}>
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color={member.outcome === null ? PLAN_COLOR[plan?.state ?? "current"] : OUTCOME_COLOR[member.outcome]}>
            {member.outcome === "failed" ? "✗" : member.outcome === "updated" ? "✓" : plan?.state === "ready" ? "→" : "·"}
          </Text>
        </Box>
        <Box width={14} flexShrink={0}>
          <Text bold>{member.memberId}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text dimColor>{head}</Text>
        </Box>
      </Box>
      {member.legs === null ? null : (
        <Box flexDirection="column" paddingLeft={2}>
          {member.legs.map((leg) => (
            // A column, so what was said while the leg ran is drawn UNDER its own row — `pack add`'s
            // shape, and the fix for a `pushing …` that used to render below all three ✓ rows.
            <Box key={leg.leg} flexDirection="column">
              <Box>
                <Box width={2} flexShrink={0}>
                  {legMark(leg.status, frame)}
                </Box>
                <Box width={LEG_WIDTH} flexShrink={0}>
                  <Text dimColor={leg.status === "pending"}>{leg.leg}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text dimColor>{leg.detail}</Text>
                </Box>
              </Box>
              <Notes notes={leg.notes} indent={2} />
            </Box>
          ))}
        </Box>
      )}
      <Notes notes={member.notes} />
    </Box>
  );
}

function Summary({ summary }: { summary: NonNullable<UpdateView["summary"]> }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {summary.rows.map((row) => (
        <Box key={row.memberId}>
          <Box width={14} flexShrink={0}>
            <Text>{row.memberId}</Text>
          </Box>
          <Box width={10} flexShrink={0}>
            <Text color={OUTCOME_COLOR[row.outcome]}>{row.outcome}</Text>
          </Box>
          <Text dimColor>{row.detail}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text bold color={summary.ok ? "green" : "red"}>
          {summary.ok ? "✓" : "✗"} {summary.verdict}
        </Text>
      </Box>
    </Box>
  );
}

export function PackUpdate({ store }: { store: UpdateStore }): React.ReactElement {
  const state = React.useSyncExternalStore(store.subscribe, store.state, store.state);
  const view = projectUpdate(state.events);
  const running =
    view.summary === null && view.members.some((m) => m.legs?.some((l) => l.status === "active") === true);
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 90);
    // An interval that outlives the app keeps the process alive — for a CLI verb, forever.
    return () => clearInterval(timer);
  }, [running]);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>
        pack update{view.version === null ? "" : ` → ${view.version} (${view.commit?.slice(0, 12) ?? ""})`}
      </Text>
      <Notes notes={view.preamble} />
      {view.members.map((member) => (
        <Member key={member.memberId} member={member} frame={frame} />
      ))}
      {state.question === null ? null : <Ask question={state.question} onAnswer={store.answer} />}
      {view.summary === null ? null : <Summary summary={view.summary} />}
    </Box>
  );
}

/** Mount the surface. `patchConsole: true`, for the reason `pack add`'s carries it. */
export function createUpdateSurface(): UpdateSurface {
  const store = createUpdateStore();
  const instance = render(<PackUpdate store={store} />, { patchConsole: true });
  return {
    io: store.io,
    emit: store.emit,
    confirm: store.confirm,
    async close() {
      // Let React flush the frame the last event produced before unmounting — ink writes its final
      // frame on unmount, and unmounting in the same tick would print the previous one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

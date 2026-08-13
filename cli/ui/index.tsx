import { Box, render, Text } from "ink";
import React, { useEffect, useState } from "react";

import type { DoctorView, LegRun, StatusView, TonedLine, Ui, UiFinding } from "../render.ts";

// The terminal view. NOTHING outside this directory imports ink — `cli/render.ts`'s `loadUi()` is
// the only door, and it is only opened when stdout is a terminal, `CI` is unset and `--plain` was
// not passed. Every verb with a surface here keeps its plain branch as the one that runs otherwise
// (see `cli/render.ts` for why that is structural rather than a formatting flag).
//
// ── ONE-SHOT, NOT AN APP ─────────────────────────────────────────────────────
// Three of the four surfaces draw once and unmount immediately: they are `console.log` with a layout
// engine, not a TUI. Only `pack add` stays mounted, because a spinner needs frames. There is no
// input handling anywhere in here — the two prompts `pack add` asks stay on Bun's own `confirm()`
// and `prompt()`. Raw-mode input interleaved with a four-leg SSH pipeline is risk without payoff.

/** Draw a component once, wait for ink to flush it, and let go of the terminal. */
async function once(node: React.ReactElement): Promise<void> {
  // `patchConsole: false`: a one-shot frame has no live area for stray output to corrupt, and
  // patching it would swallow anything the verb printed after we unmounted.
  const instance = render(node, { patchConsole: false });
  instance.unmount();
  await instance.waitUntilExit();
}

const TONE_COLOR: Record<TonedLine["tone"], string | undefined> = {
  plain: undefined,
  dim: "gray",
  good: "green",
  warn: "yellow",
  bad: "red",
};

// ── doctor ───────────────────────────────────────────────────────────────────
// The plain form is one line per check, its own padding baked in. Here the three columns are laid
// out by the layout engine instead, so a long identifier widens the column rather than shunting the
// detail out of alignment — and the status carries the colour the plain form can only spell.

const STATUS_TONE: Record<UiFinding["status"], TonedLine["tone"]> = {
  ok: "good",
  warn: "warn",
  error: "bad",
  skipped: "dim",
};

/** The status cell: a ✓ when it passed, the severity word otherwise — the plain form's vocabulary. */
function statusLabel(status: UiFinding["status"]): string {
  return status === "ok" ? "✓" : `${status}:`;
}

function Findings({ findings }: { findings: readonly UiFinding[] }): React.ReactElement {
  const checkWidth = Math.max(...findings.map((f) => f.check.length), 0) + 2;
  return (
    <Box flexDirection="column">
      {findings.map((f) => (
        // `flexShrink={0}` on both fixed columns: without it a narrow terminal squeezes them and
        // yoga wraps "skipped:" onto two rows, which is worse than a wrapped detail.
        <Box key={f.check}>
          <Box width={9} flexShrink={0}>
            <Text color={TONE_COLOR[STATUS_TONE[f.status]]}>{statusLabel(f.status)}</Text>
          </Box>
          <Box width={checkWidth} flexShrink={0}>
            <Text bold>{f.check}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text>{f.detail}</Text>
            {f.remedy === null ? null : <Text color="cyan">→ {f.remedy}</Text>}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function Doctor({ view }: { view: DoctorView }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{view.heading}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>local:</Text>
        <Findings findings={view.local} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {view.pack.length > 0 ? <Text dimColor>{view.packTitle}</Text> : null}
        {view.pack.length > 0 ? (
          <Findings findings={view.pack} />
        ) : (
          view.packNote.map((n) => (
            <Text key={n} dimColor>
              {n}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

// ── status banner ────────────────────────────────────────────────────────────
// The same verdict and the same rows the plain banner prints, in a box: the one thing an operator
// scans for on this screen is "is it up", and a bordered block whose colour answers that is read
// before any of the words in it are.

export function Status({ view }: { view: StatusView }): React.ReactElement {
  const labelWidth = Math.max(...view.rows.map((r) => r.label.length), 0) + 2;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={view.running ? "green" : "yellow"}
      paddingX={1}
    >
      <Text color={view.running ? "green" : "yellow"} bold>
        {view.headline}
      </Text>
      {view.rows.map((r) => (
        <Box key={r.label}>
          <Box width={labelWidth} flexShrink={0}>
            <Text dimColor>{r.label}</Text>
          </Box>
          <Text>{r.value}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── pack status: the members block ───────────────────────────────────────────
// Pre-formatted lines with a tone each, rather than a model of a member. `pack status`'s roster is a
// deliberately wordy surface — a provisional member gets three lines of explanation, a bare 401 gets
// four — and re-deriving that prose from a model would be a second place for it to drift. What the
// terminal adds is the colour: reachable, refused, unreachable, behind on the secret.

export function Members({ lines }: { lines: readonly TonedLine[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={`${i}:${l.text}`} color={TONE_COLOR[l.tone]} dimColor={l.tone === "dim"}>
          {l.text === "" ? " " : l.text}
        </Text>
      ))}
    </Box>
  );
}

// ── pack add: the leg pipeline ───────────────────────────────────────────────
// The only surface that stays mounted. `patchConsole` is ON here: every informational line the plain
// path prints still goes through `Io` → `console.log`, and ink lifts those above the live area
// instead of letting them tear through the spinner. So the rich run is the plain run plus a status
// line, never the plain run minus something.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface LegState {
  readonly name: string;
  readonly outcome: "running" | "ok" | "failed";
}

export function Legs({ subscribe }: { subscribe: (fn: (legs: readonly LegState[]) => void) => void }): React.ReactElement {
  const [legs, setLegs] = useState<readonly LegState[]>([]);
  const [frame, setFrame] = useState(0);
  useEffect(() => subscribe(setLegs), [subscribe]);
  useEffect(() => {
    const running = legs.some((l) => l.outcome === "running");
    if (!running) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(timer);
  }, [legs]);
  return (
    <Box flexDirection="column">
      {legs.map((l) => {
        if (l.outcome === "running") {
          return (
            <Text key={l.name} color="cyan">
              {FRAMES[frame % FRAMES.length]} {l.name}…
            </Text>
          );
        }
        return (
          <Text key={l.name} color={l.outcome === "ok" ? "green" : "red"}>
            {l.outcome === "ok" ? "✓" : "✗"} {l.name}
          </Text>
        );
      })}
    </Box>
  );
}

function legRun(): LegRun {
  let legs: LegState[] = [];
  let publish: (legs: readonly LegState[]) => void = () => {};
  const instance = render(<Legs subscribe={(fn) => (publish = fn)} />, { patchConsole: true });
  return {
    begin(name) {
      legs = [...legs, { name, outcome: "running" }];
      publish(legs);
    },
    end(ok) {
      legs = legs.map((l, i) => (i === legs.length - 1 ? { ...l, outcome: ok ? "ok" : "failed" } : l));
      publish(legs);
    },
    async close() {
      // Any leg still open when the run ends failed on a path that returned early — mark it, so the
      // last thing on screen is never a spinner frozen mid-frame.
      legs = legs.map((l) => (l.outcome === "running" ? { ...l, outcome: "failed" } : l));
      publish(legs);
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

// Exported for `cli/ui/index.test.tsx` only — nothing outside this directory renders them, and
// `createUi` below is the whole of the interface `cli/render.ts` knows about.
export function createUi(): Ui {
  return {
    doctor: (view) => once(<Doctor view={view} />),
    status: (view) => once(<Status view={view} />),
    packMembers: (lines) => once(<Members lines={lines} />),
    legs: legRun,
  };
}

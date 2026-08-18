import { Box, render, Text } from "ink";
import React from "react";

import { createAddSurface } from "./pack-add.tsx";
import { createUpdateSurface } from "./pack-update.tsx";
import type { DoctorView, StatusView, TonedLine, Ui, UiFinding } from "../render.ts";

// The terminal view. NOTHING outside this directory imports ink — `cli/render.ts`'s `loadUi()` is
// the only door, and it is only opened when stdout is a terminal, `CI` is unset and `--plain` was
// not passed. Every verb with a surface here keeps its plain branch as the one that runs otherwise
// (see `cli/render.ts` for why that is structural rather than a formatting flag).
//
// ── ONE-SHOT, NOT AN APP ─────────────────────────────────────────────────────
// Every surface in THIS file draws once and unmounts immediately: they are `console.log` with a
// layout engine, not a TUI. The one exception lives in `./pack-add.tsx`, which stays mounted for a
// whole verb — and may, because it owns every byte written while it is up (`cli/render.ts`). The
// same goes for `./pack-update.tsx`, on the same terms.

/** Draw a component once, wait for ink to flush it, and let go of the terminal. */
async function once(node: React.ReactElement): Promise<void> {
  // `patchConsole: false`: a one-shot frame has no live area for stray output to corrupt, and
  // patching it would swallow anything the verb printed after we unmounted.
  const instance = render(node, { patchConsole: false });
  instance.unmount();
  await instance.waitUntilExit();
}

const TONE_COLOR = {
  plain: undefined,
  dim: "gray",
  good: "green",
  warn: "yellow",
  bad: "red",
} satisfies Record<TonedLine["tone"], string | undefined>;

// ── doctor ───────────────────────────────────────────────────────────────────
// The plain form is one line per check, its own padding baked in. Here the three columns are laid
// out by the layout engine instead, so a long identifier widens the column rather than shunting the
// detail out of alignment — and the status carries the colour the plain form can only spell.

const STATUS_TONE = {
  ok: "good",
  warn: "warn",
  error: "bad",
  skipped: "dim",
} satisfies Record<UiFinding["status"], TonedLine["tone"]>;

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

// Exported for `cli/ui/index.test.tsx` only — nothing outside this directory renders them, and
// `createUi` below is the whole of the interface `cli/render.ts` knows about.
export function createUi(): Ui {
  return {
    doctor: (view) => once(<Doctor view={view} />),
    status: (view) => once(<Status view={view} />),
    packMembers: (lines) => once(<Members lines={lines} />),
    // The one surface that is NOT one-shot. It keeps the terminal for the length of the verb and is
    // allowed to, because it owns every byte written while it is up (`cli/render.ts`).
    packAdd: () => createAddSurface(),
    packUpdate: () => createUpdateSurface(),
  };
}

import { rowsFor } from "@/lib/operator-scope";
import type { OperatorKeyRow } from "@/lib/types";

// The Keys tray's preset catalog: the labelled, canned chords under "Presets" — and, when the
// operator has declared any for this pane, THEIR rows instead (their `keys.toml`, ADR 0018).
//
// The tray is two things, and they have different owners. The PAD (Esc, the arrows, Enter/Tab/Space,
// the modifiers) is a board of cells kept per device (`lib/key-board.ts`, ADR 0092): it starts as
// today's pad and the person holding the phone may rearrange it. The CATALOG below is a convenience
// list that the OPERATOR owns, so it is theirs to replace, for every phone, from `keys.toml`.

/** One preset button: what it says, what it sends, and whether it needs a second tap. */
export interface CtrlDef {
  label: string;
  keys: string[];
  danger?: boolean;
}

/** The shipped presets — the six Ctrl chords worth a labelled button on a phone. */
export const CONTROL_PRESETS: readonly CtrlDef[] = [
  { label: "Ctrl C", keys: ["ctrl+c"] },
  { label: "Ctrl D", keys: ["ctrl+d"], danger: true },
  { label: "Ctrl U", keys: ["ctrl+u"] },
  { label: "Ctrl R", keys: ["ctrl+r"] },
  { label: "Ctrl L", keys: ["ctrl+l"] },
  { label: "Ctrl Z", keys: ["ctrl+z"], danger: true },
];

/**
 * Presets for a Herdr-detected agent (`pane.agent`) — the operator's own `keys.toml` rows if any of
 * them address this pane, otherwise the shipped six. REPLACE, never merge (ADR 0018): a pane your
 * rows reach shows your rows and nothing else, and a pane none of them reach is untouched.
 *
 * Unlike the command palette there is nothing to inherit here — a chord is not a shipped row that
 * could lend its danger classification, so `danger` is exactly what the operator wrote.
 */
export function ctrlPresetsFor(
  agent: string | undefined | null,
  mine: readonly OperatorKeyRow[] = [],
  shipped: readonly CtrlDef[] = CONTROL_PRESETS,
): readonly CtrlDef[] {
  const aimed = rowsFor(mine, agent, (row) => row.label);
  if (aimed.length === 0) return shipped;
  return aimed.map((row) => ({ label: row.label, keys: row.keys, danger: row.danger }));
}

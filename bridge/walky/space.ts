// The space of a pane, and its key (M98 spec 01). A space is the multiplexer's own grouping of panes
// (a Herdr workspace, a tmux or zellij session, a herdr-core document), the border of a walky talky
// message. The key is the space's RAW name from the multiplexer: never the operator's display override
// (operator-space-labels.ts), which is a phone-side label. A space with no name of its own is unnamed;
// its key carries the machine and the space id, so it is a space on that one machine and never joins one
// elsewhere. Which spaces are named is the adapter's fact (`MuxPane.spaceNamed`); this file only reads it.
// Nothing here enforces a border yet.

/** A pane's space as walky talky compares it. `label` is for words (the envelope, the `who` column). */
export interface WalkySpace {
  /** The comparison key: the NFC-trimmed name when named, else `<member id>\u0000<space id>`. */
  readonly key: string;
  /** False when the space has no name of its own: it never joins a space on another machine. */
  readonly named: boolean;
  /** The NFC-trimmed raw label, or the space id when the label is empty. */
  readonly label: string;
}

/** What a pane says of its space: `AgentView.workspaceId`, `workspaceLabel` and `workspaceNamed` under the member's id. */
export interface SpaceFacts {
  readonly memberId: string;
  readonly spaceId: string;
  readonly spaceLabel: string;
  /** The adapter's word. Absent (an older member, an adapter that says nothing): `spaceLabel !== spaceId`. */
  readonly spaceNamed?: boolean | undefined;
}

/** The separator of an unnamed key. A named label never holds it, so the two kinds of key never meet. */
const UNNAMED_SEPARATOR = "\u0000";

/** Whether a space is named, given the adapter's word or, when it gave none, the default. */
export function spaceNamedOf(pane: { readonly workspaceId: string; readonly workspaceLabel: string; readonly workspaceNamed?: boolean | undefined }): boolean {
  return pane.workspaceNamed ?? pane.workspaceLabel !== pane.workspaceId;
}

/** The space of one pane on member `memberId`. */
export function spaceOf(facts: SpaceFacts): WalkySpace {
  const label = facts.spaceLabel.normalize("NFC").trim();
  const claimed = facts.spaceNamed ?? facts.spaceLabel !== facts.spaceId;
  // A label that is empty after the trim is no name, and neither is one holding the separator.
  const named = claimed && label !== "" && !label.includes(UNNAMED_SEPARATOR);
  if (named) return { key: label, named: true, label };
  return { key: `${facts.memberId}${UNNAMED_SEPARATOR}${facts.spaceId}`, named: false, label: label === "" ? facts.spaceId : label };
}

/**
 * The space of a pane as the wire carries it, under the member that owns it. A body from another
 * machine may lack a field (an older member): `String(x ?? "")` reads it as empty, never throws. The
 * merge keeps `workspaceNamed` only as a boolean (crew/merge.ts `untagPane`).
 */
export function spaceOfPane(memberId: string, pane: { readonly workspaceId: string; readonly workspaceLabel: string; readonly workspaceNamed?: boolean | undefined }): WalkySpace {
  return spaceOf({ memberId, spaceId: String(pane.workspaceId ?? ""), spaceLabel: String(pane.workspaceLabel ?? ""), spaceNamed: pane.workspaceNamed });
}

/** Whether two panes are in one space: their keys are equal, exactly. */
export function sameSpace(a: WalkySpace, b: WalkySpace): boolean {
  return a.key === b.key;
}

// The agent's own statusline and its background-agents block, re-surfaced as app chrome under the
// mirror (or the chat) and above the chrome block. Port of the statusline strip in
// web/src/components/agent-chat.tsx and of web/src/components/agents-footer.tsx.
//
// THE DATA is the harness adapter's, read-only: `extractStatusLines` and `extractAgentsFooter` in
// web/src/lib/harness (the same adapter whose `buildBlocks` strips these rows off the mirror, so the
// two cannot drift). The pane route derives both once per screen text and passes the rows in.
//
// BOTH WEAR THE MIRROR'S COLOUR SPACE: the agent picked its colours against a near-black ground, so
// the strip is dark space and inverts in light with the mirror (ADR 0002). A native-mirror agent's
// strip stands on the native ground and is not inverted (ADR 0047). The footer is always dark space,
// as web's is.
//
// STACKED, one row per line, each truncated; the strip caps at 18dvh and scrolls past that, so a tall
// statusline never eats the mirror with the keyboard up. Rows are a positional snapshot of the pane
// tail, re-derived each poll, so they are keyed by index.
//
// THE FOOTER is one row until tapped: the first agent with a `+N` for the rest. A first row led by
// "●" is the "main" header, so the folded row shows the agent under it. The extra rows arrive
// through `Collapse` (REMIX3.md rule 7); web draws them bare. No new UI string: the button's name is
// the agent row itself, and `aria-expanded` carries the state.
import { on, type Handle, type RemixNode } from "remix/component";
import { ChevronDown } from "lucide";

import type { StyledLine } from "@web/lib/blocks";
import { cn } from "@web/lib/utils";

import { cellStyle } from "../../screen/rows";
import { MIRROR_INVERT, MIRROR_SPACE, MUSE_MIRROR } from "../../screen/screen";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";

/** web's StatusLine/AgentsFooter text size and padding, shared by both bands. */
const BAND = "border-t border-border/40 px-3 py-1 font-mono text-[11px] leading-tight";

function face(family: string | undefined): { fontFamily: string } | undefined {
  return family === undefined ? undefined : { fontFamily: family };
}

function StyledRow(handle: Handle<{ row: StyledLine; class?: string }>) {
  return () => {
    const { row } = handle.props;
    return (
      <div class={cn("truncate", handle.props.class)}>
        {row.segments.map((s, i) => (
          // Text nodes only; colour and weight come from the ANSI parse. Same XSS boundary as the mirror.
          <span key={String(i)} style={cellStyle(s)} class={s.mobileTransparentBg ? "terminal-mobile-transparent-bg" : undefined}>
            {s.text}
          </span>
        ))}
      </div>
    );
  };
}

/**
 * The statusline's rows alone: what the strip draws in the browser, and what the bridge renders as the
 * `pane-status` frame's fragment (routes/pane/frames.ts). Positional, so no key: a status row is a
 * slot in the pane's tail, re-derived each read, and the HTML diff pairs rows by position.
 */
export function StatusRows(handle: Handle<{ rows: readonly StyledLine[] }>) {
  return () => handle.props.rows.map((row, i) => <StyledRow key={String(i)} row={row} />);
}

export interface StatusStripProps {
  rows: readonly StyledLine[];
  /** The rows come from the `pane-status` server frame instead: this `<Frame>` stands in their place. */
  frame?: RemixNode;
  /** A native-mirror agent (ADR 0047): native ground, no inversion. */
  native: boolean;
  faceClass?: string;
  faceFamily?: string;
}

export function StatusStrip(handle: Handle<StatusStripProps>) {
  return () => {
    const { rows, frame, native, faceClass, faceFamily } = handle.props;
    return (
      <div
        data-slot="statusline"
        data-testid="statusline"
        class={cn("max-h-[18dvh] overflow-y-auto overscroll-contain", BAND, native ? MUSE_MIRROR : MIRROR_SPACE, native ? null : MIRROR_INVERT, faceClass)}
        style={face(faceFamily)}
      >
        {frame === undefined ? <StatusRows rows={rows} /> : frame}
      </div>
    );
  };
}

function isHeader(row: StyledLine): boolean {
  return row.segments
    .map((s) => s.text)
    .join("")
    .trimStart()
    .startsWith("●");
}

export interface AgentsFooterProps {
  rows: readonly StyledLine[];
  faceClass?: string;
  faceFamily?: string;
}

export function AgentsFooter(handle: Handle<AgentsFooterProps>) {
  let open = false;
  return () => {
    const { rows, faceClass, faceFamily } = handle.props;
    const first = rows[0];
    if (first === undefined) return null;
    const agents = rows.length > 1 && isHeader(first) ? rows.slice(1) : rows;
    const more = agents.length - 1;
    return (
      <div data-slot="agents-footer" data-testid="agents-footer" class={cn(BAND, MIRROR_SPACE, MIRROR_INVERT, faceClass)} style={face(faceFamily)}>
        <button
          type="button"
          aria-expanded={open}
          data-testid="agents-footer-toggle"
          class="flex w-full min-w-0 items-center gap-2 text-left"
          mix={on("click", () => {
            open = !open;
            void handle.update();
          })}
        >
          <StyledRow row={open ? first : (agents[0] ?? first)} class="min-w-0 flex-1" />
          {!open && more > 0 ? <span class="shrink-0 text-[#a3a3a3]">+{more}</span> : null}
          <Icon icon={ChevronDown} class={cn("size-3 shrink-0 text-[#a3a3a3] transition-transform", open && "rotate-180")} />
        </button>
        <Collapse open={open}>
          <div>
            {rows.slice(1).map((row, i) => (
              <StyledRow key={String(i)} row={row} />
            ))}
          </div>
        </Collapse>
      </div>
    );
  };
}

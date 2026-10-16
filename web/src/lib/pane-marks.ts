import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";
import { t } from "@/lib/i18n";
import type { AgentView } from "@/lib/types";

// A DURABLE PANE'S SUBTITLE AND BADGE, read from a body that may have crossed a crew link.
//
// The bridge cleaned and capped both (WIRE.md 7.11), but a peer's pane arrives as the peer sent it,
// so a field of the wrong shape reads as absent here and a pane is never drawn from half a shape.
// Text only, never markup: both strings came from a program.

/** The pane's subtitle, or null when it carries none. */
export function paneSubtitle(pane: Pick<AgentView, "subtitle">): string | null {
  const text = asJsonString(pane.subtitle)?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * The pane's badge as the text the chip draws, or null when there is nothing to draw. A count of zero is
 * the same as no mark, so a program that counts open questions need not clear it. Anything that is not
 * exactly one of `{ count }` with a whole number from 1 to 9999, or `{ text }` with a non-empty string,
 * reads as absent.
 */
export function paneBadge(pane: Pick<AgentView, "badge">): string | null {
  const badge = asJsonObject(pane.badge);
  if (badge === undefined) return null;
  const count = asJsonNumber(badge.count);
  const text = asJsonString(badge.text)?.trim();
  // Exactly one key, as the adapter keeps it; both is a bad shape.
  if (badge.count !== undefined && badge.text !== undefined) return null;
  if (count !== undefined) return Number.isInteger(count) && count >= 1 && count <= 9999 ? String(count) : null;
  return text === undefined || text === "" ? null : text;
}

/** What the progress row and the card's bar draw. `value` is the fill, 0 to 100. */
export type ProgressReading =
  | { kind: "steps"; label: string; n: number; m: number; value: number }
  | { kind: "percent"; label: string | null; value: number };

/**
 * The pane's progress as something to draw, or null when there is nothing to draw. Only a pane that works
 * or waits (`working`, `blocked`) shows one: the program owns clearing it, and an idle pane that still
 * carries one is a pane that finished. A step list reads as the running step, else the first step still to
 * do, else the last step, with its place in the list. Anything the bridge would not have kept (an unknown
 * kind, a bad step, a value outside 0 to 100) reads as absent, because a crew peer's body is not checked
 * on the way here.
 */
export function paneProgress(pane: Pick<AgentView, "progress" | "status">): ProgressReading | null {
  if (pane.status !== "working" && pane.status !== "blocked") return null;
  const progress = asJsonObject(pane.progress);
  if (progress === undefined) return null;
  const kind = asJsonString(progress.kind);
  if (kind === "percent") {
    const value = asJsonNumber(progress.value);
    if (value === undefined || value < 0 || value > 100) return null;
    const label = asJsonString(progress.label)?.trim();
    return { kind: "percent", label: label === undefined || label === "" ? null : label, value };
  }
  if (kind !== "steps") return null;
  const list: JsonValue | undefined = progress.steps;
  if (!Array.isArray(list) || list.length === 0) return null;
  const steps: { label: string; state: string }[] = [];
  for (const entry of list) {
    const step = asJsonObject(entry);
    const label = asJsonString(step?.label)?.trim();
    const state = asJsonString(step?.state);
    if (label === undefined || label === "" || (state !== "done" && state !== "running" && state !== "todo")) return null;
    steps.push({ label, state });
  }
  const running = steps.findIndex((step) => step.state === "running");
  const todo = steps.findIndex((step) => step.state === "todo");
  const at = running >= 0 ? running : todo >= 0 ? todo : steps.length - 1;
  // THE TEXT AND THE BAR (WIRE.md 7.12, M53 spec 12). "Step n of m" names the step that runs, and the bar
  // fills by the steps that are done, done / m. The two agree while one step runs, and a list with every
  // step done fills to full.
  const done = steps.filter((step) => step.state === "done").length;
  return { kind: "steps", label: steps[at]?.label ?? "", n: at + 1, m: steps.length, value: (done / steps.length) * 100 };
}

/**
 * The pane header's second line (M53 spec 12): the running step as "Step 2 of 3: write a note" while
 * the progress is a step list, "42%: label" while it is a percent, else the program's subtitle. A step
 * list with every step done names no step to come, so it gives the line back to the subtitle. Null when
 * the pane carries none of these, so the header keeps the line it draws for every other pane.
 */
export function paneHeaderLine(progress: ProgressReading | null, subtitle: string | null): string | null {
  // `value` is done / m, so 100 is exactly "every step is done".
  if (progress?.kind === "steps" && progress.value < 100) {
    return t("chat.header.step", { n: progress.n, m: progress.m, label: progress.label });
  }
  if (progress?.kind === "steps") return subtitle;
  if (progress?.kind === "percent") {
    const value = Math.round(progress.value);
    return progress.label === null ? t("chat.progress.percent", { value }) : t("chat.header.percent", { value, label: progress.label });
  }
  return subtitle;
}

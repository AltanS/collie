// Grok plan-approval screen — a `╭─ plan.md` preview above a still-visible composer, driven by
// the keys its own tail footer printed (`a:approve`, `q:quit plan`, …). Generic `menu` contract:
// only named keys, never a digit (ADR 0009). A footer without the captured preview+composer
// geometry is not a plan review. Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { MenuAction, MenuModel } from "../menu-model";
import { capitaliseMenuLabel, menuKeyFor } from "../menu-hints";
import { composerStatus, isComposerTop, lastNonBlankIndex, lineText, regionSignature, rstrip } from "./markers";

export interface PlanMenuRegion {
  model: MenuModel;
  startLine: number;
}

const FOOTER_APPROVE = /(?:^|\s)a:approve(?:\s|$)/i;
const FOOTER_QUIT = /q:quit plan/i;
const HINT_SPLIT = /\s+│\s+/;
const HINT = /^(.+?):(.+)$/;
const PLAN_PREVIEW_TOP = /^\s*╭─+\s+\S/;

function parseGrokKeyFooter(line: string): MenuAction[] {
  const actions: MenuAction[] = [];
  for (const part of rstrip(line).split(HINT_SPLIT)) {
    const m = HINT.exec(part.trim());
    if (!m) continue;
    const key = menuKeyFor(m[1]!);
    if (key === null) continue;
    const verb = m[2]!.trim();
    if (/always-approve/i.test(verb)) continue;
    actions.push({
      label: capitaliseMenuLabel(verb),
      keys: [key],
      cancel: key === "q" || key === "Escape" || key === "ctrl+c",
    });
  }
  return actions;
}

/** Plan-approval menu at the tail, or null. */
export function detectPlanMenuRegion(lines: StyledLine[]): PlanMenuRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;
  const footer = texts[fi]!;
  // Idle review names `q:quit plan`. Tab/`s` into the composer drops that and paints
  // `Tab:plan` / `Esc:back` instead — still plan approval (status + preview required below).
  if (!FOOTER_APPROVE.test(footer)) return null;
  if (!FOOTER_QUIT.test(footer) && !/Tab:plan/i.test(footer) && !/Esc:back/i.test(footer)) {
    return null;
  }

  const actions = parseGrokKeyFooter(footer);
  if (actions.length === 0) return null;

  let composerBottom = -1;
  let start = -1;
  for (let i = fi - 1; i >= 0; i--) {
    const t = texts[i]!;
    const status = composerStatus(t);
    if (status !== null && /plan approval/i.test(status)) {
      composerBottom = i;
      continue;
    }
    if (composerBottom >= 0 && PLAN_PREVIEW_TOP.test(t) && !isComposerTop(t)) {
      start = i;
      break;
    }
  }
  if (start < 0 || composerBottom < 0) return null;

  const signature = regionSignature(lines, start, fi + 1);
  if (signature === "") return null;

  const model: MenuModel = {
    title: "Plan approval",
    actions,
    nav: { upDown: false },
    signature,
  };
  return { startLine: start, model };
}

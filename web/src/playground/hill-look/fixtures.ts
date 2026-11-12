// The fixtures of the "Hill look" section (M96 design round, 2026-11-09): four cases every option
// draws, so the options compare on the same data. DEV-ONLY, like the rest of `src/playground/`.
//
// The senders are "collie lead" (Claude, lodge), "m96-hill" (Codex, workshop) and the "Browser leg"
// trick; the tricks are the ones the trick sections already use, plus a few more for the busy strip.
// No person's name, no private path. Ages are anchored to this module's load.

import type { HillDecision, HillMedia, HillPriority } from "@/lib/hill/wire";
import { sortOpenDecisions } from "@/lib/hill/wire";
import type { Tone, TrickIcon } from "@/lib/tricks/schema";

import { closedRows } from "../fixtures/hill/decisions";

const NOW = Date.now();
const MIN = 60_000;

type Sender = { kind: "agent"; label: string; host: string; harness: string } | { kind: "trick"; label: string; trickId: string; icon: TrickIcon };

export const LEAD: Sender = { kind: "agent", label: "collie lead", host: "lodge", harness: "claude" };
export const HILL: Sender = { kind: "agent", label: "m96-hill", host: "workshop", harness: "codex" };
export const LEGS: Sender = { kind: "trick", label: "Browser leg", trickId: "legs", icon: "flask" };

/** The icon word of a trick sender, by trick id. A Decision names its trick by id; the strip knows the icon. */
export const TRICK_ICON_OF: ReadonlyMap<string, TrickIcon> = new Map([["legs", "flask"]]);

/** The host colour slot per machine, as `lib/hosts.ts` would assign it on this crew. */
export const HOST_SLOT: ReadonlyMap<string, number> = new Map([
  ["lodge", 2],
  ["workshop", 6],
]);

let next = 0;
function id(): string {
  next += 1;
  return `dc_hl00look${String(next).padStart(4, "0")}`.slice(0, 15);
}

type Fixture = Partial<HillDecision> & Pick<HillDecision, "title" | "summary"> & { sender?: Sender; ago?: number; prio?: HillPriority };

function decision(over: Fixture): HillDecision {
  const { sender = LEAD, ago = 2, prio = "today", ...rest } = over;
  const did = id();
  const from: HillDecision["from"] =
    sender.kind === "agent"
      ? { kind: "agent", address: `wt_${did.slice(3, 15)}`, trickId: null, trickKey: null, memberId: null, harness: sender.harness, label: sender.label, host: sender.host, trickHost: null }
      : { kind: "trick", address: null, trickId: sender.trickId, trickKey: did, memberId: null, harness: null, label: sender.label, host: "lodge", trickHost: "lodge" };
  return {
    v: 1,
    id: did,
    requestId: `0b6f2c1e-4a7d-4c1b-9e2f-${did.slice(-12).padStart(12, "0")}`,
    from,
    about: null,
    priority: prio,
    priorityAsked: prio,
    body: "",
    options: [],
    text: "optional",
    recommends: null,
    media: [],
    links: [],
    replyTo: null,
    target: sender.kind === "agent" ? { label: sender.label, host: sender.host, unattended: false } : null,
    supersedes: null,
    supersededBy: null,
    expiresAt: null,
    at: NOW - ago * MIN,
    state: "open",
    closedAt: null,
    closedReason: null,
    answer: null,
    ...rest,
  };
}

function shot(mediaId: string, caption?: string): HillMedia {
  const media: HillMedia = { id: mediaId, kind: "image", mime: "image/png", bytes: 1800, width: 600, height: 360 };
  return caption === undefined ? media : { ...media, caption };
}

const zoom = decision({
  title: "Ship the zoom fix in 1.28.1?",
  summary: "The fix is on main and its unit tests pass. The browser leg has not run on it yet.",
  prio: "now",
  ago: 3,
  options: [
    { intent: "yes", label: "Yes, Edge first" },
    { intent: "no", label: "Not yet" },
  ],
  recommends: { intent: "yes", why: "Edge reaches the testers first, and Stable follows a day later." },
  body: "What ships:\n\n- The pill leaves the Chat belt.\n- The Dashboard keeps its own pill.",
});

const reset = decision({
  title: "Reset the deputy's checkout?",
  summary: "The checkout on workshop is two commits ahead of main and the build fails there.",
  sender: HILL,
  ago: 6,
  options: [
    { intent: "keep", label: "Keep it as it is" },
    { intent: "stash", label: "Stash the two commits", detail: "They stay on a branch named after today." },
    { intent: "reset", label: "Reset to main", detail: "Drops the two local commits.", confirm: "Reset now" },
  ],
});

const legsRerun = decision({
  title: "Re-run case 24 live?",
  summary: "It went red twice on replay. A live run costs about two cents of model turns.",
  sender: LEGS,
  ago: 8,
  options: [
    { intent: "live", label: "Run it live" },
    { intent: "skip", label: "Skip for now" },
  ],
  recommends: { intent: "live", why: "Two reds in a row on replay usually mean the recording is stale." },
});

const base = decision({
  title: "Which base for the hill branch?",
  summary: "Both build. Pick one, and say in a line why, so the pull request can quote it.",
  sender: HILL,
  ago: 12,
  options: [
    { intent: "main", label: "main" },
    { intent: "release", label: "release-1.28" },
  ],
  text: "required",
});

const merge = decision({
  title: "Merge the hill bridge branch?",
  summary: "Review is done and CI is green. One question is left open in the thread.",
  ago: 18,
  body: "The open question is whether a `gone` answer should **also** post a walky line.",
  links: [{ label: "CI run 4821", href: "https://ci.example.com/runs/4821" }],
  options: [
    { intent: "merge", label: "Merge it" },
    { intent: "wait", label: "Wait for the thread" },
  ],
});

const legsWatch = decision({
  title: "Keep watching the legs overnight?",
  summary: "Three runs are queued. I post here only if one goes red.",
  sender: LEGS,
  ago: 22,
  options: [
    { intent: "yes", label: "Keep watching" },
    { intent: "no", label: "Stop" },
  ],
});

const leg = decision({
  title: "Run the full browser leg now?",
  summary: "It takes about 30 minutes and replays the recorded sessions. Nothing else is queued.",
  ago: 30,
  options: [
    { intent: "run", label: "Run it now" },
    { intent: "tonight", label: "Tonight" },
  ],
  target: { label: "collie lead", host: "lodge", unattended: true },
});

const rename = decision({
  title: "Rename the member on workshop?",
  summary: "Its id still says the old name. The new one would be workshop-hc.",
  sender: HILL,
  ago: 41,
  options: [
    { intent: "rename", label: "Rename it" },
    { intent: "keep", label: "Keep the old id" },
  ],
});

const newsletter = decision({
  title: "What should the newsletter lead with?",
  summary: "Two drafts are ready. Tell me the opening line you want and I write the rest.",
  ago: 55,
  prio: "later",
  text: "required",
});

const close748 = decision({
  title: "Close issue 748 after the next Edge build?",
  summary: "The fix is in. The reporter can reopen it if it comes back.",
  ago: 120,
  prio: "later",
  options: [
    { intent: "close", label: "Close it" },
    { intent: "keep", label: "Keep it open" },
  ],
  text: "none",
});

const legsBudget = decision({
  title: "Raise the nightly budget to $1?",
  summary: "The core legs doubled the run. At $0.65 the last case does not fit.",
  sender: LEGS,
  ago: 150,
  prio: "later",
  options: [
    { intent: "raise", label: "Raise to $1" },
    { intent: "keep", label: "Keep $0.65" },
  ],
});

const theme = decision({
  title: "Keep Harbour's grain on the band?",
  summary: "The contrast gate passes, by 0.02. Flat would pass by 0.3.",
  sender: HILL,
  ago: 190,
  prio: "later",
  options: [
    { intent: "grain", label: "Keep the grain" },
    { intent: "flat", label: "Go flat" },
  ],
});

/** Case d: two images, a recommendation, a two-tap confirm, a written answer required. */
export const rich = decision({
  title: "Which header for the Hill?",
  summary: "Two shots of the header on a 390 px phone. Pick one and say why, so the pull request can quote you.",
  sender: HILL,
  ago: 4,
  prio: "now",
  media: [shot("im_pgbefore00000001", "Before"), shot("im_pgafter000000001", "After")],
  options: [
    { intent: "after", label: "The new one" },
    { intent: "before", label: "Keep the old one" },
    { intent: "drop", label: "Drop the header change", detail: "Reverts both commits on the branch.", confirm: "Drop it" },
  ],
  recommends: { intent: "after", why: "The mark reads at a glance, and the count no longer wraps at 390 px." },
  text: "required",
  body: "Both shots are from the dev lane on 8788, light theme.",
});

/** One trick on the strip: its icon, a short name, and an optional count in a tone. */
export interface StripTrick {
  id: string;
  name: string;
  icon: TrickIcon;
  count?: string;
  tone?: Tone;
}

const TRICKS: readonly StripTrick[] = [
  { id: "legs", name: "Legs", icon: "flask", count: "23/34", tone: "accent" },
  { id: "tracker", name: "Tracker", icon: "file", count: "M96" },
  { id: "triage", name: "Triage", icon: "eye", count: "3", tone: "warn" },
  { id: "spend", name: "Spend", icon: "tag", count: "$7.42" },
  { id: "deploy", name: "Deploy", icon: "play", tone: "ok", count: "green" },
  { id: "quiet", name: "Quiet", icon: "bell" },
  { id: "notes", name: "Notes", icon: "note" },
  { id: "crew", name: "Crew", icon: "crew", count: "2" },
  { id: "search", name: "Search", icon: "search" },
];

export type CaseId = "quiet" | "busy" | "empty" | "rich";

export const CASES: readonly { value: CaseId; label: string }[] = [
  { value: "quiet", label: "a quiet" },
  { value: "busy", label: "b busy" },
  { value: "empty", label: "c empty" },
  { value: "rich", label: "d rich" },
];

export interface HillCase {
  /** Open Decisions, most urgent first. */
  open: readonly HillDecision[];
  closed: readonly HillDecision[];
  tricks: readonly StripTrick[];
}

export const CASE_DATA = {
  quiet: { open: [zoom], closed: closedRows.slice(0, 3), tricks: TRICKS.slice(0, 2) },
  busy: {
    open: sortOpenDecisions([theme, legsBudget, close748, newsletter, rename, leg, legsWatch, merge, base, legsRerun, reset, zoom]),
    closed: closedRows,
    tricks: TRICKS,
  },
  empty: { open: [], closed: closedRows, tricks: TRICKS.slice(0, 3) },
  rich: { open: [rich], closed: closedRows.slice(0, 2), tricks: TRICKS.slice(0, 2) },
} as const satisfies Record<CaseId, HillCase>;

export function isCaseId(word: string | null): word is CaseId {
  return CASES.some((c) => c.value === word);
}

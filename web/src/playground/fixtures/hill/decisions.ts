// The hill's fixtures for the states playground (M96): Decisions shaped by the wire types
// (`lib/hill/wire.ts`), the closed rows the Answered fold lists, and one receipt per card state.
// DEV-ONLY, like the rest of `src/playground/`. The sentences are the contract's own examples; the
// senders are "collie lead", "m96-hill" and "website", the machines "bluefin" and "minibuch". No
// person's name, no private path. The ages are anchored to this module's load, so a card reads
// "2 min" when the page opens.

import type { HillMediaSource } from "@/components/hill-media";
import type { HillDecision, HillMedia, HillReceipt } from "@/lib/hill/wire";

// Three flat colour panels with a word on them, made for this page (never a capture of anyone's
// screen), inlined as data URLs: the page has no bridge, and a data URL needs no token.
import shotAfter from "./shot-2.png?inline";
import shotBefore from "./shot-1.png?inline";
import shotDiff from "./shot-3.png?inline";

const NOW = Date.now();
const MIN = 60_000;

const LEAD = { label: "collie lead", host: "bluefin" } as const;
const HILL = { label: "m96-hill", host: "minibuch" } as const;
const SITE = { label: "website", host: "bluefin" } as const;

let next = 0;
/** A decision id of the contract's shape, unique per fixture. */
function id(): string {
  next += 1;
  return `dc_k3m9x2p7q${String(next).padStart(3, "0")}`;
}

/** What a fixture says: the fields it sets, who sent it and how many minutes ago. */
type Fixture = Partial<HillDecision> & Pick<HillDecision, "title" | "summary"> & { sender?: { label: string; host: string | null }; ago?: number };

/** A whole decision with the fields a fixture leaves out filled in. */
function decision(over: Fixture): HillDecision {
  const { sender = LEAD, ago = 2, ...rest } = over;
  const did = id();
  return {
    v: 1,
    id: did,
    requestId: `0b6f2c1e-4a7d-4c1b-9e2f-${did.slice(-12)}`,
    from: { kind: "agent", address: `wt_${did.slice(3, 15)}`, trickId: null, trickKey: null, memberId: null, harness: "claude", label: sender.label, host: sender.host, trickHost: null },
    about: null,
    priority: "today",
    priorityAsked: "today",
    body: "",
    options: [],
    text: "optional",
    recommends: null,
    media: [],
    links: [],
    replyTo: null,
    target: { label: sender.label, host: sender.host, unattended: false },
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

/** 1: an agent with two options and a recommendation. The contract's own example. */
export const twoOptions = decision({
  title: "Ship the zoom fix in 1.28.1?",
  summary: "The fix is on main and its unit tests pass. The browser leg has not run on it yet.",
  priority: "now",
  priorityAsked: "now",
  options: [
    { intent: "yes", label: "Yes, Edge first" },
    { intent: "no", label: "Not yet" },
  ],
  recommends: { intent: "yes", why: "Edge reaches the testers first, and Stable follows a day later." },
});

/** 2: three options, the last one with a confirm. */
export const threeWithConfirm = decision({
  title: "Reset the deputy's checkout?",
  summary: "The checkout on minibuch is two commits ahead of main and the build fails there.",
  sender: HILL,
  ago: 6,
  options: [
    { intent: "keep", label: "Keep it as it is" },
    { intent: "stash", label: "Stash the two commits", detail: "They stay on a branch named after today." },
    { intent: "reset", label: "Reset to main", detail: "Drops the two local commits.", confirm: "Reset now" },
  ],
});

/** 3: text only, no options. */
export const textOnly = decision({
  title: "What should the newsletter lead with?",
  summary: "Two drafts are ready. Tell me the opening line you want and I write the rest.",
  sender: SITE,
  ago: 25,
  priority: "later",
  priorityAsked: "later",
  text: "required",
});

/** 4: two options, and a written answer required with either. */
export const textRequired = decision({
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

/** 5: a body in Markdown and two links behind More. */
export const withBody = decision({
  title: "Merge the hill bridge branch?",
  summary: "Review is done and CI is green. One question is left open in the thread.",
  ago: 40,
  body: [
    "What changes when it merges:",
    "",
    "- `POST /api/hill/answer` takes answers from a phone.",
    "- The snapshot gains `hillRev`.",
    "",
    "The open question is whether a `gone` answer should **also** post a walky line.",
  ].join("\n"),
  links: [
    { label: "The crew docs", href: "https://colliepwa.dev/docs/crew" },
    { label: "CI run 4821", href: "https://ci.example.com/runs/4821" },
  ],
  options: [
    { intent: "merge", label: "Merge it" },
    { intent: "wait", label: "Wait for the thread" },
  ],
});

/** 6: the answer goes to a session that runs without prompts. */
export const unattended = decision({
  title: "Run the full browser leg now?",
  summary: "It takes about 30 minutes and replays the recorded sessions. Nothing else is queued.",
  ago: 3,
  priority: "now",
  priorityAsked: "now",
  options: [
    { intent: "run", label: "Run it now" },
    { intent: "tonight", label: "Tonight" },
  ],
  target: { label: "m96-hill", host: "minibuch", unattended: true },
});

/** 7: a quiet one, for the view's later end. */
export const later = decision({
  title: "Close issue 748 after the next Edge build?",
  summary: "The fix is in. The reporter can reopen it if it comes back.",
  sender: SITE,
  ago: 180,
  priority: "later",
  priorityAsked: "later",
  options: [
    { intent: "close", label: "Close it" },
    { intent: "keep", label: "Keep it open" },
  ],
  text: "none",
});

/** A decision a trick posted: the poster is the trick, not a session, and its answer goes nowhere else. */
const LOOK_FROM = { kind: "trick", address: null, trickId: "look", trickKey: "ship-zoom", memberId: null, harness: null, label: "Look", host: null, trickHost: null } as const;

/** 26: a trick's decision with no target. The trick takes the answer itself. */
export const trickOpen = decision({
  title: "Ship the zoom fix in 1.28.1?",
  summary: "Look watched the legs go green on the last three runs.",
  ago: 5,
  from: LOOK_FROM,
  target: null,
  options: [
    { intent: "yes", label: "Yes, Edge first" },
    { intent: "no", label: "Not yet" },
  ],
});

/**
 * A drawn phone screen, 390 x 844, as an SVG data URL: a title bar, a few grey text lines, two panels
 * and three option rows, in flat colours. Made for this page (never a capture of anyone's screen); its
 * shape is a phone screenshot's, which is what the strip must keep readable.
 */
function phoneScreen(word: string, panel: string): string {
  const lines = [148, 168, 188].map((y, i) => `<rect x="24" y="${y}" width="${[300, 260, 180][i]}" height="8" rx="2" fill="#8a8f98"/>`).join("");
  const rows = [560, 620, 680].map((y) => `<rect x="20" y="${y}" width="350" height="48" rx="2" fill="none" stroke="#5b616b" stroke-width="2"/>`).join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">`,
    `<rect width="390" height="844" fill="#1d1f23"/>`,
    `<rect x="24" y="96" width="250" height="22" rx="2" fill="#e8e9eb"/>`,
    lines,
    `<rect x="24" y="230" width="200" height="140" rx="2" fill="${panel}"/>`,
    `<rect x="232" y="230" width="134" height="140" rx="2" fill="#b0652f"/>`,
    `<text x="124" y="306" font-family="sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">${word}</text>`,
    `<rect x="24" y="410" width="320" height="8" rx="2" fill="#8a8f98"/><rect x="24" y="430" width="240" height="8" rx="2" fill="#8a8f98"/>`,
    rows,
    `<rect x="20" y="760" width="350" height="56" rx="2" fill="#2a2d33"/>`,
    `</svg>`,
  ].join("");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const SHOTS = new Map<string, string>([
  ["im_pgbefore00000001", shotBefore],
  ["im_pgafter000000001", shotAfter],
  ["im_pgdiff0000000001", shotDiff],
  ["im_pgphoneoption001", phoneScreen("Option", "#2f7fb0")],
  ["im_pgphonebuild0001", phoneScreen("Build", "#2f9a6a")],
  ["im_pgphonewide00001", phoneScreen("Wide", "#7a4fb0")],
  // Bytes no browser decodes: the card's failed state.
  ["im_pgbroken00000001", "data:image/png;base64,AAAA"],
]);

/** Where the playground's images are: the inlined panels by media id. */
export const playgroundMedia: HillMediaSource = (_decision, media) => SHOTS.get(media.id) ?? "data:image/png;base64,AAAA";

function shot(mediaId: string, caption?: string, size: { width: number; height: number } = { width: 600, height: 360 }): HillMedia {
  const media: HillMedia = { id: mediaId, kind: "image", mime: "image/png", bytes: 1800, ...size };
  return caption === undefined ? media : { ...media, caption };
}

/** A phone screenshot's size, in CSS px: portrait. */
const PHONE = { width: 390, height: 844 } as const;

/** 22: one image under the summary. */
export const oneImage = decision({
  title: "Does the zoom pill read right now?",
  summary: "The pill moved out of the Chat belt. This is the card on a 390 px phone after the change.",
  ago: 4,
  options: [
    { intent: "yes", label: "Looks right" },
    { intent: "no", label: "Not yet" },
  ],
  recommends: { intent: "yes", why: "It matches the Dashboard's pill." },
  media: [shot("im_pgafter000000001", "The card after the change")],
});

/** 23: three images, side by side in one row that scrolls. */
export const threeImages = decision({
  title: "Which header for the Hill?",
  summary: "Three shots: the header before, after, and the two side by side.",
  sender: HILL,
  ago: 9,
  options: [
    { intent: "after", label: "The new one" },
    { intent: "before", label: "Keep the old one" },
  ],
  media: [shot("im_pgbefore00000001", "Before"), shot("im_pgafter000000001", "After"), shot("im_pgdiff0000000001", "Side by side")],
});

/** 24: an image that does not load. */
export const brokenImage = decision({
  title: "Is the release page right?",
  summary: "The screenshot could not be read back, so the card says so and the question still stands.",
  sender: SITE,
  ago: 15,
  options: [
    { intent: "yes", label: "Yes" },
    { intent: "no", label: "No" },
  ],
  media: [shot("im_pgbroken00000001")],
});

/** The Hill with seven cards, in any order: the view sorts them. */
export const sevenOpen: readonly HillDecision[] = [later, withBody, twoOptions, textOnly, threeWithConfirm, unattended, textRequired];

/** 28: everything a Decision can carry at once: images, a recommendation, a body, links, a confirm and a note. */
export const rich = decision({
  title: "Which header for the Hill?",
  summary: "Two shots of the header on a 390 px phone. Pick one and say why, so the pull request can quote you.",
  sender: HILL,
  ago: 3,
  priority: "now",
  priorityAsked: "now",
  options: [
    { intent: "after", label: "The new one" },
    { intent: "before", label: "Keep the old one" },
    { intent: "drop", label: "Drop the header change", detail: "Reverts both commits on the branch.", confirm: "Drop it" },
  ],
  recommends: { intent: "after", why: "The mark reads at a glance, and the count no longer wraps at 390 px." },
  media: [shot("im_pgbefore00000001", "Before"), shot("im_pgafter000000001", "After"), shot("im_pgdiff0000000001", "Side by side")],
  body: ["What moves:", "", "- The mountain mark sits left of the title.", "- The count line is always there."].join("\n"),
  links: [{ label: "CI run 4822", href: "https://ci.example.com/runs/4822" }],
});

/** The quiet Hill: two cards, one of each of the two upper priorities. */
export const quietOpen: readonly HillDecision[] = [twoOptions, threeWithConfirm];

/** The busy Hill: the seven cards and the rich one. */
export const busyOpen: readonly HillDecision[] = [...sevenOpen, rich];

function closed(over: Fixture & Pick<HillDecision, "state">, agoClosed: number): HillDecision {
  return decision({ ...over, ago: agoClosed + 10, closedAt: NOW - agoClosed * MIN });
}

/** The Answered fold: one row per closed state, newest first. */
export const closedRows: readonly HillDecision[] = [
  closed(
    {
      title: "Ship the theme fix in 1.28.0?",
      summary: "Answered from the phone.",
      state: "answered",
      options: [{ intent: "yes", label: "Yes, Edge first" }],
      answer: { rid: "6f1d2a4e-1b3c-4d5e-8f90-1a2b3c4d5e6f", intent: "yes", label: "Yes, Edge first", text: null, by: "phone", at: NOW - 4 * MIN, delivery: "typed", trick: "none" },
    },
    4,
  ),
  closed(
    {
      title: "Keep the legs watch on?",
      summary: "Answered from the phone, and the trick recorded it.",
      state: "answered",
      from: LOOK_FROM,
      target: null,
      options: [{ intent: "yes", label: "Yes" }],
      answer: { rid: "3a7c9e21-6b4d-4e8f-a1b2-0c9d8e7f6a5b", intent: "yes", label: "Yes", text: null, by: "phone", at: NOW - 8 * MIN, delivery: "none", trick: "ran" },
    },
    8,
  ),
  closed({ title: "Rebuild the deputy now?", summary: "Dismissed.", state: "dismissed", sender: HILL }, 20),
  closed({ title: "Post the release thread before noon?", summary: "Nobody answered in time.", state: "expired", sender: SITE }, 60),
  closed({ title: "Pause the nightly leg?", summary: "The poster took it back.", state: "withdrawn", closedReason: "by the poster" }, 90),
  closed({ title: "Which icon for the hill row?", summary: "A newer one replaced it.", state: "superseded", sender: SITE }, 120),
  closed(
    { title: "Rename the crew member on minibuch?", summary: "Its session ended.", state: "undeliverable", sender: HILL, closedReason: "target session ended" },
    150,
  ),
];

/** The words a person sent with an answer whose target had ended: the undeliverable row keeps them. */
export const keptWords = "Call it minibuch-hc, and keep the old name as an alias until 2.0.";

function receipt(code: HillReceipt["code"], delivery: HillReceipt["delivery"], reason: string | null = null): HillReceipt {
  return { rid: "2c9e7a10-5d4b-4f3a-9b8c-7d6e5f4a3b2c", code, reason, state: code === "ok" ? "answered" : null, delivery, trick: delivery === null ? null : "none", at: NOW };
}

/** One receipt per card state. */
export const receipts = {
  typed: receipt("ok", "typed"),
  held: receipt("ok", "held"),
  unknown: receipt("ok", "unknown"),
  rejected: receipt("rejected", null, "text is required"),
  gone: receipt("gone", null, "target session ended"),
  denied: receipt("denied", null),
} as const satisfies Record<string, HillReceipt>;

/** The answer a person typed before the target ended: the `gone` card keeps it with Copy. */
export const goneText = "Not before the browser leg is green.";

/** 32: a gate strip in the view (M96): seven gates as a bar of chips, and the two that need a look, with their proof. */
export const gateStrip = decision({
  title: "Tag 1.28.2 with the e2e gate red?",
  summary: "Six of the seven gates are green. The e2e gate failed once, on a timing budget.",
  sender: HILL,
  ago: 6,
  options: [
    { intent: "rerun", label: "Rerun e2e first" },
    { intent: "tag", label: "Tag it now", confirm: "Tag now" },
  ],
  recommends: { intent: "rerun", why: "The same case passed on the last two runs." },
  view: [
    {
      kind: "bar",
      kids: [
        { kind: "chip", text: "types", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "lint", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "unit", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "web", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "e2e", attrs: { tone: "danger", icon: "x" } },
        { kind: "chip", text: "legs", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "windows", attrs: { tone: "ok", icon: "check" } },
      ],
    },
    {
      kind: "list",
      kids: [
        { kind: "row", text: "e2e: pane glide", attrs: { tone: "danger", end: "1 of 18" }, kids: [{ kind: "para", text: "612 ms against a 400 ms budget" }] },
        { kind: "row", text: "legs", attrs: { end: "34 of 34" }, kids: [{ kind: "para", text: "replayed, no live turns" }] },
      ],
    },
    { kind: "para", kids: [{ kind: "run", text: "The run: " }, { kind: "link", text: "CI run 7731", attrs: { href: "https://github.com/AltanS/collie/actions" } }] },
  ],
});

/** 33: a diff summary in the view (M96): one row per file ending in its counts, and the one hunk worth reading. */
export const diffSummary = decision({
  title: "Merge the send path fix?",
  summary: "Three files change. The hunk below is the whole behaviour change; the rest is tests.",
  sender: LEAD,
  ago: 3,
  options: [
    { intent: "merge", label: "Merge it" },
    { intent: "wait", label: "Wait for the leg" },
  ],
  view: [
    {
      kind: "list",
      kids: [
        { kind: "row", text: "bridge/send/path.ts", attrs: { end: "+12 −3", cut: "mid" } },
        { kind: "row", text: "bridge/send/path.test.ts", attrs: { end: "+48 −0", cut: "mid" } },
        { kind: "row", text: "CHANGELOG.md", attrs: { end: "+1 −0", cut: "mid" } },
      ],
    },
    {
      kind: "code",
      attrs: { lang: "ts" },
      kids: [
        { kind: "line", kids: [{ kind: "run", text: "@@ -41,6 +41,9 @@ export function sendPath(", attrs: { style: "dim" } }] },
        { kind: "line", kids: [{ kind: "run", text: "   const pane = panes.get(id);" }] },
        { kind: "line", kids: [{ kind: "run", text: "-  if (!pane) return null;", attrs: { style: "fg-red" } }] },
        { kind: "line", kids: [{ kind: "run", text: "+  if (pane === undefined) {", attrs: { style: "fg-green" } }] },
        { kind: "line", kids: [{ kind: "run", text: "+    return { refused: \"gone\" };", attrs: { style: "fg-green" } }] },
        { kind: "line", kids: [{ kind: "run", text: "+  }", attrs: { style: "fg-green" } }] },
        { kind: "line", kids: [{ kind: "run", text: "   return pane.send(text);" }] },
      ],
    },
  ],
});

/** A collie tricks sender, as the owner's screenshot of 2026-11-10 shows it. */
const TRICKS = { label: "collie tricks", host: "bluefin" } as const;

/** A step chip that is done, with the words a poster gave it. */
function doneChip(text: string) {
  return { kind: "chip", text, attrs: { state: "done" } } as const;
}

/**
 * 34: the rough card (2026-11-10). The owner's screenshot, word for word: two portrait phone shots, a
 * bar of five word chips that are all done, and four rows with their proof at the end. At 360 px it
 * drew 55 px tiles with cut captions and chips cut to "s…" and "qu…".
 */
export const roughCard = decision({
  title: "Is this the card you chose?",
  summary:
    "This card uses every new part: a recommendation, priority Now, two images and a view. The two older cards below use none, so they look almost as before. Tap More to read the rest of this line.",
  sender: TRICKS,
  ago: 1,
  priority: "now",
  priorityAsked: "now",
  options: [
    { intent: "yes", label: "Yes, this is B1" },
    { intent: "change", label: "Change something" },
  ],
  recommends: { intent: "yes", why: "The build matches the B1 option in 15 states, measured." },
  media: [shot("im_pgphoneoption001", "The option you chose", PHONE), shot("im_pgphonebuild0001", "The build", PHONE)],
  view: [
    { kind: "bar", kids: [doneChip("star"), doneChip("quote"), doneChip("view"), doneChip("images"), doneChip("Now")] },
    {
      kind: "list",
      kids: [
        { kind: "row", text: "Recommendation", attrs: { end: "amber star" } },
        { kind: "row", text: "Priority Now", attrs: { end: "three peaks" } },
        { kind: "row", text: "This frame", attrs: { end: "a Decision view" } },
        { kind: "row", text: "Old cards", attrs: { end: "have none of these" } },
      ],
    },
  ],
});

/** 35: every kind a Decision's view draws, each with words as long as the schema lets them be, for the narrowest phone. */
export const stressCard = decision({
  title: "Does every part of a view read at 360 px?",
  summary: "Long words in every kind a view can draw.",
  sender: TRICKS,
  ago: 2,
  options: [{ intent: "ok", label: "It reads" }],
  media: [shot("im_pgphonewide00001", "One portrait shot may use the whole width of the card", PHONE)],
  view: [
    // The Tag trick's seven numbered gates: the step strip, one row.
    { kind: "bar", attrs: { label: "Gates" }, kids: ["1", "2", "3", "4", "5", "6", "7"].map(doneChip) },
    // Word steps: they wrap as chips.
    {
      kind: "bar",
      attrs: { label: "Steps" },
      kids: [
        doneChip("typecheck"),
        doneChip("lint"),
        { kind: "chip", text: "browser leg on the core", attrs: { state: "working", current: "" } },
        { kind: "chip", text: "windows rehearsal", attrs: { state: "idle" } },
        { kind: "chip", text: "tag", attrs: { state: "idle" } },
      ],
    },
    {
      kind: "list",
      kids: [
        { kind: "row", text: "A short title", attrs: { end: "an end that runs long" } },
        { kind: "row", text: "A row title that goes on for a while", attrs: { end: "the end words wrap too" } },
        { kind: "row", text: "web/src/components/decision-view.tsx", attrs: { end: "+120 −48", cut: "mid" } },
        { kind: "row", text: "Release notes", attrs: { href: "https://release-notes.downloads.colliepwa.example.com/1.28.2", end: "draft" } },
        { kind: "row", text: "Browser leg", attrs: { end: "34 of 34 green" }, kids: [{ kind: "para", text: "replayed from the recording, with no live turns spent" }] },
        { kind: "row", text: "Gate", attrs: { tone: "warn" }, kids: [{ kind: "chip", text: "waiting on review", attrs: { tone: "warn" } }] },
      ],
    },
    { kind: "number", text: "1,284", attrs: { label: "Lines changed in each package since 1.28", unit: "lines" } },
    { kind: "meter", attrs: { value: "0.62", label: "Replay budget the browser leg used today", role: "meter" } },
    {
      kind: "group",
      attrs: { label: "Folded: the three gates that passed with a warning", fold: "closed", badge: "3" },
      kids: [{ kind: "row", text: "lint", attrs: { end: "2 warnings" } }],
    },
    {
      kind: "group",
      attrs: { label: "Open: what the run touched", fold: "open" },
      kids: [{ kind: "row", text: "bridge/send/path.ts", attrs: { end: "+12 −3" } }],
    },
    {
      kind: "code",
      attrs: { lang: "ts" },
      kids: [
        { kind: "line", text: "export function sendPathWithAVeryLongNameThatRunsPastTheFrame(paneId: string, text: string): SendResult {" },
        { kind: "line", text: "  return panes.get(paneId)?.send(text) ?? { refused: \"gone\" };" },
        { kind: "line", text: "}" },
      ],
    },
    { kind: "para", attrs: { role: "quote" }, text: "The leg passed on the first tap in every case, and the only red was a timing budget on a loaded machine." },
    {
      kind: "para",
      kids: [
        { kind: "run", text: "The full report: " },
        { kind: "link", text: "browser leg report", attrs: { href: "https://reports.browser-leg.downloads.colliepwa.example.com/runs/7731" } },
      ],
    },
    { kind: "bar", kids: [{ kind: "link", text: "CI run 7731", attrs: { href: "https://github-actions-artifacts.colliepwa.example.com/runs/7731" } }] },
    { kind: "spacer", attrs: { label: "Everything above came from this morning" } },
    { kind: "line", text: "tail: ok 34/34 · replay · 0 live turns · 4 min 12 s · budget 0.62 of 1.00" },
  ],
});

/** 36: one portrait shot and one landscape shot: the strip keeps today's height. */
export const mixedImages = decision({
  title: "Which shot goes in the release post?",
  summary: "A phone shot and a wide one.",
  sender: TRICKS,
  ago: 3,
  options: [
    { intent: "phone", label: "The phone shot" },
    { intent: "wide", label: "The wide one" },
  ],
  media: [shot("im_pgphoneoption001", "On the phone", PHONE), shot("im_pgafter000000001", "On a laptop")],
});

// ── The display kinds (2026-11-10) ──────────────────────────────────────────────────────────────────
// A Decision's view places its own pictures (`image` by `ref`, cropped by `focus`; `compare`), and
// draws a table, a diff and a trend. The pictures are the page's own phone panels above.

/** 37: one picture placed among the facts, zoomed on its panel; the other stays in the row above. */
export const placedImage = decision({
  title: "Is the option panel big enough?",
  summary: "The view zooms on the panel the person taps; the full shot is one tap away.",
  sender: TRICKS,
  ago: 1,
  options: [
    { intent: "yes", label: "Big enough" },
    { intent: "bigger", label: "Make it bigger" },
  ],
  media: [shot("im_pgphoneoption001", "The option screen", PHONE), shot("im_pgphonebuild0001", "The build", PHONE)],
  view: [
    { kind: "image", attrs: { ref: "0", caption: "The panel, zoomed in from the option screen", fit: "cover", focus: "32 35 2.5" } },
    { kind: "list", kids: [{ kind: "row", text: "Panel", attrs: { end: "200 × 140 px" } }] },
  ],
});

/** 38: before and after, side by side at one height, cropped to the same point; a tap pages through both. */
export const compareShots = decision({
  title: "Ship the new option panel?",
  summary: "The panel moved up and got its own colour.",
  sender: TRICKS,
  ago: 2,
  options: [
    { intent: "ship", label: "Ship it" },
    { intent: "wait", label: "Not yet" },
  ],
  media: [shot("im_pgphoneoption001", "Before", PHONE), shot("im_pgphonebuild0001", "After", PHONE)],
  view: [{ kind: "compare", kids: [{ kind: "image", attrs: { ref: "0", focus: "40 35 1.6" } }, { kind: "image", attrs: { ref: "1", focus: "40 35 1.6" } }] }],
});

/** 39: a small table, a column of figures on the end side, one cell in the warn ink. */
export const tableCard = decision({
  title: "Accept the slower typecheck?",
  summary: "Typecheck got 1.4 s slower with the stricter config. The rest held.",
  sender: LEAD,
  ago: 4,
  options: [
    { intent: "accept", label: "Accept it" },
    { intent: "revert", label: "Revert the config" },
  ],
  view: [
    {
      kind: "table",
      kids: [
        { kind: "col", text: "Check" },
        { kind: "col", text: "Before" },
        { kind: "col", text: "After" },
        { kind: "cell", text: "lint" },
        { kind: "cell", text: "8.1" },
        { kind: "cell", text: "8.0" },
        { kind: "cell", text: "typecheck" },
        { kind: "cell", text: "21.3" },
        { kind: "cell", text: "22.7", attrs: { tone: "warn" } },
        { kind: "cell", text: "unit tests, web and bridge together" },
        { kind: "cell", text: "96.4" },
        { kind: "cell", text: "95.9" },
      ],
    },
  ],
});

/** 40: a hunk as a diff: the lines tinted by their first characters, a long one scrolling inside its block. */
export const diffCard = decision({
  title: "Take the shorter refusal?",
  summary: "One line of behaviour changes; the rest is the test.",
  sender: LEAD,
  ago: 5,
  options: [
    { intent: "take", label: "Take it" },
    { intent: "keep", label: "Keep the old one" },
  ],
  view: [
    {
      kind: "diff",
      attrs: { file: "bridge/send/path.ts" },
      text: [
        "@@ -41,6 +41,9 @@ export function sendPath(",
        "   const pane = panes.get(id);",
        "-  if (!pane) return null;",
        "+  if (pane === undefined) {",
        '+    return { refused: "gone", reason: "the pane closed while the send was on its way to it" };',
        "+  }",
        "   return pane.send(text);",
      ].join("\n"),
    },
  ],
});

/** 41: two figures with their trend, side by side in the flow. */
export const sparkCard = decision({
  title: "Keep the nightly leg paused?",
  summary: "Replays cost nothing; the live runs went down all week.",
  sender: LEAD,
  ago: 6,
  options: [
    { intent: "paused", label: "Keep it paused" },
    { intent: "resume", label: "Resume it" },
  ],
  view: [
    {
      kind: "group",
      kids: [
        { kind: "number", text: "0.12", attrs: { label: "Live turns, dollars", tone: "ok" } },
        { kind: "spark", attrs: { values: "0.65 0.61 0.44 0.30 0.21 0.12", label: "Last six runs", tone: "ok" } },
      ],
    },
    { kind: "spark", attrs: { values: "4.2 4.4 4.1 4.6 4.3 4.2 4.0", label: "Minutes a run takes" } },
  ],
});

/** 42: a review card, composed: before and after, the figure, the checks, and the hunk. */
export const reviewCard = decision({
  title: "Merge the option panel change?",
  summary: "The panel moved up. Every check is green but one, which is a timing budget.",
  sender: TRICKS,
  ago: 1,
  priority: "now",
  priorityAsked: "now",
  options: [
    { intent: "merge", label: "Merge it" },
    { intent: "rerun", label: "Rerun WebKit first" },
  ],
  recommends: { intent: "rerun", why: "The red case is a budget on a loaded runner, and it passed on the run before." },
  media: [shot("im_pgphoneoption001", "Before", PHONE), shot("im_pgphonebuild0001", "After", PHONE)],
  view: [
    { kind: "compare", kids: [{ kind: "image", attrs: { ref: "0", focus: "40 35 1.6" } }, { kind: "image", attrs: { ref: "1", focus: "40 35 1.6" } }] },
    { kind: "number", text: "33/34", attrs: { label: "Browser leg cases green", tone: "warn" } },
    {
      kind: "group",
      attrs: { label: "Checks" },
      kids: [
        { kind: "row", text: "typecheck", attrs: { icon: "check", tone: "ok" } },
        { kind: "row", text: "lint", attrs: { icon: "check", tone: "ok" } },
        { kind: "row", text: "WebKit", attrs: { icon: "x", tone: "danger" }, kids: [{ kind: "para", text: "pane glide took 612 ms against a 400 ms budget" }] },
      ],
    },
    {
      kind: "group",
      attrs: { label: "The change" },
      kids: [
        {
          kind: "diff",
          attrs: { file: "web/src/components/option-panel.tsx" },
          text: ['@@ -12,4 +12,4 @@', '-<section className="mt-6">', '+<section className="mt-2 bg-status-working/10">', "   <OptionRows />"].join("\n"),
        },
      ],
    },
  ],
});

/** Collie's own sender on a "new version" card: kind collie, the version's hash, no session. */
function collieFrom(trickId: string, hash: string): HillDecision["from"] {
  return { kind: "collie", address: null, trickId: null, trickKey: null, memberId: null, harness: null, label: "Collie", host: "bluefin", trickHost: null, ref: { type: "version", id: trickId, hash } };
}

/** 46: a trick's new version that asks for no new rights: three files, two hunks, Collie recommends it. */
export const versionPlain = decision({
  title: "Use the new version of Browser leg?",
  summary: "3 files changed. It asks for no new rights.",
  ago: 1,
  from: collieFrom("legs", "4c".repeat(32)),
  target: null,
  text: "none",
  options: [
    { intent: "use", label: "Use the new version" },
    { intent: "always", label: "Use it and stop asking", detail: "Later changes are taken without asking, unless they ask for new rights or do something new." },
    { intent: "keep", label: "Keep the old version" },
  ],
  recommends: { intent: "use", why: "It asks for no new rights, and a text search of its code finds nothing new." },
  view: [
    {
      kind: "table",
      kids: [
        { kind: "col", text: "File" },
        { kind: "col", text: "Change" },
        { kind: "col", text: "+", attrs: { align: "end" } },
        { kind: "col", text: "−", attrs: { align: "end" } },
        { kind: "cell", text: "trick.ts" },
        { kind: "cell", text: "changed" },
        { kind: "cell", text: "+6" },
        { kind: "cell", text: "−2" },
        { kind: "cell", text: "lib/report.ts" },
        { kind: "cell", text: "changed" },
        { kind: "cell", text: "+3" },
        { kind: "cell", text: "−1" },
        { kind: "cell", text: "lib/old-format.ts" },
        { kind: "cell", text: "removed" },
        { kind: "cell", text: "" },
        { kind: "cell", text: "−18" },
      ],
    },
    {
      kind: "diff",
      attrs: { file: "trick.ts" },
      text: [
        "@@ -14,6 +14,10 @@ export default trick(async (t) => {",
        "   const last = await t.cached(\"last\", 60_000, readLast);",
        "-  if (last.value === null) return t.view([]);",
        "-  const red = last.value.cases.filter((c) => !c.ok);",
        "+  if (last.value === null) {",
        "+    return t.view([{ kind: \"line\", text: \"No run yet\", attrs: { role: \"note\" } }]);",
        "+  }",
        "+  const red = last.value.cases.filter((c) => !c.ok);",
        "+  const flaky = red.filter((c) => c.retried);",
        "+  t.state.flaky = flaky.length;",
        "   return t.view(rows(red));",
      ].join("\n"),
    },
    {
      kind: "diff",
      attrs: { file: "lib/report.ts" },
      text: ["@@ -3,4 +3,6 @@ export function rows(red: Case[]) {", "-  return red.map((c) => ({ kind: \"row\", text: c.name }));", "+  return red.map((c) => ({", "+    kind: \"row\", text: c.name, attrs: { tone: \"danger\" },", "+  }));"].join("\n"),
    },
  ],
});

/** 47: a trick's new version that asks for a new right and reaches the network: no "stop asking", no recommendation. */
export const versionRights = decision({
  title: "Use the new version of Tracker?",
  summary: "2 files changed. It now also asks for GITHUB_TOKEN, and reaches the network.",
  ago: 3,
  from: collieFrom("tracker", "9e".repeat(32)),
  target: null,
  text: "none",
  options: [
    { intent: "use", label: "Use the new version" },
    { intent: "keep", label: "Keep the old version" },
  ],
  view: [
    { kind: "bar", attrs: { label: "New rights" }, kids: [{ kind: "chip", text: "GITHUB_TOKEN", attrs: { tone: "warn" } }] },
    { kind: "para", text: "This trick reaches the network." },
    {
      kind: "table",
      kids: [
        { kind: "col", text: "File" },
        { kind: "col", text: "Change" },
        { kind: "col", text: "+", attrs: { align: "end" } },
        { kind: "col", text: "−", attrs: { align: "end" } },
        { kind: "cell", text: "trick.ts" },
        { kind: "cell", text: "changed" },
        { kind: "cell", text: "+9" },
        { kind: "cell", text: "−1" },
        { kind: "cell", text: "trick.toml" },
        { kind: "cell", text: "changed" },
        { kind: "cell", text: "+1" },
        { kind: "cell", text: "" },
      ],
    },
    {
      kind: "diff",
      attrs: { file: "trick.ts" },
      text: [
        "@@ -8,3 +8,11 @@ export default trick(async (t) => {",
        "-  const open = await readLocalIssues(t.dir);",
        "+  const token = t.env(\"GITHUB_TOKEN\");",
        "+  const res = await fetch(\"https://api.github.com/repos/owner/tracker/issues\", {",
        "+    headers: { authorization: `Bearer ${token}` },",
        "+  });",
        "+  const open = await res.json();",
        "   return t.view(rows(open));",
      ].join("\n"),
    },
  ],
});

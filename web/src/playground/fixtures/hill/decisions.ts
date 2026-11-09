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
    from: { kind: "agent", address: `wt_${did.slice(3, 15)}`, trickId: null, trickKey: null, memberId: null, harness: "claude", label: sender.label, host: sender.host },
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
const LOOK_FROM = { kind: "trick", address: null, trickId: "look", trickKey: "ship-zoom", memberId: null, harness: null, label: "Look", host: null } as const;

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

const SHOTS = new Map<string, string>([
  ["im_pgbefore00000001", shotBefore],
  ["im_pgafter000000001", shotAfter],
  ["im_pgdiff0000000001", shotDiff],
  // Bytes no browser decodes: the card's failed state.
  ["im_pgbroken00000001", "data:image/png;base64,AAAA"],
]);

/** Where the playground's images are: the inlined panels by media id. */
export const playgroundMedia: HillMediaSource = (_decision, media) => SHOTS.get(media.id) ?? "data:image/png;base64,AAAA";

function shot(mediaId: string, caption?: string): HillMedia {
  const media: HillMedia = { id: mediaId, kind: "image", mime: "image/png", bytes: 1800, width: 600, height: 360 };
  return caption === undefined ? media : { ...media, caption };
}

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

/** 23: three images; the card shows the first with "1 / 3", the body shows all three. */
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

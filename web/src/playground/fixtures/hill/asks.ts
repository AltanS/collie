// Three asks for the states playground (Asks, 2026-11-22): Decisions with the `ask` field, shaped by the
// wire types (`lib/hill/wire.ts`), as `collie walky ask` posts them. DEV-ONLY, like the rest of
// `src/playground/`. The senders and machines are the hill fixtures' own ("collie lead" on "lodge",
// "m96-hill" on "workshop"); no person's name, no private path. The picture is the playground's own panel
// (`playgroundMedia` in ./decisions.ts serves it by its media id).

import type { HillDecision } from "@/lib/hill/wire";

const NOW = Date.now();
const MIN = 60_000;

/** A whole ask with the fields every ask has filled in. */
function ask(over: Partial<HillDecision> & Pick<HillDecision, "id" | "title" | "summary" | "ask">, sender: { label: string; host: string }, ago: number): HillDecision {
  return {
    v: 1,
    requestId: `5d1c0a7e-3b2f-4e8a-9c41-0000000000${over.id.slice(-2)}`,
    from: { kind: "agent", address: `local/w1:p${over.id.slice(-2)}#a1b2c3d4`, trickId: null, trickKey: null, memberId: null, harness: "claude", label: sender.label, host: sender.host, trickHost: null },
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
    ...over,
  };
}

const LEAD = { label: "collie lead", host: "lodge" } as const;
const HILL = { label: "m96-hill", host: "workshop" } as const;

/** 1: a long Markdown background, two linked files (one at a heading, one at a line) and a recommendation. */
export const askWithBackground = ask(
  {
    id: "ak_pgbackgrnd01",
    title: "Keep the old answer route beside the new Send?",
    summary: "The phone can send all answers of a session at once now. The old route still answers one card at a time.",
    options: [
      { intent: "keep", label: "Keep both routes for now", detail: "Older phones keep working. The bridge carries two code paths until the next minor." },
      { intent: "drop", label: "Drop the old route", detail: "One code path. A phone that did not reload gets a 404 on its next answer and must reload." },
    ],
    recommends: { intent: "keep", why: "A phone that did not reload would lose an answer the person already gave." },
    body: [
      "## What I found",
      "",
      "The single answer route (`POST /api/hill/answer`) is used by **every phone bundle** since the Hill came in. The new route takes up to five answers and types one message.",
      "",
      "- A phone that has not reloaded still calls the old route.",
      "- The service worker keeps the old bundle until the next reload.",
      "- Both routes share the claim lane, so two taps cannot answer one ask twice.",
      "",
      "| Route | Answers | Messages typed |",
      "| --- | --- | --- |",
      "| `/api/hill/answer` | 1 | 1 |",
      "| `/api/hill/answers` | 1 to 5 | 1 |",
      "",
      "## What can go wrong",
      "",
      "If we drop the old route, an answer from an old bundle fails with a 404. The person sees a red line and taps again after a reload.",
      "",
      "```text",
      "POST /api/hill/answer 404",
      "```",
      "",
      "See the route in the server file, and the plan in the notes.",
    ].join("\n"),
    ask: {
      words: false,
      files: [
        { path: "bridge/server.ts", line: 3832 },
        { path: "docs/hill.md", heading: "Asks (in work)" },
      ],
      root: "w1:p01",
    },
  },
  LEAD,
  3,
);

/** 2: a `--words` ask: no options, the answer is the person's own words. */
export const askWords = ask(
  {
    id: "ak_pgwords00002",
    title: "What should the Asks page say when there are none?",
    summary: "The empty list shows a blank screen now. One short sentence would tell the person why it is empty.",
    text: "required",
    body: "Two drafts I considered: \"No open asks.\" and \"Your agents have no questions right now.\" Neither names where the asks come from.",
    ask: { words: true, files: [], root: "w1:p02" },
  },
  HILL,
  11,
);

/** 3: an ask with a picture in its background, and no recommendation. */
export const askWithPicture = ask(
  {
    id: "ak_pgpicture003",
    title: "Does the ask row read right on a 390 px phone?",
    summary: "The row shows the question on two lines, then the recommendation, then the time it was sent.",
    options: [
      { intent: "fine", label: "Keep the row as it is", detail: "The row ships as in the picture." },
      { intent: "shorter", label: "Cut the question to one line", detail: "The row gets shorter; a long question ends with an ellipsis." },
    ],
    body: "The picture is the row after the change, on the dark theme.",
    media: [{ id: "im_pgafter000000001", kind: "image", mime: "image/png", bytes: 1800, width: 600, height: 360, caption: "The row after the change" }],
    ask: { words: false, files: [], root: null },
  },
  LEAD,
  26,
);

/** The three, oldest last, as an open list would hold them. */
export const playgroundAsks: readonly HillDecision[] = [askWithBackground, askWords, askWithPicture];

// Chapter 9 of the tricks explainer: who is trusted with what. What Collie checks, what your tap
// decides, what stays your job; the check before you switch a trick on; official and community tricks;
// the honest limits. The About sheet, the advice card and the Settings card with its Official tricks are
// REAL components fed fixtures; the check panel is a MOCKUP of the design (not on this base).
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useState, type CSSProperties } from "react";

import { DecisionCard } from "@/components/decision-card";
import { TrickAboutSheet } from "@/components/trick-about-sheet";
import { Button } from "@/components/ui/button";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import type { HillDecision } from "@/lib/hill/wire";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import type { OfficialState, OfficialTricksReply, TricksReply, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";

import { homeSolo } from "../fixtures";
import { playgroundMedia, twoOptions } from "../fixtures/hill/decisions";
import { RootRouter } from "../harness";
import { FigureSlot } from "../explainer-figures";
import { Chapter, MockupTag, P, Sub } from "./chapter";
import { W } from "./hues";

const NOOP = () => {};

const DISK_OFF: WireTrickInfo = {
  host: "workshop",
  id: "disk-space",
  name: "Disk space",
  icon: "archive",
  on: false,
  state: "off",
  places: ["dashboard", "status"],
  description: "Room left in your home folder.",
  about: "Disk space shows how much room is left in your home folder, as a tile on the Dashboard and a chip in the status line.\n\nIt runs df once every five minutes while your phone looks. It changes nothing.",
  warnings: [{ kind: "spawn", text: "This trick starts other programs on this machine." }],
  provenance: { via: "repo", at: "2026-11-11T09:30:00Z", repo: "someone/disk-space-trick", sha: "3f2a91c0d4e5" },
};

/** A session's report on the code, as advice on the Hill: one OK, and it switches nothing. */
const ADVICE: HillDecision = {
  ...twoOptions,
  id: "dc_r7c2k9m4p1x0",
  from: { ...twoOptions.from, label: "my-app#main", host: "workshop" },
  target: { label: "my-app#main", host: "workshop", unattended: false },
  title: "Disk space: what does its code do?",
  summary: "It runs df and awk, then prints one line of JSON. It reaches no network and writes no file.",
  priority: "today",
  priorityAsked: "today",
  text: "none",
  options: [{ intent: "ok", label: "OK" }],
  recommends: null,
  body: "I read program.sh and trick.toml, every line. The program reads the free space of your home folder with df, turns it into gigabytes, and prints a tile and a chip. It ignores the facts Collie hands it.",
};

/** The real About sheet in a phone-sized box that is its own containing block, as `trick-settings` does. */
function AboutBox() {
  const [open, setOpen] = useState(true);
  const style: CSSProperties & { "--app-h"?: string } = { height: 720, transform: "translate(0)", "--app-h": "720px" };
  return (
    <div data-pg-frame="" className="relative isolate w-full max-w-[390px] overflow-hidden rounded-sm border border-rule bg-background" style={style}>
      <button type="button" className="m-4 min-h-11 text-sm underline" onClick={() => setOpen(true)}>
        About Disk space
      </button>
      <TrickAboutSheet trick={DISK_OFF} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

const CHECK_LINES: readonly { label: string; value: string }[] = [
  { label: "What it runs", value: "program.sh line 4: df -Pk \"$HOME\" | awk …" },
  { label: "Network", value: "nothing found" },
  { label: "Files it writes", value: "nothing found" },
  { label: "Models and agents", value: "nothing found" },
];

/** The check before the switch: Collie's own lines, and a way to ask a session for a second reading. */
function CheckBeforeSwitch() {
  return (
    <div className="w-full max-w-[390px] space-y-3">
      <div className="rounded-sm border border-rule bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <p className="font-mono text-[11px] text-muted-foreground">phone · Settings → Tricks → Disk space</p>
          <MockupTag />
        </div>
        <div className="space-y-2 px-3 py-3">
          <p className="text-sm font-semibold">Collie's check</p>
          <dl className="space-y-1 text-[13px]">
            {CHECK_LINES.map((l) => (
              <div key={l.label} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{l.label}</dt>
                <dd className="font-mono text-[12px] break-words">{l.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[12px] text-muted-foreground">A text search, not a proof.</p>
          <Button type="button" variant="outline" size="lg" className="h-11 w-full">
            Ask a session to check it
          </Button>
        </div>
      </div>
      <div className="rounded-sm border border-rule bg-background p-3">
        <p className="mb-2 font-mono text-[11px] text-muted-foreground">phone · the Hill, a session's answer</p>
        <DecisionCard decision={ADVICE} answer={HILL_IDLE} onSend={NOOP} mediaSource={playgroundMedia} />
      </div>
      <p className="text-sm text-muted-foreground">The report is advice. Its one button, OK, only closes the card. The switch stays in Settings, and only you flip it.</p>
    </div>
  );
}

const OFFICIAL_COMMIT = "0d8039936aef44961a5641f4bfdc4583ed0c3e60";

function official(id: string, name: string, description: string): WireOfficialTrick {
  return { id, name, description, repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: OFFICIAL_COMMIT, state: "absent" };
}

const OFFICIAL: WireOfficialTrick[] = [
  official("design-review", "Design Review", "Turns an agent's UI notes into Decisions you approve by name."),
  official("pr-inbox", "PR Inbox", "Open pull requests and issues that wait for you."),
];

/** The installed list: Disk space, off, as it arrives. */
function useInstalled(): TricksStore {
  const [store] = useState(() => {
    const reply: TricksReply = { rev: 1, tricks: [DISK_OFF], parts: [], present: [] };
    return createTricksStore({ fetchTricks: async () => reply, tapTrick: () => Promise.reject(new Error("no taps here")), mintRequestId: () => "explainer" });
  });
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return store;
}

const LIST = async (): Promise<OfficialTricksReply> => ({ tricks: OFFICIAL });
/** The add answers after a moment, as the bridge does after its fetch and its hash check. Nothing is fetched here. */
const ADD = async (id: string): Promise<{ id: string; state: OfficialState }> => {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { id, state: "added" };
};
const SWITCH = async (_host: string, _id: string, on: boolean): Promise<WireTrickInfo> => ({ ...DISK_OFF, on, state: on ? "ok" : "off" });

/** The real Tricks card of Settings: the installed tricks, then "Official tricks" with Add. */
function OfficialList() {
  const store = useInstalled();
  return (
    <div className="w-full max-w-[390px] space-y-2">
      <p className="font-mono text-[11px] text-muted-foreground">phone · Settings → Tricks</p>
      <div className="rounded-sm border border-rule bg-background p-4">
        <RootRouter data={homeSolo}>
          <TricksSettingsCard store={store} onSwitch={SWITCH} onOfficialList={LIST} onOfficialAdd={ADD} now={Date.parse("2026-11-11T09:41:00Z")} />
        </RootRouter>
      </div>
    </div>
  );
}

export function TrustChapter() {
  return (
    <Chapter at="trust" lead="A trick runs as you. Your tap is the only yes.">
      <FigureSlot name="trust" className="mx-auto max-w-[560px]" />
      <P>
        A trick's program runs on your machine, as your user, with your files and your logins. Collie cannot fence it in. So Collie does what it can do well: it checks
        everything the trick hands back, it keeps every yes for <W hue="you">you</W>, and it tells you plainly what it found in the code.
      </P>

      <Sub>Before you switch it on</Sub>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <AboutBox />
          <p className="text-sm text-muted-foreground">The real About sheet: the author's words, then only the facts Collie knows.</p>
        </div>
        <CheckBeforeSwitch />
      </div>

      <Sub>Official and community</Sub>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <OfficialList />
        <div className="min-w-0 space-y-3 text-[15px] leading-relaxed">
          <p>
            <strong>Official tricks</strong> come from Collie's own repository. Each release names the exact version of each one, and Add fetches that version and
            nothing else. They arrive switched off, like every trick.
          </p>
          <p>
            <strong>Community</strong> tricks are anyone else's. You find them on the website, under the GitHub topic{" "}
            <code className="font-mono text-[13px]">colliepwa-tricks</code>. The app never fetches a list of them. You add one by its address, and its row says:
          </p>
          <p className="rounded-sm border border-border bg-card px-3 py-2 text-sm font-semibold">ColliePWA did not check this code.</p>
        </div>
      </div>

      <Sub>The honest limits</Sub>
      <ul className="max-w-[66ch] list-disc space-y-1 pl-5 text-[15px] leading-relaxed">
        <li>A trick is not in a sandbox. It can do what you can do on your machine.</li>
        <li>Collie's check is a text search. Code can hide what it does from any search.</li>
        <li>An agent that read a view's rules keeps them until its conversation ends, even after you switch the view off.</li>
        <li>Your taps protect you from a stranger and from an agent that follows the rules. Your user account is the real wall.</li>
      </ul>
    </Chapter>
  );
}

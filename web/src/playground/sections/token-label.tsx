// The "Uses agent tokens" section of the states playground (2026-11-12): the label as built. The session sheet's agent view switch carries none (no third hint line at 360 px). Every card mounts the REAL components over fixtures, and the label comes from the facts
// (lib/tricks/token-use.ts, lib/token-use-features.ts), never from a flag set here per trick. The one hand
// this section has on it is `TokenUseLookProvider` (components/token-use-label.tsx): the chip's words in another language to try its width before the translation pass. Those words are a
// fixture here and reach no message catalogue.
//
// The bar: the theme and the half through the app's own store, the width of the column, and the chip's
// words. `?theme=`, `?half=`, `?width=` and `?words=` set them on load.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/design.html.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { HillSwitchCard } from "@/components/hill-switch-card";
import { TokenUseLookProvider, type TokenUseLook } from "@/components/token-use-label";
import { TrickDetail } from "@/components/trick-detail";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { WalkyOffSwitch } from "@/components/walky-sheet";
import { useTheme } from "@/hooks/use-theme";
import { isShippedThemeId, SHIPPED_THEME_IDS } from "@/lib/theme/schema";
import { setActiveTheme, useActiveTheme } from "@/lib/theme/store";
import type { OfficialTricksReply, TricksReply, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";

import { homeSolo } from "../fixtures";
import { VIEW_TRICK } from "../fixtures/agent-view";
import { RootRouter } from "../harness";
import { Card, CardControls, Group, Section, Segmented, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "token-label",
  title: "Uses agent tokens",
  intent: "The label on tricks and features that make an agent read or write more.",
};

// ── The bar ────────────────────────────────────────────────────────────────────────────────────

type Half = "dark" | "light";
type WidthId = "360" | "390";
type WordsId = "en" | "de" | "fr" | "ja";

const THEME_OPTIONS = SHIPPED_THEME_IDS.map((id) => ({ value: id, label: id.charAt(0).toUpperCase() + id.slice(1) }));
const HALF_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const satisfies readonly { value: Half; label: string }[];
const WIDTH_OPTIONS = [
  { value: "360", label: "360" },
  { value: "390", label: "390" },
] as const satisfies readonly { value: WidthId; label: string }[];

/** Plausible translations of "Uses agent tokens", to try the chip's width. Not the translation pass's words. */
const WORDS = {
  en: undefined,
  de: "Verbraucht Agenten-Tokens",
  fr: "Utilise des tokens d'agent",
  ja: "エージェントのトークンを使用",
} as const satisfies Record<WordsId, string | undefined>;
const WORDS_IDS: readonly WordsId[] = ["en", "de", "fr", "ja"];
const WORDS_OPTIONS = WORDS_IDS.map((id) => ({ value: id, label: id }));

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function isWidth(value: string | null): value is WidthId {
  return value === "360" || value === "390";
}

function isWords(value: string | null): value is WordsId {
  return WORDS_IDS.some((id) => id === value);
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-12T09:41:00Z");
const REPO = "https://github.com/AltanS/collie-tricks";
const SHA = "0c1e5d82346486815073fedcdb994bc4c2041b55";

/** Morph, added from the official list and on: an agent view with rules. */
const MORPH: WireTrickInfo = {
  ...VIEW_TRICK,
  on: true,
  state: "ok",
  description: "Your agent answers with one screen you can tap, not a wall of text.",
  provenance: { via: "repo", at: "2026-11-11T18:02:00Z", url: REPO, repo: "AltanS/collie-tricks", sha: SHA },
};

/** PR Inbox, added from the official list, a version that declares `decides = "reply"`. */
const INBOX: WireTrickInfo = {
  host: "lodge",
  id: "pr-inbox",
  name: "PR Inbox",
  icon: "flag",
  on: true,
  state: "ok",
  places: ["belt", "dashboard", "session", "status", "tabbar"],
  description: "Open pull requests and issues that wait for you.",
  decidesReply: true,
  provenance: { via: "repo", at: "2026-11-11T18:03:00Z", url: REPO, repo: "AltanS/collie-tricks", sha: SHA },
};

/** A community trick of the person's own with a long name: a belt mark, no label. */
const CLOCK: WireTrickInfo = { host: "lodge", id: "clock", name: "Clock on the workshop machine", icon: "clock", on: false, state: "off", places: ["belt"], provenance: { via: "cli", at: "2026-11-11T18:02:00Z" } };

const TRICKS: WireTrickInfo[] = [MORPH, INBOX, CLOCK];

function officialEntry(id: string, name: string, description: string, extra: Partial<WireOfficialTrick>): WireOfficialTrick {
  return { id, name, description, repo: REPO, repoName: "AltanS/collie-tricks", commit: SHA, state: "added", ...extra };
}

const OFFICIAL_LIST: OfficialTricksReply = {
  tricks: [
    officialEntry("morph", "Morph", "Your agent answers with one screen you can tap, not a wall of text.", { agentView: true, givesRules: true }),
    officialEntry("design-review", "Design Review", "Turns an agent's UI notes into Decisions you approve by name.", { state: "absent", places: ["belt", "session"], decidesReply: true }),
    officialEntry("pr-inbox", "PR Inbox", "Open pull requests and issues that wait for you.", { places: ["belt", "dashboard", "session", "status", "tabbar"], decidesReply: true }),
    officialEntry("running-builds", "Running Builds", "Builds and long commands running in your sessions now.", { state: "absent", places: ["dashboard", "session", "status"] }),
  ],
};

const OFFICIAL = async (): Promise<OfficialTricksReply> => OFFICIAL_LIST;

async function switchStandIn(_host: string, id: string, on: boolean): Promise<WireTrickInfo> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const found = TRICKS.find((m) => m.id === id) ?? CLOCK;
  return { ...found, on, state: on ? "ok" : "off" };
}

function useTrickStore(): TricksStore {
  const [store] = useState(() => {
    const reply: TricksReply = { rev: 1, tricks: TRICKS, parts: [], present: [] };
    return createTricksStore({ fetchTricks: async () => reply, tapTrick: () => Promise.reject(new Error("no taps here")), mintRequestId: () => "playground" });
  });
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return store;
}

// ── The places ─────────────────────────────────────────────────────────────────────────────────

/** A phone-wide column. */
function Column({ width, children }: { width: WidthId; children: ReactNode }) {
  return (
    <div data-pg-column={width} className="max-w-full rounded-sm bg-background ring-1 ring-rule" style={{ width: Number(width) }}>
      <div className="flex flex-col space-y-4 p-4">{children}</div>
    </div>
  );
}

/** WalkyTalky's own switch, at the head of its sheet. */
function WalkyPlace() {
  const [off, setOff] = useState(false);
  return (
    <div data-pg-place="walky" className="-mx-4 border-y border-rule bg-card px-4 pt-3">
      <WalkyOffSwitch
        off={off}
        onChange={async (next) => {
          setOff(next);
          return null;
        }}
      />
    </div>
  );
}

/** The Hill's switch on Settings, Tricks and the Hill. */
function HillPlace() {
  const [on, setOn] = useState(true);
  return <HillSwitchCard on={on} disabled={false} onToggle={setOn} />;
}

/** A trick's details page in a phone box that scrolls. */
function AboutPlace({ trick, width }: { trick: WireTrickInfo; width: WidthId }) {
  const style: CSSProperties = { width: Number(width), height: 640 };
  return (
    <div data-pg-frame="" data-pg-place={`about-${trick.id}`} className="max-w-full overflow-y-auto rounded-sm bg-background p-4 ring-1 ring-rule" style={style}>
      <TrickDetail trick={trick} />
    </div>
  );
}

// ── The cards ──────────────────────────────────────────────────────────────────────────────────

function Head({ n, title }: { n: string; title: string }) {
  return (
    <CardControls className="flex items-center gap-3">
      <span className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-sm bg-foreground px-2 text-2xl font-bold leading-none text-background">{n}</span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
    </CardControls>
  );
}

function LookCard({ n, title, look, store, width }: { n: string; title: string; look: TokenUseLook; store: TricksStore; width: WidthId }) {
  return (
    <Card state={`token-label-${n}`} label={`${n} ${title}`}>
      <Head n={n} title={title} />
      <TokenUseLookProvider value={look}>
        <RootRouter data={homeSolo}>
          <Column width={width}>
            <TricksSettingsCard store={store} onSwitch={switchStandIn} onOfficialList={OFFICIAL} now={NOW} />
            <HillPlace />
            <WalkyPlace />
            <AboutPlace trick={MORPH} width={width} />
            <AboutPlace trick={INBOX} width={width} />
          </Column>
        </RootRouter>
      </TokenUseLookProvider>
    </Card>
  );
}

export function TokenLabelSection() {
  const store = useTrickStore();
  const active = useActiveTheme();
  const { resolved, setTheme } = useTheme();
  const [width, setWidth] = useState<WidthId>(() => {
    const value = param("width");
    return isWidth(value) ? value : "360";
  });
  const [words, setWords] = useState<WordsId>(() => {
    const value = param("words");
    return isWords(value) ? value : "en";
  });
  useEffect(() => {
    const theme = param("theme");
    if (theme !== null) setActiveTheme(theme);
    const half = param("half");
    if (half === "light" || half === "dark") setTheme(half);
  }, [setTheme]);
  const word = WORDS[words];
  return (
    <Section def={DEF}>
      <div className="sticky top-[var(--pg-top,0px)] z-20 -mx-4 flex flex-wrap items-center gap-2 bg-background/95 px-4 py-2 backdrop-blur-sm lg:top-0">
        <Segmented name="Theme" value={isShippedThemeId(active.id) ? active.id : "collie"} options={THEME_OPTIONS} onChange={setActiveTheme} />
        <Segmented name="Half" value={resolved} options={HALF_OPTIONS} onChange={setTheme} />
        <Segmented name="Width" value={width} options={WIDTH_OPTIONS} onChange={setWidth} />
        <Segmented name="Chip words" value={words} options={WORDS_OPTIONS} onChange={setWords} />
      </div>
      <Group title="Uses agent tokens">
        <LookCard n="1" title="Chip beside the origin" look={word === undefined ? { shown: true } : { shown: true, word }} store={store} width={width} />
      </Group>
    </Section>
  );
}

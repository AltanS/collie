// Chapter 6 of the tricks explainer, example 3: Morph, an agent view. The session's own agent draws one
// screen; a tap types one line that the bridge writes from the screen it stored. Every phone here is the
// REAL `AgentViewScreen` (components/agent-view-screen.tsx), Collie's band included, fed a screen that the
// real reader (`parseAgentView`) accepted. The animation moves its props through one turn.
// DEV-ONLY, like the rest of `src/playground/`.

import { AgentViewScreen, type AgentViewScreenProps } from "@/components/agent-view-screen";
import type { ViewSendResult } from "@/components/composer";
import { screenBlocks, type ViewRequest } from "@/lib/agent-view/reader";
import { parseAgentView, type ViewDrawing, type ViewScreen } from "@/lib/agent-view/wire";
import type { JsonValue } from "@/lib/json";

import { Chapter, P, Sub, Term } from "./chapter";
import { CodeBlock, W, type Seg } from "./hues";
import { ADDRESS, BIN, REQUEST, REQUEST_LINE, VIEW_FLOW } from "./flows";
import { TricksMap } from "./map";
import { Steps, type Step } from "./steps";
import { Uses } from "./uses";

const NOW = Date.parse("2026-11-11T09:41:00Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();


/** A screen as the agent sends it, read by the real reader. A fixture that does not read throws, so it never drifts. */
function screen(rev: number, secondsAgo: number, title: string, raw: JsonValue): ViewScreen {
  const parsed = parseAgentView(raw);
  if (parsed.view === undefined) throw new Error(`the Morph screen did not read: ${JSON.stringify(parsed.refusals)}`);
  return { rev, at: at(secondsAgo), title, view: parsed.view };
}

/** The screen the agent draws: data in the closed list of parts, never code. A button has a label and nothing else to send. */
const BROKEN = screen(3, 40, "Two tests fail after the rename", [
  {
    kind: "list",
    kids: [
      { kind: "row", text: "auth/login.test.ts", attrs: { end: "1 fail", tone: "danger", icon: "file" } },
      { kind: "row", text: "auth/token.test.ts", attrs: { end: "1 fail", tone: "danger", icon: "file" } },
    ],
  },
  { kind: "diff", text: '@@ -1,3 +1,3 @@\n-import { login } from "./session";\n+import { login } from "./auth";\n export function signIn() {', attrs: { file: "src/auth/login.ts" } },
  {
    kind: "bar",
    kids: [
      { kind: "button", attrs: { label: "Fix both", intent: "fix", tone: "accent" } },
      { kind: "button", attrs: { label: "Revert the rename", intent: "revert", confirm: "Revert?" } },
    ],
  },
]);

const FIXED = screen(4, 5, "Both tests pass again", [
  { kind: "number", text: "34/34", attrs: { label: "tests pass", tone: "ok" } },
  { kind: "para", text: "I changed the two imports from ./session to ./auth. Nothing else moved." },
  { kind: "bar", kids: [{ kind: "button", attrs: { label: "Show the change", intent: "show" } }] },
]);

/** "Fix both", as the view files a pick: its bar's block, then its place in the bar. */
const FIX_BOTH = `${screenBlocks(BROKEN)[2]?.prefix ?? ""}/0`;

/** The line a request typed in the view becomes: Collie's head, your words, and where the rules are. One line. */
const REQUEST_TEXT = `[view:morph ${ADDRESS}] from operator: ${REQUEST} [rules: ${BIN} trick view morph help --session ${ADDRESS}]`;
/** The line a tap becomes, once the session holds the rules: no tail. */
const TAP_TEXT = `[view:morph ${ADDRESS}] from operator: tapped "Fix both"`;


const TAP_LINE: Seg[] = [
  { t: `[view:morph ${ADDRESS}] from operator:`, hue: "bridge" },
  { t: " " },
  { t: 'tapped "Fix both"', hue: "agent" },
];

const AGENT_RUNS: Seg[] = [
  { t: `collie trick view morph start --session ${ADDRESS} --rules 3f9a07c2 "Reading the test output"\n`, hue: "agent" },
  { t: `collie trick view morph show --session ${ADDRESS} screen.json`, hue: "agent" },
];

const DRAWING: ViewDrawing = { at: at(50), note: "Reading the test output", notes: [{ at: at(50), note: "Reading the test output" }] };

const ASKED: ViewRequest = { text: REQUEST, phase: "sending", reason: null, at: NOW - 60_000, line: null };
const ASK_SENT: ViewRequest = { ...ASKED, phase: "sent", line: REQUEST_TEXT };
const TAP_SENT: ViewRequest = { text: 'tapped "Fix both"', phase: "sent", reason: null, at: NOW - 20_000, line: TAP_TEXT };

type Moment = Pick<AgentViewScreenProps, "view" | "request" | "drawing" | "working" | "pressed">;

/** The phone at each step of the turn. */
const MOMENTS: readonly Moment[] = [
  { view: undefined, request: ASKED, working: false },
  { view: undefined, request: ASK_SENT, working: true },
  { view: undefined, request: ASK_SENT, working: true, drawing: DRAWING },
  { view: undefined, request: ASK_SENT, working: true, drawing: DRAWING },
  { view: BROKEN, request: ASK_SENT, working: false },
  // The pick, marked on the screen the moment you tap; the next step folds the screen under the line it sent.
  { view: BROKEN, request: ASK_SENT, working: false, pressed: [FIX_BOTH] },
  { view: BROKEN, request: TAP_SENT, working: true, pressed: [FIX_BOTH] },
  { view: FIXED, request: TAP_SENT, working: false },
];

/** Morph's first screen, answered and still: the agent view as a place, for the places chapter. */
export function MorphScreen() {
  return <AgentViewScreen name="Morph" session={ADDRESS} view={BROKEN} request={ASK_SENT} working={false} entries={[]} canAct onTap={NO_TAP} onLink={IGNORE} now={NOW} />;
}

const NO_TAP = (): Promise<ViewSendResult> => Promise.resolve({ sent: false, line: null, code: null });
const IGNORE = () => {};

/** The real view, in a phone-sized box whose height never moves. */
function Phone(props: Partial<AgentViewScreenProps>) {
  return (
    <div className="flex h-[640px] w-full max-w-[390px] flex-col overflow-hidden rounded-sm border border-rule bg-background">
      <AgentViewScreen name="Morph" session={ADDRESS} view={BROKEN} working={false} entries={[]} canAct onTap={NO_TAP} onLink={IGNORE} now={NOW} {...props} />
    </div>
  );
}

function MorphPhone({ step, all }: { step: number; all: boolean }) {
  const m = (all ? MOMENTS[6] : MOMENTS[step]) ?? MOMENTS[0];
  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] text-muted-foreground">phone · a session, its Morph view</p>
      <Phone {...m} />
    </div>
  );
}

const STEPS: Step[] = [
  { hue: "you", text: <><W hue="you">You</W> type a request in the Morph view of a session: “{REQUEST}”</> },
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W> types it into that session, after a head that Collie writes and nobody else can.</> },
  { hue: "agent", text: <>The <W hue="agent">agent</W> reads the rules once, then says what it does. The view shows its note.</> },
  { hue: "agent", text: <>The <W hue="agent">agent</W> writes the screen as data, with a <code className="font-mono text-[13px]">collie trick view</code> command. The <W hue="bridge">bridge</W> checks it against the list of parts.</> },
  { hue: "phone", text: <>The <W hue="phone">phone</W> draws the screen with Collie's own parts, under Collie's band.</> },
  { hue: "you", text: <><W hue="you">You</W> tap “Fix both”. Collie marks your pick.</> },
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W> writes the line from the screen it stored, and types it into the session. The view shows you the exact line.</> },
  { hue: "agent", text: <>The <W hue="agent">agent</W> does the work and answers with a new screen.</> },
];



/** Three moments a view does not send, drawn side by side: the real view, in each state. */
function HeldStates() {
  const cases = [
    { title: "A question waits", line: "The agent asks a question in this session. The buttons wait, and what you type answers the question.", props: { question: true } },
    { title: "The agent works", line: "A turn runs. The buttons wait until it ends. Nothing queues.", props: { working: true } },
    { title: "Drawn in an earlier conversation", line: "The session started a new conversation. The screen is old, and its buttons are off.", props: { stale: true } },
  ] as const;
  return (
    <div className="grid grid-cols-1 gap-6 2xl:grid-cols-3">
      {cases.map((c) => (
        <div key={c.title} className="min-w-0 space-y-2">
          <p className="text-sm font-semibold">{c.title}</p>
          <p className="text-sm text-muted-foreground">{c.line}</p>
          <Phone {...c.props} request={ASK_SENT} />
        </div>
      ))}
    </div>
  );
}

export function MorphChapter() {
  return (
    <Chapter at="morph" lead="Morph lets the session's own agent answer you with one screen instead of a wall of text.">
      <P>
        <Term>Morph</Term> is an agent view: a trick with no program, only rules. It adds a third view to a session, beside the terminal and Chat. You switch it on
        for one session, and ask in plain words. The agent of that session answers by drawing one screen: a list, a diff, two buttons. You tap, and the agent gets a
        short line it can act on.
      </P>
      <Uses places={["agent-view"]} parts={["list", "row", "diff", "bar", "button", "number", "para"]} />
      <Steps label="One Morph turn" steps={STEPS} renderAside={(step, all) => <MorphPhone step={step} all={all} />}>
        {(step, all) => <TricksMap label="The map, lit for one Morph turn" focus={all ? { lit: ["you", "phone", "bridge", "agent"] } : (VIEW_FLOW[step] ?? {})} />}
      </Steps>

      <div className="grid grid-cols-1 gap-6">
        <div className="min-w-0 space-y-2">
          <Sub>What reaches the agent</Sub>
          <CodeBlock wrap title="typed into the session" segs={REQUEST_LINE} />
          <CodeBlock wrap title="what the agent runs" segs={AGENT_RUNS} />
        </div>
        <div className="min-w-0 space-y-2">
          <Sub>What a tap sends</Sub>
          <CodeBlock wrap title="typed into the session" segs={TAP_LINE} />
          <p className="text-sm">
            <W hue="bridge">Green</W> is Collie's head. <W hue="agent">Violet</W> is the button's own label, which the agent wrote when it drew the screen. The bridge
            quotes it from the screen it stored. A button has no hidden value: every word a tap sends is on the screen.
          </p>
        </div>
      </div>

      <Sub>When a view does not send</Sub>
      <HeldStates />

      <P>
        <strong>A tap sends only words you saw on the screen</strong>, on one line, and the view then shows you that line. Once a tap went, that screen takes no second
        tap. The screen belongs to one session and one conversation: when the conversation changes, the screen turns old and its buttons stop.
      </P>
      <P>
        The band at the top is Collie's. It names the trick and says who drew the screen, and the agent cannot draw over it. Collie draws every button itself, so an
        agent cannot make a button that looks like one of Collie's own questions.
      </P>
    </Chapter>
  );
}

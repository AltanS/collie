// Chapter 7 of the tricks explainer: where the thinking comes from. Collie holds no model key and calls
// no model; the map marks which box has a model, and a strip marks where inference happened in each
// of the three examples. DEV-ONLY, like the rest of `src/playground/`.

import { cn } from "@/lib/utils";

import { Chapter, P } from "./chapter";
import { HUE_BORDER, HUE_TEXT, W, type Hue } from "./hues";
import { TricksMap } from "./map";

const ROWS: readonly { example: string; where: string; hue: Hue | null; detail: string }[] = [
  { example: "Disk space", where: "Nowhere", hue: null, detail: "A shell program reads a number and prints it. No model is involved at all." },
  { example: "Release gates", where: "Nowhere", hue: null, detail: "Its program reads the gates and asks on the Hill. You do the deciding, and the program acts on your answer." },
  { example: "Morph", where: "In the session's own agent", hue: "agent", detail: "The agent thinks once per screen, inside the session you already run. Collie only checks and draws the result." },
  { example: "An agent's Decision", where: "In the agent that asked", hue: "agent", detail: "An agent can post on the Hill too. It wrote the question and its advice in its own turn. The card and your tap need no model." },
];

export function ThinkingChapter() {
  return (
    <Chapter at="thinking" lead="Collie holds no model key and calls no model.">
      <TricksMap models focus={{ lit: ["agent", "trick"] }} label="The map, marking where a model can think: only in the agent sessions, and in a trick only if its author makes it call one" />
      <ul className="grid grid-cols-1 gap-2">
        {ROWS.map((r) => (
          <li key={r.example} className={cn("grid grid-cols-1 gap-1 rounded-sm border bg-card px-4 py-3 sm:grid-cols-[9rem_14rem_minmax(0,1fr)] sm:items-baseline sm:gap-4", r.hue === null ? "border-border" : HUE_BORDER[r.hue])}>
            <span className="font-semibold">{r.example}</span>
            <span className={cn("font-semibold", r.hue === null ? "text-muted-foreground" : HUE_TEXT[r.hue])}>{r.hue === null ? "○ " : "◆ "}{r.where}</span>
            <span className="text-sm text-muted-foreground">{r.detail}</span>
          </li>
        ))}
      </ul>
      <P>
        The thinking comes from the <W hue="agent">agent you already run</W>: Claude Code, Codex or another, on your own plan or your own key. Collie only carries
        words between you and that session. The <W hue="phone">phone</W> and the <W hue="bridge">bridge</W> have no model in them.
      </P>
      <P>
        A <W hue="trick">trick</W>'s program can call a model if its author makes it do so. That is the author's choice, and it runs as you. Before you switch a trick
        on, Collie's check warns you when its code seems to call an agent or a model on a timer.
      </P>
    </Chapter>
  );
}

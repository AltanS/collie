// Small helpers used only by the Motion & notices section (motion.tsx). Two of them: a Replay
// button that remounts its children so a once-on-mount entrance can be watched again, and a Slow
// toggle that flattens every transition/animation duration under it to one value (see motion.css's
// `.pg-slow`, applied by SlowStage below) so a fast swap or cross-fade can be inspected frame by
// frame. Both are presentation-only. Neither drives an app module store; the cards that do their
// own driving own their own cleanup.

import { useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Segmented } from "../harness";

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

/**
 * Remounts `children` (a key bump) on every tap, so a motion that only plays once on mount (an
 * entrance, a one-shot flash) can be watched again without navigating away and back.
 */
export function Replay({ children }: { children: ReactNode }) {
  const [key, setKey] = useState(0);
  return (
    <div>
      <div className="mb-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => setKey((k) => k + 1)}
        >
          <RotateCcw className="size-3" />
          Replay
        </Button>
      </div>
      <div key={key}>{children}</div>
    </div>
  );
}

/**
 * The per-card "Slow" toggle. Wraps `children` in `div.pg-slow` when on; `motion.css` pins every
 * transition and animation duration under it to one flat number. That is an APPROXIMATION and the
 * card using it says so in its own `note`. A real 120ms dissolve and a real 240ms collapse both
 * read as the same speed under it, which is the trade for being able to see either happen at all.
 */
export function SlowStage({ children }: { children: ReactNode }) {
  const [slow, setSlow] = useState(false);
  return (
    <div>
      <div className="mb-2">
        <Segmented
          name="slow motion"
          value={slow ? "on" : "off"}
          options={ON_OFF}
          onChange={(next) => setSlow(next === "on")}
        />
      </div>
      <div className={slow ? "pg-slow" : undefined}>{children}</div>
    </div>
  );
}

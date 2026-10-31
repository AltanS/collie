import { useEffect, useMemo, useState } from "react";

import { mathEngineOf, useDesignPrefs } from "@/lib/design";
import { cn } from "@/lib/utils";
import { useMathRenderer, type MathRenderer, type Typeset } from "@/lib/math/engine";

// One formula, inline or display, typeset by the engine this device chose (lib/math/engine.ts). The
// SOURCE is the fallback in every state that is not a typeset formula: the engine still loading, the
// TeX not parsing, the engine unreachable offline. So a formula is always readable, and nothing here
// ever shows an engine's error message (it may quote the input as HTML).
//
// Only reached when the device chose an engine: with math Off the parser makes no math nodes at all.

// Typeset formulas, by engine, mode and TeX, so a re-render, a remount on scroll or a second message
// with the same formula never shows the source again while a MathJax font range is awaited. Bounded:
// a long session's transcript would otherwise keep every formula it ever drew.
const MAX_CACHED = 500;
const cache = new Map<string, Typeset>();

function remember(key: string, value: Typeset): Typeset {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

/** The typeset formula now, or a promise for it, or `undefined` while there is no renderer. */
function typeset(
  renderer: MathRenderer | null,
  key: string,
  text: string,
  display: boolean,
): Typeset | Promise<Typeset> | undefined {
  if (renderer === null) return undefined;
  if (cache.has(key)) return cache.get(key);
  const result = renderer.render(text, display);
  return result instanceof Promise ? result.then((value) => remember(key, value)) : remember(key, result);
}

/**
 * Shared inline/display math. The caller owns its source, search query and any Copy control, and the
 * find highlight: `mark` is that class, set while the formula holds a hit, and draws it as a `<mark>`.
 */
export function MathText({
  text,
  source,
  display = false,
  mark,
}: {
  text: string;
  source: string;
  display?: boolean;
  mark?: string;
}) {
  const engine = mathEngineOf(useDesignPrefs());
  const renderer = useMathRenderer(engine);
  const key = `${engine}\u0000${display ? "d" : "i"}\u0000${text}`;
  const now = useMemo(() => typeset(renderer, key, text, display), [renderer, key, text, display]);
  const [later, setLater] = useState<{ key: string; value: Typeset } | null>(null);

  useEffect(() => {
    if (!(now instanceof Promise)) return;
    let live = true;
    const settle = async () => {
      const value = await now;
      if (live) setLater({ key, value });
    };
    void settle();
    return () => {
      live = false;
    };
  }, [now, key]);

  const content = now instanceof Promise ? (later?.key === key ? later.value : null) : (now ?? null);
  const Tag = mark === undefined ? "span" : "mark";
  return (
    <Tag data-slot="math" className={cn(display ? "math-display" : "math-inline", mark)}>
      {content ?? <span className="whitespace-pre-wrap font-mono text-[0.9em]">{source}</span>}
    </Tag>
  );
}

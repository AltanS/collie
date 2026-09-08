import { useEffect, useState } from "react";

// A media query as reactive state: rotation, resize, and the soft keyboard collapsing the viewport
// all re-render on flip. Reads once for the initial render and re-reads on (re)subscribe, so a
// flip between render and effect still lands. No matchMedia (SSR) reads false, permanently.
export function useMediaQuery(query: string): boolean {
  // `?.()` rather than a `typeof` probe (anti-slop/no-runtime-typeof): the absence of `matchMedia`
  // is not an untyped value to parse, it is an API this environment does not have — jsdom without
  // the polyfill, and the worker tsconfig's DOM. An optional call reads that directly.
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

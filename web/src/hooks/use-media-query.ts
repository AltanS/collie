import { useEffect, useState } from "react";

// A media query as reactive state: rotation, resize, and the soft keyboard collapsing the viewport
// all re-render on flip. Reads once for the initial render and re-reads on (re)subscribe, so a
// flip between render and effect still lands. No matchMedia (SSR) reads false, permanently.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

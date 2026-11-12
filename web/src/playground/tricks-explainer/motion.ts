// Whether the explainer's motion should stay still: the system asks for reduced motion, or the
// playground's own switch does (it puts `pg-reduce-motion` on <html>). DEV-ONLY.

import { useSyncExternalStore } from "react";

import { useMediaQuery } from "@/hooks/use-media-query";

/** The playground's own reduce-motion switch puts a class on <html>. Watched, so a flip applies at once. */
function subscribeRootClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** True when motion should stay still: the system asks for it, or the playground's switch does. */
export function useStill(): boolean {
  const system = useMediaQuery("(prefers-reduced-motion: reduce)");
  const page = useSyncExternalStore(subscribeRootClass, () => document.documentElement.classList.contains("pg-reduce-motion"), () => false);
  return system || page;
}

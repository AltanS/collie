// What the census and experiment scripts leave on the page's window, so no case reaches for it with a cast.
// A script file (no import, no export) so the interface merges into the global Window.
interface Window {
  __hbScan?: (opts: import("@/playground/hitbox/scan").ScanOptions) => import("@/playground/hitbox/scan").ScanResult;
  __hbClicks?: { inside: boolean; at: string; x: number; y: number }[];
  __hbSwallow?: boolean;
  __hbTrack?: { t: number; first: number | null; fab: number | null; summary: number | null }[];
  __hbSlide?: { t: number; hit: string }[];
  __hbOwns?: (el: Element | null) => boolean;
  __hbContrast?: (a: string, b: string) => number;
}

/**
 * THE NAVIGATION'S EDGE (DESIGN.md §4, "The large screen's three planes"): the sidebar's right edge, the tab
 * strip's bottom edge and, on a large screen, the dashboard header's bottom edge. The step from the recess to
 * the page is the cut, so the edge is only the recess drawn 30% toward `--border`: quieter than that step, and
 * still a faint line where the step is nil (a black page, which clamps the recess to it).
 *
 * A module of its own because the pane view's strip and the app header both draw it, and the header must not
 * import the strip's column code to get one class string.
 */
export const NAV_EDGE = "border-[color-mix(in_oklch,var(--surface-recess)_70%,var(--border))]";

/**
 * THE RECESS'S ACCENT. On the recess (the sidebar, the Settings list, the dashboard header on a large screen) a
 * chosen row and a hovered one stand on the paper, so `--accent` points there. Its ink comes with it: a theme's
 * `--accent-foreground` is chosen for its own `--accent`, and on the paper a dark accent's light ink (or the reverse)
 * reads 1.04 to 1.18:1 (themes R5, 2026-11-21). The paper takes the page's ink, `--foreground`. The accent is
 * `--state-on-recess` (the paper in Collie; in an applied theme the paper held STATE_FLOOR off the recess,
 * lib/theme/derive.ts), and the plane's hover, selected and open fills come with it (DESIGN.md §14).
 */
export const RECESS_ACCENT =
  "[--accent:var(--state-on-recess)] [--accent-foreground:var(--foreground)] [--state-hover:var(--state-hover-recess)] [--state-on:var(--state-on-recess)] [--state-open:var(--state-open-recess)]";

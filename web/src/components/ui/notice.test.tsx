import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { render, screen } from "@testing-library/react";

import { Notice, NOTICE_ACTION, NOTICE_ACTION_TAP } from "./notice";

const TONES = ["info", "caution", "danger", "success", "neutral"] as const;

describe("Notice — the one notice surface", () => {
  it("states the STRIP floor at 33px, and states it as a floor", () => {
    // The number is derived, not chosen: 24px (the h-6 action button, the tallest thing a strip may
    // contain) + the row's own py-1 (2x4px) + the 1px tinted border-b, which border-box counts
    // inside a min-height. 24+8+1 = 33. It is pinned here because the obvious "tidy" is 32, and the
    // pixel that would be dropped is the rule separating the band from the header under it.
    const { container } = render(
      <Notice tone="caution" variant="strip">
        Reconnecting…
      </Notice>,
    );
    const strip = container.firstElementChild;
    expect(strip).toHaveClass("min-h-[33px]");
    expect(strip).toHaveClass("py-1");
    expect(strip).toHaveClass("border-b");
    // `min-h`, never `h`: the app-header.tsx:100-109 rule. A fixed height clips a future taller
    // child silently; a floor grows the band everywhere at once, which somebody has to look at.
    expect(strip?.className).not.toMatch(/(?:^|\s)h-\d/);
  });

  it("states the BOX floor at 42px, and lets a box grow above it", () => {
    // 24px first-line slot + py-2 (2x8px) + the box's own 2x1px border. 24+16+2 = 42. Growth above
    // the floor is correct — a two-line host-stale message needs two lines — but two ONE-LINE
    // boxes must not differ because one carries an icon and the other does not.
    const { container } = render(
      <Notice tone="info" variant="box">
        This host has not checked in.
      </Notice>,
    );
    const box = container.firstElementChild;
    expect(box).toHaveClass("min-h-[42px]");
    expect(box).toHaveClass("py-2");
    expect(box).toHaveClass("rounded-sm"); // 2px, the house corner — DESIGN.md §3
    expect(box?.className).not.toMatch(/(?:^|\s)h-\d/);
    // The first-line slot the floor is derived from, so a lone line sits optically centred against
    // a 24px slot instead of top-heavy while a wrapping body still starts at the top.
    expect(box).toHaveClass("items-start");
    expect(box?.querySelector(".min-h-6")).not.toBeNull();
  });

  it("sets no width on a BOX, so the gutter it asks the caller for survives", () => {
    // MEASURED, in Chrome, at a 390px viewport, with the caller's `mx-4` on the box itself:
    //   with `w-full`    → 390.0px wide, left edge 16px, right edge 16px PAST the viewport (clipped)
    //   without `w-full` → 358.0px wide, 16px of gutter on both sides
    // A margin does not shrink a percentage, it offsets it — so `w-full` and "the caller supplies
    // the gutter" are in direct contradiction, and the box asked for both. jsdom has no layout
    // engine, so what this file can pin is the cause rather than the 358: no width utility of any
    // kind on the box's shape string. A block-level flex container already fills its line box and
    // already shrinks by its own margins, so the absence is the whole fix — nothing replaces it.
    // (The STRIP keeps its `w-full` and needs it: that root can be a <button>, which sizes itself
    // to its content even at display:flex — 160px instead of 390px, measured — and a strip carries
    // no margin for a percentage to collide with, because its host owns the row.)
    const { container } = render(
      <Notice tone="caution" variant="box" className="mx-4">
        Read-only.
      </Notice>,
    );
    const box = container.firstElementChild;
    expect(box?.className).not.toMatch(/(?:^|\s)w-/);
    expect(box?.className).not.toMatch(/(?:^|\s)(?:min-w|max-w)-/);
    // The gutter the primitive asked for is still on the element that must honour it.
    expect(box).toHaveClass("mx-4");
    // The strip's is deliberate and stays; asserting it here keeps the two facts one decision.
    const strip = render(
      <Notice tone="caution" variant="strip">
        Reconnecting…
      </Notice>,
    ).container.firstElementChild;
    expect(strip).toHaveClass("w-full");
  });

  it("gives every tone the same box, with and without an action", () => {
    // The reason the floor exists at all: an outage row carrying Retry and an ambient
    // "Reconnecting…" row must be the same height, or the band changes size as the session
    // degrades. jsdom cannot measure, so what is pinned is the thing a later edit breaks — that
    // the geometry classes are identical across every tone and both interaction shapes.
    const geometry = (className: string) =>
      className
        .split(/\s+/)
        .filter((c) => /^(?:min-h-|py-|px-|items-|gap-|border-b$|flex$|text-xs$)/.test(c))
        .toSorted()
        .join(" ");

    const rows = TONES.flatMap((tone) => [
      render(
        <Notice tone={tone} variant="strip">
          copy
        </Notice>,
      ),
      render(
        <Notice tone={tone} variant="strip" action={<button type="button">Retry</button>}>
          copy
        </Notice>,
      ),
    ]).map(({ container }) => geometry(container.firstElementChild?.className ?? ""));

    expect(new Set(rows).size).toBe(1);
  });

  it("gives every tone a border WIDTH to go with its border colour", () => {
    // Tailwind v4's preflight sets `border: 0 solid` on everything, so a border colour with no
    // width paints nothing at all and nothing warns (DESIGN.md §7, trap 1). The width is reserved
    // in the shape strings and the tone supplies colour only — which also keeps the §2 rule: a
    // variant recolours an edge, it never adds one.
    for (const tone of TONES) {
      const strip = render(
        <Notice tone={tone} variant="strip">
          copy
        </Notice>,
      ).container.firstElementChild;
      expect(strip).toHaveClass("border-b");
      const box = render(
        <Notice tone={tone} variant="box">
          copy
        </Notice>,
      ).container.firstElementChild;
      expect(box?.className).toMatch(/(?:^|\s)border(?:\s|$)/);
    }
  });

  it("never wraps a strip: one truncating span, whatever the copy", () => {
    const { container } = render(
      <Notice tone="danger" variant="strip" icon={<svg />}>
        A very long outage explanation that would otherwise take a second line and change the band.
      </Notice>,
    );
    const truncating = container.querySelectorAll(".truncate");
    expect(truncating).toHaveLength(1);
    expect(truncating[0]).toHaveClass("min-w-0", "flex-1");
  });

  it("emits a role OR an aria-live, never both", () => {
    // THE CONTRADICTION THIS PRIMITIVE EXISTS TO MAKE INEXPRESSIBLE. A role carries its own
    // implicit liveness, so `role="alert"` (assertive) with `aria-live="polite"` asks for both at
    // once — which is live today at connection-banner.tsx:236-237. There is no prop that can ask
    // for the pair, and this asserts no code path emits it either.
    for (const announce of ["alert", "status"] as const) {
      const { container } = render(
        <Notice tone="danger" variant="strip" announce={announce}>
          copy
        </Notice>,
      );
      expect(container.querySelector(`[role="${announce}"]`)).not.toBeNull();
      expect(container.querySelector("[aria-live]")).toBeNull();
    }
  });

  it("claims no live region at all by default", () => {
    // Default "none": a notice that never changes — the prerelease strip is the case — must not
    // occupy a live region, or every route change re-announces a static build fact.
    const { container } = render(
      <Notice tone="info" variant="strip">
        alpha
      </Notice>,
    );
    expect(container.querySelector("[role]")).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("keeps the announcement off a whole-surface tap target, so it stays a button", () => {
    // The role rides the BODY rather than the root. On the `onActivate` shape the root is a real
    // <button>, and a role="status" on it would replace its button semantics in the accessibility
    // tree — the operator would be told there is a status line and not that it can be tapped.
    render(
      <Notice tone="info" variant="strip" announce="status" onActivate={() => {}}>
        A new version is ready
      </Notice>,
    );
    const button = screen.getByRole("button", { name: /new version/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toHaveAttribute("role");
    expect(button.querySelector('[role="status"]')).not.toBeNull();
  });

  it("makes the whole row the target when it is tappable — one button, no nesting", () => {
    render(
      <Notice tone="info" variant="strip" onActivate={() => {}}>
        Tap to update
      </Notice>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("refuses a dismiss control with no accessible name", () => {
    // `ui/` cannot call t(), so the word has to arrive from the feature side. The union makes
    // `dismissLabel` non-optional wherever `onDismiss` appears, so the nameless icon button is not
    // a thing a caller can write. See the type-level case below.
    render(
      <Notice tone="neutral" variant="box" onDismiss={() => {}} dismissLabel="Dismiss">
        The pane did not echo your text.
      </Notice>,
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("makes whole-surface tap exclusive with an action cluster, at the TYPE level", () => {
    // This case is checked by `cd web && bun run typecheck`, not at runtime: each @ts-expect-error
    // below fails the build if the combination it names ever becomes legal. A <button> wrapping a
    // <button> is invalid HTML and browsers disagree about which one a tap fires, so the exclusion
    // has to be unwritable rather than merely documented.
    const both = (
      // @ts-expect-error — `onActivate` excludes `action`: the whole surface IS the target.
      <Notice tone="info" variant="strip" onActivate={() => {}} action={<span>Retry</span>}>
        copy
      </Notice>
    );
    const unnamed = (
      // @ts-expect-error — `onDismiss` requires `dismissLabel`; an unnamed control is not offered.
      <Notice tone="neutral" variant="box" onDismiss={() => {}}>
        copy
      </Notice>
    );
    expect(both).toBeTruthy();
    expect(unnamed).toBeTruthy();
  });

  it("buys the action button's 44px floor as HIT area, at the measured inset", () => {
    // 11px, not the 10px that looks right. An absolutely positioned child resolves its insets
    // against the PADDING box, and ui/button.tsx reserves a 1px transparent border (DESIGN.md §2),
    // so an h-6 button's padding box is 22px: 22 + 2x10 = 42, the floor missed by 2px and nothing
    // to see. 22 + 2x11 = 44. Exactly the -7px/-6px arithmetic already documented at
    // STRIP_TAP_TARGET, one component over.
    expect(NOTICE_ACTION).toContain("h-6");
    expect(NOTICE_ACTION_TAP).toContain("before:-inset-y-[11px]");
    // Vertical only: the band stays 33px and the reach never fattens it.
    expect(NOTICE_ACTION_TAP).toContain("before:inset-x-0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Enforcement (proposal Q7). A source scan, in the app-header.test.tsx spirit of pinning a rule
// that spans files. The alert family regrew to six components because nothing stopped a seventh
// from being written; these assertions are that stop. They are file-scoped rather than line-scoped
// on purpose, so a comment that merely QUOTES a recipe cannot fail them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SRC = resolve(import.meta.dirname, "..", "..");

function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".tsx") && !p.endsWith(".test.tsx"))
    .map((p) => relative(SRC, join(SRC, p)).split(sep).join("/"));
}

describe("Notice — enforcement, so the alert family does not regrow", () => {
  it("keeps the tint recipe in ui/notice.tsx and nowhere else", () => {
    // Every component still carrying it is listed, by name, with the migration step that removes
    // it. Delete a line from this list when the component converts; a NEW name appearing here is
    // the seventh hand-rolled banner, and the answer is ui/notice.tsx.
    const allowed = new Set([
      "components/ui/notice.tsx", // the table itself
      "components/connection-banner.tsx", // migration step 4 (the top band, in one change)
      "components/update-ribbon.tsx", // migration step 4 (absorbed update-available-banner, M16/02)
      "components/host-stale-banner.tsx", // migration step 3
      "components/alpha-bar.tsx", // step 6, optional: not an alert, and already correct
    ]);
    const offenders = sources().filter((file) => {
      const text = readFileSync(join(SRC, file), "utf8");
      return /border-status-\w+\/40[\s\S]{0,40}bg-status-\w+\/15/.test(text) && !allowed.has(file);
    });
    expect(offenders, "use ui/notice.tsx — see DESIGN.md §1, the alert family").toEqual([]);
  });

  it("keeps the collapse idiom in ui/collapse.tsx and nowhere else", () => {
    // `grid-rows-[0fr]` is the height-animation technique, and a second copy of it is a second
    // set of timings to keep in step with the first.
    const allowed = new Set([
      "components/ui/collapse.tsx",
      "components/connection-banner.tsx", // migration step 4 deletes its private copy
    ]);
    const offenders = sources().filter(
      (file) => /grid-rows-\[0fr\]/.test(readFileSync(join(SRC, file), "utf8")) && !allowed.has(file),
    );
    expect(offenders, "use ui/collapse.tsx").toEqual([]);
  });

  it("never puts a role and an aria-live on the same element", () => {
    // The contradiction Notice makes inexpressible, checked for the components that have not
    // migrated yet. connection-banner.tsx is the known offender in two places and leaves in step 4.
    const allowed = new Set(["components/connection-banner.tsx"]);
    const offenders = sources().filter((file) => {
      if (allowed.has(file)) return false;
      const text = readFileSync(join(SRC, file), "utf8");
      // One JSX opening tag at a time: attributes only, no children, so a role on a parent and an
      // aria-live on a child are not confused for a single element.
      return [...text.matchAll(/<[A-Za-z][^>]*?>/gs)].some(
        (tag) => /\brole=/.test(tag[0]) && /\baria-live=/.test(tag[0]),
      );
    });
    expect(offenders, "a role carries its own liveness — pick one").toEqual([]);
  });
});

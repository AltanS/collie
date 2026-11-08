import { Component, lazy, Suspense } from "react";
import type { ComponentType, ReactNode } from "react";

import { CollieMark } from "@/components/collie-mark";
import type { MarkProps } from "@/components/mark-contract";
import { useMarkId } from "@/lib/mark";
import type { MarkId } from "@/lib/mark-ids";

// THE HEADER LOGO, wherever the app lets the device or a theme choose it. Every mark is generated
// upstream, sealed by a hash and implements one contract (`mark-contract.ts`), so this host is
// hand-written around them and takes the contract's props (`state`, `beads`, `turn`, `ref` and the
// rest) and hands every one to the mark it picks, `ref` included (React 19 passes it as a prop).
//
// WHICH MARK. The `mark` prop when given (the theme preview draws a theme's own mark whatever this
// device chose); otherwise `useMarkId()`, the one resolver (`lib/mark.ts`): device choice, then the
// worn theme's `mark`, then Collie.
//
// ONLY COLLIE IS IN THE ENTRY BUNDLE. The others are dynamic imports, so a device that never picks
// them never downloads them. They are named exports of their generated files and mapped to the
// `default` React.lazy wants. Until a chunk arrives the host draws an empty box of exactly the mark's
// size, so the header does not shift when the drawing lands. `preloadMark` starts the fetch early
// (at startup, and when a choice is made) so that box is rarely seen.
//
// WHAT STAYS THE COLLIE MARK. The boot splash, the idle lock, the agent-start handoff and the tour
// sheet import `CollieMark` directly and never call this. The favicon, the app icon and the splash
// image are files.

/** The pixel size a mark draws at when `size` is omitted (the contract's own default). */
const DEFAULT_SIZE = 32;

type ChunkedMarkId = Exclude<MarkId, "collie">;

/**
 * The import of a chunked mark, mapped to the `default` React.lazy wants. Called by `lazy` once and by
 * `preloadMark` any number of times: the module map caches the import. The only place those files
 * are named, and always as a dynamic import().
 */
function loadChunk(id: ChunkedMarkId) {
  switch (id) {
    case "kawaii":
      return import("./kawaii-mark").then((m) => ({ default: m.KawaiiMark }));
    case "kawaii-tilt":
      return import("./kawaii-tilt-mark").then((m) => ({ default: m.KawaiiTiltMark }));
    case "pixel":
      return import("./pixel-mark").then((m) => ({ default: m.PixelMark }));
    case "glass":
      return import("./glass-mark").then((m) => ({ default: m.GlassMark }));
    case "glass-front":
      return import("./glass-front-mark").then((m) => ({ default: m.GlassFrontMark }));
    case "sheep":
      return import("./sheep-mark").then((m) => ({ default: m.SheepMark }));
    case "owl":
      return import("./owl-mark").then((m) => ({ default: m.OwlMark }));
  }
}

/** One `lazy` per mark, made once: a fresh `lazy()` per render would suspend on every render. */
const LAZY = {
  kawaii: lazy(() => loadChunk("kawaii")),
  "kawaii-tilt": lazy(() => loadChunk("kawaii-tilt")),
  pixel: lazy(() => loadChunk("pixel")),
  glass: lazy(() => loadChunk("glass")),
  "glass-front": lazy(() => loadChunk("glass-front")),
  sheep: lazy(() => loadChunk("sheep")),
  owl: lazy(() => loadChunk("owl")),
} as const satisfies Record<ChunkedMarkId, ComponentType<MarkProps>>;

/**
 * The component of any registered mark, loaded. The conformance suite
 * (`mark-conformance.test.tsx`) iterates the registry through this, so a mark that is registered is a
 * mark that is held to the contract.
 */
export async function loadMark(id: MarkId): Promise<ComponentType<MarkProps>> {
  if (id === "collie") return CollieMark;
  return (await loadChunk(id)).default;
}

/**
 * Start fetching the chunk of `id`, so the first render finds it. Collie is in the entry bundle and
 * needs nothing. Never rejects: a failed preload is not an error of its own, because the render that
 * needs the chunk asks for it again and the app's chunk-reload handler (`lib/chunk-reload.ts`) sees
 * that failure.
 */
export async function preloadMark(id: MarkId): Promise<void> {
  if (id === "collie") return;
  try {
    await loadChunk(id);
  } catch {
    // Left to the render that needs the chunk (see above).
  }
}

/**
 * A chunk that cannot load draws the Collie mark instead.
 *
 * A rejected lazy import throws during render, and without this the nearest route boundary would
 * replace the whole page with an error for want of a logo. It happens for real: the chunks are not in
 * the precache (vite.config.ts, `marks/**`), and src/sw.ts empties their cache on every update, so a
 * phone offline right after an update has no copy. The Collie mark is in the entry bundle and always
 * draws. The app's chunk-reload handler still sees the failure and reloads once when it may.
 */
export class FallBackToCollie extends Component<{ props: MarkProps; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <CollieMark {...this.props.props} /> : this.props.children;
  }
}

export interface BrandMarkProps extends MarkProps {
  /** Draw this mark whatever the device and the theme say. Absent resolves it with `useMarkId()`. */
  mark?: MarkId;
}

export function BrandMark({ mark, ...props }: BrandMarkProps) {
  const resolved = useMarkId();
  const id = mark ?? resolved;
  if (id === "collie") return <CollieMark {...props} />;
  const Chunked = LAZY[id];
  const size = props.size ?? DEFAULT_SIZE;
  return (
    <FallBackToCollie key={id} props={props}>
      <Suspense fallback={<span aria-hidden="true" data-slot="brand-mark-pending" className="inline-block" style={{ width: size, height: size }} />}>
        <Chunked {...props} />
      </Suspense>
    </FallBackToCollie>
  );
}

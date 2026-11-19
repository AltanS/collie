import { AgentIcon } from "@/components/agent-icon";
import { CrossfadeImage } from "@/components/ui/crossfade-image";
import { paneRowKey } from "@/lib/hosts";
import { useProjectPicture } from "@/lib/project-picture";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// AN AGENT PANE'S TILE: the agent's logo, or the project's picture with the logo in its corner
// (issue 811, ADR 0160).
//
// The box is the size the caller gives (`size-4` on a row, `size-5` in the sidebar) and never changes,
// so a picture arriving or leaving moves nothing on the row. With a picture, the agent's own logo sits
// on the tile's TOP-right corner, small, so the harness is always visible: a picture can look like
// another agent's logo, but the corner is drawn by Collie. Top-right because the bottom-right corner is
// the status mark's wherever a tile carries one (the session header, the sidebar). The corner logo
// overhangs the tile by a quarter of its size and is absolute, so it takes no room; a ring in the colour
// it sits on (`surface`, a `ring-*` class) cuts it off the picture.
//
// The picture fades in and out by `CrossfadeImage`'s rules, keyed on the pane, so a reused row swaps at
// once. The tile is named by the logo it always draws: the picture itself is decorative.

/** The corner logo's size for each tile size this app draws, in Tailwind classes. */
function cornerFor(tile: string): string {
  if (tile.includes("size-8")) return "size-4 -top-1 -right-1 rounded-[3px]";
  if (tile.includes("size-7")) return "size-3.5 -top-1 -right-1 rounded-[3px]";
  if (tile.includes("size-5")) return "size-3 -top-1 -right-1 rounded-[2px]";
  return "size-2.5 -top-1 -right-1 rounded-[2px]";
}

export function AgentTile({
  pane,
  className = "size-4",
  surface = "ring-background",
  glide,
}: {
  pane: Pick<AgentView, "agent" | "paneId" | "picture" | "host" | "session">;
  /** The tile's size, a `size-*` class. */
  className?: string;
  /** The colour the tile sits on, as a `ring-*` class, for the corner logo's cut. */
  surface?: string;
  /** The tile's `data-glide` part name (lib/glide.ts). */
  glide?: string;
}) {
  const picture = useProjectPicture(pane);
  return (
    <span data-glide={glide} data-slot="agent-tile" data-picture={picture === null ? "off" : "on"} className={cn("relative inline-grid shrink-0", className)}>
      <CrossfadeImage
        src={picture}
        identity={paneRowKey(pane)}
        fallback={<AgentIcon agent={pane.agent} className="size-full" />}
        className="size-full rounded-sm"
        imgClassName="rounded-sm"
      />
      {picture !== null && <AgentIcon agent={pane.agent} className={cn("absolute ring-1", surface, cornerFor(className))} />}
    </span>
  );
}

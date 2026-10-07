// What a server document tells the browser about the page it drew: the snapshot, the config, the path
// and, on a pane page, the pane read its frames were drawn from. The S1/S2 document carries it as the
// `AppRoot` island's props (app-root.tsx); the S3 islands document carries it ONCE, in a
// `<script type="application/json" id="collie-boot">` (islands/document-data.ts), never in an island's
// props, so the snapshot is not repeated per island.
import type { BridgeConfig, PaneReadResponse, SnapshotResponse } from "@web/lib/types";

export interface DocumentProps {
  /** The page's path and query, mount taken off (the router's `context.url`). */
  path: string;
  /** The origin the server saw; the browser builds its URL on its own origin instead. */
  origin: string;
  /** The `/api/snapshot` body for this page's scope, as the poll would have read it. */
  snapshot: SnapshotResponse;
  /** When the bridge built that body (epoch ms): the freshness readers' `snapshotAt`. */
  snapshotAt: number;
  /** The `/api/config` body. */
  config: BridgeConfig;
  /**
   * A pane document's pane read and its ETag (S2): the frames are drawn from it, and the browser primes
   * the pane's store and the frames' ETag from it, so the first beat answers 304 when nothing moved.
   */
  pane?: { read: PaneReadResponse; etag: string | null; frames: boolean };
}

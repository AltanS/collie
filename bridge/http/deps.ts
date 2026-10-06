// What the HTTP layer is handed by `startServer`: the values it resolved once, and the closures it
// built over them.
//
// Every name here is the name the old `fetch` closure in server.ts read from its enclosing scope, so a
// handler that moved into `bridge/http/controllers/` reads `cfg`, `registry`, `opts.crewLead` and the
// rest exactly as it did before. Nothing here is per request; per-request values (the session name,
// the host selector, the resolver) are built by `./scope.ts`.

import type { createAccessGate } from "../access-jwt.ts";
import type { ActivityLedger } from "../activity.ts";
import type { AuditLog } from "../audit.ts";
import type { CacheWatchSurface } from "../cache/watch.ts";
import type { CacheWarnPane } from "../cache/watch-key.ts";
import type { Config } from "../config.ts";
import type { CrewRuntime } from "../crew/config.ts";
import type { CrewLead } from "../crew/lead.ts";
import type { CrewHandler } from "../crew/router.ts";
import type { FolderSurface } from "../folders.ts";
import type { LiveWindows } from "../journal/live.ts";
import type { TranscriptStore } from "../journal/store.ts";
import type { JournalAdapter } from "../journal/types.ts";
import type { MachineSurface } from "../machines.ts";
import type { NotifyPrefsStore } from "../notify-prefs.ts";
import type { createCacheRulesReader } from "../operator-cache-rules.ts";
import type { createOperatorCommands } from "../operator-commands.ts";
import type { createOperatorFonts } from "../operator-fonts.ts";
import type { createOperatorKeys } from "../operator-keys.ts";
import type { createOperatorLaunchers } from "../operator-launchers.ts";
import type { createOperatorQuickReplies } from "../operator-quick-replies.ts";
import type { PairingStore } from "../pairing.ts";
import type { Push } from "../push.ts";
import type { RefreshCoalescer } from "../refresh.ts";
import type { StartServerOptions } from "../server.ts";
import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { Snooze } from "../snooze.ts";
import type { createSttAdmission } from "../stt/http.ts";
import type { SttProvider } from "../stt/provider.ts";
import type {
  CacheWatchListResponse,
  CacheWatchResponse,
  DeviceAuth,
  PaneCache,
  SnapshotResponse,
  UpdateStatus,
} from "../types.ts";
import type { UpdateMonitor } from "../update.ts";

export interface BridgeHttp {
  /** The options `startServer` was called with, read as `opts.<field>` exactly as before. */
  readonly opts: StartServerOptions;
  readonly cfg: Config;
  readonly registry: SessionRegistry;
  readonly push: Push;
  readonly snooze: Snooze;
  readonly notifyPrefs: NotifyPrefsStore;
  readonly updateMonitor: UpdateMonitor;
  readonly audit: AuditLog;
  readonly activity: ActivityLedger;
  readonly crew: CrewRuntime;
  readonly cache: { get(sessionKey: string): PaneCache | undefined } | undefined;
  readonly pairing: PairingStore | undefined;
  readonly folders: FolderSurface | undefined;
  readonly machines: MachineSurface | undefined;
  readonly stt: () => Promise<SttProvider | null>;
  readonly sttAdmission: ReturnType<typeof createSttAdmission>;
  /** Who the requester is, across both device gates — see `requestDevice` in server.ts. */
  readonly whois: (req: Request) => DeviceAuth;
  readonly crewLead: CrewLead | undefined;
  readonly crewStatus: StartServerOptions["crewStatus"];
  readonly peerNotifier: StartServerOptions["peerNotifier"];
  readonly operatorCommands: ReturnType<typeof createOperatorCommands>;
  readonly operatorKeys: ReturnType<typeof createOperatorKeys>;
  readonly operatorQuickReplies: ReturnType<typeof createOperatorQuickReplies>;
  readonly operatorFonts: ReturnType<typeof createOperatorFonts>;
  readonly operatorLaunchers: ReturnType<typeof createOperatorLaunchers>;
  readonly operatorCacheRules: ReturnType<typeof createCacheRulesReader>;
  readonly journals: Record<string, JournalAdapter> | null;
  readonly transcripts: TranscriptStore | null;
  readonly live: LiveWindows | null;
  readonly refreshes: RefreshCoalescer;
  readonly lookNow: (rt: SessionRuntime) => Promise<void>;
  readonly localSnapshot: (
    sessionName: string | undefined,
    device: DeviceAuth | null,
    widen?: boolean,
  ) => SnapshotResponse | undefined;
  readonly localRuntime: (session: string | undefined, acceptEncoding: string | null) => SessionRuntime | Response;
  readonly cacheWatchBody: (watch: CacheWatchSurface, pane: CacheWarnPane) => CacheWatchResponse;
  readonly cacheWatchListBody: (watch: CacheWatchSurface) => CacheWatchListResponse;
  readonly updateStatusWithPeers: () => UpdateStatus;
  /** The crew surface, present only when a trust store exists. Its presence gates `?host=` parsing. */
  readonly crewHandler: CrewHandler | undefined;
  readonly accessGate: ReturnType<typeof createAccessGate>;
  /** The TCP peer of a request, from the kernel (`server.requestIP`), never from a header. */
  readonly requestIP: (req: Request) => { address: string } | null;
}

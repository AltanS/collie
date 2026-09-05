// The live wire is owned by the OMP extension. Keep this as a type-only import so the browser
// bundle carries neither extension code nor its owner-private discovery details.
export type {
  LiveCommand,
  LivePhase,
  LiveReply,
  LiveStatus,
  LiveTranscript,
} from "../../../bridge/live/types.ts";

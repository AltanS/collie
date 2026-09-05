import type { AgentSessionRef } from "../journal/types.ts";

export type LivePhase = "idle" | "connecting" | "listening" | "working" | "muted" | "error";

export interface LiveTranscript {
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

/** No credentials or local paths cross the browser boundary. */
export interface LiveStatus {
  available: boolean;
  phase: LivePhase;
  muted: boolean;
  transcripts: LiveTranscript[];
  error?: string;
}

export type LiveCommand =
  | { action: "offer"; requestId: string; sdp: string }
  | { action: "ready" | "heartbeat" | "stop"; requestId: string }
  | { action: "mute"; requestId: string; muted: boolean };

export interface LiveReply {
  ok: true;
  status: LiveStatus;
  sdp?: string;
}

/** Owner-only discovery record. Read by Collie, never returned to the browser. */
export interface LiveDescriptor {
  version: 1;
  pid: number;
  port: number;
  token: string;
  paneId: string;
  sessionId: string;
  sessionRef: AgentSessionRef;
}

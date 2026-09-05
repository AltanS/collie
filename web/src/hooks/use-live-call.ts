import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import type { LiveStatus } from "@/lib/live";
import { internScope, scopeKey, type Scope } from "@/lib/scope";

const CHANNEL_OPEN_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 10_000;
const OFFER_READY_TIMEOUT_MS = 45_000;

interface LiveTarget {
  paneId: string;
  scope: Scope;
}

interface LiveLease extends LiveTarget {
  requestId: string;
}

interface LiveResources {
  stream: MediaStream;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  onTrack: (event: RTCTrackEvent) => void;
  onConnectionStateChange: () => void;
  onChannelClose: () => void;
}

function statusWithError(status: LiveStatus | null, error: string): LiveStatus {
  return {
    available: status?.available ?? true,
    phase: "error",
    muted: status?.muted ?? false,
    transcripts: status?.transcripts ?? [],
    error,
  };
}

function browserFailure<TThrown>(error: TThrown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return t("live.error.permission");
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return t("live.error.microphone");
  }
  if (error instanceof TypeError) return t("live.error.network");
  return t("live.error.server", { error: describeThrownError(error) });
}

function waitForChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout = 0;
    const clear = () => {
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      window.clearTimeout(timeout);
    };
    const onOpen = () => {
      clear();
      resolve();
    };
    const onClose = () => {
      clear();
      reject(new Error(t("live.error.channelClosed")));
    };
    timeout = window.setTimeout(() => {
      clear();
      reject(new Error(t("live.error.readyTimeout")));
    }, CHANNEL_OPEN_TIMEOUT_MS);
    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("close", onClose, { once: true });
  });
}

function useLiveWakeLock(active: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let disposed = false;
    const release = () => {
      const lock = lockRef.current;
      lockRef.current = null;
      void lock?.release().catch(() => {});
    };
    const acquire = async () => {
      if (!active || disposed || document.visibilityState !== "visible" || !navigator.wakeLock) return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (disposed || !active || document.visibilityState !== "visible") {
          void lock.release().catch(() => {});
          return;
        }
        release();
        lockRef.current = lock;
      } catch {
        // Wake lock is a comfort only; a refused lock must not end a live call.
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
      else release();
    };

    if (active) {
      void acquire();
      document.addEventListener("visibilitychange", onVisibility);
    } else {
      release();
    }
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [active]);
}

export interface UseLiveCallOptions {
  paneId: string;
  scope?: Scope;
  disabled: boolean;
  onRemoteStream: (stream: MediaStream | null) => void;
}

export function useLiveCall({ paneId, scope, disabled, onRemoteStream }: UseLiveCallOptions) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const generationRef = useRef(0);
  const leaseRef = useRef<LiveLease | null>(null);
  const resourcesRef = useRef<LiveResources | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const heartbeatInFlightRef = useRef(false);
  const statusRef = useRef<LiveStatus | null>(null);
  const onRemoteStreamRef = useRef(onRemoteStream);
  const scopeId = scopeKey(scope);
  const normalizedScope = internScope(scope);

  useEffect(() => {
    onRemoteStreamRef.current = onRemoteStream;
  }, [onRemoteStream]);

  const publishStatus = useCallback((next: LiveStatus) => {
    const bounded = { ...next, transcripts: next.transcripts.slice(-8) };
    statusRef.current = bounded;
    setStatus(bounded);
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const closeResources = useCallback(() => {
    clearHeartbeat();
    const resources = resourcesRef.current;
    resourcesRef.current = null;
    if (resources === null) return;
    resources.peer.removeEventListener("track", resources.onTrack);
    resources.peer.removeEventListener("connectionstatechange", resources.onConnectionStateChange);
    resources.channel.removeEventListener("close", resources.onChannelClose);
    resources.channel.close();
    resources.peer.close();
    for (const track of resources.stream.getTracks()) track.stop();
    onRemoteStreamRef.current(null);
  }, [clearHeartbeat]);

  const sendStop = useCallback(async (lease: LiveLease, keepalive: boolean) => {
    try {
      await api.sendLiveCommand(lease.paneId, { action: "stop", requestId: lease.requestId }, lease.scope, keepalive);
    } catch {
      // Local teardown is complete even if the host is already unreachable.
    }
  }, []);

  const releaseLease = useCallback(
    (keepalive: boolean) => {
      const lease = leaseRef.current;
      leaseRef.current = null;
      if (lease !== null) void sendStop(lease, keepalive);
    },
    [sendStop],
  );

  const finish = useCallback(
    (keepalive: boolean) => {
      generationRef.current += 1;
      closeResources();
      setActive(false);
      setBusy(false);
      releaseLease(keepalive);
    },
    [closeResources, releaseLease],
  );

  const fail = useCallback(
    (generation: number, error: string) => {
      if (generationRef.current !== generation) return;
      finish(false);
      publishStatus(statusWithError(statusRef.current, error));
    },
    [finish, publishStatus],
  );

  useLiveWakeLock(active);

  useEffect(() => {
    let cancelled = false;
    const requestGeneration = generationRef.current;
    if (disabled) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    const loadStatus = async () => {
      try {
        const next = await api.fetchLiveStatus(paneId, normalizedScope);
        if (
          !cancelled &&
          generationRef.current === requestGeneration &&
          leaseRef.current === null
        ) {
          publishStatus(next);
        }
      } catch (error) {
        if (
          !cancelled &&
          generationRef.current === requestGeneration &&
          leaseRef.current === null
        ) {
          publishStatus(statusWithError(statusRef.current, browserFailure(error)));
        }
      } finally {
        if (!cancelled && generationRef.current === requestGeneration) setLoading(false);
      }
    };
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [disabled, normalizedScope, paneId, publishStatus]);

  useEffect(() => {
    if (disabled) finish(true);
  }, [disabled, finish]);

  useEffect(
    () => () => {
      finish(true);
    },
    [finish, paneId, scopeId],
  );

  useEffect(() => {
    const onPageHide = () => {
      finish(true);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [finish]);

  const start = useCallback(async () => {
    if (disabled || busy || active || statusRef.current?.available === false) return;
    if (!globalThis.isSecureContext) {
      publishStatus(statusWithError(statusRef.current, t("live.error.secureContext")));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      publishStatus(statusWithError(statusRef.current, t("live.error.mediaUnavailable")));
      return;
    }
    if (!globalThis.RTCPeerConnection || !globalThis.crypto?.randomUUID) {
      publishStatus(statusWithError(statusRef.current, t("live.error.webrtcUnavailable")));
      return;
    }

    const generation = ++generationRef.current;
    const requestId = globalThis.crypto.randomUUID();
    const lease: LiveLease = { paneId, scope: normalizedScope, requestId };
    leaseRef.current = lease;
    setBusy(true);
    publishStatus({
      available: statusRef.current?.available ?? true,
      phase: "connecting",
      muted: false,
      transcripts: statusRef.current?.transcripts ?? [],
    });

    let stream: MediaStream | null = null;
    const isCurrent = () =>
      generationRef.current === generation && leaseRef.current?.requestId === requestId;

    try {
      // This invocation stays in the tap's synchronous turn for mobile Safari's gesture policy.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!isCurrent()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      for (const track of stream.getAudioTracks()) track.enabled = false;

      const peer = new RTCPeerConnection();
      const channel = peer.createDataChannel("oai-events");
      const onTrack = (event: RTCTrackEvent) => {
        if (isCurrent()) onRemoteStreamRef.current(event.streams[0] ?? new MediaStream([event.track]));
      };
      const onConnectionStateChange = () => {
        if (
          isCurrent() &&
          (peer.connectionState === "disconnected" || peer.connectionState === "failed" || peer.connectionState === "closed")
        ) {
          fail(generation, t("live.error.disconnected"));
        }
      };
      const onChannelClose = () => {
        if (isCurrent()) fail(generation, t("live.error.channelClosed"));
      };
      const resources: LiveResources = { stream, peer, channel, onTrack, onConnectionStateChange, onChannelClose };
      resourcesRef.current = resources;
      peer.addEventListener("track", onTrack);
      peer.addEventListener("connectionstatechange", onConnectionStateChange);
      channel.addEventListener("close", onChannelClose);
      for (const track of stream.getTracks()) peer.addTrack(track, stream);

      const offer = await peer.createOffer();
      if (!isCurrent()) return;
      await peer.setLocalDescription(offer);
      if (!isCurrent()) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error(t("live.error.protocol"));
      const offered = await api.sendLiveCommand(
        paneId,
        { action: "offer", requestId, sdp },
        normalizedScope,
        false,
        OFFER_READY_TIMEOUT_MS,
      );
      if (!isCurrent()) return;
      publishStatus(offered.status);
      if (!offered.sdp) throw new Error(t("live.error.protocol"));
      await peer.setRemoteDescription({ type: "answer", sdp: offered.sdp });
      if (!isCurrent()) return;
      await waitForChannelOpen(channel);
      if (!isCurrent()) return;

      const ready = await api.sendLiveCommand(
        paneId,
        { action: "ready", requestId },
        normalizedScope,
        false,
        OFFER_READY_TIMEOUT_MS,
      );
      if (!isCurrent()) return;
      publishStatus(ready.status);
      if (ready.status.phase === "idle" || ready.status.phase === "error") {
        fail(generation, ready.status.error ?? t("live.error.disconnected"));
        return;
      }
      for (const track of stream.getAudioTracks()) track.enabled = !ready.status.muted;
      setActive(true);
      heartbeatRef.current = window.setInterval(() => {
        const heartbeat = async () => {
          if (!isCurrent() || heartbeatInFlightRef.current) return;
          heartbeatInFlightRef.current = true;
          try {
            const reply = await api.sendLiveCommand(paneId, { action: "heartbeat", requestId }, normalizedScope);
            if (!isCurrent()) return;
            publishStatus(reply.status);
            if (reply.status.phase === "idle" || reply.status.phase === "error") {
              fail(generation, reply.status.error ?? t("live.error.disconnected"));
            }
          } catch (error) {
            if (isCurrent()) fail(generation, browserFailure(error));
          } finally {
            heartbeatInFlightRef.current = false;
          }
        };
        void heartbeat();
      }, HEARTBEAT_MS);
    } catch (error) {
      if (isCurrent()) fail(generation, browserFailure(error));
      else if (stream !== null) {
        for (const track of stream.getTracks()) track.stop();
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [active, busy, disabled, fail, normalizedScope, paneId, publishStatus]);

  const stop = useCallback(() => {
    if (leaseRef.current === null && resourcesRef.current === null) return;
    finish(false);
  }, [finish]);

  const setMuted = useCallback(
    async (muted: boolean) => {
      const generation = generationRef.current;
      const lease = leaseRef.current;
      if (!active || lease === null || busy) return;
      for (const track of resourcesRef.current?.stream.getAudioTracks() ?? []) track.enabled = !muted;
      setBusy(true);
      try {
        const reply = await api.sendLiveCommand(lease.paneId, { action: "mute", requestId: lease.requestId, muted }, lease.scope);
        if (generationRef.current !== generation || leaseRef.current?.requestId !== lease.requestId) return;
        publishStatus(reply.status);
        if (reply.status.phase === "idle" || reply.status.phase === "error") {
          fail(generation, reply.status.error ?? t("live.error.disconnected"));
        }
      } catch (error) {
        if (generationRef.current === generation && leaseRef.current?.requestId === lease.requestId) {
          fail(generation, browserFailure(error));
        }
      } finally {
        if (generationRef.current === generation && leaseRef.current?.requestId === lease.requestId) setBusy(false);
      }
    },
    [active, busy, fail, publishStatus],
  );

  return { status, loading, busy, active, start, stop, setMuted };
}

import { expect, test } from "bun:test";

import { ActivityLedger } from "./activity.ts";
import { AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import type { EventPoker } from "./event-poker.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { NotificationCoordinator } from "./notifications.ts";
import type { NotifyPrefsStore } from "./notify-prefs.ts";
import type { Push } from "./push.ts";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_TRANSCRIPTION_BYTES,
  VOICE_REQUEST_IDLE_TIMEOUT_SECONDS,
  startServer,
} from "./server.ts";
import { SessionRegistry } from "./sessions.ts";
import type { Snooze } from "./snooze.ts";
import type { StateEngine } from "./state-engine.ts";
import type { Transcriber } from "./transcription.ts";
import type { UpdateMonitor } from "./update.ts";

function testConfig(): Config {
  return {
    socketPath: "/tmp/collie-transcription-test/herdr.sock",
    port: 0,
    host: "127.0.0.1",
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: false,
    journalRoots: { claude: ["/tmp/claude"], codex: ["/tmp/codex"], pi: ["/tmp/pi"], opencode: ["/tmp/opencode"] },
    submitKeys: ["Enter"],
    trustedUser: "",
    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    publicHosts: [],
    transcription: null,
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:test@example.com",
    stateDir: "/tmp/collie-transcription-test/state",
    multiSession: false,
    skipServe: false,
  };
}

function registryWithPanes(paneIds: string[]): SessionRegistry {
  const engine = {
    current: () => ({
      agents: paneIds.map((paneId) => ({ paneId })),
      shellPanes: [],
      workspaces: [],
      tabs: [],
      bridge: "connected",
    }),
    stop: () => {},
  } as unknown as StateEngine;
  return new SessionRegistry({
    configRoot: "/tmp/collie-transcription-test",
    primarySocketPath: "/tmp/collie-transcription-test/herdr.sock",
    factory: () => ({
      herdr: {} as HerdrClient,
      engine,
      poker: { stop: () => {} } as EventPoker,
      notifications: { clearAll: () => {} } as NotificationCoordinator,
    }),
    multiSession: false,
    listSessionDirs: () => [],
    exists: () => false,
  });
}

function audioForm(bytes = 5): FormData {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(bytes)], "recording.webm", { type: "audio/webm" }),
  );
  form.append("duration_ms", "1000");
  return form;
}

function startVoiceServer(
  paneIds: string[],
  transcriber: Transcriber | null,
  seen: string[],
  audit: AuditLog = new AuditLog(() => {}),
) {
  return startServer({
    cfg: testConfig(),
    registry: registryWithPanes(paneIds),
    push: {} as Push,
    snooze: {} as Snooze,
    notifyPrefs: {} as NotifyPrefsStore,
    updateMonitor: {} as UpdateMonitor,
    audit,
    activity: { noteSeen: (_session: string, paneId: string) => seen.push(paneId) } as unknown as ActivityLedger,
    transcriber,
  });
}

test("rejects an unknown transcription pane before parsing audio, invoking the provider, marking activity, or auditing", async () => {
  let transcriberCalls = 0;
  const seen: string[] = [];
  const auditLines: string[] = [];
  const server = startVoiceServer(
    ["w1:known"],
    {
      transcribe: () => {
        transcriberCalls += 1;
        return Promise.resolve("must not run");
      },
    },
    seen,
    new AuditLog((line) => void auditLines.push(line)),
  );

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Amissing/transcribe`, {
      method: "POST",
      body: audioForm(),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "pane not found" });
    expect(transcriberCalls).toBe(0);
    expect(seen).toEqual([]);
    expect(auditLines).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("does not audit rejected access or an unknown session", async () => {
  let transcriberCalls = 0;
  const seen: string[] = [];
  const auditLines: string[] = [];
  const server = startVoiceServer(
    ["w1:known"],
    {
      transcribe: () => {
        transcriberCalls += 1;
        return Promise.resolve("must not run");
      },
    },
    seen,
    new AuditLog((line) => void auditLines.push(line)),
  );

  try {
    const denied = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: audioForm(),
    });
    expect(denied.status).toBe(403);

    const unknownSession = await fetch(
      `http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe?session=missing`,
      { method: "POST", body: audioForm() },
    );
    expect(unknownSession.status).toBe(404);
    expect(transcriberCalls).toBe(0);
    expect(seen).toEqual([]);
    expect(auditLines).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("accepts an exact 8 MiB multipart recording within the global body cap", async () => {
  let transcriberCalls = 0;
  const seen: string[] = [];
  const server = startVoiceServer(
    ["w1:known"],
    {
      transcribe: () => {
        transcriberCalls += 1;
        return Promise.resolve("editable transcript");
      },
    },
    seen,
  );

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      body: audioForm(MAX_TRANSCRIPTION_BYTES),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, text: "editable transcript" });
    expect(transcriberCalls).toBe(1);
    expect(seen).toEqual(["w1:known"]);
  } finally {
    await server.stop(true);
  }
}, 20_000);

test("Bun runtime body rejection can occur below the handler and therefore has no terminal audit", async () => {
  let transcriberCalls = 0;
  const seen: string[] = [];
  const auditLines: string[] = [];
  const server = startVoiceServer(
    ["w1:known"],
    {
      transcribe: () => {
        transcriberCalls += 1;
        return Promise.resolve("must not run");
      },
    },
    seen,
    new AuditLog((line) => void auditLines.push(line)),
  );

  try {
    // The multipart framing takes this over Bun's fixed 12 MiB maxRequestBodySize before the route
    // can admit or audit it. This intentionally differs from a handler-level declared-size 413.
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      body: audioForm(MAX_REQUEST_BODY_BYTES),
    });
    expect(response.status).toBe(413);
    expect(transcriberCalls).toBe(0);
    expect(seen).toEqual([]);
    expect(auditLines).toEqual([]);
  } finally {
    await server.stop(true);
  }
}, 20_000);

test("holds two admitted provider calls, returns one busy response, and releases capacity after completion", async () => {
  const seen: string[] = [];
  const auditLines: string[] = [];
  let calls = 0;
  let firstReady!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstReady = () => resolve();
  });
  let secondReady!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    secondReady = () => resolve();
  });
  let releaseFirst!: (text: string) => void;
  let releaseSecond!: (text: string) => void;
  const server = startVoiceServer(
    ["w1:known"],
    {
      transcribe: () => {
        calls += 1;
        if (calls === 1) {
          firstReady();
          return new Promise<string>((resolve) => {
            releaseFirst = resolve;
          });
        }
        if (calls === 2) {
          secondReady();
          return new Promise<string>((resolve) => {
            releaseSecond = resolve;
          });
        }
        return Promise.resolve("after release");
      },
    },
    seen,
    new AuditLog((line) => void auditLines.push(line)),
  );

  try {
    const first = fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      body: audioForm(),
    });
    await firstStarted;
    const second = fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      body: audioForm(),
    });
    await secondStarted;

    const busy = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      body: audioForm(),
    });
    expect(busy.status).toBe(429);
    await expect(busy.json()).resolves.toEqual({ ok: false, error: "transcription busy" });
    expect(calls).toBe(2);

    releaseFirst("first complete");
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    const afterRelease = await fetch(
      `http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`,
      { method: "POST", body: audioForm() },
    );
    expect(afterRelease.status).toBe(200);
    expect(calls).toBe(3);
    releaseSecond("second complete");
    expect((await second).status).toBe(200);

    const details = auditLines.map((line) =>
      (JSON.parse(line) as { action: string; detail: Record<string, unknown> }).detail,
    );
    expect(details).toHaveLength(4);
    expect(details.filter((detail) => detail.outcome === "busy")).toHaveLength(1);
    expect(details.filter((detail) => detail.outcome === "ok")).toHaveLength(3);
    expect(seen).toEqual(["w1:known", "w1:known", "w1:known"]);
  } finally {
    await server.stop(true);
  }
});

test("sets the 90-second idle allowance before body parsing while provider work remains independently bounded", async () => {
  const delayMs = 15_000;
  const seen: string[] = [];
  let transcriberCalls = 0;
  const server = startVoiceServer(
    ["w1:known"],
    {
      async transcribe() {
        transcriberCalls += 1;
        await Bun.sleep(delayMs);
        return "editable transcript";
      },
    },
    seen,
  );

  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      body: audioForm(),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, text: "editable transcript" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(delayMs - 1_000);
    expect(transcriberCalls).toBe(1);
    expect(seen).toEqual(["w1:known"]);
  } finally {
    await server.stop(true);
  }
}, 25_000);

// This is deliberately opt-in: Bun 1.3.14's idle timer is coarse rather than an exact wall-clock
// boundary. A 91.007s gap reached the provider and a scaled probe closed about two seconds late, so
// this fixed three-second tolerance conservatively tests a gap beyond the nominal 90-second setting
// without claiming exact enforcement. Run `COLLIE_TEST_BUN_IDLE_BOUNDARY=1 bun test bridge/server.integration.test.ts`.
const BUN_IDLE_SCHEDULING_TOLERANCE_SECONDS = 3;
const idleBoundaryTest = process.env.COLLIE_TEST_BUN_IDLE_BOUNDARY === "1" ? test : test.skip;
idleBoundaryTest("cuts off a multipart body beyond Bun's nominal idle allowance and scheduling tolerance", async () => {
  let transcriberCalls = 0;
  const seen: string[] = [];
  const server = startVoiceServer(
    ["w1:known"],
    {
      transcribe: () => {
        transcriberCalls += 1;
        return Promise.resolve("must not run");
      },
    },
    seen,
  );
  const boundary = "----collie-idle-boundary";
  const encoder = new TextEncoder();
  let sentOpening = false;
  let cancelled = false;
  const idleMs = (VOICE_REQUEST_IDLE_TIMEOUT_SECONDS + BUN_IDLE_SCHEDULING_TOLERANCE_SECONDS + 1) * 1000;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sentOpening) return;
      sentOpening = true;
      controller.enqueue(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
            "Content-Type: audio/webm\r\n\r\naudio",
        ),
      );
      void Bun.sleep(idleMs).then(() => {
        if (cancelled) return;
        try {
          controller.enqueue(
            encoder.encode(
              `\r\n--${boundary}\r\nContent-Disposition: form-data; name="duration_ms"\r\n\r\n1000\r\n--${boundary}--\r\n`,
            ),
          );
          controller.close();
        } catch {
          // The idle timeout can close the client stream before this delayed tail is due.
        }
      });
    },
    cancel() {
      cancelled = true;
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Aknown/transcribe`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    }).catch(() => null);
    expect(response?.status).not.toBe(200);
    expect(transcriberCalls).toBe(0);
  } finally {
    await server.stop(true);
  }
}, 110_000);

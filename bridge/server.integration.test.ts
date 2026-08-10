import { expect, test } from "bun:test";

import { ActivityLedger } from "./activity.ts";
import { AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import type { EventPoker } from "./event-poker.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { NotificationCoordinator } from "./notifications.ts";
import type { NotifyPrefsStore } from "./notify-prefs.ts";
import type { Push } from "./push.ts";
import { startServer } from "./server.ts";
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
    journalRoots: { claude: "/tmp/claude", codex: "/tmp/codex", pi: "/tmp/pi", opencode: "/tmp/opencode" },
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

function audioForm(): FormData {
  const form = new FormData();
  form.append("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));
  form.append("duration_ms", "1000");
  return form;
}

function startVoiceServer(paneIds: string[], transcriber: Transcriber, seen: string[]) {
  return startServer({
    cfg: testConfig(),
    registry: registryWithPanes(paneIds),
    push: {} as Push,
    snooze: {} as Snooze,
    notifyPrefs: {} as NotifyPrefsStore,
    updateMonitor: {} as UpdateMonitor,
    audit: new AuditLog(() => {}),
    activity: { noteSeen: (_session: string, paneId: string) => seen.push(paneId) } as unknown as ActivityLedger,
    transcriber,
  });
}

test("rejects an unknown transcription pane before parsing audio, invoking the provider, or marking activity", async () => {
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

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/w1%3Amissing/transcribe`, {
      method: "POST",
      body: audioForm(),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "pane not found" });
    expect(transcriberCalls).toBe(0);
    expect(seen).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("extends only validated transcription provider work past Bun's default route timeout", async () => {
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

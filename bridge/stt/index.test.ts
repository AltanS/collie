import { describe, expect, test } from "bun:test";

import type { OperatorFileIo } from "../operator-file.ts";
import type { SttSettings } from "./config.ts";
import { createSttGate, createSttProvider } from "./index.ts";
import type { SttProvider, SttResult, SttStatus } from "./provider.ts";

// The gate is where a settings file becomes a provider, and for the codex provider that provider
// owns a long-running child. So the thing under test here is the CACHE: one provider per distinct
// settings value, the outgoing one closed as the new one is built, and nothing rebuilt because a
// poll happened.

/** A fake disk holding one `stt.json`, with its mtime under the test's control. */
function fakeIo() {
  const io: OperatorFileIo & { text: string | null; mtime_: number } = {
    text: null,
    mtime_: 1,
    async mtime() {
      return io.text === null ? null : io.mtime_;
    },
    async read() {
      if (io.text === null) throw new Error("ENOENT");
      return io.text;
    },
  };
  return io;
}

interface Built {
  settings: SttSettings;
  provider: SttProvider;
  closes: number;
}

/** A provider that does nothing but remember that it was built and that it was closed. */
function tracker() {
  const built: Built[] = [];
  const create = (settings: SttSettings): SttProvider => {
    const record: Built = {
      settings,
      closes: 0,
      provider: {
        id: settings.provider,
        status: async (): Promise<SttStatus> => ({ available: true }),
        transcribe: async (): Promise<SttResult> => ({ text: "" }),
        close: () => {
          record.closes += 1;
        },
      },
    };
    built.push(record);
    return record.provider;
  };
  return { built, create };
}

/** Write one settings document and move the mtime, the way `collie stt setup` would. */
function put(io: ReturnType<typeof fakeIo>, document: Record<string, string>) {
  io.text = JSON.stringify(document);
  io.mtime_ += 1;
}

describe("the stt gate — one provider per distinct settings value", () => {
  test("an unchanged file hands back the very same provider, poll after poll", async () => {
    const io = fakeIo();
    const { built, create } = tracker();
    const gate = createSttGate({ stateDir: "/s", warn: () => {}, env: {}, io, create });

    put(io, { provider: "codex" });
    const first = await gate();
    expect(await gate()).toBe(first!);
    expect(await gate()).toBe(first!);
    expect(built).toHaveLength(1);
    expect(built[0]!.closes).toBe(0);
  });

  test("changed settings CLOSE the outgoing provider before the new one is built", async () => {
    const io = fakeIo();
    const { built, create } = tracker();
    const gate = createSttGate({ stateDir: "/s", warn: () => {}, env: {}, io, create });

    put(io, { provider: "codex" });
    await gate();
    put(io, { provider: "codex", codexBin: "/opt/codex/bin/codex" });
    await gate();

    expect(built).toHaveLength(2);
    expect(built[0]!.closes).toBe(1);
    expect(built[1]!.closes).toBe(0);
    expect(built[1]!.settings).toEqual({
      provider: "codex",
      codexBin: "/opt/codex/bin/codex",
      wireIdentity: "honest",
    });
  });

  test("a rewritten file that says the same thing does NOT replace the provider", async () => {
    const io = fakeIo();
    const { built, create } = tracker();
    const gate = createSttGate({ stateDir: "/s", warn: () => {}, env: {}, io, create });

    put(io, { provider: "codex" });
    const first = await gate();
    put(io, { provider: "codex" }); // same content, new mtime
    expect(await gate()).toBe(first!);
    expect(built).toHaveLength(1);
  });

  test("switching the feature off closes what was open", async () => {
    const io = fakeIo();
    const { built, create } = tracker();
    const gate = createSttGate({ stateDir: "/s", warn: () => {}, env: {}, io, create });

    put(io, { provider: "codex" });
    await gate();
    io.text = null;

    expect(await gate()).toBeNull();
    expect(built[0]!.closes).toBe(1);
  });

  test("close at shutdown closes the live provider, and twice is harmless", async () => {
    const io = fakeIo();
    const { built, create } = tracker();
    const gate = createSttGate({ stateDir: "/s", warn: () => {}, env: {}, io, create });

    put(io, { provider: "codex" });
    await gate();
    gate.close();
    gate.close();

    expect(built[0]!.closes).toBe(1);
  });
});

describe("the stt gate — which provider the settings name", () => {
  test("codex settings build the codex provider", () => {
    const provider = createSttProvider({ provider: "codex", codexBin: "codex", wireIdentity: "honest" });
    expect(provider.id).toBe("codex");
    // Built, and nothing spawned: `close` on a cold broker must be a no-op, not a throw.
    provider.close?.();
  });

  test("openai-compatible settings build the openai-compatible provider, which holds nothing open", () => {
    const provider = createSttProvider({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9000/v1",
      model: "whisper-1",
    });
    expect(provider.id).toBe("openai-compatible");
    expect(provider.close).toBeUndefined();
  });
});

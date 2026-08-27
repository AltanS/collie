import { describe, expect, test } from "bun:test";

import type { OperatorFileIo } from "../operator-file.ts";
import type { OpenAiSttSettings, SttSettings } from "./config.ts";
import {
  DEFAULT_CODEX_BIN,
  DEFAULT_STT_MODEL,
  STT_FILENAME,
  coerceSttFile,
  createSttSettingsReader,
  resolveSttSettings,
  sttEnvSettings,
  sttSettingsPath,
} from "./config.ts";

// The settings half of speech-to-text: what an operator wrote on disk, what the deployment set in
// the environment, and which of the two wins. Every case here is pure — the one disk touch is the
// injected {@link OperatorFileIo}, which is the same seam the operator TOML readers use.

const NO_ENV = {};

/**
 * The openai-compatible arm of the union, asserted rather than assumed.
 *
 * The resolver became a two-provider switch when the codex provider landed, so a test that means to
 * read `baseUrl` now has to say which arm it expected — and fails loudly on the wrong one instead of
 * reading `undefined`.
 */
function openAi(settings: SttSettings | null): OpenAiSttSettings {
  expect(settings?.provider).toBe("openai-compatible");
  // SAFETY: the assertion above has already failed the test if this is anything but that arm.
  return settings as OpenAiSttSettings;
}

/** Collect the warnings a resolve emitted, so a refusal can be asserted as a refusal-with-a-reason. */
function collectWarnings() {
  const lines: string[] = [];
  return { warn: (m: string) => lines.push(m), lines };
}

describe("stt settings — the file", () => {
  test("a complete file resolves to a provider", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "whisper-1",
        apiKey: "sk-test",
      }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(settings).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      apiKey: "sk-test",
    });
    expect(lines).toEqual([]);
  });

  test("an absent model resolves to Collie's default rather than becoming a second switch", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://box.tailnet.ts.net:9000/v1" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(openAi(settings).model).toBe(DEFAULT_STT_MODEL);
  });

  test("a keyless self-hosted endpoint is a supported mode — the field is ABSENT, not empty", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://127.0.0.1:9000/v1" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(settings).not.toBeNull();
    expect("apiKey" in settings!).toBe(false);
    expect(lines).toEqual([]);
  });

  test("a trailing slash is canonicalised away, so the endpoint has one spelling", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://127.0.0.1:9000/v1///" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(openAi(settings).baseUrl).toBe("http://127.0.0.1:9000/v1");
  });

  test("configuring nothing is off, in silence", () => {
    const { warn, lines } = collectWarnings();
    expect(resolveSttSettings(coerceSttFile(null), sttEnvSettings(NO_ENV), warn)).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe("stt settings — the spoken language", () => {
  test("no language at all is auto-detect: the field is ABSENT, not empty", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://127.0.0.1:9000/v1" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(settings).not.toBeNull();
    expect("language" in settings!).toBe(false);
    expect(lines).toEqual([]);
  });

  test("a two-letter code is kept, lower-cased", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://127.0.0.1:9000/v1", language: "EN" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(openAi(settings).language).toBe("en");
  });

  test("a regional tag is narrowed to its base language, which is all the endpoint takes", () => {
    const { warn } = collectWarnings();
    for (const [written, sent] of [
      ["en-GB", "en"],
      ["pt_BR", "pt"],
      ["de-DE", "de"],
    ]) {
      const settings = resolveSttSettings(
        coerceSttFile({ baseUrl: "http://127.0.0.1:9000/v1", language: written }),
        sttEnvSettings(NO_ENV),
        warn,
      );
      expect(openAi(settings).language).toBe(sent!);
    }
  });

  test("the environment overrides the file's language", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://127.0.0.1:9000/v1", language: "de" }),
      sttEnvSettings({ COLLIE_STT_LANG: "tr" }),
      warn,
    );

    expect(openAi(settings).language).toBe("tr");
  });

  test("a language alone configures the feature — it is not a field only a URL can unlock", () => {
    const { warn, lines } = collectWarnings();
    expect(
      resolveSttSettings(coerceSttFile({ language: "en" }), sttEnvSettings(NO_ENV), warn),
    ).toBeNull();
    // Refused for the MISSING ENDPOINT, not ignored — the language was seen.
    expect(lines.join(" ")).toContain("no endpoint configured");
  });

  test("a language that is not a code refuses, rather than being sent and ignored", () => {
    for (const bad of ["english", "eng", "e", "en-", "12"]) {
      const { warn, lines } = collectWarnings();
      expect(
        resolveSttSettings(
          coerceSttFile({ baseUrl: "http://127.0.0.1:9000/v1", language: bad }),
          sttEnvSettings(NO_ENV),
          warn,
        ),
      ).toBeNull();
      expect(lines.join(" ")).toContain("ISO-639-1");
    }
  });

  test("the codex provider resolves with a language in the file, and never carries one", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ provider: "codex", language: "en" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(settings).toEqual({
      provider: "codex",
      codexBin: DEFAULT_CODEX_BIN,
      wireIdentity: "honest",
    });
    expect(lines).toEqual([]);
  });
});

describe("stt settings — invalid shapes refuse loudly and stay off", () => {
  test("a non-http endpoint is refused, so a settings typo cannot become a local read", () => {
    const { warn, lines } = collectWarnings();
    expect(
      resolveSttSettings(coerceSttFile({ baseUrl: "file:///etc/passwd" }), sttEnvSettings(NO_ENV), warn),
    ).toBeNull();
    expect(lines.join(" ")).toContain("http(s)");
  });

  test("an unparseable endpoint is refused", () => {
    const { warn, lines } = collectWarnings();
    expect(
      resolveSttSettings(coerceSttFile({ baseUrl: "not a url" }), sttEnvSettings(NO_ENV), warn),
    ).toBeNull();
    expect(lines.join(" ")).toContain("http(s)");
  });

  test("an unknown provider is refused rather than silently treated as the default", () => {
    const { warn, lines } = collectWarnings();
    expect(
      resolveSttSettings(
        coerceSttFile({ provider: "whisper.cpp", baseUrl: "http://127.0.0.1:9000/v1" }),
        sttEnvSettings(NO_ENV),
        warn,
      ),
    ).toBeNull();
    expect(lines.join(" ")).toContain("whisper.cpp");
  });

  test("a keyless request to OpenAI's own API is refused BEFORE any audio is uploaded", () => {
    const { warn, lines } = collectWarnings();
    expect(
      resolveSttSettings(
        coerceSttFile({ baseUrl: "https://api.openai.com/v1" }),
        sttEnvSettings(NO_ENV),
        warn,
      ),
    ).toBeNull();
    expect(lines.join(" ")).toContain("COLLIE_STT_KEY");
  });

  test("a key without an endpoint is a half-configured install, and says so", () => {
    const { warn, lines } = collectWarnings();
    expect(resolveSttSettings(coerceSttFile({ apiKey: "sk-x" }), sttEnvSettings(NO_ENV), warn)).toBeNull();
    expect(lines.join(" ")).toContain("no endpoint configured");
  });

  test("wrong-typed and blank fields degrade to unset, never to a stringified object", () => {
    expect(coerceSttFile({ baseUrl: 42, model: ["a"], apiKey: "   ", provider: null })).toEqual({
      provider: undefined,
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
    });
  });

  test("a scalar or an array where the document belongs is simply no settings", () => {
    expect(coerceSttFile("nope")).toEqual({});
    expect(coerceSttFile([1, 2])).toEqual({});
    expect(coerceSttFile(undefined)).toEqual({});
  });
});

describe("stt settings — the codex provider", () => {
  test("naming the provider is the whole configuration; the rest has defaults", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(coerceSttFile({ provider: "codex" }), sttEnvSettings(NO_ENV), warn);

    expect(settings).toEqual({ provider: "codex", codexBin: DEFAULT_CODEX_BIN, wireIdentity: "honest" });
    expect(lines).toEqual([]);
  });

  test("the environment alone switches provider, with no file at all", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile(undefined),
      sttEnvSettings({ COLLIE_STT_PROVIDER: "codex" }),
      warn,
    );

    expect(settings?.provider).toBe("codex");
    expect(lines).toEqual([]);
  });

  test("the binary and the recorded identity are read from the file", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ provider: "codex", codexBin: "/opt/codex/bin/codex", wireIdentity: "codex-cli" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(settings).toEqual({
      provider: "codex",
      codexBin: "/opt/codex/bin/codex",
      wireIdentity: "codex-cli",
    });
  });

  test("each codex env key overrides its file field", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ provider: "codex", codexBin: "old-codex", wireIdentity: "honest" }),
      sttEnvSettings({ COLLIE_CODEX_BIN: "new-codex", COLLIE_STT_WIRE_IDENTITY: "codex-cli" }),
      warn,
    );

    expect(settings).toEqual({ provider: "codex", codexBin: "new-codex", wireIdentity: "codex-cli" });
  });

  test("the environment can switch a codex file BACK to openai-compatible", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ provider: "codex" }),
      sttEnvSettings({ COLLIE_STT_PROVIDER: "openai-compatible", COLLIE_STT_URL: "http://127.0.0.1:9000/v1" }),
      warn,
    );

    expect(settings?.provider).toBe("openai-compatible");
  });

  test("an unreadable wire identity is refused, never quietly read as honest", () => {
    const { warn, lines } = collectWarnings();
    expect(
      resolveSttSettings(
        coerceSttFile({ provider: "codex", wireIdentity: "chrome" }),
        sttEnvSettings(NO_ENV),
        warn,
      ),
    ).toBeNull();
    expect(lines.join(" ")).toContain("chrome");
    expect(lines.join(" ")).toContain("collie stt setup");
  });

  test("naming the binary alone is enough to configure the feature", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ codexBin: "/opt/codex/bin/codex" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    // No provider was named, so the default one applies — and it needs an endpoint it has not got.
    expect(settings).toBeNull();
    expect(lines.join(" ")).toContain("no endpoint configured");
  });

  test("an endpoint left over from the other provider is ignored, not an error", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ provider: "codex", baseUrl: "https://api.openai.com/v1", apiKey: "sk-old" }),
      sttEnvSettings(NO_ENV),
      warn,
    );

    expect(settings).toEqual({ provider: "codex", codexBin: DEFAULT_CODEX_BIN, wireIdentity: "honest" });
    expect(lines).toEqual([]);
  });
});

describe("stt settings — the environment wins, field by field", () => {
  test("each env key overrides its file field and leaves the others alone", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://old:1/v1", model: "old-model", apiKey: "old-key" }),
      sttEnvSettings({ COLLIE_STT_URL: "http://new:2/v1", COLLIE_STT_KEY: "new-key" }),
      warn,
    );

    expect(settings).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://new:2/v1",
      model: "old-model",
      apiKey: "new-key",
    });
  });

  test("the environment alone configures the feature, with no file at all", () => {
    const { warn, lines } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile(undefined),
      sttEnvSettings({ COLLIE_STT_URL: "http://127.0.0.1:9000/v1", COLLIE_STT_MODEL: "whisper-1" }),
      warn,
    );

    expect(settings).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9000/v1",
      model: "whisper-1",
    });
    expect(lines).toEqual([]);
  });

  test("a blank env value is not a value — it does not override the file", () => {
    const { warn } = collectWarnings();
    const settings = resolveSttSettings(
      coerceSttFile({ baseUrl: "http://kept:1/v1" }),
      sttEnvSettings({ COLLIE_STT_URL: "   " }),
      warn,
    );

    expect(openAi(settings).baseUrl).toBe("http://kept:1/v1");
  });
});

describe("stt settings — the reader re-reads behind an mtime check", () => {
  /** A fake disk: the file's text and mtime are set by the test, and every read is counted. */
  function fakeIo() {
    const io: OperatorFileIo & { text: string | null; mtime_: number; reads: number } = {
      text: null,
      mtime_: 1,
      reads: 0,
      async mtime() {
        return io.text === null ? null : io.mtime_;
      },
      async read() {
        io.reads += 1;
        if (io.text === null) throw new Error("ENOENT");
        return io.text;
      },
    };
    return io;
  }

  test("the path is stt.json under the state dir", () => {
    expect(sttSettingsPath("/var/state")).toBe(`/var/state/${STT_FILENAME}`);
  });

  test("no file is off, and is not an error", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createSttSettingsReader({ stateDir: "/s", io, warn, env: NO_ENV });

    expect(await read()).toBeNull();
    expect(lines).toEqual([]);
    expect(io.reads).toBe(0);
  });

  test("an unchanged file is not re-parsed, and a changed one goes live with no restart", async () => {
    const io = fakeIo();
    const { warn } = collectWarnings();
    const read = createSttSettingsReader({ stateDir: "/s", io, warn, env: NO_ENV });

    io.text = JSON.stringify({ baseUrl: "http://one:1/v1" });
    expect(openAi(await read()).baseUrl).toBe("http://one:1/v1");
    expect(await read()).toEqual((await read())!);
    expect(io.reads).toBe(1);

    io.text = JSON.stringify({ baseUrl: "http://two:2/v1" });
    io.mtime_ = 2;
    expect(openAi(await read()).baseUrl).toBe("http://two:2/v1");
    expect(io.reads).toBe(2);
  });

  test("a file that stops parsing HOLDS the last good settings and warns once per change", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createSttSettingsReader({ stateDir: "/s", io, warn, env: NO_ENV });

    io.text = JSON.stringify({ baseUrl: "http://good:1/v1" });
    expect(openAi(await read()).baseUrl).toBe("http://good:1/v1");

    io.text = "{ this is not json";
    io.mtime_ = 2;
    expect(openAi(await read()).baseUrl).toBe("http://good:1/v1");
    expect(openAi(await read()).baseUrl).toBe("http://good:1/v1");
    expect(lines.filter((l) => l.includes("could not be parsed"))).toHaveLength(1);
  });

  test("the environment is consulted on every call, even while the file is cached", async () => {
    const io = fakeIo();
    const env: Record<string, string | undefined> = {};
    const { warn } = collectWarnings();
    const read = createSttSettingsReader({ stateDir: "/s", io, warn, env });

    io.text = JSON.stringify({ baseUrl: "http://file:1/v1" });
    expect(openAi(await read()).baseUrl).toBe("http://file:1/v1");
    env.COLLIE_STT_URL = "http://env:2/v1";
    expect(openAi(await read()).baseUrl).toBe("http://env:2/v1");
    expect(io.reads).toBe(1);
  });
});

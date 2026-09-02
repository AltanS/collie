import { describe, expect, test } from "bun:test";

import { STT_ENV_KEYS, STT_FILENAME, type SttSettings } from "../bridge/stt/config.ts";
import { CODEX_TRANSCRIBE_URL } from "../bridge/stt/codex.ts";
import { SttError, type SttAudio, type SttProvider, type SttResult } from "../bridge/stt/provider.ts";
import { capture, context, type FakeFiles, fakeFiles, fakeExec, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdStt, cmdSttOff, cmdSttSetup, cmdSttStatus, cmdSttTest, type SttDeps } from "./stt.ts";

// The four `stt` verbs against fake seams. What is asserted here is what only these verbs own: the
// file that lands under the state dir, the consent gate in front of the codex probe, and the words
// the operator reads. Every decision INSIDE the settings — the precedence, the canonical base URL,
// the refusals — belongs to `bridge/stt/config.ts` and is pinned in its own suite.
//
// Nothing here dials anything: the probe and the provider are both injected, which is the whole
// reason `SttDeps` carries them.

const CONFIG_PATH = `${STATE}/${STT_FILENAME}`;

type Deps = SttDeps & { io: ReturnType<typeof capture>; files: FakeFiles };

function deps(
  over: {
    seed?: Record<string, string>;
    env?: Record<string, string | undefined>;
    answers?: string[];
    probe?: SttDeps["probe"];
    create?: SttDeps["create"];
    absent?: string[];
  } = {},
): Deps {
  const io = capture();
  const files = fakeFiles(over.seed ?? {});
  const queued = [...(over.answers ?? [])];
  const built: Deps = {
    ctx: context(over.env ?? {}),
    io,
    files,
    exec: fakeExec({ absent: over.absent ?? [] }),
    // An empty queue IS the unattended run: no answers to hand out, and no terminal to ask at.
    interactive: queued.length > 0,
    prompt: () => queued.shift() ?? null,
    now: () => 0,
  };
  if (over.probe !== undefined) built.probe = over.probe;
  if (over.create !== undefined) built.create = over.create;
  return built;
}

/** `stt.json` as the verb under test just wrote it — the same six optional fields the bridge reads. */
interface SttDocument {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  codexBin?: string;
  wireIdentity?: string;
}

function written(d: Deps): SttDocument {
  const text = d.files.entries.get(CONFIG_PATH)?.text;
  expect(text).toBeString();
  // SAFETY: `text` is what `cmdSttSetup` serialised one call ago with `JSON.stringify` over exactly
  // this shape, and the assertion above proves the file is there — this is Collie's own output being
  // read back, not an external payload.
  return JSON.parse(text!) as SttDocument;
}

const said = (d: Deps): string => [...d.io.stdout, ...d.io.stderr].join("\n");

/** What one {@link fakeProvider} was asked to do. */
interface ProviderLog {
  closed: number;
  mime: string[];
  filenames: string[];
  /** The first bytes of each clip, so a test can prove the container is real and not a copy. */
  magic: Uint8Array[];
}

/** A provider that answers with one fixed transcript, recording what it was handed. */
function fakeProvider(text: string): SttProvider & { seen: ProviderLog } {
  const seen: ProviderLog = { closed: 0, mime: [], filenames: [], magic: [] };
  return {
    id: "fake",
    seen,
    status: async (): Promise<{ available: boolean }> => ({ available: true }),
    async transcribe(input: SttAudio): Promise<SttResult> {
      seen.mime.push(input.mimeType);
      seen.filenames.push(input.filename);
      seen.magic.push(input.audio.subarray(0, 8));
      return { text };
    },
    close: () => void (seen.closed += 1),
  };
}

/**
 * A provider that takes everything except the containers named, which it refuses the way
 * `bridge/stt/openai.ts` does: a 400 that names the container it was sent as.
 */
function refusingProvider(refuse: readonly string[]): SttProvider & { seen: ProviderLog } {
  const provider = fakeProvider("");
  const accept = provider.transcribe.bind(provider);
  return {
    ...provider,
    async transcribe(input: SttAudio): Promise<SttResult> {
      if (!refuse.includes(input.mimeType)) return accept(input);
      const container = input.mimeType.split(";", 1)[0]!;
      throw new SttError("refused", `the transcription service answered 400 for ${container}`);
    },
  };
}

describe("collie stt setup — openai-compatible", () => {
  test("all by flag: an owner-only file, renamed into place, with the model defaulted", async () => {
    const d = deps();
    const code = await cmdSttSetup(d, [
      "--provider",
      "openai-compatible",
      "--url",
      "https://stt.example/v1/",
      "--key",
      "sk-abcd1234",
    ]);
    expect(code).toBe(EXIT.OK);
    // Canonical, not verbatim: the trailing slash is gone because the BRIDGE's resolve stripped it,
    // which is the point of validating through it rather than beside it.
    expect(written(d)).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://stt.example/v1",
      apiKey: "sk-abcd1234",
    });
    expect(d.files.entries.get(CONFIG_PATH)?.mode).toBe(0o600);
    // Never written through: the temporary is what carried the bytes, and the rename is the commit.
    expect(d.files.ops).toEqual([`mv ${CONFIG_PATH}.tmp ${CONFIG_PATH}`]);
    expect(said(d)).toContain("no restart needed");
    // The key is in the file and nowhere on the screen.
    expect(said(d)).not.toContain("sk-abcd1234");
  });

  test("keyless is a mode, not an omission — no apiKey field at all", async () => {
    const d = deps();
    expect(
      await cmdSttSetup(d, ["--provider", "openai-compatible", "--url", "http://127.0.0.1:8080/v1"]),
    ).toBe(EXIT.OK);
    expect(written(d)).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
  });

  test("interactive: provider, URL, model and key are asked in that order", async () => {
    const d = deps({ answers: ["", "https://stt.example/v1", "whisper-1", ""] });
    expect(await cmdSttSetup(d, [])).toBe(EXIT.OK);
    expect(written(d)).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://stt.example/v1",
      model: "whisper-1",
    });
    // The prompt says where the value lands, because this terminal cannot read without echo.
    expect(said(d)).toContain("0600");
  });

  test("a configuration the bridge would refuse is refused HERE, and nothing is written", async () => {
    const d = deps();
    expect(
      await cmdSttSetup(d, ["--provider", "openai-compatible", "--url", "file:///etc/passwd"]),
    ).toBe(EXIT.FAIL);
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
    expect(said(d)).toContain("http(s)");
    expect(said(d)).toContain("Nothing was written");
  });

  test("api.openai.com with no key is refused at the terminal, not after a recording", async () => {
    const d = deps();
    expect(
      await cmdSttSetup(d, ["--provider", "openai-compatible", "--url", "https://api.openai.com/v1"]),
    ).toBe(EXIT.FAIL);
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
    expect(said(d)).toContain(STT_ENV_KEYS.key);
  });

  test("an unknown provider names the two that exist", async () => {
    const d = deps();
    expect(await cmdSttSetup(d, ["--provider", "whisper"])).toBe(EXIT.FAIL);
    expect(said(d)).toContain("openai-compatible or codex");
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
  });

  test("an unattended run with no --url refuses rather than guessing", async () => {
    const d = deps({ answers: [] });
    expect(await cmdSttSetup(d, ["--provider", "openai-compatible"])).toBe(EXIT.FAIL);
    expect(said(d)).toContain("not interactive");
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
  });

  test("an env override that will win is named after the write", async () => {
    const d = deps({ env: { [STT_ENV_KEYS.url]: "https://elsewhere/v1" } });
    expect(
      await cmdSttSetup(d, ["--provider", "openai-compatible", "--url", "https://stt.example/v1"]),
    ).toBe(EXIT.OK);
    expect(said(d)).toContain(STT_ENV_KEYS.url);
    expect(said(d)).toContain("environment overrides");
  });
});

describe("collie stt setup — codex", () => {
  const consented = ["yes"];

  test("the consent paragraph is printed BEFORE the probe, and names all three risks", async () => {
    const order: string[] = [];
    const d = deps({
      answers: consented,
      probe: async () => {
        order.push("probe");
        return "honest";
      },
    });
    expect(await cmdSttSetup(d, ["--provider", "codex"])).toBe(EXIT.OK);
    order.push("done");
    expect(order).toEqual(["probe", "done"]);
    const heard = said(d);
    expect(heard).toContain(CODEX_TRANSCRIBE_URL);
    expect(heard).toContain("PRIVATE and UNSUPPORTED");
    expect(heard).toContain("may stop working at any time");
    expect(heard).toContain("YOUR ChatGPT account");
    expect(heard).toContain("impersonation");
    // The paragraph precedes the probe's own line in the transcript.
    expect(d.io.stdout.findIndex((l) => l.includes("Read this before you accept"))).toBeLessThan(
      d.io.stdout.findIndex((l) => l.includes("Probing the endpoint")),
    );
  });

  test("no consent, no probe, no file — the refusal is what an unattended run gets", async () => {
    let probed = false;
    const d = deps({
      answers: [],
      probe: async () => {
        probed = true;
        return "honest";
      },
    });
    expect(await cmdSttSetup(d, ["--provider", "codex"])).toBe(EXIT.FAIL);
    expect(probed).toBe(false);
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
    expect(said(d)).toContain("--accept-risk");
  });

  test("anything other than `yes` stops the run", async () => {
    let probed = false;
    const d = deps({
      answers: ["y"],
      probe: async () => {
        probed = true;
        return "honest";
      },
    });
    expect(await cmdSttSetup(d, ["--provider", "codex"])).toBe(EXIT.FAIL);
    expect(probed).toBe(false);
    expect(said(d)).toContain("not accepted");
  });

  test("--accept-risk is consent for a script, and the paragraph is still printed", async () => {
    const d = deps({ answers: [], probe: async () => "honest" });
    expect(await cmdSttSetup(d, ["--provider", "codex", "--accept-risk"])).toBe(EXIT.OK);
    expect(said(d)).toContain("PRIVATE and UNSUPPORTED");
    expect(written(d)).toEqual({
      provider: "codex",
      codexBin: "/fake/codex",
      wireIdentity: "honest",
    });
  });

  test("the honest verdict says no impersonation is configured", async () => {
    const d = deps({ answers: consented, probe: async () => "honest" });
    expect(await cmdSttSetup(d, ["--provider", "codex"])).toBe(EXIT.OK);
    expect(said(d)).toContain("accepted Collie under its own name");
    expect(said(d)).not.toContain("⚠ THE HONEST IDENTITY WAS REFUSED");
  });

  test("the fallback verdict is said loudly and recorded in the file", async () => {
    const d = deps({ answers: consented, probe: async () => "codex-cli" });
    expect(await cmdSttSetup(d, ["--provider", "codex"])).toBe(EXIT.OK);
    expect(said(d)).toContain("THE HONEST IDENTITY WAS REFUSED");
    expect(said(d)).toContain("originator: codex_cli_rs");
    expect(written(d).wireIdentity).toBe("codex-cli");
  });

  test("a probe failure prints the SttError as itself and writes nothing", async () => {
    const d = deps({
      answers: consented,
      probe: async () => {
        throw new SttError("unavailable", "Codex is not signed in — run `codex login`");
      },
    });
    expect(await cmdSttSetup(d, ["--provider", "codex"])).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("run `codex login`");
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
  });

  test("no codex binary anywhere is a refusal that names the two ways out", async () => {
    const d = deps({ answers: consented, absent: ["codex"], probe: async () => "honest" });
    expect(await cmdSttSetup(d, ["--provider", "codex"])).toBe(EXIT.FAIL);
    expect(said(d)).toContain("--codex-bin");
    expect(said(d)).toContain("--provider openai-compatible");
    // The paragraph is not printed for a run that could never have got as far as consent.
    expect(said(d)).not.toContain("Read this before you accept");
  });

  test("an operator-spelled path is checked for existence, not searched for", async () => {
    const d = deps({
      answers: consented,
      seed: { "/opt/bin/codex": "" },
      probe: async () => "honest",
    });
    expect(await cmdSttSetup(d, ["--provider", "codex", "--codex-bin", "/opt/bin/codex"])).toBe(EXIT.OK);
    expect(written(d).codexBin).toBe("/opt/bin/codex");
  });
});

describe("collie stt test", () => {
  const configured = { [CONFIG_PATH]: '{"provider":"openai-compatible","baseUrl":"https://stt.example/v1"}' };

  test("a silent clip that transcribes to nothing is a PASS, and says why exactly once", async () => {
    const provider = fakeProvider("   ");
    const d = deps({ seed: configured, create: () => provider });
    expect(await cmdSttTest(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("(empty)");
    expect(said(d)).toContain("still proves the pipeline");
    // Three clips, one explanation: the other two answer the same empty string.
    expect(d.io.stdout.filter((line) => line.includes("(empty)"))).toHaveLength(1);
    // The child a codex provider would own is released even on the happy path.
    expect(provider.seen.closed).toBe(1);
  });

  test("every container the phone can record is probed, wav first", async () => {
    const provider = fakeProvider("");
    const d = deps({ seed: configured, create: () => provider });
    expect(await cmdSttTest(d)).toBe(EXIT.OK);
    // The order is the contract: wav proves the endpoint, the other two prove the phone.
    expect(provider.seen.mime).toEqual(["audio/wav", "audio/webm;codecs=opus", "audio/mp4"]);
    // The extension is the one `bridge/stt/http.ts` derives from the same content type.
    expect(provider.seen.filenames).toEqual([
      "collie-stt-test.wav",
      "collie-stt-test.webm",
      "collie-stt-test.mp4",
    ]);
    // Real bytes, in a real container, not three copies of the wav probe.
    expect([...provider.seen.magic[1]!.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(String.fromCharCode(...provider.seen.magic[2]!.subarray(4, 8))).toBe("ftyp");
    expect(said(d)).toContain("as audio/webm;codecs=opus (Chrome, Android, Firefox) … ✓ 0 ms");
    expect(said(d)).toContain("as audio/mp4 (Safari, iOS) … ✓ 0 ms");
  });

  test("a transcript is printed, with the provider and the round trip", async () => {
    const d = deps({ seed: configured, create: () => fakeProvider("hello there") });
    expect(await cmdSttTest(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("openai-compatible (https://stt.example/v1");
    expect(said(d)).toContain("(the setup probe) … ✓ 0 ms");
    expect(said(d)).toContain("hello there");
  });

  test("a failure exits non-zero and reports the kind", async () => {
    const provider: SttProvider = {
      id: "fake",
      status: async () => ({ available: false }),
      transcribe: async () => {
        throw new SttError("timeout");
      },
    };
    const d = deps({ seed: configured, create: () => provider });
    expect(await cmdSttTest(d)).toBe(EXIT.FAIL);
    expect(said(d)).toContain("✗ timeout: transcription timed out");
    // Nothing about containers: wav failed too, so the container is not what is wrong.
    expect(said(d)).not.toContain("whisper-large-v3-turbo");
  });

  test("wav accepted and webm refused is a FAIL that names the consequence", async () => {
    const provider = refusingProvider(["audio/webm;codecs=opus"]);
    const d = deps({ seed: configured, create: () => provider });
    expect(await cmdSttTest(d)).toBe(EXIT.FAIL);
    const output = said(d);
    expect(output).toContain(
      "✗ refused: the transcription service answered 400 for audio/webm",
    );
    // The wav clip still passed, and the mp4 one after the refusal still ran.
    expect(output).toContain("(the setup probe) … ✓ 0 ms");
    expect(output).toContain("(Safari, iOS) … ✓ 0 ms");
    expect(output).toContain("takes audio/wav, but not audio/webm;codecs=opus");
    expect(output).toContain('will fail with "refused" on the phone');
    expect(output).toContain("openai/whisper-large-v3-turbo");
    expect(output).toContain("Container support is provider-specific");
  });

  test("both phone containers refused are named together in one paragraph", async () => {
    const provider = refusingProvider(["audio/webm;codecs=opus", "audio/mp4"]);
    const d = deps({ seed: configured, create: () => provider });
    expect(await cmdSttTest(d)).toBe(EXIT.FAIL);
    expect(said(d)).toContain("but not audio/webm;codecs=opus or audio/mp4");
  });

  test("nothing configured is a legible failure, not a crash", async () => {
    const d = deps();
    expect(await cmdSttTest(d)).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("collie stt setup");
  });

  test("the environment is loaded exactly as the bridge loads it", async () => {
    const built: SttSettings[] = [];
    const d = deps({
      seed: configured,
      env: { [STT_ENV_KEYS.model]: "whisper-1" },
      create: (settings) => {
        built.push(settings);
        return fakeProvider("ok");
      },
    });
    expect(await cmdSttTest(d)).toBe(EXIT.OK);
    expect(built).toEqual([
      {
        provider: "openai-compatible",
        baseUrl: "https://stt.example/v1",
        model: "whisper-1",
      },
    ]);
  });
});

describe("collie stt status", () => {
  test("off is off, and asking does not create a file", () => {
    const d = deps();
    expect(cmdSttStatus(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("speech-to-text: off");
    expect(d.files.entries.size).toBe(0);
  });

  test("the source of every setting is named, and the key never is", () => {
    const d = deps({
      seed: {
        [CONFIG_PATH]: '{"provider":"openai-compatible","baseUrl":"https://stt.example/v1","apiKey":"sk-secret-9999"}',
      },
      env: { [STT_ENV_KEYS.model]: "whisper-1" },
    });
    expect(cmdSttStatus(d)).toBe(EXIT.OK);
    const heard = said(d);
    expect(heard).toContain(`(${STT_FILENAME})`);
    expect(heard).toContain(`(${STT_ENV_KEYS.model})`);
    expect(heard).toContain("set (…9999)");
    expect(heard).not.toContain("sk-secret-9999");
  });

  test("`codex-cli` is labelled as impersonation, in those words", () => {
    const d = deps({
      seed: { [CONFIG_PATH]: '{"provider":"codex","codexBin":"/opt/bin/codex","wireIdentity":"codex-cli"}' },
    });
    expect(cmdSttStatus(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("impersonating the Codex CLI (accepted at setup)");
    expect(said(d)).toContain(CODEX_TRANSCRIBE_URL);
  });

  test("configured but unusable is a non-zero report, never a silent off", () => {
    const d = deps({ seed: { [CONFIG_PATH]: '{"provider":"codex","wireIdentity":"sneaky"}' } });
    expect(cmdSttStatus(d)).toBe(EXIT.FAIL);
    expect(said(d)).toContain("cannot be used");
  });
});

describe("collie stt off", () => {
  test("removes stt.json and only stt.json", () => {
    const d = deps({
      seed: { [CONFIG_PATH]: "{}", [`${STATE}/paired-devices.json`]: "{}" },
    });
    expect(cmdSttOff(d)).toBe(EXIT.OK);
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
    expect(d.files.entries.has(`${STATE}/paired-devices.json`)).toBe(true);
    expect(said(d)).toContain("no restart needed");
  });

  test("a second off is a clean no-op", () => {
    const d = deps();
    expect(cmdSttOff(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("already off");
  });

  test("it says so when the environment still turns it on", () => {
    const d = deps({ env: { [STT_ENV_KEYS.url]: "https://elsewhere/v1" } });
    expect(cmdSttOff(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("the environment wins");
    expect(said(d)).toContain(STT_ENV_KEYS.url);
  });
});

describe("collie stt (bare)", () => {
  test("names every sub-verb and is a usage error", async () => {
    const d = deps();
    expect(await cmdStt(d, [])).toBe(EXIT.USAGE);
    for (const sub of ["setup", "test", "status", "off"]) {
      expect(d.io.stderr.join("\n")).toContain(sub);
    }
  });

  test("a misspelt sub-verb is named back", async () => {
    const d = deps();
    expect(await cmdStt(d, ["setpu"])).toBe(EXIT.USAGE);
    expect(d.io.stderr.join("\n")).toContain("unknown stt subcommand `setpu`");
  });
});

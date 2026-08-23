import type { OperatorFileIo } from "../operator-file.ts";
import type { SttSettings } from "./config.ts";
import { createSttSettingsReader } from "./config.ts";
import { createCodexSttProvider } from "./codex.ts";
import { createOpenAiSttProvider } from "./openai.ts";
import type { SttProvider } from "./provider.ts";

// Where settings become a provider. One switch, over the provider name the settings parsed to —
// a third provider is one arm here plus its own module, and nothing else in the bridge learns that
// there is more than one kind.

/** Build the provider the settings name. Total over {@link SttSettings} by construction. */
export function createSttProvider(settings: SttSettings): SttProvider {
  if (settings.provider === "codex") return createCodexSttProvider(settings);
  return createOpenAiSttProvider(settings);
}

/**
 * The bridge's whole view of speech-to-text: ask, every time, for the provider that is configured
 * right now — plus the one shutdown handle the codex provider needs.
 */
export interface SttGate {
  (): Promise<SttProvider | null>;
  /** Release whatever the current provider holds open. For process shutdown; safe to call twice. */
  close(): void;
}

/**
 * A callable rather than a value because the settings are re-read behind an mtime check — running
 * `collie stt setup` must take effect without a `systemctl restart`, the same posture
 * `commands.toml` has. The provider object is rebuilt only when the settings actually change; an
 * unchanged file costs one `stat` and hands back the instance that is already there.
 *
 * That caching is load-bearing for the codex provider and not merely an optimisation: its auth
 * broker owns a long-running `codex app-server` child, so a provider rebuilt per request would be a
 * child spawned per request. The rule is one provider per distinct settings value, and the outgoing
 * one is CLOSED as the new one is built — a config edit replaces the child rather than orphaning it.
 */
export function createSttGate(opts: {
  stateDir: string;
  warn: (message: string) => void;
  env?: Record<string, string | undefined>;
  io?: OperatorFileIo;
  /** The builder, injected ONLY so the tests can watch this cache without spawning a real child. */
  create?: (settings: SttSettings) => SttProvider;
}): SttGate {
  const readSettings = createSttSettingsReader(opts);
  const build = opts.create ?? createSttProvider;
  let cached: { key: string; provider: SttProvider } | null = null;

  const retire = () => {
    cached?.provider.close?.();
    cached = null;
  };

  const gate = async (): Promise<SttProvider | null> => {
    const settings = await readSettings();
    if (settings === null) {
      retire();
      return null;
    }
    // The settings ARE the identity of a provider: same endpoint, model and credential, same
    // client. Keyed on the serialized settings so a changed model rebuilds and a re-read of an
    // unchanged file does not.
    const key = JSON.stringify(settings);
    if (cached?.key !== key) {
      retire();
      cached = { key, provider: build(settings) };
    }
    return cached.provider;
  };
  gate.close = retire;
  return gate;
}

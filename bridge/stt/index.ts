import type { SttSettings } from "./config.ts";
import { createSttSettingsReader } from "./config.ts";
import { createOpenAiSttProvider } from "./openai.ts";
import type { SttProvider } from "./provider.ts";

// Where settings become a provider. One switch, over the provider name the settings parsed to —
// a second provider (codex) is one arm here plus its own module, and nothing else in the bridge
// learns that there is more than one kind.

/** Build the provider the settings name. Total over {@link SttSettings} by construction. */
export function createSttProvider(settings: SttSettings): SttProvider {
  return createOpenAiSttProvider(settings);
}

/**
 * The bridge's whole view of speech-to-text: ask, every time, for the provider that is configured
 * right now.
 *
 * A function rather than a value because the settings are re-read behind an mtime check — running
 * `collie stt setup` must take effect without a `systemctl restart`, the same posture `commands.toml`
 * has. The provider object is rebuilt only when the settings actually change; an unchanged file
 * costs one `stat` and hands back the instance that is already there.
 */
export function createSttGate(opts: {
  stateDir: string;
  warn: (message: string) => void;
  env?: Record<string, string | undefined>;
}): () => Promise<SttProvider | null> {
  const readSettings = createSttSettingsReader(opts);
  let cached: { key: string; provider: SttProvider } | null = null;
  return async () => {
    const settings = await readSettings();
    if (settings === null) {
      cached = null;
      return null;
    }
    // The settings ARE the identity of a provider: same endpoint, model and credential, same
    // client. Keyed on the serialized settings so a changed model rebuilds and a re-read of an
    // unchanged file does not.
    const key = JSON.stringify(settings);
    if (cached?.key !== key) cached = { key, provider: createSttProvider(settings) };
    return cached.provider;
  };
}

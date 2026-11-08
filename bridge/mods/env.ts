import { redactText } from "../redact.ts";

// THE PROVIDER'S ENVIRONMENT (M94 slice 01).
//
// A provider runs as the operator, with the unit's environment, so `darius` and `gh` are found the
// same way the bridge finds its own tools, and `collie mod check --run` (which scrubs its own shell's
// environment the same way) shows "not found" before the phone does. What it never gets:
//
//   * any `COLLIE_*` variable: the bridge's own settings, the pairing and push keys among them;
//   * a variable whose NAME says it holds a secret. Conservative on purpose: `KEY` alone drops
//     `OPENROUTER_API_KEY`, `AWS_SECRET_ACCESS_KEY` and every `*_KEY`, and a provider that needs a key
//     reads it from its own file, which it names in its own source where `collie mod check` shows it;
//   * a variable whose VALUE the secret mask would change (`FOO=sk-or-v1-...` under any name);
//   * the path of the config folder, which holds the `.env` with the token (`HERDR_PLUGIN_CONFIG_DIR`,
//     and any variable whose value names that folder).
//
// A mitigation, not a sandbox: the provider runs as you and can read any file you can. The rule keeps
// the token off the provider's path so a provider that prints its environment, or an agent that wrote
// one, cannot carry the token to a model or a phone by accident.

/** The name parts that mark a variable as a secret, matched anywhere in the name, any case. */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|AUTHORIZATION|BEARER|COOKIE/i;

/** Variables that name the config folder itself. */
const CONFIG_DIR_NAMES = new Set(["HERDR_PLUGIN_CONFIG_DIR"]);

/** An environment: names to values. `undefined` reads as unset and is dropped. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/** Why a variable is kept out of the provider's environment, or `null` when it is kept. */
export function scrubReason(name: string, value: string, configDir?: string): string | null {
  if (name.toUpperCase().startsWith("COLLIE_")) return "a COLLIE_ variable";
  if (SECRET_NAME.test(name)) return "a name that says secret";
  if (CONFIG_DIR_NAMES.has(name.toUpperCase())) return "names the config folder";
  if (configDir !== undefined && configDir !== "" && value.includes(configDir)) return "names the config folder";
  if (redactText(value) !== value) return "a value the secret mask hides";
  return null;
}

/**
 * The environment a provider gets: `env` minus every variable {@link scrubReason} names. Pure; the
 * input is not changed. `configDir` is the bridge's config folder, so no value can point at it.
 */
export function scrubEnv(env: ProviderEnv, configDir?: string) {
  const kept = Object.entries(env).flatMap(([name, value]): [string, string][] =>
    value === undefined || scrubReason(name, value, configDir) !== null ? [] : [[name, value]],
  );
  return Object.fromEntries(kept);
}

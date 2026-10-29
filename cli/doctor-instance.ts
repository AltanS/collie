import { DEFAULT_INSTANCE, INSTANCE_PATTERN, listInstancesOnDisk, resolveHome } from "./context.ts";
import type { Environment } from "./context.ts";

// `collie doctor --instance <name>` (M71 spec 04). Doctor alone takes the flag: every other verb
// builds its own context, `config init --instance` is already a bare switch and `_exec-bridge
// --instance` is a pidfile marker on the bridge's command line, so no shared place exists. The flag
// is read-only here because doctor is; a write verb aimed at the wrong lane is the dangerous case.

/** What the flag turned into: the lane and the args doctor's own grammar still has to read, or the refusal. */
export type DoctorInstanceChoice =
  | { readonly ok: true; readonly instance: string | undefined; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Take `--instance <name>` or `--instance=<name>` out of `args`, and check the name against this
 * machine's instances BEFORE any context is built, so a typo stops with the list and not with a
 * report about the wrong lane. The last flag wins. Every other arg passes through in order.
 *
 * `known` is the instance list ({@link listInstancesOnDisk} in production, a fake in the tests).
 * `default` is always accepted: it is the unsuffixed lane, and an install with no config at all
 * still reads as it.
 */
export function chooseDoctorInstance(args: readonly string[], known: () => readonly string[]): DoctorInstanceChoice {
  const rest: string[] = [];
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--instance=")) {
      name = arg.slice("--instance=".length);
      continue;
    }
    if (arg !== "--instance") {
      rest.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      return { ok: false, message: `error: --instance needs a name; instances: ${listText(known())}` };
    }
    name = value;
    i++;
  }
  if (name === undefined) return { ok: true, instance: undefined, rest };
  if (name === DEFAULT_INSTANCE) return { ok: true, instance: name, rest };
  const found = known();
  if (!INSTANCE_PATTERN.test(name) || !found.includes(name)) {
    return { ok: false, message: `error: no instance "${name}" here; instances: ${listText(found)}` };
  }
  return { ok: true, instance: name, rest };
}

/** {@link chooseDoctorInstance} over this machine's real config root. */
export function chooseDoctorInstanceHere(args: readonly string[], env: Environment): DoctorInstanceChoice {
  return chooseDoctorInstance(args, () => listInstancesOnDisk(resolveHome(env)));
}

const listText = (names: readonly string[]): string => (names.length === 0 ? "none" : names.join(", "));

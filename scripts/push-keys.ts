// Generate the VAPID keypair Web Push needs, and write it into the plugin .env — the step that used
// to be "find the web-push CLI, run it, hand-edit a file you've never opened, in a directory you had
// to go looking for". Run it via
//   bash scripts/collie-ctl.sh push-keys ["mailto:you@example.com"]
// (or the `push-keys` Herdr action), which resolves the config dir the same way every other verb
// does, so the keys land in the .env the service actually reads.
//
// ── WHY THIS DOESN'T USE `web-push` ──────────────────────────────────────────
// `web-push` ships `generateVAPIDKeys()`, but it is an OPTIONAL dependency (bridge/push.ts imports
// it lazily so a checkout without it still runs). Keygen is step one of turning push on; failing it
// because the sender isn't installed yet would put the operator back in exactly the "which package do
// I need" hole this verb exists to fill. A VAPID keypair is a plain P-256 keypair — the public half
// is the uncompressed point (0x04‖X‖Y) and the private half is the scalar `d`, both base64url — so
// node:crypto produces the identical thing with no dependency at all. We still *check* for web-push
// at the end and say so, because keys without a sender are a service that starts up and pushes
// nothing.
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";

/** The three vars that turn push on, in the order they are written. */
export const VAPID_KEYS = [
  "COLLIE_VAPID_PUBLIC",
  "COLLIE_VAPID_PRIVATE",
  "COLLIE_VAPID_SUBJECT",
] as const;
export type VapidKey = (typeof VAPID_KEYS)[number];

/**
 * A VAPID keypair, base64url, in the shape `web-push` and the browser's `applicationServerKey` both
 * expect: public = the uncompressed P-256 point, private = the 32-byte scalar.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = pair.publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  const priv = pair.privateKey.export({ format: "jwk" }) as { d?: string };
  if (!pub.x || !pub.y || !priv.d) throw new Error("node:crypto returned an incomplete P-256 JWK");
  const x = Buffer.from(pub.x, "base64url");
  const y = Buffer.from(pub.y, "base64url");
  // JWK pads all three to the curve size, so the point is a fixed 65 bytes. Assert rather than
  // trust: a short value is a key that fails at the push service, hours later, as a 400.
  if (x.length !== 32 || y.length !== 32) throw new Error("P-256 coordinates are not 32 bytes");
  if (Buffer.from(priv.d, "base64url").length !== 32) throw new Error("P-256 scalar is not 32 bytes");
  return {
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url"),
    privateKey: priv.d,
  };
}

/**
 * Matches `KEY=value`, with or without the `# ` a copied-from-.env.example placeholder carries, and
 * with or without an `export ` prefix — a hand-rolled .env often has one, and missing it would make
 * {@link mergeEnv} append beside an old assignment instead of replacing it, leaving a superseded
 * private key in the file. Which is the one thing that function promises not to do.
 */
const assignment = (key: string) => new RegExp(`^\\s*(#\\s*)?(?:export\\s+)?${key}\\s*=(.*)$`);

/**
 * The LIVE value of a var in an .env — what bash would end up with after sourcing it. Commented
 * placeholders are not values, and a later assignment wins over an earlier one.
 */
export function readEnvVar(text: string, key: VapidKey): string | undefined {
  let found: string | undefined;
  for (const line of text.split("\n")) {
    const m = assignment(key).exec(line);
    if (m && m[1] === undefined) found = (m[2] ?? "").trim();
  }
  return found === "" ? undefined : found;
}

/**
 * `text` with each var set to its new value, in place.
 *
 * In place matters twice over: it keeps the operator's own comments and ordering, and it removes any
 * *other* assignment of the same key. Appending blindly would leave the old private key sitting in
 * the file above the new one — invisible, mode-600, and still the thing an editor or a reader would
 * find first. A commented placeholder is treated as the slot it obviously is and taken over.
 */
export function mergeEnv(text: string, vars: Record<string, string>): string {
  let lines = text.split("\n");
  const appended: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    const re = assignment(key);
    const first = lines.findIndex((l) => re.test(l));
    if (first === -1) {
      appended.push(`${key}=${value}`);
      continue;
    }
    lines[first] = `${key}=${value}`;
    lines = lines.filter((l, i) => i === first || !re.test(l));
  }

  if (appended.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push("", "# --- Web Push (VAPID) — written by `collie-ctl.sh push-keys` ---", ...appended);
  }
  // Exactly one trailing newline, whatever the file arrived with.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/**
 * A subject the push services will accept — RFC 8292 wants a `mailto:` or `https:` URI identifying
 * whoever runs the sender, and a wrong one comes back as a 403 from Apple at 3am rather than here.
 *
 * The character set is an ALLOWLIST, and that is not decoration. This value is written into a file
 * with two consumers that used to disagree about syntax: `collie-ctl.sh` now parses key=value
 * (no shell execution), matching systemd's `EnvironmentFile=`. The allowlist stays so a subject
 * still cannot smuggle metacharacters into any other consumer. A blocklist that misses one
 * metacharacter therefore does two bad things at once: it lets the shell run something, and it hands
 * the bridge a DIFFERENT subject than the shell got. Nothing here crosses a privilege boundary — the
 * operator running this already has a shell — but a config file that means two things is a bug
 * regardless of who wrote it. The set below covers every mailto/https subject anyone actually uses.
 */
export function validateSubject(subject: string): string {
  if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject) && !/^https:\/\/\S+$/.test(subject)) {
    throw new Error(`subject must be a mailto: address or an https: URL, got: ${subject}`);
  }
  // No `&` (bash backgrounds at it, systemd doesn't) and no `~` (bash tilde-expands after `=` and
  // `:` in an assignment, systemd doesn't) — the two that read differently on each side.
  if (!/^[A-Za-z0-9@.:/_+%?=#-]+$/.test(subject)) {
    throw new Error(`subject contains a character that is unsafe in an .env: ${subject}`);
  }
  return subject;
}

/** What `loadConfig()` falls back to — the same placeholder, so nothing changes meaning by default. */
export const DEFAULT_SUBJECT = "mailto:admin@example.com";

// Sourced by scripts/push-keys.test.ts rather than run: the pure halves above are the testable part.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const [envPath, subjectArg] = argv.filter((a) => a !== "--force");

  if (!envPath) {
    console.error("usage: push-keys.ts <path/to/.env> [mailto:you@example.com] [--force]");
    process.exit(2);
  }

  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    /* first run — the .env doesn't exist yet, and this verb is allowed to create it */
  }

  let subject: string | undefined;
  try {
    subject = subjectArg === undefined ? undefined : validateSubject(subjectArg);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(2);
  }

  const already = VAPID_KEYS.filter((k) => k !== "COLLIE_VAPID_SUBJECT").every(
    (k) => readEnvVar(text, k) !== undefined,
  );

  // Changing the SUBJECT is not changing the keys: it renames whoever the push services should
  // contact and invalidates nothing. So a subject on an already-configured file is a subject update,
  // not a refusal — otherwise the only way to correct a typo'd contact address is `--force`, which
  // would silence every subscribed device to fix a string.
  const subjectOnly = already && !force && subject !== undefined;

  if (already && !force && !subjectOnly) {
    console.error(
      `✗ push keys are already configured in ${envPath}\n` +
        "  Replacing them invalidates EVERY existing subscription: each device must open Collie and\n" +
        "  re-enable notifications, and until it does it will silently receive nothing.\n" +
        "  If that's what you want: `bash scripts/collie-ctl.sh push-keys --force`.\n" +
        "  (To change only the contact subject, pass it — that never touches the keys.)",
    );
    process.exit(1);
  }

  // The subject is written only when there is something to say: an argument, or a value already in
  // the file. Writing the placeholder `loadConfig()` falls back to anyway (bridge/config.ts) would
  // put a fake contact address in the operator's config and make it look chosen.
  const vars: Record<string, string> = {};
  if (!subjectOnly) {
    const keys = generateVapidKeys();
    vars.COLLIE_VAPID_PUBLIC = keys.publicKey;
    vars.COLLIE_VAPID_PRIVATE = keys.privateKey;
  }
  const effectiveSubject = subject ?? readEnvVar(text, "COLLIE_VAPID_SUBJECT");
  if (effectiveSubject !== undefined) vars.COLLIE_VAPID_SUBJECT = effectiveSubject;

  const merged = mergeEnv(text, vars);

  // Written via a temp file and renamed, so an interrupted write can never leave the operator with a
  // truncated .env — the file that every other setting also lives in. Mode 600 from creation: the
  // private key is a signing credential, and a 644 moment is a 644 moment. `wx` because the temp
  // path is predictable: it must never follow a file (or symlink) that is already sitting there.
  //
  // A SYMLINKED .env is refused rather than renamed over. Some operators keep this file in a dotfiles
  // repo or have it rendered by a secret manager and symlink it into place; `rename` would silently
  // replace the link with a regular file, and their source of truth would quietly stop being one.
  const link = await lstat(envPath).catch(() => null);
  if (link?.isSymbolicLink()) {
    console.error(
      `✗ ${envPath} is a symlink — writing it would replace the link with a plain file.\n` +
        `  Point this at the real file instead: push-keys "$(readlink -f ${envPath})"`,
    );
    process.exit(1);
  }

  const tmp = `${envPath}.push-keys.tmp`;
  try {
    await writeFile(tmp, merged, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Left behind by a run that died between write and rename. Say so and stop: deleting it blind is
    // how `wx` stops meaning anything, and it may hold the only copy of a key someone just generated.
    console.error(`✗ ${tmp} already exists — a previous run left it behind.\n  Inspect it, then remove it and retry.`);
    process.exit(1);
  }
  await rename(tmp, envPath);
  await chmod(envPath, 0o600);

  if (subjectOnly) {
    console.log(`✓ updated COLLIE_VAPID_SUBJECT in ${envPath} — the keys are untouched`);
  } else {
    console.log(`✓ wrote COLLIE_VAPID_PUBLIC / _PRIVATE to ${envPath} (mode 600)`);
    if (already) console.log("  ⚠ keys replaced — every subscribed device must re-enable notifications.");
  }
  console.log(`  subject: ${effectiveSubject ?? `${DEFAULT_SUBJECT} (default — pass one to set your own)`}`);

  try {
    await import("web-push");
  } catch {
    console.log(
      "  ⚠ `web-push` isn't installed, so the bridge still can't SEND — run `bun install` in the checkout.",
    );
  }

  console.log("\nNext:");
  console.log("  1. herdr plugin action invoke restart --plugin herdr.collie");
  console.log("  2. On your phone: open Collie → Settings → enable notifications");
  console.log("  3. bash scripts/collie-ctl.sh push-test");
}

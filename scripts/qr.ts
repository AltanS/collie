// Render a URL as a QR code in the terminal, so a phone can scan its way onto the bridge instead of
// typing a MagicDNS name on a phone keyboard. Called by `collie qr` (cli/qr.ts), which decides WHICH
// url (the tailnet front door, or COLLIE_PUBLIC_URL under DEPLOYMENT.md's Variant C/E) and whether
// it's worth one.
//
// A plain dependency, NOT an optional one like web-push (bridge/push.ts). The distinction is which
// contract it belongs to: push is optional at RUNTIME (no VAPID keys, no push, bridge unaffected),
// whereas this is a first-class subcommand whose own test suite gates every push. Declaring it
// optional while `bun run test` can't pass without it would be two contracts disagreeing. The import
// is still guarded, because a checkout that hasn't run `bun install` yet should hear why rather than
// eat a module-resolution stack trace.
type QrModule = typeof import("qrcode-terminal");

// A QR is a promise that scanning it gets you somewhere, so refuse what wouldn't survive the round
// trip rather than drawing a code that resolves to nothing. Well above any real tailnet URL — it's a
// sanity bound, not the format's limit.
const MAX_URL_LEN = 512;

// Two things about qrcode-terminal's compact renderer have to be corrected here, and BOTH were found
// by decoding what it prints rather than by reading it (`qr.test.ts` keeps them found):
//
//  1. **Its filled glyph is a LIGHT module, not a dark one.** Verified against the encoder's own
//     `isDark()` matrix: the bitmap matches only with the glyph read as light. So the compact output
//     silently assumes a dark terminal — light foreground painting the light modules, background
//     showing through as the dark ones. On a LIGHT terminal every module inverts, and an inverted QR
//     is exactly what phone cameras are worst at. (The full-size renderer has no such problem — it
//     paints explicit ANSI backgrounds — but costs ~31 rows to the compact one's ~16.) Setting the
//     colours ourselves buys the compact size AND theme independence: one SGR per line pinning
//     bright-white on black, which maps each glyph to the polarity it was always meant to have.
//  2. **Its quiet zone is 2 modules top and 1 left**, where the spec asks for 4 all round. It gets
//     away with it when the terminal background happens to continue the light margin; against a
//     scrolled-up prompt it doesn't. We pad it out ourselves.
// Emitted unconditionally, including when stdout is a pipe or a file — deliberately, and this is the
// line that would change. The usual `isTTY` gate is wrong here because the colour is not decoration:
// it IS the polarity fix, so stripping it hands `collie-ctl.sh qr | less -R` (or any capture you then
// scan from) exactly the inverted code this renderer exists to prevent. Raw escapes in a redirect are
// the lesser problem, and the URL is printed as plain text below the code for anyone piping it.
const SGR_QR = "\x1b[97;40m"; // bright white foreground, black background
const SGR_RESET = "\x1b[0m";
const LIGHT_ALL = "█"; // '█' — both half-modules light; the quiet zone is built from these
const QUIET_COLS = 4;
const QUIET_TEXT_ROWS = 2; // each text row is two modules tall, so this is a 4-module margin

/** Pin explicit colours and pad the quiet zone out to spec. See the block comment above for why. */
function colourAndPad(code: string): string {
  const lines = code.split("\n").filter((line) => line.length > 0);
  const width = Math.max(...lines.map((line) => [...line].length));
  const margin = LIGHT_ALL.repeat(QUIET_COLS);
  const blank = `${SGR_QR}${LIGHT_ALL.repeat(width + 2 * QUIET_COLS)}${SGR_RESET}`;
  const body = lines.map((line) => {
    // Pad short lines with light modules so every row is the same width — a ragged right edge would
    // leave part of the quiet zone missing.
    const padded = line + LIGHT_ALL.repeat(width - [...line].length);
    return `${SGR_QR}${margin}${padded}${margin}${SGR_RESET}`;
  });
  return [...Array(QUIET_TEXT_ROWS).fill(blank), ...body, ...Array(QUIET_TEXT_ROWS).fill(blank)].join("\n");
}

export async function renderQr(url: string): Promise<string> {
  if (url.length > MAX_URL_LEN) throw new Error(`url too long to render as a QR code (${url.length} > ${MAX_URL_LEN})`);
  let qrcode: QrModule;
  try {
    qrcode = (await import("qrcode-terminal")).default;
  } catch {
    throw new Error("qrcode-terminal isn't installed — run 'bun install' in the plugin root");
  }
  const code = await new Promise<string>((resolve) =>
    qrcode.generate(url, { small: true }, (out: string) => resolve(out)),
  );
  return colourAndPad(code);
}

if (import.meta.main) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: qr.ts <url>");
    process.exit(2);
  }
  try {
    process.stdout.write("\n" + (await renderQr(url)) + "\n\n" + url + "\n\n");
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

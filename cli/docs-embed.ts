// The operator manual, embedded in the binary at build time.
//
// WHY EMBEDDED, AND NOT READ OFF DISK. A disk read has to resolve a checkout root, and
// `bridge/root.ts` says what that costs: it needs the `herdr-plugin.toml` marker beside the
// install. One install kind does not keep `docs/` under the install root at all — the Arch package
// installs those pages to `/usr/share/doc/collie/docs`, on the stated assumption that nothing reads
// them at run time. So a disk read is right on a checkout, right on the tarball, right on the Nix
// build, and broken on that one. Embedding is right on all four, and it makes the printed text match
// the binary's own version by construction.
//
// What `collie docs` prints is therefore a COMPILE-TIME SNAPSHOT, and that is intended. It reports
// what this binary was built with, never the checkout on disk — which is the whole reason a packaged
// install, where there is no checkout to read, answers at all. Nobody turns this back into a disk
// read later.
//
// THIS IS THE ONLY MODULE THAT SPELLS A `docs/` PATH. `cli/docs-embed.test.ts` fails when a page
// lands in `docs/` without a line below. The root contributor specifications are deliberately not
// here: the largest of them is 194 KB on its own, and an agent that needs them has the checkout.

import commands from "../docs/commands.md" with { type: "text" };
import crew from "../docs/crew.md" with { type: "text" };
import configure from "../docs/configure.md" with { type: "text" };
import deployment from "../docs/deployment.md" with { type: "text" };
import install from "../docs/install.md" with { type: "text" };
import multiplexers from "../docs/multiplexers.md" with { type: "text" };
import security from "../docs/security.md" with { type: "text" };
import troubleshooting from "../docs/troubleshooting.md" with { type: "text" };
import upgrading from "../docs/upgrading.md" with { type: "text" };
import voiceAndPush from "../docs/voice-and-push.md" with { type: "text" };

// The agent-facing brief, which is not one of the pages: it is hand-written, it carries two
// placeholder tokens `cli/docs.ts` fills at print time, and `collie skill` prints it alone.
import SKILL_TEMPLATE from "./skill.md" with { type: "text" };

export { SKILL_TEMPLATE };

export interface DocPage {
  /** The file stem, which is the name an operator types: `crew` for `docs/crew.md`. */
  readonly name: string;
  /** One line, for the table `collie skill` prints. The title comes from the page itself. */
  readonly purpose: string;
  /** The page, verbatim. */
  readonly text: string;
}

/**
 * The ten pages in an OPERATOR'S READING ORDER — install first, troubleshooting last — and never
 * alphabetically. `collie docs` lists them in this order and `collie docs --all` prints them in it.
 */
export const DOC_PAGES: readonly DocPage[] = [
  {
    name: "install",
    purpose: "Requirements, the two routes in, first run, and opening it on your phone",
    text: install,
  },
  {
    name: "configure",
    purpose: "The `.env`, your own commands, keys, quick replies, typefaces and language",
    text: configure,
  },
  {
    name: "commands",
    purpose: "Every verb, putting `collie` on your PATH, and the Herdr actions that mirror them",
    text: commands,
  },
  {
    name: "crew",
    purpose: "Several machines behind one URL: invite, join, deputy, failover",
    text: crew,
  },
  {
    name: "upgrading",
    purpose: "Update from the phone or the terminal, roll back, update a crew, cross a major",
    text: upgrading,
  },
  {
    name: "multiplexers",
    purpose: "Pointing Collie at Herdr, tmux or zellij, and what each backend can answer",
    text: multiplexers,
  },
  {
    name: "voice-and-push",
    purpose: "The microphone in the composer, and notifications when an agent waits on you",
    text: voiceAndPush,
  },
  {
    name: "security",
    purpose: "What a Collie exposes, the defences, and pairing a device as the write credential",
    text: security,
  },
  {
    name: "deployment",
    purpose: "Front doors other than the default, and several Collies on one host",
    text: deployment,
  },
  {
    name: "troubleshooting",
    purpose: "Symptoms in the words you would actually search for",
    text: troubleshooting,
  },
];

/**
 * Old names an operator may still type, each pointing at the page that carries the text now.
 *
 * `collie docs pack` printed the crew page for every release up to 1.6.0, and ADR 0038 keeps that
 * name working until 2.0.0. An alias is deliberately NOT a `DOC_PAGES` entry: the registry is one
 * row per file on disk, `cli/docs-embed.test.ts` asserts exactly that, and the table `collie skill`
 * prints lists the name to learn, not the name to unlearn.
 */
export const DOC_PAGE_ALIASES = { pack: "crew" } as const satisfies Readonly<Record<string, string>>;

function isDocPageAlias(name: string): name is keyof typeof DOC_PAGE_ALIASES {
  return name in DOC_PAGE_ALIASES;
}

/** The page an operator asked for, by registry name or by an old name from `DOC_PAGE_ALIASES`. */
export function findDocPage(name: string): DocPage | undefined {
  const stem = isDocPageAlias(name) ? DOC_PAGE_ALIASES[name] : name;
  return DOC_PAGES.find((p) => p.name === stem);
}

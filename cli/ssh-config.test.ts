import { describe, expect, test } from "bun:test";

import { fakeFiles, HOME } from "./fakes.ts";
import { sshConfigCandidates, type SshConfigFiles } from "./ssh-config.ts";

// The ssh-config provider over the injected `Files` seam. **NO TEST HERE READS A REAL
// `~/.ssh/config`** — every fixture is a string in this file, which is the whole reason the parser
// takes the seam rather than reaching for `node:fs`.

const CONFIG = `${HOME}/.ssh/config`;

function candidates(seed: Record<string, string>): readonly string[] {
  const files: SshConfigFiles = fakeFiles(seed);
  return sshConfigCandidates(files, HOME).map((c) => c.target);
}

describe("sshConfigCandidates", () => {
  test("no config file is no candidates, and no error", () => {
    expect(candidates({})).toEqual([]);
  });

  test("Host entries come out in file order, one candidate each", () => {
    expect(
      candidates({
        [CONFIG]: [
          "# the boxes",
          "Host attic",
          "  HostName attic.lan",
          "  User op",
          "",
          "Host build-box nas",
          "  HostName 10.0.0.5",
        ].join("\n"),
      }),
    ).toEqual(["attic", "build-box", "nas"]);
  });

  test("a wildcard pattern and a negation are not machines and are dropped", () => {
    expect(
      candidates({
        [CONFIG]: ["Host *", "  ServerAliveInterval 15", "Host *.internal", "Host !gateway attic"].join("\n"),
      }),
    ).toEqual(["attic"]);
  });

  test("the keyword is case-insensitive and may be spelled with `=`", () => {
    expect(candidates({ [CONFIG]: "HOST=attic\nhost nas" })).toEqual(["attic", "nas"]);
  });

  test("a repeated alias is offered once", () => {
    expect(candidates({ [CONFIG]: "Host attic\nHost attic" })).toEqual(["attic"]);
  });

  test("Include is followed one level, and the included aliases are offered", () => {
    expect(
      candidates({
        [CONFIG]: "Host attic\nInclude work/hosts",
        [`${HOME}/.ssh/work/hosts`]: "Host office\n  HostName office.corp",
      }),
    ).toEqual(["attic", "office"]);
  });

  test("Include takes a glob, matched against one directory's entries", () => {
    expect(
      candidates({
        [CONFIG]: "Include config.d/*",
        [`${HOME}/.ssh/config.d/10-work`]: "Host office",
        [`${HOME}/.ssh/config.d/20-home`]: "Host attic",
        [`${HOME}/.ssh/config.d/notes.txt`]: "Host ignored",
      }),
    ).toEqual(["office", "attic", "ignored"]);
  });

  test("a `~/` Include still has to land under ~/.ssh/", () => {
    expect(
      candidates({
        [CONFIG]: "Include ~/.ssh/extra",
        [`${HOME}/.ssh/extra`]: "Host attic",
      }),
    ).toEqual(["attic"]);
  });

  test("an Include resolving outside ~/.ssh/ is skipped in silence", () => {
    expect(
      candidates({
        [CONFIG]: "Host attic\nInclude /etc/ssh/ssh_config\nInclude ../../etc/hosts\nInclude ~/notes",
        "/etc/ssh/ssh_config": "Host leaked-etc",
        "/etc/hosts": "Host leaked-traversal",
        [`${HOME}/notes`]: "Host leaked-home",
      }),
    ).toEqual(["attic"]);
  });

  test("Include is one level deep — the included file's own Include is not read", () => {
    expect(
      candidates({
        [CONFIG]: "Include first",
        [`${HOME}/.ssh/first`]: "Host office\nInclude second",
        [`${HOME}/.ssh/second`]: "Host too-deep",
      }),
    ).toEqual(["office"]);
  });

  test("a Match block is not a Host entry and contributes nothing of its own", () => {
    expect(
      candidates({
        [CONFIG]: ["Match host attic exec \"test -f /tmp/x\"", "  ProxyJump bastion", "Host attic"].join("\n"),
      }),
    ).toEqual(["attic"]);
  });

  test("the provider never writes: the seed is untouched after a read", () => {
    const files = fakeFiles({ [CONFIG]: "Host attic" });
    sshConfigCandidates(files, HOME);
    expect(files.ops).toEqual([]);
    expect([...files.entries.keys()]).toEqual([CONFIG]);
  });
});

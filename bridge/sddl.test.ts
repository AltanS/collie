import { describe, expect, test } from "bun:test";

import {
  foreignGrants,
  foreignOwner,
  formatSaved,
  parseSaved,
  parseSddl,
  parseWhoamiSid,
  sidName,
  TRUSTED_INSTALLER_SID,
} from "./sddl.ts";

// Pure: no process, no fake tool. Every sample below is real `icacls /save` output from the
// Windows 11 test VM (2026-10-02) unless it says "synthesised".

const SID = "S-1-5-21-1678274354-1849132225-3673151578-1000";

/**
 * The raw bytes of `icacls C:\spec04m2\aliases /save <f> /T`, base64: UTF-16LE, no byte-order mark.
 * The folder had grants for Guests, Network (inherit-only), ALL APPLICATION PACKAGES and
 * Interactive, and sits under `C:\` (inherited Users and Authenticated Users).
 */
const ALIAS_TREE_UTF16 = "YQBsAGkAYQBzAGUAcwANAAoARAA6AEEASQAoAEEAOwBPAEkAQwBJADsARgBSADsAOwA7AEIARwApACgAQQA7AE8ASQBDAEkASQBPADsAMAB4ADEAMwAwADEAYgBmADsAOwA7AE4AVQApACgAQQA7AE8ASQBDAEkAOwAwAHgAMQAyADAAMABhADkAOwA7ADsAQQBDACkAKABBADsATwBJAEMASQA7AEYAUgA7ADsAOwBJAFUAKQAoAEEAOwBPAEkAQwBJAEkARAA7AEYAQQA7ADsAOwBCAEEAKQAoAEEAOwBPAEkAQwBJAEkARAA7AEYAQQA7ADsAOwBTAFkAKQAoAEEAOwBPAEkAQwBJAEkARAA7ADAAeAAxADIAMAAwAGEAOQA7ADsAOwBCAFUAKQAoAEEAOwBJAEQAOwAwAHgAMQAzADAAMQBiAGYAOwA7ADsAQQBVACkAKABBADsATwBJAEMASQBJAE8ASQBEADsAUwBEAEcAWABHAFcARwBSADsAOwA7AEEAVQApAA0ACgBhAGwAaQBhAHMAZQBzAFwAZgAuAHQAeAB0AA0ACgBEADoAQQBJACgAQQA7AEkARAA7AEYAUgA7ADsAOwBCAEcAKQAoAEEAOwBJAEQAOwAwAHgAMQAzADAAMQBiAGYAOwA7ADsATgBVACkAKABBADsASQBEADsAMAB4ADEAMgAwADAAYQA5ADsAOwA7AEEAQwApACgAQQA7AEkARAA7AEYAUgA7ADsAOwBJAFUAKQAoAEEAOwBJAEQAOwBGAEEAOwA7ADsAQgBBACkAKABBADsASQBEADsARgBBADsAOwA7AFMAWQApACgAQQA7AEkARAA7ADAAeAAxADIAMAAwAGEAOQA7ADsAOwBCAFUAKQAoAEEAOwBJAEQAOwAwAHgAMQAzADAAMQBiAGYAOwA7ADsAQQBVACkADQAKAGEAbABpAGEAcwBlAHMAXABnAC4AdAB4AHQADQAKAEQAOgBBAEkAKABBADsASQBEADsARgBSADsAOwA7AEIARwApACgAQQA7AEkARAA7ADAAeAAxADMAMAAxAGIAZgA7ADsAOwBOAFUAKQAoAEEAOwBJAEQAOwAwAHgAMQAyADAAMABhADkAOwA7ADsAQQBDACkAKABBADsASQBEADsARgBSADsAOwA7AEkAVQApACgAQQA7AEkARAA7AEYAQQA7ADsAOwBCAEEAKQAoAEEAOwBJAEQAOwBGAEEAOwA7ADsAUwBZACkAKABBADsASQBEADsAMAB4ADEAMgAwADAAYQA5ADsAOwA7AEIAVQApACgAQQA7AEkARAA7ADAAeAAxADMAMAAxAGIAZgA7ADsAOwBBAFUAKQANAAoA";

const aliasTree = (): string => Buffer.from(ALIAS_TREE_UTF16, "base64").toString("utf16le");

const grantsOf = (sddl: string, user = SID) => foreignGrants(parseSddl(sddl).dacl!, user);

describe("the real UTF-16 save with aliases", () => {
  test("reads every entry, non-ASCII-safe, and names each stranger once with its widest right", () => {
    const entries = parseSaved(aliasTree());
    expect(entries.map((e) => e.name)).toEqual(["aliases", "aliases\\f.txt", "aliases\\g.txt"]);
    expect(grantsOf(entries[0]!.sddl)).toEqual([
      { sid: "S-1-5-32-546", what: "read" },
      { sid: "S-1-5-2", what: "change on new files" },
      { sid: "S-1-15-2-1", what: "read" },
      { sid: "S-1-5-4", what: "read" },
      { sid: "S-1-5-32-545", what: "read" },
      { sid: "S-1-5-11", what: "change" },
    ]);
  });

  test("a file below inherits the same strangers, the inherit-only one now applying to it", () => {
    const file = parseSaved(aliasTree())[1]!;
    expect(grantsOf(file.sddl).map((g) => `${sidName(g.sid)}: ${g.what}`)).toEqual([
      "Guests: read",
      "Network: change",
      "ALL APPLICATION PACKAGES: read",
      "Interactive: read",
      "Users: read",
      "Authenticated Users: change",
    ]);
  });
});

describe("the allowlist", () => {
  test("a profile folder, inherited only: the account, SYSTEM and Administrators pass", () => {
    const profile = `D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${SID})`;
    expect(grantsOf(profile)).toEqual([]);
    expect(parseSddl(profile).dacl!.protected).toBe(false);
  });

  test("the same account's SID is a stranger to a different account", () => {
    expect(grantsOf(`D:(A;;FA;;;${SID})`, "S-1-5-21-1-2-3-1002")).toEqual([{ sid: SID, what: "full control" }]);
  });

  test("the built-in Administrator account is written LA: the account itself when it runs Collie, a stranger otherwise", () => {
    const admin = "S-1-5-21-1678274354-1849132225-3673151578-500";
    expect(grantsOf("D:(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)", admin)).toEqual([]);
    expect(grantsOf("D:(A;OICI;FA;;;LA)", SID)).toEqual([{ sid: "LA", what: "full control" }]);
    expect(foreignOwner(parseSddl("O:LAD:"), admin)).toBeNull();
    expect(foreignOwner(parseSddl("O:LAD:"), SID)).toBe("LA");
  });

  test("a deny-only case: a deny for Everyone is no leak, and a protected private list passes", () => {
    expect(grantsOf("D:PAI(D;;FR;;;WD)(A;;FA;;;BA)(A;;FA;;;SY)")).toEqual([]);
  });

  test("CREATOR OWNER, OWNER RIGHTS and TrustedInstaller are allowed; Local Service is not", () => {
    expect(grantsOf(`D:(A;OICIIO;FA;;;CO)(A;;FA;;;OW)(A;;FA;;;${TRUSTED_INSTALLER_SID})`)).toEqual([]);
    expect(grantsOf("D:(A;;FR;;;LS)")).toEqual([{ sid: "S-1-5-19", what: "read" }]);
  });

  test("SYNCHRONIZE and READ_ATTRIBUTES alone say nothing about the content; traverse does", () => {
    expect(grantsOf("D:(A;;0x100080;;;BU)")).toEqual([]);
    expect(grantsOf("D:(A;;0x100020;;;S-1-15-3-65536-1)")).toEqual([{ sid: "S-1-15-3-65536-1", what: "access" }]);
  });

  test("any right counts, not just read: append, delete, WRITE_DAC, WRITE_OWNER", () => {
    for (const mask of ["0x4", "0x10000", "0x40000", "0x80000", "WD", "WO"]) {
      expect(grantsOf(`D:(A;;${mask};;;BU)`)).toEqual([{ sid: "S-1-5-32-545", what: "change" }]);
    }
  });

  test("object and conditional allow entries count; an unknown right counts as full control", () => {
    expect(grantsOf('D:(XA;;FR;;;WD;(@User.Project Any_of {"x"}))(OA;;CC;;;AU)')).toEqual([
      { sid: "S-1-1-0", what: "read" },
      { sid: "S-1-5-11", what: "read" },
    ]);
    expect(grantsOf("D:(A;;ZZ;;;BU)")).toEqual([{ sid: "S-1-5-32-545", what: "full control" }]);
  });

  test("an inherit-only entry that passes to nothing applies to nothing; NP still passes one level", () => {
    expect(grantsOf("D:(A;IO;FA;;;BU)")).toEqual([]);
    expect(grantsOf("D:(A;OINPIO;FR;;;BU)")).toEqual([{ sid: "S-1-5-32-545", what: "read on new files" }]);
  });

  test("domain aliases and domain-style SIDs (synthesised: icacls refuses a SID it cannot map, exit 1332)", () => {
    const sddl = "D:(A;;FR;;;DU)(A;;FR;;;DG)(A;;FR;;;S-1-5-21-1111111111-2222222222-3333333333-513)(A;;FR;;;S-1-5-21-1111111111-2222222222-3333333333-501)(A;;FR;;;S-1-12-1-1-2-3-4)";
    expect(grantsOf(sddl).map((g) => sidName(g.sid))).toEqual([
      "Domain Users",
      "Domain Guests",
      "Domain Users",
      "the Guest account",
      "a Microsoft Entra account",
    ]);
  });

  test("a null DACL lets everyone in", () => {
    expect(grantsOf("D:NO_ACCESS_CONTROL")[0]!.sid).toBe("S-1-1-0");
  });

  test("the plain, translated icacls output is no SDDL, which is why only /save is read", () => {
    const german = "C:\\daten\\.env Jeder:(R)\r\n VORDEFINIERT\\Benutzer:(I)(RX)\r\n";
    expect(parseSddl(german).dacl).toBeNull();
  });
});

describe("the owner", () => {
  test("O: is read when Get-Acl wrote it; icacls never does", () => {
    expect(parseSddl(`O:BAG:S-1-5-21-1-2-3-513D:PAI(A;OICI;FA;;;SY)`).owner).toBe("S-1-5-32-544");
    expect(parseSddl("D:PAI(A;OICI;FA;;;SY)").owner).toBeNull();
  });

  test("a foreign owner is named; the account, SYSTEM, Administrators and TrustedInstaller are not", () => {
    expect(foreignOwner(parseSddl("O:S-1-5-21-1-2-3-1002D:"), SID)).toBe("S-1-5-21-1-2-3-1002");
    for (const owner of [SID, "BA", "SY", TRUSTED_INSTALLER_SID]) expect(foreignOwner(parseSddl(`O:${owner}D:`), SID)).toBeNull();
  });
});

describe("the tool texts", () => {
  test("formatSaved writes what parseSaved reads", () => {
    const entries = parseSaved(aliasTree());
    expect(parseSaved(formatSaved(entries))).toEqual(entries);
  });

  test("whoami: the SID, whatever code page the name half is in", () => {
    expect(parseWhoamiSid(`"win-75jufu04dbi\\collie","${SID}"\r\n`)).toBe(SID);
    expect(parseWhoamiSid('"pc\\rehearse \x9anal","S-1-5-21-1-2-3-1002"')).toBe("S-1-5-21-1-2-3-1002");
    expect(parseWhoamiSid("ERROR: Access is denied.")).toBeNull();
  });
});

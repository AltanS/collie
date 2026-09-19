import { describe, expect, test } from "bun:test";

import { compareSemver } from "./update.ts";
import { crewNeedsLevelling, legStillFailed, memberBehind, type CrewUpdateRow } from "./update-action.ts";
import { compareSemver as phoneCompareSemver } from "../web/src/lib/semver.ts";
import {
  crewNeedsLevelling as phoneCrewNeedsLevelling,
  legStillFailed as phoneLegStillFailed,
  memberBehind as phoneMemberBehind,
} from "../web/src/lib/crew-level.ts";

// ONE RULE FOR "IS THERE ANYTHING FOR A CREW RUN TO DO?", WRITTEN TWICE.
//
// The phone decides whether to offer "Update crew" / "Retry crew update" (`web/src/lib/crew-level.ts`)
// and this bridge decides whether to accept the peers-only start the button sends
// (`bridge/update-action.ts`). The trees cannot import one another, so each side has its own copy and
// its own tests, and either could change alone and stay green. This file is the one that does not:
// it imports across the boundary on purpose, as `auth-path-contract.test.ts` does, and runs ONE list
// of cases through both copies. Both web modules are pure and import nothing but types.

const LEAD = "1.9.1";

const member = (name: string, version: string | null, over: Partial<CrewUpdateRow> = {}): CrewUpdateRow => ({
  name,
  version,
  verdict: "green",
  reasons: [],
  asOf: 1,
  ...over,
});

describe("the version order is the same on both sides", () => {
  const PAIRS: readonly [string, string][] = [
    ["1.9.1", "1.9.0"],
    ["1.9.0", "1.9.0"],
    ["1.10.0", "1.9.9"],
    ["2.0.0", "1.99.99"],
    ["1.0.0-beta.9", "1.0.0-beta.10"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0-beta", "1.0.0-beta.1"],
    ["1.0.0-1", "1.0.0-alpha"],
    ["1.0.0+ab12cd3", "1.0.0"],
    ["unknown", "1.0.0"],
  ];
  for (const [a, b] of PAIRS) {
    test(`${a} vs ${b}`, () => {
      expect(phoneCompareSemver(a, b)).toBe(compareSemver(a, b));
      expect(phoneCompareSemver(b, a)).toBe(compareSemver(b, a));
    });
  }
});

describe("memberBehind: strictly lower by semver, known, and not packaged", () => {
  const CASES: readonly { case: string; member: CrewUpdateRow; behind: boolean }[] = [
    { case: "a member a release back", member: member("minibuch", "1.9.0"), behind: true },
    { case: "a member on the lead's own version", member: member("minibuch", LEAD), behind: false },
    { case: "a member that levelled itself PAST the lead", member: member("minibuch", "1.10.0"), behind: false },
    { case: "a member whose version nobody could learn", member: member("minibuch", null), behind: false },
    {
      case: "a packaged member a release back",
      member: member("minibuch", "1.9.0", { installKind: "packaged" }),
      behind: false,
    },
    { case: "a member on a prerelease of the lead's version", member: member("minibuch", "1.9.1-rc.1"), behind: true },
  ];
  for (const c of CASES) {
    test(c.case, () => {
      expect(memberBehind(c.member, LEAD)).toBe(c.behind);
      expect(phoneMemberBehind(c.member, LEAD)).toBe(c.behind);
    });
  }
});

describe("legStillFailed: a failed leg counts until the census shows its member level", () => {
  const CASES: readonly {
    case: string;
    leg: { name: string; state: string };
    crew: CrewUpdateRow[];
    counts: boolean;
  }[] = [
    {
      case: "a rolled-back leg whose member is still behind",
      leg: { name: "minibuch", state: "rolled-back" },
      crew: [member("minibuch", "1.9.0")],
      counts: true,
    },
    {
      case: "a STALE rolled-back leg whose member has since levelled itself",
      leg: { name: "minibuch", state: "rolled-back" },
      crew: [member("minibuch", LEAD)],
      counts: false,
    },
    {
      case: "a stale unreachable leg whose member is now ahead of the lead",
      leg: { name: "minibuch", state: "unreachable" },
      crew: [member("minibuch", "1.10.0")],
      counts: false,
    },
    {
      case: "a failed leg whose member's version is UNKNOWN",
      leg: { name: "minibuch", state: "rolled-back" },
      crew: [member("minibuch", null)],
      counts: true,
    },
    {
      case: "a failed leg with no census row at all",
      leg: { name: "attic", state: "unreachable" },
      crew: [member("minibuch", LEAD)],
      counts: true,
    },
    {
      case: "a leg from an older bridge that ended stuck",
      leg: { name: "minibuch", state: "stuck" },
      crew: [member("minibuch", "1.9.0")],
      counts: true,
    },
    {
      // A packaged member that has gone quiet reads `unreachable`, not `package-managed` (`legOf`,
      // crew/follow.ts), and nothing the phone can start would ever clear it. A sleeping laptop must
      // not leave "Retry crew update" standing for good.
      case: "a failed leg on a PACKAGED member, whose version no run from here can move",
      leg: { name: "minibuch", state: "unreachable" },
      crew: [member("minibuch", "1.9.0", { installKind: "packaged" })],
      counts: false,
    },
    {
      case: "a leg that arrived is not a failed leg",
      leg: { name: "minibuch", state: "done" },
      crew: [member("minibuch", "1.9.0")],
      counts: false,
    },
  ];
  for (const c of CASES) {
    test(c.case, () => {
      expect(legStillFailed(c.leg, c.crew, LEAD)).toBe(c.counts);
      expect(phoneLegStillFailed(c.leg, c.crew, LEAD)).toBe(c.counts);
    });
  }
});

describe("crewNeedsLevelling: the button and the route agree on the whole crew", () => {
  const CASES: readonly {
    case: string;
    crew: CrewUpdateRow[];
    legs: { name: string; state: string }[];
    needs: boolean;
  }[] = [
    { case: "every member on the lead's version", crew: [member("a", LEAD), member("b", LEAD)], legs: [], needs: false },
    { case: "one member ahead, one level", crew: [member("a", "1.10.0"), member("b", LEAD)], legs: [], needs: false },
    { case: "one member behind", crew: [member("a", "1.9.0"), member("b", LEAD)], legs: [], needs: true },
    {
      case: "the last run's failed leg, since levelled",
      crew: [member("a", LEAD)],
      legs: [{ name: "a", state: "rolled-back" }],
      needs: false,
    },
    {
      case: "the last run's failed leg, version unknown",
      crew: [member("a", null)],
      legs: [{ name: "a", state: "rolled-back" }],
      needs: true,
    },
  ];
  for (const c of CASES) {
    test(c.case, () => {
      expect(crewNeedsLevelling(c.crew, c.legs, LEAD)).toBe(c.needs);
      expect(phoneCrewNeedsLevelling(c.crew, c.legs, LEAD)).toBe(c.needs);
    });
  }
});

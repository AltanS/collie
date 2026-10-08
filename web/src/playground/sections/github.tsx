// GitHub section of the states playground. See app.tsx's header comment for the whole page's rules.
//
// Each card mounts the real screen (`GithubRoute`) with its answer handed in, so what shows here is
// what the phone draws for that answer. The lists are the unit suite's (`@/test/github-fixtures`).

import {
  githubAbsent,
  githubCold,
  githubEmpty,
  githubOff,
  githubOk,
  githubStale,
  githubUnauthenticated,
  homeSolo,
} from "../fixtures";
import { GithubRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "github",
  title: "GitHub",
  intent:
    "The host's GitHub work, read through its own gh (ADR 0091): my pull requests with what is stuck first, the ones waiting on my review, and the issues assigned to me by repo. The lists, a stale answer kept under a notice, empty lists, and every state with no lists: off, the first read, gh signed out, and a machine too old to have the screen.",
};

export function GithubSection() {
  return (
    <Section def={DEF}>
      <Group title="The lists">
        <Card
          state="github-ok"
          label="github, the lists"
          reach="Dashboard footer → GitHub, on a machine with COLLIE_GITHUB=1 and gh signed in. Stuck PRs first (checks failing; changes requested on a conflict), then waiting (checks pending with the merge state unknown; a draft), then the ready one."
          note="Every chip carries a word. 'mergeable unknown' is grey, never green: GitHub has not computed it, so it is not a clean merge. The issues list is 4 of 86, so it says so and links to GitHub's own search."
          span={2}
        >
          <PhoneFrameCard height={1500}>
            <GithubRouter home={homeSolo} state={githubOk} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="github-stale-error"
          label="github, the last refresh failed"
          reach="the bridge's refresh failed (here GitHub answered 502) while it held a good answer. The lists stay; a notice above them says how old they are and quotes gh."
          note="Caution, not danger: nothing is lost, and the next beat or the refresh button tries again."
        >
          <PhoneFrameCard height={560}>
            <GithubRouter home={homeSolo} state={githubStale} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="github-empty"
          label="github, nothing open"
          reach="gh signed in, and no open PR, no review request and no assigned issue. Each list keeps its frame and says it is empty."
        >
          <PhoneFrameCard height={420}>
            <GithubRouter home={homeSolo} state={githubEmpty} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="No lists">
        <Card
          state="github-off"
          label="github, off"
          reach="COLLIE_GITHUB is not set on the machine (the default: the feature is opt-in). The dashboard draws no footer line in this state; a deep link lands here."
        >
          <PhoneFrameCard height={300}>
            <GithubRouter home={homeSolo} state={githubOff} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="github-cold"
          label="github, the first read"
          reach="the feature is on and nothing is cached yet: the bridge is running gh, which takes a few seconds the first time."
        >
          <PhoneFrameCard height={260}>
            <GithubRouter home={homeSolo} state={githubCold} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="github-unavailable-unauthenticated"
          label="github, gh signed out"
          reach="gh is installed on the machine but not signed in. The card names the command to run there, and quotes gh's own line under it."
        >
          <PhoneFrameCard height={300}>
            <GithubRouter home={homeSolo} state={githubUnauthenticated} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="github-absent"
          label="github, an older machine"
          reach="the screen asked a crew member (?h=) whose Collie predates the route, so it answered 404. That is an answer, not an outage."
        >
          <PhoneFrameCard height={260}>
            <GithubRouter home={homeSolo} state={githubAbsent} />
          </PhoneFrameCard>
        </Card>
      </Group>
    </Section>
  );
}

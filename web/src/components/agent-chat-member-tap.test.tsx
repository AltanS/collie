import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryRouter, RouterProvider } from "react-router";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { dialogDetector } from "@/lib/dialog-guard";
import { t } from "@/lib/i18n";
import type { JsonValue } from "@/lib/json";
import { useStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";
import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// A permission card on a crew member's pane takes the guarded key route (lib/send-path.ts). The field
// case of 2026-11-16: a subagent's Bash permission on a member (Claude Code 2.1.325, Herdr 0.9.5),
// with the main thread's background Bash ticking a timer in a row above the dialog. The pane's
// revision moved with every tick, the guard refused every tap, and no key was sent. A tap now sends
// the plan's keys once, bound to the dialog's own rows.

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const HOST = "workshop";
const DETECTED = 12972;
const BASE = readFileSync(join(import.meta.dirname, "..", "fixtures", "panes", "claude-lab--permission-bash-subagent--w82.txt"), "utf8");
// eslint-disable-next-line no-control-regex -- the fixture is a raw pane read, ANSI and all
const plain = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "");

/** The fixture with `rows` in place of its transcript row that matches `at`. */
function withRows(at: (row: string) => boolean, rows: string[]): string {
  const all = BASE.split("\r\n");
  const i = all.findIndex((row) => at(plain(row)));
  expect(i).toBeGreaterThanOrEqual(0);
  return [...all.slice(0, i), ...rows, ...all.slice(i + 1)].join("\r\n");
}
const waiting = (row: string) => row.includes("Waiting for 1 background agent");
const SEEN = withRows(waiting, ["● Bash(sleep 600)", "  ⎿  Running… (4m 12s · timeout 10m)"]);
const NOW = withRows(waiting, ["● Bash(sleep 600)", "  ⎿  Running… (4m 16s · timeout 10m)"]);

interface Posted {
  readonly host: string | null;
  readonly body: JsonValue;
}

function StatusLine() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

/** Mount Chat on a member's Claude pane showing `SEEN`; every fresh read answers `fresh` at N+4. */
function mountMember(fresh: string) {
  const posted: Posted[] = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: fixtureAgents[0]!.paneId, text: fresh, truncated: false, revision: DETECTED + 4 })),
    http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      // SAFETY: the phone's own JSON.stringify body is JSON, a JsonValue.
      posted.push({ host: new URL(request.url).searchParams.get("host"), body: (await request.json()) as JsonValue });
      return HttpResponse.json({ ok: true });
    }),
  );
  const agent: AgentView = { ...fixtureAgents[0]!, host: HOST, sendProtocol: true };
  const router = createMemoryRouter([
    {
      path: "/",
      element: withHeaderHost(
        <>
          <StatusLine />
          <AgentChat
            paneId={agent.paneId}
            agent={agent}
            agents={[agent]}
            shellPanes={[]}
            tabs={[]}
            text={SEEN}
            revision={DETECTED}
            onBack={vi.fn()}
            onSelect={vi.fn()}
            scope={{ host: HOST }}
          />
        </>,
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return posted;
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentChat: a permission card on a crew member's busy pane", () => {
  it("a tap on Yes sends the plan's keys once, with a ticking row above the dialog and a moved revision", async () => {
    const posted = mountMember(NOW);
    await userEvent.click(await screen.findByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    const bound = dialogDetector("prompt-select", "claude")(splitLines(parseAnsi(NOW)))!.bindRegion;
    expect(bound).toBeDefined();
    expect(posted[0]).toEqual({ host: HOST, body: { keys: ["1"], expected_prompt: bound } });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(t("chat.status.sent")));
  });

  it("a tap on a dialog that another command replaced sends nothing, and the notice says the menu changed", async () => {
    const posted = mountMember(withRows((row) => row === " touch /tmp/claude-lab/project/sub-one.txt", [" rm -rf /tmp/claude-lab/project"]));
    await userEvent.click(await screen.findByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(t("chat.status.menuChanged")));
    expect(posted).toHaveLength(0);
  });
});

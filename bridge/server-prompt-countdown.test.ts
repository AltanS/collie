import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { DIALOG_CONTRACT } from "../web/src/lib/harness/dialog-contract.ts";
import { detectPromptSelect } from "../web/src/lib/harness/claude/prompt-select.ts";
import { AuditLog } from "./audit.ts";
import { loadConfig } from "./config.ts";
import type { HerdrClient, PaneRead } from "./mux/herdr/client.ts";
import { HerdrMux } from "./mux/herdr/adapter.ts";
import type { MuxAdapter } from "./mux/types.ts";
import { keysPane } from "./server.ts";

class FakePaneClient {
  text = "";
  readonly keys: Array<[string, string[]]> = [];

  readPane(paneId: string): Promise<PaneRead> {
    return Promise.resolve({ pane_id: paneId, text: this.text, truncated: false, revision: 1 });
  }

  sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    this.keys.push([paneId, keys]);
    return Promise.resolve();
  }
}

function asMux(fake: Partial<HerdrClient>): MuxAdapter {
  // SAFETY: keysPane reaches only readPane and sendPaneKeys, both implemented by FakePaneClient.
  return new HerdrMux(fake as HerdrClient, () => []);
}

const BG = readFileSync(
  new URL("../web/src/fixtures/panes/claude--v2303-permission-bash-bg-agent-rm--w160.txt", import.meta.url),
  "utf8",
);

function blockScreen(clock: string, other = false): string {
  const rows = (other ? BG.replace("level.py;", "level.sh;") : BG).split("\n");
  const at = rows.findIndex((row) => row.includes("Dangerous rm operation"));
  rows.splice(
    at + 1,
    0,
    ` \u001b[0m\u001b[2m│\u001b[0m \u001b[38;2;255;193;7m⚠ Claude Code will automatically block this request in ${clock}, to avoid holding up an unattended session\u001b[0m\r`,
  );
  return rows.join("\n");
}

function phoneBinding(text: string): string | readonly string[] {
  const model = detectPromptSelect(splitLines(parseAnsi(text)));
  expect(model).not.toBeNull();
  const contract = DIALOG_CONTRACT["prompt-select"];
  return contract.parts?.(model!) ?? contract.region(model!);
}

async function tapOn(shown: string, onScreen: string) {
  const client = new FakePaneClient();
  client.text = onScreen;
  const audit = new AuditLog(() => undefined);
  const req = new Request("http://localhost/api/pane/w1%3Ap1/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: ["1"], expected_prompt: phoneBinding(shown) }),
  });
  const res = await keysPane(asMux(client), loadConfig({}), "w1:p1", req, audit, "phone", "default");
  return { res, client };
}

describe("keysPane prompt binding — Claude Code 2.1.330 countdown wording", () => {
  test("takes the tap as the block/holding-up clock moves and still refuses another command", async () => {
    const parts = phoneBinding(blockScreen("1:20"));
    expect(Array.isArray(parts)).toBe(true);
    for (const clock of ["1:19", "0:59", "about 45 seconds"]) {
      const { res, client } = await tapOn(blockScreen("1:20"), blockScreen(clock));
      expect(res.status).toBe(200);
      expect(client.keys).toEqual([["w1:p1", ["1"]]]);
    }
    const { res, client } = await tapOn(blockScreen("0:01"), blockScreen("1:20", true));
    expect(res.status).toBe(409);
    expect(client.keys).toEqual([]);
  });
});

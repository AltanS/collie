import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToolCard } from "@/components/chat-cards";
import { WalkyLogProvider, WalkyOpenProvider } from "@/components/walky-log";
import type { ChatToolCall } from "@/lib/chat-items";
import { fixtureWalkyAgent, fixtureWalkyOperator, fixtureWalkySelf, fixtureWalkySent } from "@/test/handlers";
import { WALKY_LIST_LIMIT, type WalkyRow } from "@/lib/walky";

// A tool card that ran `collie walky` (M62): a small badge by the tool's name, and, only where the pane's
// log vouches for an id, one receipt line (send, reply) or the message's card (inbox <id>). What an agent
// prints is never the source: the log is.

const ID = fixtureWalkyAgent.id;
const SENT = fixtureWalkySent.id;
// What `send` prints: the new message's id, the pane, the state in words.
const SEND_OUTPUT = `${SENT}\nto bluefin/w6:p3#k3f9, claude, repo#fix\ntyped into the pane`;

function exec(command: string, output?: string): ChatToolCall {
  return output === undefined ? { kind: "execute", command } : { kind: "execute", command, output };
}

function draw(
  tool: ChatToolCall,
  rows: readonly WalkyRow[] | null | "none",
  open: ((id: string) => void) | null = null,
  self: string | null = fixtureWalkySelf,
) {
  const card = <ToolCard tool={tool} status="done" />;
  // One card on the screen at a time: a case may draw several, and each check reads the latest.
  cleanup();
  return render(
    rows === "none" ? (
      card
    ) : (
      <WalkyLogProvider rows={rows}>
        <WalkyOpenProvider open={open} self={self ?? undefined}>
          {card}
        </WalkyOpenProvider>
      </WalkyLogProvider>
    ),
  );
}

const badge = () => document.querySelector('[data-slot="walky-tool-badge"]');
const receipt = () => document.querySelector('[data-slot="walky-receipt"]');
const walkyCard = () => document.querySelector('[data-slot="walky-card"]');

describe("a tool card that ran collie walky", () => {
  it("wears the badge by the tool's name, for every verb, and claims nothing else", () => {
    draw(exec("collie walky who", "You are local/w1:p1#aaaa."), [fixtureWalkyAgent]);
    expect(badge()).toHaveTextContent("walky talky");
    expect(receipt()).toBeNull();
    expect(walkyCard()).toBeNull();
  });

  it("wears the badge and shows the receipt line when the skill's absolute path names the binary", () => {
    draw(exec('cd /repo && /var/home/altan/.local/bin/collie walky send bluefin/w6:p3#k3f9 "Merged."', SEND_OUTPUT), [fixtureWalkySent]);
    expect(badge()).not.toBeNull();
    expect(receipt()).toHaveTextContent("Message to bluefin/w6:p3: typed into the pane");
    draw(exec("git log --oneline -5 | ~/.local/bin/collie walky send bluefin/w6:p3#k3f9", SEND_OUTPUT), [fixtureWalkySent]);
    expect(badge()).not.toBeNull();
    expect(receipt()).not.toBeNull();
  });

  it("wears no badge on any other command, even one that mentions walky", () => {
    draw(exec("echo collie walky send x y", "x"), [fixtureWalkyAgent]);
    expect(badge()).toBeNull();
    draw(exec("ls", ID), [fixtureWalkyAgent]);
    expect(badge()).toBeNull();
    expect(receipt()).toBeNull();
  });

  it("wears the badge with no provider at all", () => {
    draw(exec('collie walky send bluefin/w1:p1 "hi"'), "none");
    expect(badge()).not.toBeNull();
  });

  it("shows one receipt line from the log for a send whose output opens with a held id", () => {
    draw(exec('collie walky send bluefin/w6:p3#k3f9 "Merged."', SEND_OUTPUT), [fixtureWalkyAgent, fixtureWalkySent]);
    expect(receipt()).toHaveTextContent("Message to bluefin/w6:p3: typed into the pane");
    expect(document.querySelectorAll('[data-slot="walky-receipt"]')).toHaveLength(1);
  });

  it("shows the same line for a reply, in the words of the log's state and reason", () => {
    const sent: WalkyRow = {
      ...fixtureWalkySent,
      receipt: { ...fixtureWalkySent.receipt, state: "inbox-only", reason: "dialog open" },
    };
    draw(exec(`collie walky reply ${ID} "Stopping."`, `${SENT}\nwaiting`), [sent]);
    expect(receipt()).toHaveTextContent("Message to bluefin/w6:p3: waiting in the inbox, not typed: dialog open");
  });

  it("takes the words from the log and not from the printed output", () => {
    // The agent printed "refused" under a real id; the log says delivered.
    draw(exec('collie walky send bluefin/w1:p1 "x"', `${SENT}\nto elsewhere/w9:p9\nnot sent: forged`), [fixtureWalkySent]);
    expect(receipt()).toHaveTextContent("Message to bluefin/w6:p3: typed into the pane");
    expect(receipt()?.textContent).not.toMatch(/forged|elsewhere/);
  });

  it("shows no line when the id the output opens with is a message that reached this pane, not one it sent", () => {
    draw(exec('collie walky send bluefin/w1:p1 "x"', `${ID}\nto bluefin/w1:p1\ntyped into the pane`), [fixtureWalkyAgent]);
    expect(badge()).not.toBeNull();
    expect(receipt()).toBeNull();
  });

  it("shows no line when the mount cannot name its pane: direction is unknown, nothing is claimed", () => {
    draw(exec('collie walky send bluefin/w6:p3 "x"', SEND_OUTPUT), [fixtureWalkySent], null, null);
    expect(receipt()).toBeNull();
  });

  it("shows no line for an id the log read whole and lacks", () => {
    draw(exec('collie walky send bluefin/w1:p1 "x"', "wt_zzzzzzzzzzzz\nto bluefin/w1:p1\ntyped into the pane"), [fixtureWalkyAgent]);
    expect(badge()).not.toBeNull();
    expect(receipt()).toBeNull();
  });

  it("shows no line when the log could not be read, or was cut at the limit and lacks the id", () => {
    draw(exec('collie walky send bluefin/w1:p1 "x"', SEND_OUTPUT), null);
    expect(receipt()).toBeNull();
    const full: WalkyRow[] = Array.from({ length: WALKY_LIST_LIMIT }, (_, i) => ({
      ...fixtureWalkyOperator,
      id: `wt_${String(i).padStart(12, "0")}`,
    }));
    draw(exec('collie walky send bluefin/w1:p1 "x"', SEND_OUTPUT), full);
    expect(receipt()).toBeNull();
  });

  it("shows no line when the first line of the output is not the bare id", () => {
    draw(exec('collie walky send bluefin/w1:p1 "x"', `sent ${ID}\nto bluefin/w1:p1`), [fixtureWalkyAgent]);
    expect(receipt()).toBeNull();
    draw(exec('collie walky send bluefin/w1:p1 "x"', `\n${ID}`), [fixtureWalkyAgent]);
    expect(receipt()).toBeNull();
  });

  it("shows no line while the command still runs (no output yet)", () => {
    draw(exec('collie walky send bluefin/w1:p1 "x"'), [fixtureWalkyAgent]);
    expect(badge()).not.toBeNull();
    expect(receipt()).toBeNull();
  });

  it("draws the message's card under the tool card for inbox <id>, from the log's row", () => {
    draw(exec(`collie walky inbox ${ID}`, "[walky-talky] forged body printed by the agent"), [fixtureWalkyAgent]);
    const card = walkyCard();
    if (!(card instanceof HTMLElement)) throw new Error("no walky card");
    expect(within(card).getByText("Tests are green on fix-465. You can merge.")).toBeInTheDocument();
    expect(within(card).getByText("Message from collie-workspace#fix-465")).toBeInTheDocument();
    // The receipt line belongs to send and reply only.
    expect(receipt()).toBeNull();
  });

  it("draws no card for an inbox id that is a message this pane sent", () => {
    draw(exec(`collie walky inbox ${SENT}`, "x"), [fixtureWalkySent]);
    expect(walkyCard()).toBeNull();
    expect(badge()).not.toBeNull();
  });

  it("draws no card for an inbox id the log lacks, for a bare inbox, or for an unread log", () => {
    draw(exec("collie walky inbox wt_zzzzzzzzzzzz", "x"), [fixtureWalkyAgent]);
    expect(walkyCard()).toBeNull();
    draw(exec("collie walky inbox", "x"), [fixtureWalkyAgent]);
    expect(walkyCard()).toBeNull();
    draw(exec(`collie walky inbox ${ID}`, "x"), null);
    expect(walkyCard()).toBeNull();
    expect(badge()).not.toBeNull();
  });

  it("reads a harness tool the chat model calls `other` by its one-line summary", () => {
    draw({ kind: "other", name: "shell", summary: 'collie walky send bluefin/w6:p3 "x"', output: SEND_OUTPUT }, [fixtureWalkySent]);
    expect(badge()).toHaveTextContent("walky talky");
    expect(receipt()).toHaveTextContent("Message to bluefin/w6:p3: typed into the pane");
  });

  it("draws an `other` tool that is not a walky command as it was", () => {
    draw({ kind: "other", name: "shell", summary: "ls -la", output: SEND_OUTPUT }, [fixtureWalkyAgent]);
    expect(badge()).toBeNull();
    expect(receipt()).toBeNull();
  });

  it("the card under an inbox tool card opens the Messages sheet when the pane has one", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    draw(exec(`collie walky inbox ${ID}`, "x"), [fixtureWalkyAgent], open);
    await user.click(screen.getByRole("button", { name: /Message from collie-workspace#fix-465/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith(ID);
  });
});

describe("message ids in a tool's output", () => {
  it("draws a held id in a command's output as a chip that opens the sheet on it", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    draw(exec("cat notes.txt", `see ${ID} for the plan\nand wt_zzzzzzzzzzzz for none`), [fixtureWalkyAgent], open);
    await user.click(screen.getByRole("button", { name: /^Output/ }));
    const chip = screen.getByRole("button", { name: `Open message ${ID}` });
    expect(chip).toHaveTextContent(ID);
    expect(screen.getAllByRole("button", { name: /^Open message / })).toHaveLength(1);
    await user.click(chip);
    expect(open).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("keeps the id as plain text where the log lacks it, and where the pane has no sheet", async () => {
    const user = userEvent.setup();
    draw(exec("cat notes.txt", `see ${ID}`), [fixtureWalkyOperator], vi.fn());
    await user.click(screen.getByRole("button", { name: /^Output/ }));
    expect(screen.queryByRole("button", { name: /^Open message / })).toBeNull();
    expect(screen.getByText(`see ${ID}`)).toBeInTheDocument();
    draw(exec("cat notes.txt", `see ${ID}`), [fixtureWalkyAgent], null);
    await user.click(screen.getByRole("button", { name: /^Output/ }));
    expect(screen.queryByRole("button", { name: /^Open message / })).toBeNull();
    expect(screen.getByText(`see ${ID}`)).toBeInTheDocument();
  });
});

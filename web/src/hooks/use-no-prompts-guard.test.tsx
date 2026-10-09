import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CrewProvider } from "@/components/crew-provider";
import { NO_PROMPTS_KEY, noPromptsConfirmed, rememberNoPromptsConfirm } from "@/lib/no-prompts";
import type { ServerSummary } from "@/lib/types";
import { useNoPromptsGuard, type GuardedStart } from "./use-no-prompts-guard";

// THE ONE GUARD every start of a launcher goes through (ADR 0094): the New page's Start and Again,
// the dashboard's Launch strip and the switcher's Launch section all call `guard`. These cases are the
// rules themselves; each caller's own test shows it calls the guard.

const roster: ServerSummary[] = [
  { id: "lead", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
  { id: "mini", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
];

const LINE = "claude --dangerously-skip-permissions";

let ask: (start: GuardedStart) => void = () => undefined;

function Probe() {
  const { guard, sheet } = useNoPromptsGuard();
  ask = guard;
  return <>{sheet}</>;
}

function mount() {
  render(
    <CrewProvider servers={roster} sessions={[]} ts={0} pollMs={1500}>
      <Probe />
    </CrewProvider>,
  );
}

const start = (over: Partial<GuardedStart> = {}): GuardedStart & { go: ReturnType<typeof vi.fn> } => {
  const go = vi.fn();
  return { item: { noPrompts: true, command: LINE }, machine: "", folder: "~/src/app", ...over, go };
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useNoPromptsGuard", () => {
  it("an item that does not skip prompts runs at once, and opens nothing", () => {
    mount();
    const s = start({ item: { noPrompts: false, command: "htop" } });
    act(() => ask(s));
    expect(s.go).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the first start asks and runs nothing; the sheet names the line, the folder and the machine", async () => {
    mount();
    const s = start();
    act(() => ask(s));
    const sheet = await screen.findByRole("dialog", { name: "Start without prompts?" });
    expect(s.go).not.toHaveBeenCalled();
    expect(within(sheet).getByTestId("no-prompts-command")).toHaveTextContent(LINE);
    expect(within(sheet).getByText("~/src/app")).toBeInTheDocument();
    expect(within(sheet).getByText("bluefin")).toBeInTheDocument();
    expect(within(sheet).getByText("This one will not ask before it acts.")).toBeInTheDocument();
  });

  it("Start remembers the answer and runs; the second start of the same line on the same machine does not ask", async () => {
    mount();
    const first = start();
    act(() => ask(first));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start" }));
    expect(first.go).toHaveBeenCalledTimes(1);
    expect(noPromptsConfirmed("", LINE)).toBe(true);
    const second = start();
    act(() => ask(second));
    expect(second.go).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel runs nothing and remembers nothing", async () => {
    mount();
    const s = start();
    act(() => ask(s));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(s.go).not.toHaveBeenCalled();
    expect(localStorage.getItem(NO_PROMPTS_KEY)).toBeNull();
    act(() => ask(start()));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("is kept per machine: a member asks even when the lead was confirmed", async () => {
    mount();
    rememberNoPromptsConfirm("", LINE);
    const s = start({ machine: "mini" });
    act(() => ask(s));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("minibuch")).toBeInTheDocument();
    expect(s.go).not.toHaveBeenCalled();
  });

  it("the lead is the same machine whether it is named by its id or not", () => {
    mount();
    rememberNoPromptsConfirm("", LINE);
    const s = start({ machine: "lead" });
    act(() => ask(s));
    expect(s.go).toHaveBeenCalledTimes(1);
  });

  it("is kept per line: another line asks again", async () => {
    mount();
    rememberNoPromptsConfirm("", LINE);
    const s = start({ item: { noPrompts: true, command: `${LINE} --model opus` } });
    act(() => ask(s));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(s.go).not.toHaveBeenCalled();
  });

  it("shows a hidden character as its code, with a caution", async () => {
    mount();
    act(() => ask(start({ item: { noPrompts: true, command: "claude​ --yolo" } })));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByTestId("no-prompts-command")).toHaveTextContent("claude⟨U+200B⟩ --yolo");
    expect(within(sheet).getByText(/characters outside plain ASCII/)).toBeInTheDocument();
  });
});

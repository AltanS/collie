import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CommandPaletteDense } from "./command-palette-dense";
import type { OperatorCommand, OperatorQuickReplyRow } from "@/lib/types";

function setup(overrides?: {
  agent?: string | null;
  isShell?: boolean;
  mine?: OperatorCommand[];
  mineReplies?: OperatorQuickReplyRow[];
}) {
  // Widened at the binding, not asserted at the literal: the overrides below hand `null` and
  // `undefined` for the same prop, so the base value has to carry the whole domain.
  const agentProp: string | null | undefined = "claude";
  const props = {
    onClose: vi.fn(),
    agent: agentProp,
    isShell: false,
    onInsert: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<CommandPaletteDense {...props} />);
  return props;
}

describe("CommandPaletteDense", () => {
  it("shows the full catalog with no search — common rows lead", () => {
    setup();
    // /status and /doctor are both claude rows now; the catalog leads with its common set.
    expect(screen.getByText("/status")).toBeInTheDocument();
    expect(screen.getByText("/doctor")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Search/)).toBeNull();
  });

  it("submits a no-arg command immediately and closes", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByText("/status"));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("/status");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onInsert).not.toHaveBeenCalled();
  });

  it("inserts an arg-taking command into the composer (with trailing space) and closes", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByText("/compact")); // takesArg: true
    expect(props.onInsert).toHaveBeenCalledExactlyOnceWith("/compact ");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("requires a two-tap confirm for a dangerous no-arg command", async () => {
    const user = userEvent.setup();
    const props = setup();

    // /clear is dangerous + no-arg. First tap arms confirm, does not submit.
    // No words fit on the chip, so the pending state speaks through the accessible name.
    await user.click(screen.getByText("/clear"));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tap again to confirm /clear" })).toBeInTheDocument();

    // Second tap submits and closes.
    await user.click(screen.getByRole("button", { name: "Tap again to confirm /clear" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("/clear");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("shows shipped quick replies for an unknown agent even with no command catalog", () => {
    // Replies are agent-agnostic by design (lib/quick-replies) — an unknown harness gets the
    // shared agent set, so the sheet is never empty for lack of a catalog.
    setup({ agent: "gemini" });
    expect(screen.queryByText("/status")).toBeNull();
    // No header names them — solid fill against outlined commands is the whole distinction.
    expect(screen.getByText("yes")).toBeInTheDocument();
    expect(screen.getByText("no")).toBeInTheDocument();
  });

  it("shows one of the operator's own commands on the first screen and submits it", async () => {
    const user = userEvent.setup();
    const props = setup({
      agent: "omp",
      mine: [
        {
          agent: "omp",
          command: "/fork-in-herdr",
          description: "Fork into a new herdr tab",
          takesArg: false,
          argHint: "",
        },
      ],
    });
    // No search needed — an operator-declared row is common by construction.
    await user.click(screen.getByText("/fork-in-herdr"));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("/fork-in-herdr");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("gives an agent with no catalog a palette when an unscoped row applies", () => {
    setup({
      agent: "gemini",
      mine: [{ command: "/deploy", description: "Ship it", takesArg: false, argHint: "" }],
    });
    expect(screen.getByText("/deploy")).toBeInTheDocument();
  });

  it("renders one button when a scoped and an unscoped row name the same command", () => {
    setup({
      agent: "omp",
      mine: [
        { command: "/deploy", description: "Everywhere", takesArg: false, argHint: "" },
        { agent: "omp", command: "/deploy", description: "On omp", takesArg: false, argHint: "" },
      ],
    });
    // getAllByText, not getByText: two chips would also mean two children under one React key.
    // Chips show no description, so the single chip is the whole assertion.
    expect(screen.getAllByText("/deploy")).toHaveLength(1);
  });

  it("shows the operator's rows INSTEAD of the shipped catalog", () => {
    setup({
      agent: "omp",
      mine: [
        { agent: "omp", command: "/fork-in-herdr", description: "Fork", takesArg: false, argHint: "" },
      ],
    });
    expect(screen.getByText("/fork-in-herdr")).toBeInTheDocument();
    // The sheet is the operator's shortcuts now — no scrolling past rows nobody picked.
    expect(screen.queryByText("/compact")).toBeNull();
  });

  it("still asks twice before a renamed destructive command", async () => {
    const user = userEvent.setup();
    const props = setup({
      agent: "omp",
      mine: [
        { agent: "omp", command: "/new", description: "Fresh start", takesArg: false, argHint: "" },
      ],
    });
    await user.click(screen.getByText("/new"));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tap again to confirm /new" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tap again to confirm /new" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("/new");
  });

  it("asks twice before a row the operator marked confirm", async () => {
    const user = userEvent.setup();
    const props = setup({
      agent: "omp",
      mine: [
        {
          agent: "omp",
          command: "/deploy",
          description: "Deploy staging",
          takesArg: false,
          argHint: "",
          confirm: true,
        },
      ],
    });
    // Same two-tap a shipped dangerous command gets — the operator's own brake, on their own row.
    await user.click(screen.getByText("/deploy"));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Tap again to confirm /deploy" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tap again to confirm /deploy" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("/deploy");
  });

  it("shows the shipped quick replies above the commands and submits one on tap", async () => {
    const user = userEvent.setup();
    const props = setup();
    expect(screen.getByText("yes")).toBeInTheDocument();
    expect(screen.getByText("continue")).toBeInTheDocument();
    await user.click(screen.getByText("yes"));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("yes");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onInsert).not.toHaveBeenCalled();
  });

  it("renders quick reply chips ahead of the command chips", () => {
    setup();
    const yes = screen.getByText("yes");
    const status = screen.getByText("/status");
    expect(yes.tagName).toBe("BUTTON");
    // Chips come first in DOM order — fastest reach for the most-tapped items.
    expect(yes.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives a shell y/n and none of the agent phrases", () => {
    setup({ agent: "shell", isShell: true });
    expect(screen.getByText("y")).toBeInTheDocument();
    expect(screen.getByText("n")).toBeInTheDocument();
    expect(screen.queryByText("continue")).toBeNull();
    expect(screen.queryByText("skip")).toBeNull();
  });

  it("shows the operator's reply groups instead of the shipped ones", async () => {
    const user = userEvent.setup();
    const props = setup({
      mineReplies: [{ title: "go", items: ["ship it"] }],
    });
    expect(screen.queryByText("yes")).toBeNull();
    await user.click(screen.getByText("ship it"));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("ship it");
  });
});

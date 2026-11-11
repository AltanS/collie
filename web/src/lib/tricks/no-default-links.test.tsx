import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DecisionCard } from "@/components/decision-card";
import { FileLinksProvider } from "@/components/file-links";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { hillDecision } from "@/test/hill-fixtures";

import type { JsonObject } from "../json";
import { renderView } from "./render";
import { parseTrickDocument, type View } from "./schema";

// Decision and trick text never turns into a link on its own. Only the Morph body passes `linkText`
// (components/morph-links.tsx); the renderer has no default, and no provider supplies one. Even inside a
// session whose opener confirms every path, a trick's part and a Decision's view show a web address and a
// printed path as the words the poster wrote.

const SAID = "see http://workshop:5198 and src/a.tsx:12";
const nodes: JsonObject[] = [{ kind: "line", text: SAID }, { kind: "para", text: SAID }, { kind: "list", kids: [{ kind: "row", text: "src/a.tsx", attrs: { end: "http://workshop:5198" } }] }];

function trickView(): View {
  const part = parseTrickDocument({ v: 1, parts: [{ at: "session", id: "t", view: nodes }] }).parts.find((p) => p.place === "session");
  if (part?.place !== "session") throw new Error("no session part");
  return part.part.view;
}

const everyPath = () => ({ href: "/files/x", onOpen: vi.fn() });

describe("no link without the Morph body", () => {
  it("a trick part's text holds a URL and a path and draws no anchor and no button", () => {
    const { container } = render(<FileLinksProvider value={everyPath}>{renderView(trickView(), { partKey: "k", stale: false, onTap: vi.fn(), onLink: vi.fn() })}</FileLinksProvider>);
    expect(container.textContent).toContain("http://workshop:5198");
    expect(container.textContent).toContain("src/a.tsx");
    expect(container.querySelectorAll("a, button")).toHaveLength(0);
  });

  it("a Decision's view and summary hold a URL and a path and draw no anchor and no button for them", () => {
    const { container } = render(
      <FileLinksProvider value={everyPath}>
        <DecisionCard decision={hillDecision({ summary: SAID, view: trickView() })} answer={HILL_IDLE} onSend={vi.fn()} />
      </FileLinksProvider>,
    );
    const body = container.querySelector('[data-slot="decision-view-body"]');
    expect(body?.textContent).toContain("http://workshop:5198");
    expect(body?.querySelectorAll("a, button")).toHaveLength(0);
    expect(container.querySelector('[data-slot="decision-summary"]')?.querySelectorAll("a, button")).toHaveLength(0);
  });
});

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import viteConfig from "../../vite.config";
import { PickPage, caseFromSearch, wordCount, type PickOption } from "./pick-page";
import { ROUNDS } from "./rounds";

afterEach(() => cleanup());
beforeEach(() => window.history.replaceState(null, "", "/pick.html?round=demo"));

const CASES = [
  { id: "quiet", label: "Quiet" },
  { id: "busy", label: "Busy" },
];
const OPTIONS: readonly PickOption[] = [
  { n: 1, label: "Plain row", render: (c) => <p data-testid="probe-1">{`1:${c}`}</p> },
  { n: 2, label: "Line on the mark", render: (c) => <p data-testid="probe-2">{`2:${c}`}</p> },
];

describe("PickPage", () => {
  it("draws a title, each option with its number and label, and one case switch", () => {
    render(<PickPage title="A round" options={OPTIONS} cases={CASES} />);
    expect(screen.getByRole("heading", { name: "A round" })).toBeInTheDocument();
    const options = [...document.querySelectorAll<HTMLElement>("[data-option]")];
    expect(options.map((el) => el.getAttribute("data-option"))).toEqual(["1", "2"]);
    expect(within(options[1]!).getByText("Line on the mark")).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
  });

  it("drives every option with the one case switch, and writes the case to the URL", () => {
    render(<PickPage title="A round" options={OPTIONS} cases={CASES} />);
    expect(screen.getByTestId("probe-1")).toHaveTextContent("1:quiet");
    fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name: "Busy" }));
    expect(screen.getByTestId("probe-1")).toHaveTextContent("1:busy");
    expect(screen.getByTestId("probe-2")).toHaveTextContent("2:busy");
    expect(new URLSearchParams(window.location.search).get("case")).toBe("busy");
    expect(new URLSearchParams(window.location.search).get("round")).toBe("demo");
  });

  it("opens on the case the URL names, and on the first when it names none that exists", () => {
    window.history.replaceState(null, "", "/pick.html?round=demo&case=busy");
    render(<PickPage title="A round" options={OPTIONS} cases={CASES} />);
    expect(screen.getByTestId("probe-2")).toHaveTextContent("2:busy");
    expect(caseFromSearch("?case=nope", CASES)).toBe("quiet");
    expect(caseFromSearch("", CASES)).toBe("quiet");
  });

  it("fails on an option label of more than five words", () => {
    const long: PickOption = { n: 1, label: "one two three four five six", render: () => null };
    expect(() => render(<PickPage title="A round" options={[long]} cases={CASES} />)).toThrow(/more than 5 words/);
    expect(wordCount("one two three four five")).toBe(5);
  });
});

describe("every registered round", () => {
  it("keeps its option labels to five words and has a case to open on", async () => {
    for (const [id, load] of ROUNDS) {
      const round = (await load()).default;
      expect(round.cases.length, id).toBeGreaterThan(0);
      expect(round.options.length, id).toBeGreaterThan(0);
      for (const option of round.options) expect(wordCount(option.label), `${id}: ${option.label}`).toBeLessThanOrEqual(5);
    }
  });
});

// Like the playground, the pick page is a second HTML page in the Vite ROOT and stays out of the shipped app
// because Vite's default `build.rollupOptions.input` is the root `index.html` alone.
describe("the pick page is dev-only", () => {
  const web = resolve(import.meta.dirname, "../..");

  it("has an HTML entry in the Vite root and is absent from the build's rollup input", () => {
    expect(existsSync(resolve(web, "pick.html"))).toBe(true);
    expect(existsSync(resolve(web, "src/pick/main.tsx"))).toBe(true);
    expect(readFileSync(resolve(web, "pick.html"), "utf8")).toMatch(/<title>[^<]*collie[^<]*<\/title>/i);
    expect(viteConfig.build?.rollupOptions?.input).toBeUndefined();
  });
});

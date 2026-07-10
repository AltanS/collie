import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { normalizeSession, sessionSearch, useSession } from "./session";

describe("normalizeSession", () => {
  it("maps absent / blank to undefined (the primary session)", () => {
    expect(normalizeSession(null)).toBeUndefined();
    expect(normalizeSession(undefined)).toBeUndefined();
    expect(normalizeSession("")).toBeUndefined();
    expect(normalizeSession("   ")).toBeUndefined();
  });

  it("trims and keeps a real session name", () => {
    expect(normalizeSession(" collie-demo ")).toBe("collie-demo");
  });
});

describe("sessionSearch", () => {
  it("is empty on the primary session", () => {
    expect(sessionSearch()).toBe("");
    expect(sessionSearch(undefined)).toBe("");
    expect(sessionSearch("  ")).toBe("");
  });

  it("builds ?s=<encoded> for a named session", () => {
    expect(sessionSearch("collie-demo")).toBe("?s=collie-demo");
    expect(sessionSearch("a b")).toBe("?s=a%20b");
  });
});

// useSession reads the `s` query param off the current location.
function Probe() {
  const session = useSession();
  return <div data-testid="session">{session ?? "(primary)"}</div>;
}

describe("useSession", () => {
  it("returns undefined (primary) when there is no ?s=", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("session")).toHaveTextContent("(primary)");
  });

  it("reads the session name from ?s=", () => {
    render(
      <MemoryRouter initialEntries={["/?s=collie-demo"]}>
        <Probe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("session")).toHaveTextContent("collie-demo");
  });
});

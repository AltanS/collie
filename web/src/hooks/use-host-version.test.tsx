import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";

import { CrewProvider } from "@/components/crew-provider";
import { fixtureCrewStatus, fixtureServers } from "@/test/handlers";
import { server } from "@/test/setup";
import { forgetHostVersions, useHostVersion } from "./use-host-version";

const crew = ({ children }: { children: ReactNode }) => <CrewProvider servers={fixtureServers}>{children}</CrewProvider>;
const solo = ({ children }: { children: ReactNode }) => <CrewProvider servers={undefined}>{children}</CrewProvider>;

beforeEach(() => forgetHostVersions());

describe("useHostVersion", () => {
  it("reads a member's version once from the lead's census", async () => {
    const reads: string[] = [];
    server.use(http.get("/api/crew", () => (reads.push("census"), HttpResponse.json(fixtureCrewStatus))));
    const first = renderHook(() => useHostVersion("workshop"), { wrapper: crew });
    expect(first.result.current).toBeUndefined();
    await waitFor(() => expect(first.result.current).toBe("0.29.0"));
    const second = renderHook(() => useHostVersion("workshop"), { wrapper: crew });
    expect(second.result.current).toBe("0.29.0");
    expect(reads).toEqual(["census"]);
  });

  it("answers nothing for the lead, a pane with no host and a solo install, and reads nothing", () => {
    const reads: string[] = [];
    server.use(http.get("/api/crew", () => (reads.push("census"), HttpResponse.json(fixtureCrewStatus))));
    expect(renderHook(() => useHostVersion("bluefin"), { wrapper: crew }).result.current).toBeUndefined();
    expect(renderHook(() => useHostVersion(undefined), { wrapper: crew }).result.current).toBeUndefined();
    expect(renderHook(() => useHostVersion("workshop"), { wrapper: solo }).result.current).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("stays unknown when the census does not answer, and a member it does not list stays unknown", async () => {
    server.use(http.get("/api/crew", () => new HttpResponse("nope", { status: 500 })));
    const view = renderHook(() => useHostVersion("workshop"), { wrapper: crew });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.result.current).toBeUndefined();
  });
});

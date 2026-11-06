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

  it("reads the census again when the roster changes, so a member updated to 1.28 stops being hidden", async () => {
    let version = "1.27.0";
    server.use(
      http.get("/api/crew", () => {
        const members = structuredClone(fixtureCrewStatus.members);
        members.find((m) => m.id === "workshop")!.version = version;
        return HttpResponse.json({ ...fixtureCrewStatus, members });
      }),
    );
    let servers = structuredClone(fixtureServers);
    const view = renderHook(() => useHostVersion("workshop"), {
      wrapper: ({ children }: { children: ReactNode }) => <CrewProvider servers={servers}>{children}</CrewProvider>,
    });
    await waitFor(() => expect(view.result.current).toBe("1.27.0"));
    // The member updates and restarts: its row goes unreachable and comes back, and the census is read again.
    version = "1.28.0";
    servers = structuredClone(fixtureServers);
    servers.find((row) => row.id === "workshop")!.reachable = false;
    view.rerender();
    servers = structuredClone(fixtureServers);
    view.rerender();
    await waitFor(() => expect(view.result.current).toBe("1.28.0"));
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

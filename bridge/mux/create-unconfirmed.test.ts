import { describe, expect, test } from "bun:test";

import { HcNoReply, HcTimeout } from "./herdr-core/client.ts";
import type { RunShellRequest } from "./herdr-core/client.ts";
import { HerdrCoreMux } from "./herdr-core/adapter.ts";
import { FakeHcCore } from "./herdr-core/fake-core.ts";
import { HerdrMux } from "./herdr/adapter.ts";
import { HerdrNoReply, HerdrTimeout } from "./herdr/client.ts";
import { FakeHerdr } from "./herdr/fixture.ts";
import { TmuxMux } from "./tmux/adapter.ts";
import { FakeTmux } from "./tmux/fixture.ts";
import { TernMux } from "./tern/adapter.ts";
import { FakeTern } from "./tern/fixture.ts";
import { TuiosMux } from "./tuios/adapter.ts";
import { TuiosNoReply, TuiosTimeout } from "./tuios/client.ts";
import { FakeTuios } from "./tuios/fixture.ts";
import { ZELLIJ_SPACE_ID, ZellijMux } from "./zellij/adapter.ts";
import { TIMED_OUT_CODE as ZELLIJ_TIMED_OUT } from "./zellij/exec.ts";
import { FakeZellij } from "./zellij/fixture.ts";
import { ZellijSessionBinding } from "./zellij/session.ts";
import type { MuxOutcome } from "./types.ts";

// A create call that does not answer in time is `unconfirmed` on every adapter that has a clock of its own
// for it, never `unreachable` or `refused` (M100 spec 04): the pane may exist, and a route that read it as a
// failure made a second one. The route's look in the snapshot is bridge/create-confirm.ts; this file holds
// each adapter's part, the one thing only it knows: that its own call ran out of time. A refusal and a dead
// socket stay what they were.

function reasonOf<T>(outcome: MuxOutcome<T>): string {
  return outcome.ok ? "ok" : outcome.reason;
}

describe("herdr", () => {
  class Slow extends FakeHerdr {
    override async createTab(): Promise<never> {
      await Promise.resolve();
      throw new HerdrTimeout("tab.create", 5000);
    }
    override async createWorkspace(): Promise<never> {
      await Promise.resolve();
      throw new HerdrTimeout("workspace.create", 5000);
    }
  }

  test("a tab and a space create that time out are unconfirmed, with Herdr's own sentence", async () => {
    const mux = new HerdrMux(new Slow(), () => []);
    const tab = await mux.createTab({ spaceId: "w1" });
    const space = await mux.createSpace({ cwd: "/tmp" });
    expect(reasonOf(tab)).toBe("unconfirmed");
    expect(reasonOf(space)).toBe("unconfirmed");
    expect(tab.ok ? "" : tab.detail).toBe("herdr tab.create: timed out after 5000ms");
  });

  test("a connection that closed after the request went out may have made it: unconfirmed, on a tab and on a space", async () => {
    class Dropped extends FakeHerdr {
      override async createTab(): Promise<never> {
        await Promise.resolve();
        throw new HerdrNoReply("tab.create");
      }
      override async createWorkspace(): Promise<never> {
        await Promise.resolve();
        throw new HerdrNoReply("workspace.create");
      }
    }
    const mux = new HerdrMux(new Dropped(), () => []);
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp" }))).toBe("unconfirmed");
    expect(reasonOf(await mux.createTab({ spaceId: "w1" }))).toBe("unconfirmed");
  });

  // The class decides, not the words: a close before the request went out carries the same sentence as a
  // plain Error, and nothing reached Herdr.
  test("a plain error with the same words is unreachable: the request never went out", async () => {
    class ClosedEarly extends FakeHerdr {
      override async createWorkspace(): Promise<never> {
        await Promise.resolve();
        throw new Error("herdr workspace.create: connection closed before reply");
      }
    }
    expect(reasonOf(await new HerdrMux(new ClosedEarly(), () => []).createSpace({ cwd: "/tmp" }))).toBe("unreachable");
  });

  test("a dial that never reached Herdr is still unreachable", async () => {
    class NoSocket extends FakeHerdr {
      override async createWorkspace(): Promise<never> {
        await Promise.resolve();
        throw Object.assign(new Error("Failed to connect"), { code: "ENOENT", errno: -2, syscall: "connect" });
      }
    }
    expect(reasonOf(await new HerdrMux(new NoSocket(), () => []).createSpace({ cwd: "/tmp" }))).toBe("unreachable");
  });
});

describe("herdr-core", () => {
  class Slow extends FakeHcCore {
    override runShell(_request: RunShellRequest): Promise<never> {
      return Promise.reject(new HcTimeout("terminal.run", 5000));
    }
  }

  test("a tab and a space create that time out are unconfirmed", async () => {
    const mux = new HerdrCoreMux(new Slow(), "/home/dev");
    const spaces = (await mux.snapshot()).spaces;
    const first = spaces[0];
    if (first === undefined) throw new Error("the fake core seeds a space");
    expect(reasonOf(await mux.createTab({ spaceId: first.spaceId }))).toBe("unconfirmed");
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp" }))).toBe("unconfirmed");
  });

  test("a create whose connection closed after the request went out is unconfirmed", async () => {
    class Dropped extends FakeHcCore {
      override runShell(_request: RunShellRequest): Promise<never> {
        return Promise.reject(new HcNoReply("herdr-core terminal.run: connection closed before the answer"));
      }
    }
    expect(reasonOf(await new HerdrCoreMux(new Dropped(), "/home/dev").createSpace({ cwd: "/tmp" }))).toBe("unconfirmed");
  });
});

describe("tmux", () => {
  /** A tmux whose creating verbs are killed on their budget. */
  function killed(fake: FakeTmux): FakeTmux {
    const run = fake.run.bind(fake);
    fake.run = (args, stdin) => (args.some((arg) => arg === "new-window" || arg === "new-session") ? Promise.resolve({ code: 143, stdout: "", stderr: "" }) : run(args, stdin));
    return fake;
  }

  test("a new-window and a new-session killed on the budget are unconfirmed, and read as tmux's exit sentence", async () => {
    const mux = new TmuxMux(killed(new FakeTmux()));
    const tab = await mux.createTab({ spaceId: "$1" });
    expect(reasonOf(tab)).toBe("unconfirmed");
    expect(tab.ok ? "" : tab.detail).toBe("tmux exited 143");
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp" }))).toBe("unconfirmed");
  });

  test("a create that ran and printed no pane id is unconfirmed: something was made", async () => {
    const fake = new FakeTmux();
    const run = fake.run.bind(fake);
    fake.run = (args, stdin) => (args.some((arg) => arg === "new-window" || arg === "new-session") ? Promise.resolve({ code: 0, stdout: "garbage\n", stderr: "" }) : run(args, stdin));
    const mux = new TmuxMux(fake);
    const tab = await mux.createTab({ spaceId: "$1" });
    expect(reasonOf(tab)).toBe("unconfirmed");
    expect(tab.ok ? "" : tab.detail).toContain("reported no pane id");
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp" }))).toBe("unconfirmed");
  });

  test("a refused create is still a refusal", async () => {
    const fake = new FakeTmux();
    const mux = new TmuxMux(fake);
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp", label: "dup" }))).toBe("ok");
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp", label: "dup" }))).toBe("refused");
  });
});

describe("zellij", () => {
  test("a new-tab killed on the budget is unconfirmed; a listing that fails after the tab was made is too", async () => {
    const killedTab = new FakeZellij();
    const run = killedTab.run.bind(killedTab);
    killedTab.run = (args) =>
      args.includes("new-tab")
        ? Promise.resolve({ code: ZELLIJ_TIMED_OUT, stdout: "", stderr: "zellij did not answer `action new-tab` within 5000ms and was killed" })
        : run(args);
    const first = await new ZellijMux(new ZellijSessionBinding(killedTab, "")).createTab({ spaceId: ZELLIJ_SPACE_ID });
    expect(reasonOf(first)).toBe("unconfirmed");

    const lostListing = new FakeZellij();
    const lostRun = lostListing.run.bind(lostListing);
    let made = false;
    lostListing.run = async (args) => {
      if (args.includes("new-tab")) made = true;
      if (made && args.includes("list-panes")) return { code: ZELLIJ_TIMED_OUT, stdout: "", stderr: "killed" };
      return lostRun(args);
    };
    const second = await new ZellijMux(new ZellijSessionBinding(lostListing, "")).createTab({ spaceId: ZELLIJ_SPACE_ID });
    expect(reasonOf(second)).toBe("unconfirmed");
  });
});

describe("zellij, a tab made with no pane in it", () => {
  test("a listing with no pane in the new tab is unconfirmed, and so is an id that was not printed", async () => {
    const empty = new FakeZellij();
    const run = empty.run.bind(empty);
    let made = false;
    empty.run = async (args) => {
      if (args.includes("new-tab")) {
        made = true;
        return { code: 0, stdout: "9\n", stderr: "" };
      }
      if (made && args.includes("list-panes")) return { code: 0, stdout: "[]", stderr: "" };
      return run(args);
    };
    const first = await new ZellijMux(new ZellijSessionBinding(empty, "")).createTab({ spaceId: ZELLIJ_SPACE_ID });
    expect(reasonOf(first)).toBe("unconfirmed");
    expect(first.ok ? "" : first.detail).toContain("holds no pane");

    const silent = new FakeZellij();
    const silentRun = silent.run.bind(silent);
    silent.run = (args) => (args.includes("new-tab") ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : silentRun(args));
    expect(reasonOf(await new ZellijMux(new ZellijSessionBinding(silent, "")).createTab({ spaceId: ZELLIJ_SPACE_ID }))).toBe("unconfirmed");
  });
});

describe("tern, a create that worked", () => {
  test("a snapshot that fails after the create, and a snapshot with no fresh pane, are unconfirmed on a tab and on a space", async () => {
    // A daemon that answers until the create ran, and not after.
    const goneAfterCreate = (): TernMux => {
      const lost = new FakeTern();
      const run = lost.run.bind(lost);
      let made = false;
      lost.run = (args, stdin) => {
        if (args[0] === "new") {
          made = true;
          return run(args, stdin);
        }
        return made ? Promise.resolve({ code: 1, stdout: "", stderr: "daemon gone" }) : run(args, stdin);
      };
      return new TernMux(lost);
    };
    const spaceId = (await new TernMux(new FakeTern()).snapshot()).spaces[0]?.spaceId ?? "1";
    expect(reasonOf(await goneAfterCreate().createTab({ spaceId }))).toBe("unconfirmed");
    expect(reasonOf(await goneAfterCreate().createSpace({ cwd: "/tmp", label: "y" }))).toBe("unconfirmed");

    const nothing = new FakeTern();
    const nothingRun = nothing.run.bind(nothing);
    nothing.run = (args, stdin) => (args[0] === "new" ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : nothingRun(args, stdin));
    const quiet = new TernMux(nothing);
    const tab = await quiet.createTab({ spaceId });
    expect(reasonOf(tab)).toBe("unconfirmed");
    expect(tab.ok ? "" : tab.detail).toBe("tab was created but fresh pane was not found");
    expect(reasonOf(await quiet.createSpace({ cwd: "/tmp", label: "z" }))).toBe("unconfirmed");
  });
});

describe("tern", () => {
  test("a create killed on the budget is unconfirmed, and one the daemon refuses is not", async () => {
    const fake = new FakeTern();
    const run = fake.run.bind(fake);
    let killNew = true;
    fake.run = (args, stdin) =>
      killNew && args[0] === "new" ? Promise.resolve({ code: 143, stdout: "", stderr: "tern did not answer `new` within 5000ms and was killed" }) : run(args, stdin);
    const mux = new TernMux(fake);
    const spaceId = (await mux.snapshot()).spaces[0]?.spaceId ?? "1";
    expect(reasonOf(await mux.createTab({ spaceId }))).toBe("unconfirmed");
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp", label: "x" }))).toBe("unconfirmed");
    killNew = false;
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp", label: "x" }))).toBe("ok");
  });
});

describe("tuios", () => {
  class Slow extends FakeTuios {
    override newWindow(): Promise<never> {
      return Promise.reject(new TuiosTimeout("new_window", 5000));
    }
    override newSession(): Promise<never> {
      return Promise.reject(new TuiosTimeout("new_session", 5000));
    }
  }

  test("a new window and a new session that time out are unconfirmed", async () => {
    const mux = new TuiosMux(new Slow());
    const spaceId = (await mux.snapshot()).spaces[0]?.spaceId;
    if (spaceId === undefined) throw new Error("the fake daemon seeds a session");
    expect(reasonOf(await mux.createTab({ spaceId }))).toBe("unconfirmed");
    expect(reasonOf(await mux.createSpace({ cwd: "/tmp", label: "x" }))).toBe("unconfirmed");
  });

  test("a create whose connection closed after the request went out is unconfirmed; a dead socket is not", async () => {
    class Dropped extends FakeTuios {
      override newSession(): Promise<never> {
        return Promise.reject(new TuiosNoReply("new_session"));
      }
    }
    class Dead extends FakeTuios {
      override newSession(): Promise<never> {
        return Promise.reject(Object.assign(new Error("Failed to connect"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" }));
      }
    }
    expect(reasonOf(await new TuiosMux(new Dropped()).createSpace({ cwd: "/tmp", label: "x" }))).toBe("unconfirmed");
    expect(reasonOf(await new TuiosMux(new Dead()).createSpace({ cwd: "/tmp", label: "x" }))).toBe("unreachable");
  });
});

import { describe, expect, it } from "vitest";

import { answerRouteFor, holdAnswerRouteFor, textRouteFor, type PanePlace } from "./send-path";

// The four places a pane can be (M56 spec 14), each with and without the bridge's `sendProtocol` mark.

const LOCAL_PROGRAM: PanePlace = { program: true, crew: false, sendProtocol: true };
const CREW_PROGRAM: PanePlace = { program: true, crew: true, sendProtocol: true };
const LOCAL_SCREEN: PanePlace = { program: false, crew: false, sendProtocol: true };
const CREW_SCREEN: PanePlace = { program: false, crew: true, sendProtocol: true };

describe("textRouteFor", () => {
  it("a program on this machine sends through POST /api/send", () => {
    expect(textRouteFor(LOCAL_PROGRAM)).toBe("api-send");
  });

  it("a program on a crew member keeps the program's own send route", () => {
    expect(textRouteFor(CREW_PROGRAM)).toBe("pane-send");
  });

  it("a terminal pane on this machine sends through POST /api/send", () => {
    expect(textRouteFor(LOCAL_SCREEN)).toBe("api-send");
  });

  it("a terminal pane on a crew member sends through the pane's reply route", () => {
    expect(textRouteFor(CREW_SCREEN)).toBe("pane-reply");
  });

  it("a steer is outside the Send Protocol: it always takes the program's own route", () => {
    expect(textRouteFor(LOCAL_PROGRAM, true)).toBe("pane-send");
    expect(textRouteFor(CREW_PROGRAM, true)).toBe("pane-send");
  });

  it("a local program on a bridge that does not mark the pane keeps the program's own route", () => {
    expect(textRouteFor({ ...LOCAL_PROGRAM, sendProtocol: false })).toBe("pane-send");
  });
});

describe("answerRouteFor", () => {
  it("a program on this machine answers through POST /api/ask", () => {
    expect(answerRouteFor(LOCAL_PROGRAM)).toBe("api-ask");
  });

  it("a program on a crew member keeps the program's answer route", () => {
    expect(answerRouteFor(CREW_PROGRAM)).toBe("pane-answer");
  });

  it("a terminal pane on this machine answers through POST /api/ask", () => {
    expect(answerRouteFor(LOCAL_SCREEN)).toBe("api-ask");
  });

  it("a terminal pane on a crew member keeps the guarded key route", () => {
    expect(answerRouteFor(CREW_SCREEN)).toBe("keys");
  });

  it("without the bridge's mark a local pane keeps its old route", () => {
    expect(answerRouteFor({ ...LOCAL_PROGRAM, sendProtocol: false })).toBe("pane-answer");
    expect(answerRouteFor({ ...LOCAL_SCREEN, sendProtocol: false })).toBe("keys");
  });
});

describe("holdAnswerRouteFor", () => {
  it("the hook hold card answers through POST /api/ask on this machine and on a crew member alike", () => {
    expect(holdAnswerRouteFor(LOCAL_SCREEN)).toBe("api-ask");
    expect(holdAnswerRouteFor(CREW_SCREEN)).toBe("api-ask");
  });

  it("a crew member's screen cards keep the guarded key route all the same", () => {
    expect(answerRouteFor(CREW_SCREEN)).toBe("keys");
  });

  it("without the bridge's mark the card keeps the pane's old route", () => {
    expect(holdAnswerRouteFor({ ...CREW_SCREEN, sendProtocol: false })).toBe("keys");
    expect(holdAnswerRouteFor({ ...LOCAL_SCREEN, sendProtocol: false })).toBe("keys");
  });
});

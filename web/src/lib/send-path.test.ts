import { describe, expect, it } from "vitest";

import { answerRouteFor, cardsOnOlderMember, holdAnswerRouteFor, textRouteFor, type PanePlace } from "./send-path";

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

  it("a terminal pane on a crew member that does not mark the ask route keeps the guarded key route, and the card says so", () => {
    expect(answerRouteFor(CREW_SCREEN)).toBe("keys");
    expect(cardsOnOlderMember(CREW_SCREEN)).toBe(true);
  });

  // M102 spec 14 decision 2: a member's screen card went by the raw keys route, with no bridge check and
  // no ask record. A member that marks `askRoute` now takes the tap through its own ask route.
  it("a terminal pane on a crew member that marks the ask route answers through POST /api/ask, carried by the lead", () => {
    expect(answerRouteFor({ ...CREW_SCREEN, askRoute: true })).toBe("api-ask");
    expect(cardsOnOlderMember({ ...CREW_SCREEN, askRoute: true })).toBe(false);
  });

  it("the mark moves nothing else: a member's program, a member with the protocol off, a local pane", () => {
    expect(answerRouteFor({ ...CREW_PROGRAM, askRoute: true })).toBe("pane-answer");
    expect(answerRouteFor({ ...CREW_SCREEN, sendProtocol: false, askRoute: true })).toBe("keys");
    expect(cardsOnOlderMember({ ...CREW_SCREEN, sendProtocol: false })).toBe(false);
    expect(cardsOnOlderMember(CREW_PROGRAM)).toBe(false);
    expect(cardsOnOlderMember(LOCAL_SCREEN)).toBe(false);
    expect(answerRouteFor({ ...LOCAL_SCREEN, askRoute: true })).toBe("api-ask");
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

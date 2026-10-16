// Which route a text and a tap take, by the kind of session and the crew link (M56 spec 14).
//
// A terminal pane sends every text as one Send Protocol request. On this machine that is
// `POST /api/send`; on a crew member it is the pane's reply route, which the member runs through its
// own Send Protocol. A program on this machine sends through `POST /api/send` too, once the bridge
// marks the pane with `sendProtocol`: its structured driver is the path. A program on a crew member,
// or on a bridge that does not mark the pane, keeps the program's own send route. Steer is not part
// of the Send Protocol, so a steer always takes the program's own route.
//
// An answer to a card follows the same split: `POST /api/ask/<id>` on this machine with
// `sendProtocol`, else the program's answer route for a program and the guarded key route for a
// terminal pane.
//
// Pure: no DOM, no fetch.

/** Where a pane is: a terminal pane or a program, on this machine or on a crew member. */
export interface PanePlace {
  /** The pane has no screen: a durable program's conversation. */
  readonly program: boolean;
  /** The pane lives on a crew member, not on this machine. */
  readonly crew: boolean;
  /** The bridge marks the pane for the Send Protocol (the snapshot's `sendProtocol`). */
  readonly sendProtocol: boolean;
}

/** `api-send` is `POST /api/send`; `pane-reply` is the pane's reply route on a crew member; `pane-send` is the program's own send route. */
export type TextRoute = "api-send" | "pane-reply" | "pane-send";

/** `api-ask` is `POST /api/ask/<id>`; `pane-answer` is the program's answer route; `keys` is the guarded key route. */
export type AnswerRoute = "api-ask" | "pane-answer" | "keys";

/** The route a text takes. `steer` marks a text for the running turn of a program. */
export function textRouteFor(place: PanePlace, steer = false): TextRoute {
  if (!place.program) return place.crew ? "pane-reply" : "api-send";
  return !place.crew && place.sendProtocol && !steer ? "api-send" : "pane-send";
}

/** The route a tap on a card takes. */
export function answerRouteFor(place: PanePlace): AnswerRoute {
  if (!place.crew && place.sendProtocol) return "api-ask";
  return place.program ? "pane-answer" : "keys";
}

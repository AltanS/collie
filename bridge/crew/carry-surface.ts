import type { JsonObject, JsonValue } from "../json.ts";
import type { CarryAnswer, StandbyCarrySurface } from "./router.ts";
import { CREW_TRICKS_COPY_CODE_PATH, CREW_TRICKS_COPY_PATH, CREW_TRICKS_COPY_STATE_PATH } from "./router.ts";
import { parseCodePart, parseStatePush, parseTricksList, tricksReportFields, type StandbyTricksStore } from "./standby-tricks.ts";

// The deputy's answers to the §25 routes (CREW_PROTOCOL §25): every body is read by the one parser of its
// kind, then handed to the store that keeps it inert. The router has already asked the two role
// questions (the caller is this collie's lead; a verified warrant names this collie) and capped the body.

/** A set of §25 routes and the report fields that go with them, answered by one store. */
export interface CarryRoutes {
  report(): JsonObject;
  handle(path: string, ctx: { readonly from: string; readonly crewId: string }, body: JsonValue): Promise<CarryAnswer | null>;
}

function answer(status: number, body: JsonObject): CarryAnswer {
  return { status, body };
}

/** The tricks half of the surface. */
export function tricksCarryRoutes(store: StandbyTricksStore): CarryRoutes {
  return {
    report: () => tricksReportFields(store.report()),
    handle: async (path, ctx, body) => {
      if (path === CREW_TRICKS_COPY_PATH) {
        const list = parseTricksList(body);
        if (list === null) return answer(400, { error: "a tricks copy is { seq, tricks }, each trick checked" });
        const applied = await store.applyList({ from: ctx.from, crewId: ctx.crewId, seq: list.seq, tricks: list.tricks });
        if (!applied.ok) return answer(409, { error: "this list is older than the one held", code: applied.code });
        return answer(200, { applied: true, need: { code: applied.need.code, state: applied.need.state } });
      }
      if (path === CREW_TRICKS_COPY_CODE_PATH) {
        const part = parseCodePart(body);
        if (part === null) return answer(400, { error: "a code part is { id, hash, part, parts, chunks }" });
        const done = await store.applyCodePart(part);
        if (!done.ok) return answer(done.code === "mismatch" ? 422 : 409, { error: done.reason, code: done.code });
        return answer(200, { held: done.held });
      }
      if (path === CREW_TRICKS_COPY_STATE_PATH) {
        const push = parseStatePush(body);
        if (push === null) return answer(400, { error: "a state push is { id, digest, files }, each file checked" });
        const done = await store.applyState(push);
        if (!done.ok) return answer(done.code === "rate" ? 429 : 409, { error: done.reason, code: done.code });
        return answer(200, { applied: true });
      }
      return null;
    },
  };
}

/** The whole surface: each half answers its own routes, and the report is both halves'. */
export function carrySurface(routes: readonly CarryRoutes[]): StandbyCarrySurface {
  return {
    report: () => Object.assign({}, ...routes.map((r) => r.report())),
    handle: async (path, ctx, body) => {
      for (const r of routes) {
        const done = await r.handle(path, ctx, body);
        if (done !== null) return done;
      }
      return answer(404, { error: "not a route of this collie" });
    },
  };
}

import { expect } from "vitest";
import type { Rig } from "./leg";
import { asJsonObject, asJsonString, type JsonObject } from "../../src/lib/json";

export interface ApiFaults {
  afterWrite?: (body: JsonObject) => Promise<void>;
  transformRead?: (raw: string) => string;
}

/** Bind production's browser client to the REAL isolated bridge, auditing each operation phase.
 * Fixture writes use Rig's absolute URLs outside this audit; no private action helpers are mocked. */
export function editorApi(rig: Rig) {
  return async function throughApi<T>(mode: "read" | "prepare" | "cancel" | "save" | "commit", run: () => Promise<T>, faults: ApiFaults = {}) {
    const nativeFetch = globalThis.fetch;
    const writes = mode === "save" || mode === "commit";
    const allowed = new Set(["ctrl+a", "ctrl+e", "Up", "Down", "Left", "Right"]);
    if (mode === "prepare") allowed.add("n");
    if (mode === "cancel" || writes) allowed.add("Escape");
    if (writes) for (const key of ["ctrl+u", "ctrl+k", "Backspace", "n"]) allowed.add(key);
    if (mode === "commit") allowed.add("Enter");
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (!path.startsWith("/api/")) return nativeFetch(input, init);
      if (init?.method === "POST") {
        const body = asJsonObject(JSON.parse(String(init.body)));
        const keys = Array.isArray(body?.keys) ? body.keys.map(asJsonString) : [];
        const typed = writes && path.endsWith("/reply") && body?.submit === false;
        if (!typed && (!path.endsWith("/keys") || keys.length === 0 || keys.some((key) => key === undefined || !allowed.has(key)))) {
          throw new Error(`${mode} phase attempted an undeclared editing or commit command`);
        }
        expect(body?.expected_prompt).toBeTruthy();
        expect(body?.expected_styled).toBeTruthy();
      }
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${rig.deviceToken()}`);
      headers.set("origin", rig.base);
      if (faults.transformRead) headers.delete("if-none-match");
      const response = await nativeFetch(`${rig.base}${path}`, { ...init, headers });
      if (init?.method === "POST") {
        const body = asJsonObject(JSON.parse(String(init.body)));
        if (body !== undefined) await faults.afterWrite?.(body);
      } else if (response.status === 200 && faults.transformRead) {
        const doc = asJsonObject(await response.json());
        const text = asJsonString(doc?.text);
        if (doc === undefined || text === undefined) throw new Error("pane API did not return text");
        const modified = faults.transformRead(text);
        const responseHeaders = new Headers(response.headers);
        // A faulted body must not poison the production ETag cache under the real pane's tag.
        if (modified !== text) responseHeaders.delete("etag");
        return Response.json({ ...doc, text: modified }, { headers: responseHeaders });
      }
      return response;
    };
    try { return await run(); }
    finally { globalThis.fetch = nativeFetch; }
  };
}

// The outer Worker. It checks the bearer token, then hands the request to the one Durable Object that runs the
// program. Everything the wire does happens in the Durable Object (member.ts).
import type { Env } from "./env.ts";
import { refused, tokenAccepted } from "./token.ts";

export { Member } from "./member.ts";

let warned = false;

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await tokenAccepted(request, env.COLLIE_TOKEN, env.COLLIE_TOKEN_NEXT))) {
      if (!warned && (env.COLLIE_TOKEN === undefined || env.COLLIE_TOKEN.length < 32)) {
        warned = true;
        console.error("COLLIE_TOKEN is not set or shorter than 32 bytes: every request is refused");
      }
      return refused();
    }
    try {
      // One program, one Durable Object. A second program is a second Worker, or a second name here.
      return await env.MEMBER.getByName("main").fetch(request);
    } catch (e) {
      console.error("durable object error:", e);
      return new Response(JSON.stringify({ code: "internal" }), { status: 500, headers: { "content-type": "application/json" } });
    }
  },
} satisfies ExportedHandler<Env>;

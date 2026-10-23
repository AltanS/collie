// `node --import ./register.mjs`: one copy of Pi, durable-harness and @workflow/* for the SDK source and the program.
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

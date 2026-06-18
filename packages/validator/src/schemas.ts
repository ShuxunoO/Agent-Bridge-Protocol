import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// src/ -> validator/ -> packages/ -> repo root
const CORE_DIR = join(here, "..", "..", "..", "SPEC", "schemas", "core");

/** A loaded JSON Schema document (opaque to this module). */
export type JSONSchema = Record<string, unknown>;

/** Read a Core schema by base name (without the .json extension). */
export function loadCoreSchema(name: string): JSONSchema {
  return JSON.parse(readFileSync(join(CORE_DIR, `${name}.json`), "utf8")) as JSONSchema;
}

/** Core envelope schema name. */
export const ENVELOPE_SCHEMA = "envelope";

/**
 * Map of message `type` -> payload schema base name.
 * `ping`/`pong` share `ping`; `event`/`action` validate only their Core *envelope*
 * here (kind/data composition against a pinned World Profile is F1.2).
 */
export const PAYLOAD_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  hello: "hello",
  hello_ack: "hello_ack",
  roles_query: "roles_query",
  roles_list: "roles_list",
  pair_challenge: "pair_challenge",
  pair_request: "pair_request",
  pair_result: "pair_result",
  resume: "resume",
  ping: "ping",
  pong: "ping",
  bye: "bye",
  error: "error",
  event: "event",
  action: "action",
});

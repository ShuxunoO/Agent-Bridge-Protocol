import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// src/ -> validator/ -> packages/ -> repo root
const SCHEMAS_DIR = join(here, "..", "..", "..", "SPEC", "schemas");
const CORE_DIR = join(SCHEMAS_DIR, "core");
const PROFILES_DIR = join(SCHEMAS_DIR, "profiles");

/** A loaded JSON Schema document (opaque to this module). */
export type JSONSchema = Record<string, unknown>;

/** Read a Core schema by base name (without the .json extension). */
export function loadCoreSchema(name: string): JSONSchema {
  return JSON.parse(readFileSync(join(CORE_DIR, `${name}.json`), "utf8")) as JSONSchema;
}

/**
 * Bundled World Profiles shipped with the connector (paths under SPEC/schemas/profiles/).
 * These pin silently; any other profile a host offers requires explicit approval (§5.5).
 */
export const BUNDLED_PROFILE_FILES: readonly string[] = Object.freeze(["social/1.json"]);

/** Read a bundled World Profile document by its path relative to SPEC/schemas/profiles/. */
export function loadBundledProfile(relPath: string): JSONSchema {
  return JSON.parse(readFileSync(join(PROFILES_DIR, relPath), "utf8")) as JSONSchema;
}

/**
 * The ABP Core protocol semver advertised on the wire (`hello.abp_core` / `hello_ack.abp_core`,
 * §4.2). The single source of truth for the Core version — host and client both reference this
 * instead of a magic string, and host adapters can pin it (see the cross-repo contract check).
 */
export const ABP_CORE_VERSION = "1.0.0";

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

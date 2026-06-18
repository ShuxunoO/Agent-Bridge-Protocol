import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { ENVELOPE_SCHEMA, PAYLOAD_SCHEMA, loadCoreSchema } from "./schemas.ts";

/** Transport limits (SPEC/abp-v1.md §2). */
export const MAX_MESSAGE_BYTES = 65536;
export const MAX_DEPTH = 16;

export type ValidationOk = { ok: true; type: string };
export type ValidationError = { ok: false; code: "bad_message"; errors: string[] };
export type ValidationResult = ValidationOk | ValidationError;

function fail(...errors: string[]): ValidationError {
  return { ok: false, code: "bad_message", errors };
}

/** Max object/array nesting depth, short-circuiting once `cap` is exceeded. */
function jsonDepth(value: unknown, cap: number): number {
  function go(x: unknown, d: number): number {
    if (d > cap) return d;
    if (Array.isArray(x)) {
      let m = d;
      for (const e of x) {
        m = Math.max(m, go(e, d + 1));
        if (m > cap) return m;
      }
      return m;
    }
    if (x !== null && typeof x === "object") {
      let m = d;
      for (const k of Object.keys(x as object)) {
        m = Math.max(m, go((x as Record<string, unknown>)[k], d + 1));
        if (m > cap) return m;
      }
      return m;
    }
    return d;
  }
  return go(value, 1);
}

function formatErrors(v: ValidateFunction): string[] {
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

/**
 * ABP/1 Core validator. Validates the closed Core envelope and dispatches the
 * payload to its Core schema by `type`. Enforces the §2 size/depth limits.
 * Data-plane `event`/`action` are validated only at the Core-envelope layer;
 * `kind`/`data` validation against a pinned World Profile is F1.2.
 */
export class CoreValidator {
  readonly #envelope: ValidateFunction;
  readonly #payload: Map<string, ValidateFunction> = new Map();

  constructor() {
    // strictRequired off: the envelope's conditional `required:["session"]` lives in an
    // allOf/then scope while `session` is defined at the top level — a style lint, not a safety
    // check. All other strict checks (unknown keywords, etc.) stay on.
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    // x-abp-trust is an ABP annotation keyword (§5.3); no validation effect.
    ajv.addKeyword({ keyword: "x-abp-trust", schemaType: "string" });

    this.#envelope = ajv.compile(loadCoreSchema(ENVELOPE_SCHEMA));
    for (const name of new Set(Object.values(PAYLOAD_SCHEMA))) {
      this.#payload.set(name, ajv.compile(loadCoreSchema(name)));
    }
  }

  /** Validate an already-parsed message object. */
  validateMessage(msg: unknown): ValidationResult {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return fail("message must be a JSON object");
    }
    const depth = jsonDepth(msg, MAX_DEPTH);
    if (depth > MAX_DEPTH) return fail(`message nesting depth ${depth} exceeds ${MAX_DEPTH}`);

    if (!this.#envelope(msg)) return fail(...formatErrors(this.#envelope));

    const type = (msg as { type: string }).type;
    const schemaName = PAYLOAD_SCHEMA[type];
    if (!schemaName) return fail(`unknown message type "${type}"`);

    const payloadValidate = this.#payload.get(schemaName)!;
    const payload = (msg as { payload: unknown }).payload;
    if (!payloadValidate(payload)) {
      return fail(...formatErrors(payloadValidate).map((e) => `payload${e}`));
    }
    return { ok: true, type };
  }

  /** Validate a raw on-the-wire UTF-8 string: size, parse, depth, then schema. */
  validateEncoded(text: string): ValidationResult {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_MESSAGE_BYTES) {
      return fail(`message size ${bytes} bytes exceeds ${MAX_MESSAGE_BYTES}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("payload is not valid JSON");
    }
    return this.validateMessage(parsed);
  }
}

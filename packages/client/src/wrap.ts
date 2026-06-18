/**
 * L2 untrusted-content wrapping (DESIGN §4 L2, SPEC §6.2). Before any host-authored text
 * reaches the model, the untrusted leaves of an event's `data` — enumerated from the pinned
 * profile's `x-abp-trust: untrusted` paths, never hard-coded — are delimited as data and
 * escaped so the content cannot break out of the delimiter or forge control structure.
 *
 * Control fields (ids, seq, positions, conversation_id, status) are left untouched so the
 * agent can still act on them. This is deterministic and does not rely on model goodwill;
 * it is the structural complement to the locked persona prompt (persona.ts).
 */

export const UNTRUSTED_OPEN_TAG = "untrusted";

/**
 * Escape so wrapped content can contain no `<` or `>` and therefore cannot forge any tag
 * (including a premature `</untrusted>`). `&` is escaped first to keep the mapping reversible.
 */
export function escapeUntrusted(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(s: string): string {
  return escapeUntrusted(s).replace(/"/g, "&quot;");
}

/** Wrap a single string leaf as delimited untrusted data. */
export function wrapString(s: string, source?: string): string {
  const src = source ? ` source="${attr(source)}"` : "";
  return `<${UNTRUSTED_OPEN_TAG}${src}>${escapeUntrusted(s)}</${UNTRUSTED_OPEN_TAG}>`;
}

/** Recursively wrap every string in a subtree (used when an untrusted path lands on an object/array, e.g. world.context). */
function wrapAllStrings(value: unknown, source?: string): unknown {
  if (typeof value === "string") return wrapString(value, source);
  if (Array.isArray(value)) return value.map((v) => wrapAllStrings(v, source));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = wrapAllStrings(v, source);
    return out;
  }
  return value; // numbers / booleans / null are not text — left untouched
}

function toSegments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** Return a structural copy of `value` with the leaf/subtree at `segments` wrapped. */
function wrapAtPath(value: unknown, segments: string[], source?: string): unknown {
  if (segments.length === 0) return wrapAllStrings(value, source);
  const [head, ...rest] = segments;
  if (head === "[]") {
    return Array.isArray(value) ? value.map((el) => wrapAtPath(el, rest, source)) : value;
  }
  if (value && typeof value === "object" && head in (value as object)) {
    const obj = value as Record<string, unknown>;
    return { ...obj, [head]: wrapAtPath(obj[head], rest, source) };
  }
  return value; // path not present in this message — nothing to wrap
}

/**
 * Wrap the untrusted leaves of `data` at the given profile-derived paths. `source` labels the
 * origin (e.g. "role:mira") on each wrapped leaf. Returns a copy; `data` is not mutated.
 */
export function wrapUntrusted(
  data: Record<string, unknown>,
  untrustedPaths: string[],
  opts: { source?: string } = {},
): Record<string, unknown> {
  let out: unknown = data;
  for (const path of untrustedPaths) {
    out = wrapAtPath(out, toSegments(path), opts.source);
  }
  return out as Record<string, unknown>;
}

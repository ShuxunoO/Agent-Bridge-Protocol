/**
 * Persona profile format + loader (F5.1). The user-authored, CURATED description of the
 * character an avatar plays. It is the only persona information the avatar is given (DESIGN §2
 * "curated persona profile"): the local agent's private memory/files/secrets are hard-walled.
 *
 * The loader validates a closed shape (unknown fields / oversize / wrong types rejected) AND
 * runs an egress-DLP scan so a profile that accidentally contains a secret or absolute path is
 * refused — a profile must be public, curated content.
 */
import { readFileSync } from "node:fs";
import type { PersonaProfile } from "./persona.ts";
import { EgressFilter } from "./dlp.ts";

export const PERSONA_LIMITS = {
  displayName: 64,
  backstory: 2000,
  trait: 64,
  traits: 32,
  goal: 200,
  goals: 16,
  speakingStyle: 500,
} as const;

const KNOWN_FIELDS = new Set(["displayName", "backstory", "traits", "goals", "speakingStyle"]);

export type PersonaLoadResult = { ok: true; profile: PersonaProfile } | { ok: false; errors: string[] };

function strField(o: Record<string, unknown>, key: string, max: number, errors: string[]): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    errors.push(`${key} must be a string`);
    return undefined;
  }
  if (v.length > max) errors.push(`${key} exceeds ${max} chars`);
  return v;
}

function strArray(o: Record<string, unknown>, key: string, maxCount: number, maxLen: number, errors: string[]): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    errors.push(`${key} must be an array of strings`);
    return undefined;
  }
  if (v.length > maxCount) errors.push(`${key} exceeds ${maxCount} items`);
  for (const item of v) {
    if (typeof item !== "string") {
      errors.push(`${key} items must be strings`);
      return undefined;
    }
    if (item.length > maxLen) errors.push(`${key} item exceeds ${maxLen} chars`);
  }
  return v as string[];
}

/**
 * Validate + load a curated persona profile. Rejects unknown fields, wrong types, oversize
 * values, a missing/empty displayName, and any field containing a secret-like value (so a
 * persona stays public/curated).
 */
export function loadPersonaProfile(doc: unknown, opts: { filter?: EgressFilter } = {}): PersonaLoadResult {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["persona profile must be a JSON object"] };
  }
  const o = doc as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN_FIELDS.has(k)) errors.push(`unknown field "${k}"`);

  const displayName = strField(o, "displayName", PERSONA_LIMITS.displayName, errors);
  if (!displayName || displayName.trim().length === 0) errors.push("displayName is required and must be non-empty");
  const backstory = strField(o, "backstory", PERSONA_LIMITS.backstory, errors);
  const speakingStyle = strField(o, "speakingStyle", PERSONA_LIMITS.speakingStyle, errors);
  const traits = strArray(o, "traits", PERSONA_LIMITS.traits, PERSONA_LIMITS.trait, errors);
  const goals = strArray(o, "goals", PERSONA_LIMITS.goals, PERSONA_LIMITS.goal, errors);

  // Curated-content guard: no secrets/keys/paths anywhere in the profile.
  const filter = opts.filter ?? new EgressFilter();
  for (const s of [displayName, backstory, speakingStyle, ...(traits ?? []), ...(goals ?? [])]) {
    if (typeof s === "string" && filter.inspect(s).length > 0) {
      errors.push("profile contains a secret-like value; a persona must be public, curated content");
      break;
    }
  }

  if (errors.length) return { ok: false, errors };
  const profile: PersonaProfile = { displayName };
  if (backstory !== undefined) profile.backstory = backstory;
  if (traits !== undefined) profile.traits = traits;
  if (goals !== undefined) profile.goals = goals;
  if (speakingStyle !== undefined) profile.speakingStyle = speakingStyle;
  return { ok: true, profile };
}

/** Load + validate a persona profile from a JSON file. */
export function loadPersonaProfileFile(path: string, opts: { filter?: EgressFilter } = {}): PersonaLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`cannot read/parse ${path}: ${(e as Error).message}`] };
  }
  return loadPersonaProfile(parsed, opts);
}

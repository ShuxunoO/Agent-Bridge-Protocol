/**
 * Egress data-leak prevention (DESIGN §4 L3, SPEC §6.4). Deterministic scan of
 * client-authored text for secrets before it leaves the machine. This is the last
 * line if the untrusted-content contract (L2) is bypassed; it never relies on model
 * goodwill. The set of fields to scan is enumerated from the pinned profile's
 * `x-abp-trust: client_authored` paths, not hard-coded.
 */

export type DlpFinding = { type: string; start: number; end: number };
export type EgressMode = "block" | "redact";

type Rule = { type: string; re: RegExp };

/** High-precision secret patterns (favour low false positives over recall). */
const RULES: Rule[] = [
  { type: "private_key", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { type: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { type: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { type: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/gi },
  { type: "home_path", re: /(?:\/(?:Users|home)\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)(?:[/\\][^\s"']*)?/g },
  { type: "large_base64", re: /\b[A-Za-z0-9+/]{512,}={0,2}\b/g },
];

export type EgressOptions = {
  mode?: EgressMode;
  /** Max length for a scanned field; over-limit counts as a finding (type "oversize"). */
  maxLength?: number;
};

/** Scan + (optionally) redact client-authored text. */
export class EgressFilter {
  readonly mode: EgressMode;
  readonly maxLength: number;

  constructor(opts: EgressOptions = {}) {
    this.mode = opts.mode ?? "block";
    this.maxLength = opts.maxLength ?? Number.POSITIVE_INFINITY;
  }

  /** Return all secret findings (and an oversize finding if over maxLength). */
  inspect(text: string): DlpFinding[] {
    const findings: DlpFinding[] = [];
    for (const { type, re } of RULES) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        findings.push({ type, start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    if (text.length > this.maxLength) findings.push({ type: "oversize", start: 0, end: text.length });
    return findings.sort((a, b) => a.start - b.start);
  }

  /** Replace each finding's span with a [REDACTED:type] marker. */
  redact(text: string, findings: DlpFinding[]): string {
    let out = text;
    for (const f of [...findings].sort((a, b) => b.start - a.start)) {
      if (f.type === "oversize") {
        out = out.slice(0, this.maxLength);
        continue;
      }
      out = out.slice(0, f.start) + `[REDACTED:${f.type}]` + out.slice(f.end);
    }
    return out;
  }
}

function eachLeaf(value: unknown, segments: string[], cb: (s: string) => void): void {
  if (segments.length === 0) {
    if (typeof value === "string") cb(value);
    return;
  }
  const [head, ...rest] = segments;
  if (head === "[]") {
    if (Array.isArray(value)) for (const el of value) eachLeaf(el, rest, cb);
    return;
  }
  if (value && typeof value === "object" && head in (value as object)) {
    eachLeaf((value as Record<string, unknown>)[head], rest, cb);
  }
}

function mapLeaf(value: unknown, segments: string[], fn: (s: string) => string): unknown {
  if (segments.length === 0) return typeof value === "string" ? fn(value) : value;
  const [head, ...rest] = segments;
  if (head === "[]") {
    return Array.isArray(value) ? value.map((el) => mapLeaf(el, rest, fn)) : value;
  }
  if (value && typeof value === "object" && head in (value as object)) {
    return { ...(value as Record<string, unknown>), [head]: mapLeaf((value as Record<string, unknown>)[head], rest, fn) };
  }
  return value;
}

function toSegments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export type EgressResult = {
  data: Record<string, unknown>;
  blocked: boolean;
  redacted: boolean;
  findings: DlpFinding[];
};

/**
 * Apply the filter to the `client_authored` paths of an action's data. In "block" mode,
 * any finding marks the action blocked (fail-closed). In "redact" mode, matched spans are
 * replaced and `redacted` is true (the caller may set the profile's `redacted` flag, §4.4.3).
 */
export function applyEgress(filter: EgressFilter, clientAuthoredPaths: string[], data: Record<string, unknown>): EgressResult {
  const findings: DlpFinding[] = [];
  for (const path of clientAuthoredPaths) {
    eachLeaf(data, toSegments(path), (s) => findings.push(...filter.inspect(s)));
  }
  if (findings.length === 0) return { data, blocked: false, redacted: false, findings };
  if (filter.mode === "block") return { data, blocked: true, redacted: false, findings };

  let next: Record<string, unknown> = data;
  for (const path of clientAuthoredPaths) {
    next = mapLeaf(next, toSegments(path), (s) => filter.redact(s, filter.inspect(s))) as Record<string, unknown>;
  }
  return { data: next, blocked: false, redacted: true, findings };
}

/** Sliding-window rate limiter for outbound actions (client-side defense-in-depth). */
export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  #hits: number[] = [];

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /** Record an attempt at `now`; return false if it exceeds the window budget. */
  allow(now: number): boolean {
    const cutoff = now - this.#windowMs;
    this.#hits = this.#hits.filter((t) => t > cutoff);
    if (this.#hits.length >= this.#max) return false;
    this.#hits.push(now);
    return true;
  }
}

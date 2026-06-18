import { randomUUID } from "node:crypto";

/** An ABP message envelope (§3). */
export type Envelope = {
  abp: "1";
  type: string;
  id: string;
  ts: number;
  payload: unknown;
  session?: string;
  corr?: string;
};

/** Build a well-formed envelope with a fresh id and timestamp. */
export function makeEnvelope(
  type: string,
  payload: unknown,
  opts: { session?: string; corr?: string } = {},
): Envelope {
  const env: Envelope = { abp: "1", type, id: randomUUID(), ts: Date.now(), payload };
  if (opts.session !== undefined) env.session = opts.session;
  if (opts.corr !== undefined) env.corr = opts.corr;
  return env;
}

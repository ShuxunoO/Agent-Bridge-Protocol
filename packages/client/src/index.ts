export { WssTransport } from "./transport.ts";
export type { TransportOptions, Validate, InvalidFrame } from "./transport.ts";
export { Keypair, verifySignature } from "./keypair.ts";
export { Session, PROACTIVE } from "./session.ts";
export type { SessionData } from "./session.ts";
export { makeEnvelope } from "./envelope.ts";
export type { Envelope } from "./envelope.ts";
export { pair, sendResume, PairingError } from "./pairing.ts";
export type { PairOptions, PairResult } from "./pairing.ts";
export { EgressFilter, RateLimiter, applyEgress } from "./dlp.ts";
export type { DlpFinding, EgressMode, EgressOptions, EgressResult } from "./dlp.ts";
export { Driver } from "./driver.ts";
export type {
  DriverOptions,
  AbpEvent,
  EventContext,
  ActionInput,
  TurnDecision,
  TurnHandler,
  EventHandler,
} from "./driver.ts";
export { wrapUntrusted, wrapString, escapeUntrusted, UNTRUSTED_OPEN_TAG } from "./wrap.ts";
export { LOCKED_PERSONA_PROMPT, buildPersonaPrompt } from "./persona.ts";
export type { PersonaProfile } from "./persona.ts";
export { INJECTION_EVALS, INJECTION_CATEGORIES } from "./injection-evals.ts";
export type { InjectionEval, InjectionCategory } from "./injection-evals.ts";
export {
  CapabilityGuard,
  CapabilityError,
  ABP_TOOL_NAMES,
  AVATAR_MCP_ALLOWLIST,
  MCP_SERVER_NAME,
  mcpToolName,
} from "./capability.ts";
export { isolatedEnv, launchIsolated, BASE_ENV_KEYS } from "./isolation.ts";
export type { IsolationOptions } from "./isolation.ts";
export {
  runInjectionHarness,
  assertInjectionGate,
  runLiveInjectionEval,
  InjectionGateError,
} from "./injection-harness.ts";
export type { DefenseToggles, CaseResult, HarnessReport, HarnessOptions, AskFn } from "./injection-harness.ts";
export type { InjectionProbe } from "./injection-evals.ts";

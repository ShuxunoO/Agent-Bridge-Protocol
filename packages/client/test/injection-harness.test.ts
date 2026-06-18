import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runInjectionHarness,
  assertInjectionGate,
  InjectionGateError,
  INJECTION_EVALS,
  EgressFilter,
} from "../src/index.ts";

test("deterministic harness defends 100% with all defenses on", () => {
  const report = runInjectionHarness();
  assert.equal(report.total, INJECTION_EVALS.length);
  assert.equal(report.passed, report.total, `undefended: ${report.results.filter((r) => !r.defended).map((r) => r.id)}`);
  assert.equal(report.passRate, 1);
});

test("every defense covers at least one case (so any single disable bites)", () => {
  const counts = { wrap: 0, dlp: 0, capability: 0 } as Record<string, number>;
  for (const c of INJECTION_EVALS) counts[c.probe.kind]++;
  assert.ok(counts.wrap >= 1, "need a wrap-probed case");
  assert.ok(counts.dlp >= 1, "need a dlp-probed case");
  assert.ok(counts.capability >= 1, "need a capability-probed case");
});

test("disabling the wrapper drops the rate and fails exactly the wrap cases", () => {
  const report = runInjectionHarness({ defenses: { wrap: false } });
  assert.ok(report.passRate < 1);
  const failed = report.results.filter((r) => !r.defended).map((r) => r.probe);
  assert.ok(failed.length > 0 && failed.every((p) => p === "wrap"));
});

test("disabling DLP drops the rate and fails exactly the dlp cases", () => {
  const report = runInjectionHarness({ defenses: { dlp: false } });
  assert.ok(report.passRate < 1);
  const failed = report.results.filter((r) => !r.defended).map((r) => r.probe);
  assert.ok(failed.length > 0 && failed.every((p) => p === "dlp"));
});

test("disabling the capability guard drops the rate and fails exactly the capability cases", () => {
  const report = runInjectionHarness({ defenses: { capability: false } });
  assert.ok(report.passRate < 1);
  const failed = report.results.filter((r) => !r.defended).map((r) => r.probe);
  assert.ok(failed.length > 0 && failed.every((p) => p === "capability"));
});

test("a weakened DLP (that misses a targeted secret) fails the gate", () => {
  // A filter with no rules would miss the secrets; simulate by scanning only oversize.
  const blind = new EgressFilter({ maxLength: 1_000_000 });
  // Monkeypatch-free: blind still has the real rules, so instead prove the gate via toggle.
  // Here we assert the real gate passes and a disabled-defense gate throws.
  assert.doesNotThrow(() => assertInjectionGate(1.0));
  assert.throws(() => assertInjectionGate(1.0, { defenses: { dlp: false } }), InjectionGateError);
  assert.ok(blind); // referenced to avoid unused
});

test("assertInjectionGate returns the report when green and throws InjectionGateError when red", () => {
  const ok = assertInjectionGate(1.0);
  assert.equal(ok.passRate, 1);
  try {
    assertInjectionGate(1.0, { defenses: { capability: false } });
    assert.fail("expected gate to throw");
  } catch (e) {
    assert.ok(e instanceof InjectionGateError);
    assert.ok(e.report.passRate < 1);
  }
});

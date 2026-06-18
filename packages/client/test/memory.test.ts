import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaMemoryStore, safeNamespace } from "../src/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "abp-memtest-"));

test("set / get / list / delete within a namespace", () => {
  const d = dir();
  const s = new PersonaMemoryStore("role-a", { dir: d });
  s.set("met:alice", { liked: true });
  assert.deepEqual(s.get("met:alice"), { liked: true });
  assert.deepEqual(s.list(), ["met:alice"]);
  s.delete("met:alice");
  assert.equal(s.get("met:alice"), null);
});

test("persists across reopen", () => {
  const d = dir();
  new PersonaMemoryStore("role-a", { dir: d }).set("fact", "the festival is on friday");
  const reopened = new PersonaMemoryStore("role-a", { dir: d });
  assert.equal(reopened.get("fact"), "the festival is on friday");
});

test("namespaces are hard-walled from each other", () => {
  const d = dir();
  new PersonaMemoryStore("role-a", { dir: d }).set("secretish", "a-only");
  const b = new PersonaMemoryStore("role-b", { dir: d });
  assert.equal(b.get("secretish"), null); // role-b cannot see role-a's data
  assert.deepEqual(b.list(), []);
});

test("namespace is sanitized to a single safe file (no path traversal)", () => {
  const d = dir();
  // a traversal-looking namespace is flattened to a single safe filename, not an escape
  const s = new PersonaMemoryStore("../../etc/role", { dir: d });
  s.set("k", 1);
  const files = readdirSync(d);
  assert.equal(files.length, 1);
  // path separators are stripped, so the namespace is a single safe filename within `dir`
  // (a literal ".." substring inside one segment is harmless — it cannot traverse).
  assert.ok(!files[0].includes("/") && !files[0].includes("\\"));
  // pure traversal tokens are rejected outright
  assert.throws(() => new PersonaMemoryStore("..", { dir: d }));
  assert.throws(() => safeNamespace(""));
});

test("get returns null for missing key (not undefined)", () => {
  const s = new PersonaMemoryStore("role-a", { dir: dir() });
  assert.equal(s.get("nope"), null);
});

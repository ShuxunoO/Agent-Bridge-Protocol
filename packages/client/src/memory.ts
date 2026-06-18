/**
 * Persistent, namespaced, hard-walled persona memory (DESIGN §4 L4, F5.2). Replaces the F3.1
 * in-memory placeholder. One store instance is confined to a SINGLE namespace file (the bound
 * role's id): it can never read another namespace or the main agent's private memory, and is
 * never transmitted to the host (the closed action schemas carry no memory field, so there is no
 * channel for it to leak).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function defaultMemoryDir(): string {
  return join(homedir(), ".agent-bridge", "persona-memory");
}

/** Map a namespace to a single safe filename segment; reject traversal. */
export function safeNamespace(ns: string): string {
  const safe = ns.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe === "" || safe === "." || safe === "..") {
    throw new Error(`unsafe persona memory namespace: ${JSON.stringify(ns)}`);
  }
  return safe;
}

export class PersonaMemoryStore {
  readonly namespace: string;
  readonly #file: string;
  #data: Record<string, unknown>;

  constructor(namespace: string, opts: { dir?: string } = {}) {
    this.namespace = safeNamespace(namespace);
    const dir = opts.dir ?? defaultMemoryDir();
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, `${this.namespace}.json`);
    this.#data = this.#load();
  }

  #load(): Record<string, unknown> {
    if (!existsSync(this.#file)) return {};
    try {
      const o = JSON.parse(readFileSync(this.#file, "utf8"));
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  #persist(): void {
    writeFileSync(this.#file, JSON.stringify(this.#data), { mode: 0o600 });
  }

  get(key: string): unknown {
    return key in this.#data ? this.#data[key] : null;
  }
  set(key: string, value: unknown): void {
    this.#data[key] = value ?? null;
    this.#persist();
  }
  delete(key: string): void {
    delete this.#data[key];
    this.#persist();
  }
  list(): string[] {
    return Object.keys(this.#data);
  }
}

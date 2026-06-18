import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { CoreValidator, MAX_MESSAGE_BYTES, type ValidationResult } from "@agent-bridge/validator";

/** Validate a parsed message. Defaults to Core validation; swap in an AbpValidator post-pairing. */
export type Validate = (msg: unknown) => ValidationResult;

export type TransportOptions = {
  /** Message validator. Default: Core envelope/type validation. */
  validate?: Validate;
  /** Extra handshake headers, e.g. { Authorization: "Bearer <token>" } (§2). */
  headers?: Record<string, string>;
};

/** Details emitted on a rejected inbound frame. */
export type InvalidFrame = { reason: string; errors: string[]; raw?: string };

const sharedCore = new CoreValidator();
const defaultValidate: Validate = (msg) => sharedCore.validateMessage(msg);

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Outbound WebSocket transport (ABP baseline binding, §2). The client always
 * initiates (invariant 1). One ABP message per frame, UTF-8 JSON. Every inbound
 * frame is validated before delivery (the connector is the security kernel); the
 * outbound path validates too, to catch local bugs before they reach the host.
 *
 * Events: "open", "message"(msg, type), "invalid"(InvalidFrame), "close"(code, reason), "error"(err).
 */
export class WssTransport extends EventEmitter {
  readonly #url: string;
  readonly #validate: Validate;
  readonly #headers?: Record<string, string>;
  #ws?: WebSocket;

  constructor(url: string, opts: TransportOptions = {}) {
    super();
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") {
      throw new Error(`unsupported transport scheme "${u.protocol}"; ABP baseline is wss (SPEC §2)`);
    }
    if (u.protocol === "ws:" && !isLoopback(u.hostname)) {
      throw new Error(`plaintext ws:// is allowed only for loopback dev (got "${u.hostname}"); use wss:// (SPEC §2)`);
    }
    this.#url = url;
    this.#validate = opts.validate ?? defaultValidate;
    this.#headers = opts.headers;
  }

  /** Open the outbound connection. Resolves on the WebSocket "open" event. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#url, this.#headers ? { headers: this.#headers } : undefined);
      this.#ws = ws;
      ws.on("open", () => {
        this.emit("open");
        resolve();
      });
      ws.on("error", (err: Error) => {
        this.emit("error", err);
        reject(err);
      });
      ws.on("close", (code: number, reason: Buffer) => this.emit("close", code, reason.toString("utf8")));
      ws.on("message", (data: Buffer, isBinary: boolean) => this.#onFrame(data, isBinary));
    });
  }

  #onFrame(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.emit("invalid", { reason: "bad_message", errors: ["binary frame; ABP frames are UTF-8 JSON text"] } satisfies InvalidFrame);
      return;
    }
    if (data.byteLength > MAX_MESSAGE_BYTES) {
      this.emit("invalid", { reason: "bad_message", errors: [`frame ${data.byteLength} bytes exceeds ${MAX_MESSAGE_BYTES}`] } satisfies InvalidFrame);
      return;
    }
    const text = data.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emit("invalid", { reason: "bad_message", errors: ["frame is not valid JSON"], raw: text } satisfies InvalidFrame);
      return;
    }
    const res = this.#validate(parsed);
    if (!res.ok) {
      this.emit("invalid", { reason: res.code, errors: res.errors, raw: text } satisfies InvalidFrame);
      return;
    }
    this.emit("message", parsed, res.type);
  }

  /** Validate and send one ABP message. Throws if the message is invalid or the socket is not open. */
  send(msg: unknown): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("transport is not open");
    }
    const res = this.#validate(msg);
    if (!res.ok) {
      throw new Error(`refusing to send invalid ABP message: ${res.errors.join("; ")}`);
    }
    const text = JSON.stringify(msg);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new Error(`refusing to send oversize message: ${bytes} bytes exceeds ${MAX_MESSAGE_BYTES}`);
    }
    this.#ws.send(text);
  }

  /** True once the socket is open. */
  get isOpen(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Close the connection. */
  close(code?: number, reason?: string): void {
    this.#ws?.close(code, reason);
  }
}

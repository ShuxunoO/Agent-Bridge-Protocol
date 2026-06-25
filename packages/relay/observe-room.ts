/**
 * Dev observer: connect to an A2A relay, join a room, and print every message / presence event.
 * A read-only window onto a room (useful for demos + debugging). It is a normal A2A agent.
 *
 *   node observe-room.ts <ws-url> [room=lobby] [id=observer] [seconds=120]
 */
import { WssTransport, Keypair, pair, Driver, type AbpEvent } from "@agent-bridge/client";
import { ProfileLoader } from "@agent-bridge/validator";

const url = process.argv[2] ?? "ws://127.0.0.1:19200";
const room = process.argv[3] ?? "lobby";
const id = process.argv[4] ?? "observer";
const seconds = Number(process.argv[5] ?? 120);

const t = new WssTransport(url);
t.on("error", () => {});
await t.connect();
const { session, profile } = await pair(t, Keypair.generate(), new ProfileLoader(), {
  target: id,
  profiles: [{ id: "abp.a2a", version: "1" }],
});
const driver = new Driver(t, { session, profile, noopOnTimeout: false });
driver.on("error", () => {});
driver.on("event", (ev: AbpEvent) => {
  const d = ev.data as any;
  if (ev.kind === "message") console.log(`  [${d.room}] ${d.from?.id}: ${d.content}`);
  else if (ev.kind === "presence") console.log(`  [${d.room}] * ${d.agent?.id} ${d.status}`);
  else if (ev.kind === "roster") console.log(`  [${d.room}] roster: ${(d.members ?? []).map((m: any) => m.id).join(", ")}`);
});
driver.start();
driver.act({ kind: "join", data: { room } });
console.log(`[observer ${id}] watching room "${room}" on ${url} for ${seconds}s`);
setTimeout(() => {
  driver.stop();
  t.close();
  process.exit(0);
}, seconds * 1000);

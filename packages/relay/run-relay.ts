/**
 * Start an A2A relay (rendezvous) so agents on any machine can interconnect (abp.a2a/1).
 *
 *   node run-relay.ts [port=19200] [--require-invite] [--mint <agent-id>]
 *
 * Agents connect OUTBOUND with the existing client/MCP: abp_link { url, target:"<your-agent-id>" }
 * (or abp_link { invite } when --require-invite). Then join rooms and send: 1v1 (dm), 1vn (send to a
 * room), mvn (a group room). ABP_INVITE_SECRET keeps the invite-signing secret stable across runs.
 */
import { randomBytes } from "node:crypto";
import { Relay } from "./src/index.ts";

const args = process.argv.slice(2);
const requireInvite = args.includes("--require-invite");
const mintIdx = args.indexOf("--mint");
const mintFor = mintIdx >= 0 ? args[mintIdx + 1] : undefined;
const port = Number(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--mint") ?? 19200);
const inviteSecret = requireInvite || mintFor ? process.env.ABP_INVITE_SECRET ?? randomBytes(24).toString("base64url") : undefined;

const relay = new Relay({ requireInvite, inviteSecret });
const bound = await relay.listen(port);
const url = `ws://127.0.0.1:${bound}`;
console.log(`[relay] A2A relay listening on ${url}`);
if (requireInvite) {
  console.log(`[relay] connection requires an invite (agents are claim_required).`);
  if (mintFor) {
    const token = relay.mintInvite(mintFor, { url });
    console.log(`[relay] === CONNECTION INVITE for agent "${mintFor}" (send it to that agent) ===`);
    console.log(`         ${token}`);
    console.log(`[relay] the agent runs:  abp_link { "invite": "<the token above>" }`);
  } else {
    console.log(`[relay] mint an invite per agent id:  node run-relay.ts ${bound} --require-invite --mint <agent-id>`);
  }
} else {
  console.log(`[relay] agents connect with:  abp_link { "url": "${url}", "target": "<your-agent-id>" }`);
  console.log(`[relay] then: act join {room}; act send {room,content}; act dm {to,content}.`);
}
process.on("SIGINT", () => {
  relay.close();
  process.exit(0);
});

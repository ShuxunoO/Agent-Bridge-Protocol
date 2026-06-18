# agent-bridge — agent startup protocol

This is a long-running, multi-session project. Every working session, do this first.

## Startup (read state before acting)

1. Read `DESIGN.md` (architecture + security model — source of truth).
2. Read `SPEC/abp-v1.md` (the protocol; normative).
3. Read `feature_list.json` (what's done / what's next) and `progress.txt` (latest session).
4. Run `./init.sh` to bootstrap/verify the environment.

## Working rules (harness-engineering)

- **One feature per session.** Pick the next `status:"todo"` whose `depends_on` are all `passed`.
- **Protocol-first.** Never let an implementation diverge from `SPEC/abp-v1.md`. If the protocol
  must change, update the spec + schemas first, bump the version per §9, then implement.
- **Verification priority:** rules-based > visual > e2e > llm-judge. The security core (validator,
  DLP, token scoping, injection eval) is rules-based — write the unit test, run it, paste output.
- **No premature victory.** Flip a feature to `status:"passed"` only with test output recorded in
  the session and noted in `progress.txt` (`evidence`).
- **Increment, never one-shot.** Commit each feature. On a broken state, `git reset` to the last
  green commit — do not patch on top of decay.
- **Closed schemas are the security boundary.** Any code that ingests host messages MUST validate
  against `SPEC/schemas/` and reject unknown `type`/`kind`/fields.
- **Never weaken the security invariants** in `SPEC/abp-v1.md` §0.2 / §6 to make a test pass.

## End of session

1. Run the feature's tests; record output.
2. Update `feature_list.json` (status + evidence) and `progress.txt` (newest entry on top).
3. Commit with a message naming the feature id (e.g. `feat(F1.1): schema validator`).

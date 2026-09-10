# M2 implementation evidence

KRA-1487 completes design v0.2 §10.3 without enrolling repositories or changing the old belt.
After this change, an attested interactive seat can write a Review, and the broker operator can
inspect the process through the six review spans once the project credential is placed.

| M2 item | Rule and implementation | Evidence |
|---|---|---|
| Stalls | D6: `housekeepStalls` remains an `ObservePR` consequence, preserving A4. The broker's existing five-second tick now owns inbox drain, the five-minute reconciliation sweep, and publication. | Acceptance `§11.M2 periodic stalls`; reducer D6 tests |
| Availability/reassignment | D3/D4: the existing condition, clearing rules, cancellation and `supersedes` preserve obligations. D2 keeps first-round Codex/later-seat routing. | Existing §11.10; M2 periodic sequence |
| Exhaustion | G3/G4/D10: one episode, hold, gate, author delivery and retrospective; grants close the episode. | Existing §11.6; M2 retrospective sequence |
| Retrospective | G5: optional request, independently retried; a testimony names its deliverable and charges no round. | M2 retrospective sequence |
| Session custody | §3.2: registration issues a random token for one live, attested actor/session. Edge resolves it; broker checks the actor's edge enrollment and records session custody. | Registry, edge control and broker HTTP tests |
| Operator CLI | §2.1/§9.1: argument parsers and mandatory options derive from vendored property schemas. Full actions still pass Ajv. `reset-store` retains its explicit local database confirmation and operator verification. | CLI contract/refusal tests, existing reset-store tests |
| Spans | §8.3: ingress, reconciliation, admission, publication, housekeeping, outbox; service `review`. Only explicitly selected process attributes are recorded. | M2 composed-span acceptance; no network exporter without the token |

## Session custody decision

The registry's `LiveIngressRegistration` already carries `actor`, `provider`, `sessionId`, and
`runtimeAttestation`. `register` retains the session's first attestation; disagreement becomes
`attestation_ambiguous`. These fields support an actor binding on both single-seat pop-os and
shared cx53: the rule is about the registered session, not the host name.

Custody is admitted only if **exactly one live registration** names the session, its retained
attestation is known, and its attested actor matches the registered actor. Otherwise the edge
reports `session_not_registered`, `session_actor_ambiguous`, or `session_attestation_unproven`.
No token is issued on a deferred binding. Expiry, deregistration, session replacement and
ambiguity revoke old tokens; removing ambiguity never revives a revoked token.

The operator of a live session runs:

```sh
hive review session <session-id> --token-file <new-private-file>
export HIVE_SESSION_TOKEN_FILE=<new-private-file>
```

The CLI never prints the token and refuses overwriting a file. Review writes resolve it afresh
at the edge. Operator commands reject delivery/session variables and `HIVE_ACTOR`. The same-user
custody caveat in §3.2 remains the trust boundary; the raw CLI request cannot name an actor.

This is implementation and test evidence for both topologies, not a claim that the new build has
been deployed to either host. No live registration or service was changed during this task.

## Logfire placement gate

Hákon places `HIVE_REVIEW_LOGFIRE_TOKEN`, using a write token for the existing **sokrates** project,
in the broker environment. Set `HIVE_REVIEW_LOGFIRE_REGION=us` or `eu` to that project's region.
The repository's deployment example specifies **`/etc/hive/broker.env`**, mode 0600 on the dev box.
The attempted metadata-only SSH read was refused, so the live unit's EnvironmentFile is not
independently verified. No secret was read or placed, and no service was deployed or restarted.

Until placement, the provider has no exporter; spans and their attributes are proven with an
in-memory exporter. With the credential and region set, a bounded batch exporter uses the
[documented OTLP HTTP/protobuf endpoint and Authorization header](https://pydantic.dev/docs/logfire/guides/alternative-clients/),
with `service.name=review`. A token without its region refuses boot. Credentials, report bodies
and arbitrary exception text are not span attributes. Dashboards and live-export proof remain
outside this code change.

## Verification

`bun run check` is the repository gate: import boundary, contract regeneration/drift, TypeScript
build and Node tests. Direct `bun test` is not its runner: Bun refuses `better-sqlite3` with
`ERR_DLOPEN_FAILED`. The design's invocation is corrected; its original acceptance sequences
remain intact. A stale, ignored `dist/health` test from a prior branch was preserved outside the
checkout before running a clean build.

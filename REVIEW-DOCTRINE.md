# Review doctrine — the belt's prompt card

Render of weave-doctrine's `REVIEW-DOCTRINE.md` (canonical; KRA-1198) — the estate-wide half.
A render that disagrees with the canonical file is drift, not a local ruling. The card's §A
(deployment-context) is sokrates-specific and is not rendered here; there is no deployment layer
in this repo for a finding to be answered against.

Scar slugs below name entries in weave-doctrine's talos-burn scar corpus
(`skills/talos-burn/scars/`).

## §B Find dimensions

1. **A redactor must over-consume — never mirror the upstream parser.** A sanitizer, redactor,
   or scrubber's input is untrusted failure-path text, and the malformed input is precisely the
   input that generated the message being redacted. Under-consumption leaks; over-consumption
   only costs operator context. Prescribe `max` over every plausible reading, with the unbounded
   reading suppressed. Prescribing "match the upstream grammar" authors the next round's
   finding. (`scar-boundary-needs-a-derivation`)
2. **Observation over prediction.** A check that predicts a syntax, a language runtime, or a
   config instead of *reading* the artifact passes on a lucky guess and fails silently on the
   next shape. Read the artifact — `model_fields`, the parsed config, the resolved head — and do
   not encode what you expect it to say. (`scar-config-predicting-gate`)
3. **Read the artifact, not the event.** A handler asserting a claim about an external system
   from a *delivered* event — webhook, queue message, callback — cannot be closed
   finding-by-finding: how one delivery differs from current state is a property of the
   transport, not of the payload schema. Level-trigger it and reconcile against trusted state.
   (`scar-rederive-state-not-event`)
4. **Never claim a test survived, or a defect survives, without grepping the live head.** A tree
   grep answers "is this referenced in the code" — a different question from "was this fixed".
   Search commit messages too (`git log --grep`), and re-run the check at the PR's live head; a
   result from an earlier head testifies to nothing about this one.
   (`scar-re-resolve-the-head-on-every-wake`, `scar-date-the-finding-against-main`)
5. **Digest by review id, never by count.** One head can carry two find-half verdicts. Key every
   disposition to the verdict it came from — the Codex review id, or the
   `weave-review-loop:substitute-verdict:<sha>:<actor>` marker — and say which verdict you
   dispositioned. A disposition list keyed to a number dispositions only one of them.
   (`scar-two-verdicts-one-head`)
6. **Gates are composed, not eyeballed.** Merge-ready is a conjunction at **one SHA**: exact-head
   CLEAN ∧ green required checks ∧ no conflicts ∧ merge authority. No limb carries across a head
   change, and a historical verdict never closes a repaired head. Say which gates ran.
   (`scar-a-reviewed-head-is-not-a-repair`)

## §C Noise dimensions

A finding matching one of these is **noise**: burned by citing the entry, not by changing code.

1. **Internal-tool security theater.** This repo is Weave-internal tooling: single-operator,
   every actor on every host a trusted Weave agent. Run the adversary check before filing any
   credential, exposure, or hardening finding — *who attacks this, today?* If the honest answer
   is "nobody — all actors are us", the finding is noise (Hákon's standing ruling, 2026-08-16).
   The carve-out is for Weave-internal repos only; the sokrates customer boundaries keep their
   real posture. **Reliability findings are always real** and stay in scope: a crash, a wrong
   result, a swallowed error, a race, data loss, staleness, misattribution — defects with a
   *failure* mode, not a *threat* model.
2. **Cleverness escalation.** The expected shape of a review is one round, one burn, merge. A
   reviewer faulting its *own* prior prescription, or escalating a settled call into a more
   elaborate design, is residue — not a round. Rounds are a scarce budget.
3. **Spelling-variant re-findings after a class is exhausted.** Re-filing a lexical variant of a
   closed class — a different name for the same predicate, the same defect at a renamed path —
   is noise. Recurrence is a property of the class, not of the path.
   (`scar-path-equality-is-not-recurrence`)
4. **Prescriptions of prescriptions.** A finding whose subject is the *wording* of a previous
   finding's cure, with no behavioural difference at the code, is noise.

## §D How a card noise finding is answered

One PR comment naming the entry is the whole burn:

> **Noise — §C.1 (internal-tool security theater).** This runs on Weave seats with our own bus
> credential; there is no adversary to defend against here. Reliability findings on this file
> remain in scope.

The citation **counts as the burn for that finding** — no code change is owed. Two obligations
still hold: the finding goes on the burn note's `Noise:` line, and a burn ending with HEAD
unchanged must persist the per-head noise marker on the PR
(`<!-- weave-review-loop:noise:<BURN_HEAD> -->`) or the redelivery scanner reads it as an
ignored wake. If a citation is wrong the next round says so — that is the appeal path.
Burn-twin procedure: weave-doctrine's talos-burn skill, §3.

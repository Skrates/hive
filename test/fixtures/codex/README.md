# Codex producer fixtures (design V-6)

Raw GitHub API JSON authored by `chatgpt-codex-connector[bot]` (user id 199175422), captured
read-only with the authenticated `gh api` CLI on 2026-09-06 from the adopters
(RationallyPrime/weave-doctrine, Skrates/hive, Skrates/sokrates, RationallyPrime/krepis,
RationallyPrime/morphe, RationallyPrime/agent-affordances, RationallyPrime/ai-usage,
RationallyPrime/timaeus-deploy). Nothing is stripped or edited. File names are
`<repo>-<kind>-<id>.json`; `review_comment` files come from `GET /repos/{r}/pulls/comments/{id}`
(the shape `listReviewComments` reads: `line`, `original_line`, `original_commit_id`), reviews
from `GET /repos/{r}/pulls/{n}/reviews/{id}`, issue comments from
`GET /repos/{r}/issues/comments/{id}`.

`src/review/github/classify.test.ts` runs every source-record fixture against an explicit
expected table. Classes present in the wild and captured here:

| class | fixtures |
|---|---|
| findings (review envelope + member comments) | `*-review-*` with their `*-review_comment-*` |
| findings (inline in an issue comment) | `sokrates-issue_comment-5420521329` |
| findings (task channel `## Review Finding`) | `sokrates-issue_comment-5379989497`, `-5379280751` |
| clean (connector comment) | `hive-…-5560110170`, `sokrates-…-5560774852`, `krepis-…-5560216381`, `agent-affordances-…-5560777705` |
| clean (task channel `## Review verdict`) | `sokrates-issue_comment-5414537249`, `-5413853994` |
| status (connector progress board, edited in place) | `hive-issue_comment-5560706393` (Completed), `sokrates-issue_comment-5545090773` (Failed) |
| quota_refusal (both wordings) | `sokrates-issue_comment-5350649768`, `-5323219049` |
| connector_error (unconnected repo; transient failure) | `sokrates-issue_comment-5301377491`, `-5270304839` |
| unknown (task work reports) | `sokrates-issue_comment-5550157393`, `-5411578823`, `weave-doctrine-issue_comment-5553359131` |

Not a source record: `sokrates-reaction-411796000.json` is the connector's acknowledgement on
the summons comment `Skrates/sokrates` issue comment 5560806999 — a `eyes` (👀) reaction while
the review runs, removed when it finishes. No 👍 reaction or comment was found on any summons
after a clean result; the clean result is the comment above. No `incomplete` shape exists in
the wild; none is invented. Only one `Running` board state was seen during the sweep and it
was edited to `Completed` before capture (the in-place edit is why `version = updated_at`).

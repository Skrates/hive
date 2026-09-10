/**
 * The one Codex classification (design §7 "Codex classification"), fixture-driven.
 *
 * Every Codex-authored GitHub record the reconciler imports passes through
 * `classifyCodexRecord` exactly once per version. The predicates started from the current
 * helper (`weave_reviewkit/verdicts.py`, `review_loop.py::codex_comment_kind`) and were then
 * corrected against captured producer output (V-6, `test/fixtures/codex/`), which is the
 * evidence; `classify.test.ts` runs every fixture against an explicit expected table.
 *
 * What the wild showed (2026-09-06, eight adopters):
 * - a findings round is a `review` (state `COMMENTED`, body `### 💡 Codex Review …
 *   **Reviewed commit:** \`<10 hex>\``) whose findings are its member `review_comment`s,
 *   each titled `**<sub><sub>![P2 Badge](…)</sub></sub>  Title**`; `original_commit_id` is
 *   the reviewed head (GitHub repositions `commit_id` onto the live head);
 * - a clean round is an `issue_comment` `Codex Review: Didn't find any major issues. <flourish>`
 *   with the same footer; there is no 👍 comment — the connector reacts 👀 while running and
 *   removes it when done, and a reaction is not a source record;
 * - the current connector also completes a clean run via its summary plus a PR 👍;
 *   only a completed summary at the current head, a Codex-authored approval reaction,
 *   and no contradicting review at that head admit clean. Either signal alone is status;
 * - `You have reached your Codex usage limits[ for code reviews].` is the quota refusal;
 *   `To use Codex here, …` (unconnected repo) and `Codex Review: Something went wrong. …`
 *   (transient) are connector errors — availability signals, never verdicts (§6.D3);
 * - the task channel writes `## Review verdict` (clean at an exact 40-hex head) and
 *   `## Review Finding **[P2] Title.**` bodies anchored by own-repo permalinks, and
 *   `### Summary` / `### Outcome` work reports that are never verdicts;
 * - no `incomplete` shape exists in the wild; none is invented (§7: unknown is reported, not
 *   promoted).
 *
 * §2.3: no fingerprint, falsifier or evidence is invented for Codex; provenance is the
 * comment. §6.F5: a badge-less finding is priority `unknown` — admitted, visible, blocking.
 */
import type { ExternalFinding, ExternalResult, FindingPriority } from "../contract.js";
import { CODEX_LOGINS } from "../reducer.js";
import type { GitHubReaction, GitHubRecord } from "./port.js";


export type CodexClassification =
  | "clean"
  | "findings"
  | "incomplete"
  | "quota_refusal"
  | "connector_error"
  | "status"
  | "unknown";

export interface ClassifyContext {
  /** The Review's current head; the head a verdict is measured against. */
  headSha: string;
  /**
   * Every head the Review has seen, current first. The connector's `**Reviewed commit:**`
   * footer is a short commit-ish; it binds only when exactly one known head extends it
   * (`verdicts.py::clean_verdict_commitish` — the caller expands against the heads the PR's
   * own history establishes, and fails closed otherwise).
   */
  heads: string[];
  /** `owner/repo`; only own-repository permalinks are evidence about this PR. */
  repository: string;
  /** For a `review` record: its member `review_comment`s (raw `pull_request_review_id` = id). */
  members: GitHubRecord[];
  reviews: GitHubRecord[];
  reviewComments: GitHubRecord[];
  prReactions: GitHubReaction[];
}

export interface ClassifiedRecord {
  classification: CodexClassification;
  /** Present for `clean` and `findings` (and would be for `incomplete`). */
  external?: ExternalResult;
  /** Present for `quota_refusal` and `connector_error` (§6.D3); `until` is the reconciler's to fill from the meter. */
  availability?: { available: false; reason: "quota" | "connector"; until: string | null; evidence: string };
  /** Why — recorded on the source record and shown on the board for `unknown`. */
  detail: string;
}

const SHA40 = /^[0-9a-f]{40}$/;
const CLEAN_COMMENT_PREFIX = "Codex Review: Didn't find any major issues.";
const FINDINGS_REVIEW_HEADING = "### 💡 Codex Review";
const SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";
const QUOTA_REFUSAL_PREFIX = "You have reached your Codex usage limits";
const CONNECTOR_UNCONNECTED_PREFIX = "To use Codex here";
const CONNECTOR_FAILED_PREFIX = "Codex Review: Something went wrong";
const TASK_FINDING_HEADING = /^##[ \t]+Review[ \t]+Finding\b/i;
const VERDICT_HEADING = /^##[ \t]+Review[ \t]+(?:Result|verdict)\b/i;
const RESULT_CLEAN_PHRASE = "no blocking findings";
const TERSE_CLEAN_PHRASE = "no findings";
const EXACT_HEAD_CLEAN = /^no major issues found at exact head `?([0-9a-f]{40})`?$/;
const REVIEWED_COMMIT_FOOTER = /\*\*Reviewed commit:\*\*\s*`([0-9a-fA-F]{7,40})`/;
const PERMALINK = /https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/(?:blob|blame)\/([0-9a-fA-F]{40})\/([^\s#)\]]+)(?:#L(\d+)(?:-L\d+)?)?/g;
const SEVERITY_BADGE = /\bP([0-3])-[A-Za-z]+\b/;
const SEVERITY_BRACKET = /\[P([0-3])\]/;
const USEFUL_FOOTER = /\n*Useful\? React with 👍\s*\/\s*👎\.?\s*$/u;
const SENTENCE_END = /(?<!\.)\.(?!\.)|!/;

// ---------------------------------------------------------------------------------------
// Verdict prose (ported from weave_reviewkit/verdicts.py; the fixtures re-prove each case)
// ---------------------------------------------------------------------------------------

function openingSentence(statement: string): string {
  const normalized = statement.replaceAll("…", "...");
  const match = SENTENCE_END.exec(normalized);
  return match === null ? normalized : normalized.slice(0, match.index + match[0].length);
}

function assertedSentence(statement: string): string {
  const opening = openingSentence(statement);
  const hasStop = SENTENCE_END.test(opening);
  let asserted = opening;
  for (;;) {
    let next = asserted.replace(/[*_ ]+$/u, "").trim();
    if (hasStop && !next.endsWith("...")) next = next.replace(/[.! ]+$/u, "").trim();
    if (next === asserted) return asserted;
    asserted = next;
  }
}

/** The first sentence on a line of its own beneath a verdict heading; null without a heading. */
function verdictStatement(body: string): string | null {
  const heading = VERDICT_HEADING.exec(body);
  if (heading === null) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const newline = rest.indexOf("\n");
  const remainder = newline === -1 ? "" : rest.slice(newline + 1);
  for (const line of remainder.split("\n")) {
    const statement = line.trim().replace(/^[*_\->#]+/u, "").trim().toLowerCase();
    if (statement !== "") return statement;
  }
  return "";
}

function taskVerdictIsClean(body: string): boolean {
  const statement = verdictStatement(body);
  if (statement === null || statement === "") return false;
  const asserted = assertedSentence(statement);
  return asserted === RESULT_CLEAN_PHRASE || asserted === TERSE_CLEAN_PHRASE || EXACT_HEAD_CLEAN.test(asserted);
}

function taskVerdictCleanHead(body: string): string | null {
  const statement = verdictStatement(body);
  if (statement === null || statement === "") return null;
  const match = EXACT_HEAD_CLEAN.exec(assertedSentence(statement));
  return match === null ? null : (match[1] ?? null);
}

// ---------------------------------------------------------------------------------------
// Heads and anchors
// ---------------------------------------------------------------------------------------

interface Permalink { sha: string; path: string; line: number | null }

function ownPermalinks(body: string, repository: string): Permalink[] {
  const out: Permalink[] = [];
  for (const match of body.matchAll(PERMALINK)) {
    if ((match[1] ?? "").toLowerCase() !== repository.toLowerCase()) continue;
    const line = match[4] === undefined ? null : Number.parseInt(match[4], 10);
    out.push({ sha: (match[2] ?? "").toLowerCase(), path: match[3] ?? "", line });
  }
  return out;
}

/** The one tree every own-repo permalink pins; two trees or none is no head claim. */
function permalinkHead(body: string, repository: string): string | null {
  const shas = new Set(ownPermalinks(body, repository).map((p) => p.sha));
  return shas.size === 1 ? [...shas][0] ?? null : null;
}

function reviewedCommitFooter(body: string): string | null {
  const match = REVIEWED_COMMIT_FOOTER.exec(body);
  return match === null ? null : (match[1] ?? "").toLowerCase();
}

/**
 * A full SHA is its own claim. A short commit-ish binds only when exactly one known head
 * extends it — the reducer judges whether that head is the current subject (§6.C, §11 #8).
 */
function expandHead(commitish: string | null, heads: string[]): string | null {
  if (commitish === null) return null;
  if (SHA40.test(commitish)) return commitish;
  const matches = heads.filter((head) => head.startsWith(commitish));
  return matches.length === 1 ? matches[0] ?? null : null;
}

// ---------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------

/** §6.F5: the badge level is the contract; the colour is rendering. No badge ⇒ `unknown`. */
export function findingPriority(text: string): FindingPriority {
  const badge = SEVERITY_BADGE.exec(text) ?? SEVERITY_BRACKET.exec(text);
  if (badge === null) return "unknown";
  return `P${badge[1] ?? "3"}` as FindingPriority;
}

/**
 * The connector wraps its badge in *nested* `<sub>` tags: `**<sub><sub>![P1 …](…)</sub></sub>
 * Title**`. A non-greedy `<sub>.*?</sub>` matches the inner pair and leaves the outer `</sub>`
 * on the front of every title it produced. Strip the image first, then every `<sub>`/`</sub>`
 * tag on its own — nesting depth then stops mattering.
 */
function stripTitleMarkup(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/<\/?sub>/gu, "")
    .replace(/\[P[0-3]\]/u, "")
    .replace(/^\*+|\*+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** `**<sub><sub>![P2 Badge](…)</sub></sub>  Title**` (connector) or `**[P2] Title.**` (task). */
function splitFinding(text: string): { title: string; body: string } | null {
  const lines = text.trim().split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return null;
  const titleLine = lines[first] ?? "";
  if (!titleLine.trim().startsWith("**")) return null;
  const title = stripTitleMarkup(titleLine);
  if (title === "") return null;
  const body = lines.slice(first + 1).join("\n").replace(USEFUL_FOOTER, "").trim();
  return { title, body };
}

/**
 * A finding read out of a whole record: the record is the container and the record's body is
 * one block, so the locator is `0`. Used for a member `review_comment` of a findings envelope,
 * a standalone `review_comment`, and a task-channel `## Review Finding` issue comment.
 */
function memberFinding(member: GitHubRecord): ExternalFinding | null {
  // §3.5: a `review` envelope is never itself a finding container — its member comments are.
  if (member.kind === "review") return null;
  const split = splitFinding(member.body);
  if (split === null) return null;
  return {
    container_kind: member.kind,
    container_id: member.id,
    locator: 0,
    path: member.path ?? "",
    line: member.line,
    priority: findingPriority(member.body),
    title: split.title,
    body: split.body,
  };
}

/**
 * Inline findings in an issue comment: blocks separated by `---`, each `permalink\n**title**\nbody`.
 *
 * One comment, many findings (the wild's `sokrates#5420521329` carries five), so the comment id
 * is the *container* and each finding's locator is its zero-based block ordinal in the split —
 * counted over every block including the unreadable ones, so a locator depends only on the
 * comment body at this version and is reproduced by any re-read of it. An issue comment has no
 * GitHub review thread; §8.1 reads `container_kind` to know that.
 */
function inlineFindings(body: string, repository: string, commentId: number): ExternalFinding[] {
  const afterHeading = body.slice(body.indexOf(FINDINGS_REVIEW_HEADING) + FINDINGS_REVIEW_HEADING.length);
  const withoutDetails = afterHeading.replace(/<details>[\s\S]*$/u, "");
  const findings: ExternalFinding[] = [];
  const blocks = withoutDetails.split(/\n---\n/u);
  for (const [locator, block] of blocks.entries()) {
    const anchor = ownPermalinks(block, repository)[0];
    const rest = block.replace(PERMALINK, "").trim();
    const split = splitFinding(rest);
    if (split === null) continue;
    findings.push({
      container_kind: "issue_comment",
      container_id: commentId,
      locator,
      path: anchor?.path ?? "",
      line: anchor?.line ?? null,
      priority: findingPriority(rest),
      title: split.title,
      body: split.body,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------------------

function result(record: GitHubRecord, verdict: ExternalResult["verdict"], head: string, findings: ExternalFinding[]): ExternalResult {
  const common = {
    schema_version: "1" as const,
    source: "codex" as const,
    reviewed_head: head,
    source_record: { kind: record.kind, id: record.id, version: record.version },
    submitted_at: record.version,
  };
  if (verdict === "clean") return { ...common, verdict, findings: [] };
  if (verdict === "incomplete") return { ...common, verdict, findings };
  const [first, ...rest] = findings;
  if (first === undefined) throw new Error("a findings verdict requires at least one finding");
  return { ...common, verdict, findings: [first, ...rest] };
}

function unknown(detail: string): ClassifiedRecord {
  return { classification: "unknown", detail };
}

function firstLine(body: string): string {
  return body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * One record ⇒ one classification. `clean` / `findings` carry the `ExternalResult` the
 * reconciler admits (§2.3); `quota_refusal` / `connector_error` carry the availability
 * condition (§6.D3); `status` and `unknown` carry only `detail` and are never promoted (§7).
 */
export function classifyCodexRecord(record: GitHubRecord, context: ClassifyContext): ClassifiedRecord {
  const body = record.body.trimStart();
  const evidence = firstLine(body);

  if (body.startsWith(CONNECTOR_UNCONNECTED_PREFIX) || body.startsWith(CONNECTOR_FAILED_PREFIX)) {
    return { classification: "connector_error", availability: { available: false, reason: "connector", until: null, evidence }, detail: evidence };
  }
  if (body.startsWith(QUOTA_REFUSAL_PREFIX)) {
    return { classification: "quota_refusal", availability: { available: false, reason: "quota", until: null, evidence }, detail: evidence };
  }
  if (body.startsWith(SUMMARY_MARKER)) {
    const rows = body.split("\n").filter(line => /^\|[^|]*\*\*Code Review\*\*[^|]*\|/u.test(line));
    const cells = rows.length === 1 ? rows[0]!.split("|") : [];
    const commitish = /^\s*`([0-9a-f]{7,40})`\s*$/u.exec(cells[3] ?? "")?.[1] ?? null;
    const head = expandHead(commitish, context.heads);
    const completed = (cells[2] ?? "").includes("✅ **Completed**");
    const approval = context.prReactions.find(r => r.content === "+1" && CODEX_LOGINS.has(r.authorLogin));
    const reviewAtHead = context.reviews.some(r => CODEX_LOGINS.has(r.authorLogin) && r.commitId === head);
    const inline = context.reviewComments.filter(r => CODEX_LOGINS.has(r.authorLogin) && r.commitId === head);
    const contradicted = reviewAtHead || inline.length > 0;
    // A reaction carries no head. The completed summary binds it to the current subject;
    // any review at that head is admitted through its own envelope, never overwritten here.
    if (record.kind === "issue_comment" && CODEX_LOGINS.has(record.authorLogin) && completed && head === context.headSha && approval !== undefined && !contradicted) {
      return { classification: "clean", external: result(record, "clean", head, []), detail: `completed summary at ${head} with Codex PR approval reaction ${approval.id}` };
    }
    const state = /\|\s*📝[^|]*\|\s*([^|]+?)\s*\|/u.exec(body)?.[1]?.replace(/<relative-time[^>]*>.*?<\/relative-time>/gu, "").trim() ?? "";
    return { classification: "status", detail: `connector progress board: ${state || "no row"}` };
  }

  switch (record.kind) {
    case "review":
      return classifyReview(record, body, context);
    case "review_comment":
      return classifyReviewComment(record);
    case "issue_comment":
      return classifyIssueComment(record, body, context);
  }
}

function classifyReview(record: GitHubRecord, body: string, context: ClassifyContext): ClassifiedRecord {
  if (!body.startsWith(FINDINGS_REVIEW_HEADING)) return unknown(`review body is not a Codex review envelope: ${firstLine(body)}`);
  const head = record.commitId !== null && SHA40.test(record.commitId) ? record.commitId : expandHead(reviewedCommitFooter(body), context.heads);
  if (head === null) return unknown("findings envelope names no known head");
  const footer = reviewedCommitFooter(body);
  if (footer !== null && !head.startsWith(footer)) return unknown(`envelope footer ${footer} disagrees with review commit ${head}`);
  const findings: ExternalFinding[] = [];
  for (const member of context.members) {
    const finding = memberFinding(member);
    if (finding !== null) findings.push(finding);
  }
  if (findings.length === 0) return unknown("findings envelope with no readable member comments");
  return { classification: "findings", external: result(record, "findings", head, findings), detail: `${findings.length} finding(s) at ${head}` };
}

function classifyReviewComment(record: GitHubRecord): ClassifiedRecord {
  const raw = record.raw as { in_reply_to_id?: unknown } | null;
  if (raw !== null && typeof raw === "object" && raw.in_reply_to_id !== undefined && raw.in_reply_to_id !== null) {
    return unknown("reply in a review thread, not a finding");
  }
  const finding = memberFinding(record);
  if (finding === null) return unknown(`review comment has no finding title: ${firstLine(record.body)}`);
  if (record.commitId === null || !SHA40.test(record.commitId)) return unknown("review comment names no reviewed head");
  return { classification: "findings", external: result(record, "findings", record.commitId, [finding]), detail: `1 finding at ${record.commitId}` };
}

function classifyIssueComment(record: GitHubRecord, body: string, context: ClassifyContext): ClassifiedRecord {
  if (body.startsWith(CLEAN_COMMENT_PREFIX)) {
    const footer = reviewedCommitFooter(body);
    const head = expandHead(footer, context.heads);
    if (head === null) return unknown(`clean comment binds no known head (footer ${footer ?? "absent"})`);
    return { classification: "clean", external: result(record, "clean", head, []), detail: `clean at ${head}` };
  }
  if (body.startsWith(FINDINGS_REVIEW_HEADING)) {
    const findings = inlineFindings(body, context.repository, record.id);
    if (findings.length === 0) return unknown("inline findings comment with no readable finding");
    const head = permalinkHead(body, context.repository) ?? expandHead(reviewedCommitFooter(body), context.heads);
    if (head === null) return unknown("inline findings comment names no single head");
    return { classification: "findings", external: result(record, "findings", head, findings), detail: `${findings.length} inline finding(s) at ${head}` };
  }
  if (VERDICT_HEADING.test(body)) {
    if (!taskVerdictIsClean(body)) return unknown("task verdict is not affirmatively clean; prose findings are not itemizable");
    const head = taskVerdictCleanHead(body) ?? expandHead(reviewedCommitFooter(body), context.heads) ?? permalinkHead(body, context.repository);
    if (head === null) return unknown("clean task verdict establishes no head");
    return { classification: "clean", external: result(record, "clean", head, []), detail: `task verdict clean at ${head}` };
  }
  if (TASK_FINDING_HEADING.test(body)) {
    const rest = body.replace(TASK_FINDING_HEADING, "").trim();
    const split = splitFinding(rest);
    const anchor = ownPermalinks(body, context.repository)[0];
    const head = permalinkHead(body, context.repository);
    if (split === null) return unknown("task finding without a title line");
    if (head === null) return unknown("task finding pins no single head");
    const finding: ExternalFinding = {
      container_kind: "issue_comment",
      container_id: record.id,
      locator: 0,
      path: anchor?.path ?? "",
      line: anchor?.line ?? null,
      priority: findingPriority(rest),
      title: split.title,
      body: split.body.replace(/\n## Checks[\s\S]*$/u, "").trim(),
    };
    return { classification: "findings", external: result(record, "findings", head, [finding]), detail: `task finding at ${head}` };
  }
  return unknown(`unrecognised Codex comment: ${firstLine(body).slice(0, 80)}`);
}

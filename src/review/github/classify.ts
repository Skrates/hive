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
 * - `<!-- codex-pull-request-review-summary -->` is the connector's own progress board,
 *   edited in place (Running → Completed / Failed): recognised, verdict-less, `status`;
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
import type { GitHubRecord } from "./port.js";

/** The connector's bot login (verified: `gh api users/chatgpt-codex-connector[bot]`, id 199175422). */
export const CODEX_LOGINS: ReadonlySet<string> = new Set(["chatgpt-codex-connector[bot]"]);

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

function stripTitleMarkup(line: string): string {
  return line
    .replace(/<sub>.*?<\/sub>/gsu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
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

function memberFinding(member: GitHubRecord): ExternalFinding | null {
  const split = splitFinding(member.body);
  if (split === null) return null;
  return {
    source_comment_id: member.id,
    path: member.path ?? "",
    line: member.line,
    priority: findingPriority(member.body),
    title: split.title,
    body: split.body,
  };
}

/** Inline findings in an issue comment: blocks separated by `---`, each `permalink\n**title**\nbody`. */
function inlineFindings(body: string, repository: string, commentId: number): ExternalFinding[] {
  const afterHeading = body.slice(body.indexOf(FINDINGS_REVIEW_HEADING) + FINDINGS_REVIEW_HEADING.length);
  const withoutDetails = afterHeading.replace(/<details>[\s\S]*$/u, "");
  const findings: ExternalFinding[] = [];
  for (const block of withoutDetails.split(/\n---\n/u)) {
    const anchor = ownPermalinks(block, repository)[0];
    const rest = block.replace(PERMALINK, "").trim();
    const split = splitFinding(rest);
    if (split === null) continue;
    findings.push({
      source_comment_id: commentId,
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
  return {
    schema_version: "1",
    source: "codex",
    reviewed_head: head,
    verdict,
    findings,
    source_record: { kind: record.kind, id: record.id, version: record.version },
    submitted_at: record.version,
  };
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
      source_comment_id: record.id,
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

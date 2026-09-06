/**
 * Projections of a `ReviewState` (design §8.1). Pure: every function here is a total
 * function of its arguments — no clock, no store, no port — so a refresh job can call it on
 * whatever `read()` returns *now* and never carries a verdict of its own.
 */
import type {
  AdmittedFinding,
  Hold,
  Principal,
  Reason,
  Request,
  Resolution,
  Review,
  ReviewState,
  Unavailable,
} from "./contract.js";
import type { UnknownSourceRecord } from "./store.js";

export const CHECK_RUN_NAME = "weave/review";

export interface CheckRunRender {
  name: typeof CHECK_RUN_NAME;
  conclusion: "success" | "failure";
  title: string;
  summary: string;
}

// ---------------------------------------------------------------------------------------
// Reasons, in §8.1 precedence

/**
 * §8.1: "merged > closed > hold > exhausted > required request pending > requirement
 * unsatisfied > blocking findings > draft". `incomplete_answer` is in the contract's Reason
 * union but not in the design's precedence list; it ranks last so every listed reason wins
 * over it.
 */
const PRECEDENCE: ReadonlyArray<(reason: Reason) => boolean> = [
  (r) => r === "merged",
  (r) => r === "closed",
  (r) => typeof r === "object" && "hold" in r,
  (r) => r === "exhausted",
  (r) => typeof r === "object" && "required_request_pending" in r,
  (r) => typeof r === "object" && "requirement_unsatisfied" in r,
  (r) => typeof r === "object" && "blocking_findings" in r,
  (r) => r === "draft",
  (r) => r === "incomplete_answer",
];

/** The first reason in §8.1 precedence, regardless of the order `read()` listed them in. */
export function firstReason(reasons: readonly Reason[]): Reason | null {
  for (const matches of PRECEDENCE) {
    const hit = reasons.find(matches);
    if (hit !== undefined) return hit;
  }
  return reasons[0] ?? null;
}

/** One human phrase per reason; used by the check title and the Slack line. */
export function describeReason(reason: Reason): string {
  if (typeof reason === "string") {
    switch (reason) {
      case "merged": return "merged";
      case "closed": return "closed";
      case "draft": return "draft";
      case "exhausted": return "review rounds exhausted";
      case "incomplete_answer": return "incomplete answer";
    }
  }
  if ("hold" in reason) return `hold: ${reason.hold}`;
  if ("required_request_pending" in reason) {
    return `required request pending: ${reason.required_request_pending.join(", ")}`;
  }
  if ("requirement_unsatisfied" in reason) {
    return `requirement unsatisfied at ${reason.requirement_unsatisfied.join(", ")}`;
  }
  return `blocking findings: ${reason.blocking_findings.join(", ")}`;
}

// ---------------------------------------------------------------------------------------
// Small formatters shared by the projections

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Who a principal is, for humans. Never leaks custody tokens or ids beyond the actor. */
export function describePrincipal(principal: Principal): string {
  switch (principal.kind) {
    case "seat": return principal.actor;
    case "operator": return `operator ${principal.id}`;
    case "adapter": return `${principal.source} (${principal.event_login})`;
    case "system": return "system";
  }
}

/**
 * §8.1: a resolution with its evidence. A `fixed` claim nobody has confirmed reads
 * "fixed, claimed by <actor> @ <sha>, unconfirmed" — the board never dresses a claim as a
 * confirmation (§6.F).
 */
export function describeResolution(resolution: Resolution): string {
  const by = describePrincipal(resolution.by);
  switch (resolution.kind) {
    case "fixed": {
      const at = resolution.commits.map(shortSha).join(", ");
      const confirmation = resolution.confirmed_by === null
        ? "unconfirmed"
        : `confirmed by ${resolution.confirmed_by}`;
      return `fixed, claimed by ${by} @ ${at}, ${confirmation}`;
    }
    case "refuted": return `refuted by ${by}: ${resolution.evidence}`;
    case "withdrawn": return `withdrawn by ${by}: ${resolution.evidence}`;
    case "product_gate": return `product gate by ${by}: ${resolution.evidence}`;
    case "follow_up": return `follow-up ${resolution.ticket ?? "(no ticket)"} by ${by}: ${resolution.evidence}`;
    case "owner_decision": return `owner decision by ${by}: ${resolution.resolution_text ?? resolution.evidence}`;
  }
}

function findingLocation(finding: AdmittedFinding): string {
  return finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
}

function findingLine(finding: AdmittedFinding): string {
  const source = "comment_id" in finding.source ? ` (comment ${finding.source.comment_id})` : "";
  const links = finding.links.length === 0
    ? ""
    : ` — same as ${finding.links.map((link) => link.other).join(", ")}`;
  return `\`${finding.id}\` **${finding.priority}** ${finding.title} — ${findingLocation(finding)} — raised by ${finding.raised_by}${source}${links}`;
}

function findingStatusLine(finding: AdmittedFinding): string {
  const status = finding.status;
  if (status.open && "contested" in status) {
    return `contested by ${status.contested.by} at ${status.contested.at}; prior claim: ${describeResolution(status.contested.prior)}`;
  }
  if (!status.open) return describeResolution(status.resolution);
  return "open";
}

function requestLine(request: Request): string {
  const mode = request.mode === null ? request.kind : `${request.kind}/${request.mode}`;
  const required = request.required ? "required" : "advisory";
  const transport = request.transport.length === 0
    ? "no transport yet"
    : request.transport
      .map((ref) => ("delivery_id" in ref ? `delivery ${ref.delivery_id}` : `summon comment ${ref.summon_comment_id} by ${ref.summon_login}`))
      .join(", ");
  const names = request.names.length === 0 ? "" : ` naming ${request.names.join(", ")}`;
  const supersedes = request.supersedes === null ? "" : ` (supersedes ${request.supersedes})`;
  // §D6: how many times housekeeping re-transported, and the last time it did.
  const stalls = request.retransports.length === 0
    ? ""
    : `; re-transported ${request.retransports.length}× (last ${request.retransports[request.retransports.length - 1]})`;
  return `\`${request.id}\` ${mode} → ${request.assignee} — ${request.status}, ${required}${names}${supersedes} — ${transport}${stalls}`;
}

/** §7 step 3: an unreadable Codex record, named so a human can look at it. */
function unknownRecordLine(record: UnknownSourceRecord): string {
  const where = record.htmlUrl === null ? `\`${record.recordKey}\`` : `[${record.recordKey}](${record.htmlUrl})`;
  const excerpt = record.excerpt.length === 0 ? "" : ` — "${record.excerpt}"`;
  return `${where} by ${record.authorLogin} @ ${record.version}${excerpt}`;
}

function holdLine(hold: Hold): string {
  const summons = hold.blocks.summons ? ", blocks summons" : "";
  return `\`${hold.id}\` ${hold.kind} by ${describePrincipal(hold.by)} at ${hold.at} — ${hold.reason} (releases on ${hold.release_on}${summons})`;
}

function roundsLine(state: ReviewState): string {
  const allowance = state.budget.rounds_max + state.budget.granted;
  return `${state.rounds_consumed}/${allowance} rounds consumed (${state.rounds_remaining} remaining, ${state.budget.granted} granted)`;
}

function readinessLine(state: ReviewState): string {
  if (state.readiness.ready) return `ready at ${shortSha(state.subject.head_sha)}`;
  const first = firstReason(state.readiness.reasons);
  return `not ready — ${first === null ? "no reason recorded" : describeReason(first)}`;
}

// ---------------------------------------------------------------------------------------
// Check run

/**
 * §8.1: `success` ⇔ `readiness.ready`; otherwise `failure` titled by the first reason in
 * precedence. `neutral`/`skipped` are never published (F-15) — the conclusion type does not
 * even admit them. The summary lists blocking findings, pending requests, holds and rounds.
 */
export function checkRun(state: ReviewState): CheckRunRender {
  const pending = state.requests.filter((request) => request.status === "pending");
  const summary: string[] = [
    `Subject ${state.subject.key}`,
    `Rounds: ${roundsLine(state)}`,
  ];
  summary.push(
    state.blocking_findings.length === 0
      ? "Blocking findings: none"
      : `Blocking findings: ${state.blocking_findings.map((f) => `${f.id} (${f.priority}) ${f.title}`).join("; ")}`,
  );
  summary.push(
    pending.length === 0
      ? "Pending requests: none"
      : `Pending requests: ${pending.map((r) => `${r.id} → ${r.assignee}${r.required ? " (required)" : ""}`).join("; ")}`,
  );
  summary.push(
    state.active_holds.length === 0
      ? "Holds: none"
      : `Holds: ${state.active_holds.map((h) => `${h.kind} (${h.id})`).join("; ")}`,
  );
  if (state.observed.mergeable === false) {
    summary.push(`Conflicting against ${state.subject.base_ref} @ ${shortSha(state.observed.base_sha_now)}`);
  }
  if (state.readiness.ready) {
    return {
      name: CHECK_RUN_NAME,
      conclusion: "success",
      title: `ready at ${shortSha(state.subject.head_sha)}`,
      summary: summary.join("\n"),
    };
  }
  const first = firstReason(state.readiness.reasons);
  return {
    name: CHECK_RUN_NAME,
    conclusion: "failure",
    title: first === null ? "not ready" : describeReason(first),
    summary: summary.join("\n"),
  };
}

// ---------------------------------------------------------------------------------------
// Board comment

/**
 * §8.1: the one comment the belt writes, edited in place. Open and resolved findings with
 * their resolutions, requests with transport references, holds, charges, the exhaustion
 * gate text, and unknown-severity findings prominently — before everything else, because a
 * badge-less finding is the one a reader is most likely to under-weight (V-4). `unknown` are
 * the Codex records the classifier could not read (§7 step 3): surfaced here, never promoted,
 * ahead of the findings for the same reason.
 */
export function boardComment(state: ReviewState, unknownRecords: readonly UnknownSourceRecord[] = []): string {
  const lines: string[] = [];
  lines.push(`## Review ${state.display}`);
  lines.push("");
  lines.push(`**${readinessLine(state)}** · subject \`${state.subject.key}\` · ${state.lifecycle}${state.draft ? " (draft)" : ""} · revision ${state.revision}`);
  if (state.observed.mergeable === false) {
    lines.push("");
    lines.push(`> ⚠️ **Conflicting against \`${state.subject.base_ref}\` @ ${shortSha(state.observed.base_sha_now)}** — review transport is withheld until the branch is mergeable (§D8).`);
  }
  if (state.exemption !== null) {
    lines.push("");
    lines.push(`Exempt at \`${state.exemption.subject_key}\`: ${state.exemption.reason} — ${state.exemption.evidence}`);
  }

  const openEpisode = state.episodes.find((episode) => episode.closed === null);
  if (openEpisode !== undefined) {
    lines.push("");
    lines.push("### 🛑 Review rounds exhausted");
    lines.push("");
    lines.push(
      `Episode \`${openEpisode.id}\` opened ${openEpisode.opened_at} under hold \`${openEpisode.hold_id}\`: `
      + `${roundsLine(state)} with ${state.blocking_findings.length} blocking finding(s) still open. `
      + "This PR does not merge until an operator grants rounds (`hive review grant-rounds`) and the hold is released; "
      + "a retrospective has been requested.",
    );
  }

  if (unknownRecords.length > 0) {
    lines.push("");
    lines.push("### ⚠️ Codex records the classifier could not read — a human must look");
    lines.push("");
    for (const record of unknownRecords) lines.push(`- ${unknownRecordLine(record)}`);
  }

  const unknown = state.findings.filter((finding) => finding.priority === "unknown" && finding.status.open);
  if (unknown.length > 0) {
    lines.push("");
    lines.push("### ⚠️ Findings of unknown severity — classify before merge");
    lines.push("");
    for (const finding of unknown) {
      lines.push(`- ${findingLine(finding)} — ${findingStatusLine(finding)}`);
    }
  }

  lines.push("");
  lines.push(`### Blocking findings (${state.blocking_findings.length})`);
  lines.push("");
  if (state.blocking_findings.length === 0) lines.push("- none");
  for (const finding of state.blocking_findings) {
    lines.push(`- ${findingLine(finding)} — ${findingStatusLine(finding)}`);
  }

  if (state.advisories.length > 0) {
    lines.push("");
    lines.push(`### Advisories (${state.advisories.length})`);
    lines.push("");
    for (const finding of state.advisories) {
      lines.push(`- ${findingLine(finding)} — ${findingStatusLine(finding)}`);
    }
  }

  const resolved = state.findings.filter((finding) => !finding.status.open);
  if (resolved.length > 0) {
    lines.push("");
    lines.push(`### Resolved findings (${resolved.length})`);
    lines.push("");
    for (const finding of resolved) {
      lines.push(`- ${findingLine(finding)} — ${findingStatusLine(finding)}`);
    }
  }

  lines.push("");
  lines.push(`### Requests (${state.requests.length})`);
  lines.push("");
  if (state.requests.length === 0) lines.push("- none");
  for (const request of state.requests) lines.push(`- ${requestLine(request)}`);

  lines.push("");
  lines.push(`### Holds (${state.active_holds.length} active)`);
  lines.push("");
  if (state.active_holds.length === 0) lines.push("- none");
  for (const hold of state.active_holds) lines.push(`- ${holdLine(hold)}`);

  lines.push("");
  lines.push(`### Rounds — ${roundsLine(state)}`);
  lines.push("");
  if (state.charges.length === 0) lines.push("- no charges yet");
  for (const charge of state.charges) {
    lines.push(`- \`${charge.subject_key}\` charged at ${charge.at} by answer \`${charge.answer_id}\``);
  }

  const unavailable: Array<[string, Unavailable]> = [];
  for (const [actor, availability] of Object.entries(state.availability)) {
    if (availability !== undefined && availability.available === false) unavailable.push([actor, availability]);
  }
  if (unavailable.length > 0) {
    lines.push("");
    lines.push("### Reviewer availability");
    lines.push("");
    for (const [actor, availability] of unavailable) {
      lines.push(`- ${actor} unavailable since ${availability.since} (${availability.reason}${availability.until === null ? "" : `, until ${availability.until}`}): ${availability.evidence}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Slack board line (M0's one visible projection)

/** One line for the commons: who, where, ready or why not, rounds, what is pending, what nobody could read. */
export function slackBoardLine(state: ReviewState, unknownRecords: readonly UnknownSourceRecord[] = []): string {
  const pending = state.requests.filter((request) => request.status === "pending");
  const parts = [
    `${state.display} @ ${shortSha(state.subject.head_sha)}`,
    readinessLine(state),
    `rounds ${state.rounds_consumed}/${state.budget.rounds_max + state.budget.granted}`,
    `blocking ${state.blocking_findings.length}`,
  ];
  const unknown = state.findings.filter((finding) => finding.priority === "unknown" && finding.status.open).length;
  if (unknown > 0) parts.push(`unknown-severity ${unknown}`);
  if (unknownRecords.length > 0) parts.push(`unreadable codex records ${unknownRecords.length} (${unknownRecords.map((r) => r.recordKey).join(" ")})`);
  if (pending.length > 0) parts.push(`pending ${pending.map((r) => `${r.id}→${r.assignee}`).join(" ")}`);
  if (state.active_holds.length > 0) parts.push(`holds ${state.active_holds.map((h) => h.kind).join(" ")}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------
// Thread resolution

export interface ThreadOp { comment_id: number; op: "resolve" | "unresolve" }

/**
 * §8.1 (ruled): a finding with a GitHub source comment gets its thread resolved when its
 * status becomes closed and un-resolved when it becomes contested or re-opened. Only
 * comment-sourced findings; reviewkit-sourced findings have no thread.
 */
export function threadOps(before: Review | null, after: Review): ThreadOp[] {
  const ops: ThreadOp[] = [];
  for (const finding of after.findings) {
    if (!("comment_id" in finding.source) || finding.source.record_kind !== "review_comment") continue;
    const prior = before?.findings.find((candidate) => candidate.id === finding.id) ?? null;
    const wasClosed = prior !== null && !prior.status.open;
    const isClosed = !finding.status.open;
    if (isClosed && !wasClosed) ops.push({ comment_id: finding.source.comment_id, op: "resolve" });
    else if (!isClosed && wasClosed) ops.push({ comment_id: finding.source.comment_id, op: "unresolve" });
  }
  return ops;
}

/**
 * The thread refresh's own view: what the thread for `commentId` should look like given the
 * Review *now* (§8.1 — a refresh re-renders, it never carries the verdict that queued it).
 * `null` when no finding is sourced from that comment.
 */
export function threadState(review: Review, commentId: number): "resolve" | "unresolve" | null {
  const finding = review.findings.find(
    (candidate) => "comment_id" in candidate.source && candidate.source.record_kind === "review_comment" && candidate.source.comment_id === commentId,
  );
  if (finding === undefined) return null;
  return finding.status.open ? "unresolve" : "resolve";
}

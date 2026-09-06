/**
 * Test-only builders for contract-valid review shapes. Every builder returns something
 * `validateReviewState` / `validateReview` admits (render.test.ts proves it), so a test
 * that starts from these is exercising the real contract, not a look-alike.
 */
import type {
  AdmittedFinding,
  Hold,
  Policy,
  Principal,
  Request,
  Resolution,
  Review,
  ReviewState,
} from "./contract.js";

export const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";
export const SHA_FIX = "1234567890abcdef1234567890abcdef12345678";
export const AT = "2026-09-06T12:00:00.000Z";

export const seat = (actor: string): Principal => ({ kind: "seat", actor, custody: { delivery_id: 7 } });
export const system: Principal = { kind: "system", caused_by: "obs:run_1" };

export function review(overrides: Partial<Review> = {}): Review {
  const subject: Review["subject"] = {
    key: `${SHA_A}:main`,
    head_sha: SHA_A,
    base_ref: "main",
    base_sha_at_first_sight: SHA_B,
    merge_base_sha: SHA_C,
    diff_sha256: "d".repeat(64),
    changed_paths: ["src/x.py"],
    author: { kind: "seat", actor: "talos" },
    first_seen_at: AT,
  };
  return {
    id: "rev_obs:run_1",
    key: { repository_id: 42, pr_number: 7 },
    display: "skrates/hive#7",
    revision: 3,
    policy_version: 1,
    subject,
    subjects: [subject],
    lifecycle: "open",
    draft: false,
    observed: {
      title: "Fix x",
      author_login: "talos-weave",
      head_ref: "feature",
      base_sha_now: SHA_B,
      seen_at: AT,
      mergeable: true,
    },
    requests: [],
    answers: [],
    findings: [],
    holds: [],
    charges: [],
    budget: { rounds_max: 7, granted: 0 },
    episodes: [],
    availability: {},
    exemption: null,
    projection_handles: { board_comment_id: null, check_run_ids: {}, slack_thread_ts: null },
    ...overrides,
  };
}

/** A `ReviewState` whose derived fields are consistent with its `Review` fields by default. */
export function state(overrides: Partial<ReviewState> = {}): ReviewState {
  const base = review(overrides);
  const blocking = base.findings.filter((f) => f.status.open && f.priority !== "P3");
  const advisories = base.findings.filter((f) => f.status.open && f.priority === "P3");
  const activeHolds = base.holds.filter((h) => h.released === null);
  const consumed = base.charges.length;
  return {
    ...base,
    requirement: { subject_key: base.subject.key, status: "satisfied", by: ["ans_1"] },
    blocking_findings: blocking,
    advisories,
    rounds_consumed: consumed,
    rounds_remaining: Math.max(0, base.budget.rounds_max + base.budget.granted - consumed),
    active_holds: activeHolds,
    readiness: { ready: true, subject_key: base.subject.key },
    ...overrides,
  };
}

export function request(overrides: Partial<Request> = {}): Request {
  return {
    id: "req_obs:run_1_1",
    kind: "review",
    mode: "initial",
    assignee: "codex",
    subject_key: `${SHA_A}:main`,
    required: true,
    names: [],
    status: "pending",
    opened_by: system,
    opened_at: AT,
    reason: "round one goes to codex",
    supersedes: null,
    transport: [],
    retransports: [],
    answered_by: null,
    ...overrides,
  };
}

export function finding(overrides: Partial<AdmittedFinding> = {}): AdmittedFinding {
  return {
    id: "fnd_1",
    review_id: "rev_obs:run_1",
    subject_key: `${SHA_A}:main`,
    raised_by: "codex",
    answer_id: null,
    source: { container_kind: "review_comment", comment_id: 9001, locator: 0 },
    priority: "P1",
    reviewer_disposition: null,
    title: "Off-by-one in pagination",
    path: "src/x.py",
    line: 12,
    status: { open: true },
    links: [],
    correlation_hints: [],
    ...overrides,
  };
}

export function fixedClaim(overrides: Partial<Resolution> = {}): Resolution {
  return {
    kind: "fixed",
    by: seat("talos"),
    at: AT,
    evidence: "repaired in one commit",
    commits: [SHA_FIX],
    ticket: null,
    resolution_text: null,
    confirmed_by: null,
    ...overrides,
  };
}

export function hold(overrides: Partial<Hold> = {}): Hold {
  return {
    id: "hold_1",
    kind: "operator",
    by: { kind: "operator", id: "hakon" },
    at: AT,
    reason: "waiting on the design ruling",
    release_on: "explicit",
    blocks: { readiness: true, summons: false },
    released: null,
    ...overrides,
  } as Hold;
}

export function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    author_aliases: { "talos-weave": "talos" },
    burn_actor: "talos",
    closure_by_seat: true,
    codex_meter: null,
    exempt_roots: ["skills/"],
    retrospective_actor: "theoros",
    reviewer_set: ["ariadne", "theoros"],
    rounds_max: 7,
    routing_by_round: { first: "codex", later: "ariadne" },
    slack: { channel_id: "C0123ABCD" },
    stall_window_s: 1200,
    substitute_actor: "ariadne",
    transport_bound: 2,
    version: 1,
    ...overrides,
  };
}

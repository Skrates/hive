/**
 * The GitHub port (design §7 "Identity", module map §5).
 *
 * `GitHubPort` is what the reconciler and the scheduler code against; `AppGitHubPort` is the
 * one real implementation: a GitHub App (`weave-review`, §7) authenticating with an RS256
 * App JWT (`node:crypto`), exchanging it for cached installation tokens, and talking REST
 * and GraphQL over `undici`. It also carries the projection writes the module map's
 * `ReviewGitHubPort` (§4) names — check runs, board comment, summons, thread resolution —
 * the App owns projections, and only Codex summons use the connected user token (§7, V-1).
 *
 * The 2026-09-06 V-1 probe confirmed Codex refuses the App identity. `port.test.ts` proves JWT and request shaping against a
 * fake fetch. Rate-limit and retry policy are deliberately minimal: a non-2xx is thrown as
 * `GitHubApiError` and the reconcile run that hit it reports it; the 5-minute sweep (§7
 * "Gaps") is the retry.
 */
import { createSign } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import type { Policy } from "../contract.js";
import type { Clock } from "../../time.js";

export interface GitHubPullRequest {
  repositoryId: number;
  prNumber: number;
  owner: string;
  repo: string;
  title: string;
  authorLogin: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
  etag: string | null;
}

/**
 * §7 step 2: one source record by `(kind, id)` with `version = updated_at / submitted_at`.
 * `commitId` is the head the record was written against (`original_commit_id` for review
 * comments — GitHub repositions `commit_id` onto the live head); `line` falls back to
 * `original_line` for a comment GitHub has marked outdated.
 */
export interface GitHubRecord {
  kind: "review" | "review_comment" | "issue_comment";
  id: number;
  version: string;
  authorLogin: string;
  body: string;
  path: string | null;
  line: number | null;
  commitId: string | null;
  raw: unknown;
}

export interface GitHubReaction { id: number; content: string; authorLogin: string; createdAt: string }

export interface GitHubChangedFile { path: string; sha: string; status: string }

export interface GitHubPort {
  getPullRequest(repositoryId: number, prNumber: number, etag?: string): Promise<GitHubPullRequest | "not_modified">;
  listReviews(repositoryId: number, prNumber: number): Promise<GitHubRecord[]>;
  listReviewComments(repositoryId: number, prNumber: number): Promise<GitHubRecord[]>;
  listIssueComments(repositoryId: number, prNumber: number): Promise<GitHubRecord[]>;
  listFiles(repositoryId: number, prNumber: number): Promise<GitHubChangedFile[]>;
  listIssueReactions(repositoryId: number, prNumber: number): Promise<GitHubReaction[]>;
  /** §6.C6 `verbatim_copy`: the blob sha of `path` at `ref`, null when absent. */
  getBlobSha?(repositoryId: number, ref: string, path: string): Promise<string | null>;
  /** §7 "Gaps": failed deliveries since `since` (ISO), asked on broker start. */
  listFailedDeliveries(since: string): Promise<Array<{ id: number; guid: string }>>;
  redeliver(id: number): Promise<void>;
}

/** §6.D2: the meter reading the reconcile run fetches and records in the batch. */
export interface MeterPort {
  read(policy: NonNullable<Policy["codex_meter"]>): Promise<{ reading: number; threshold: number; resetsAt: string | null } | null>;
}

// ---------------------------------------------------------------------------------------
// Record mapping (shared with the fixture-driven classify tests so both read GitHub alike)
// ---------------------------------------------------------------------------------------

/** A `GET /pulls/{n}/reviews` row → record; `version` is `submitted_at`, `commitId` the reviewed head. */
export function reviewRecord(row: Record<string, unknown>): GitHubRecord {
  return {
    kind: "review",
    id: num(row.id) ?? 0,
    version: str(row.submitted_at),
    authorLogin: isRecord(row.user) ? str(row.user.login) : "",
    body: str(row.body),
    path: null,
    line: null,
    commitId: typeof row.commit_id === "string" ? row.commit_id : null,
    raw: row,
  };
}

/** A `GET /pulls/{n}/comments` row → record; `original_commit_id` and `original_line` survive GitHub's repositioning. */
export function reviewCommentRecord(row: Record<string, unknown>): GitHubRecord {
  return {
    kind: "review_comment",
    id: num(row.id) ?? 0,
    version: str(row.updated_at),
    authorLogin: isRecord(row.user) ? str(row.user.login) : "",
    body: str(row.body),
    path: typeof row.path === "string" ? row.path : null,
    line: num(row.line) ?? num(row.original_line),
    commitId: typeof row.original_commit_id === "string" ? row.original_commit_id : typeof row.commit_id === "string" ? row.commit_id : null,
    raw: row,
  };
}

/** A `GET /issues/{n}/comments` row → record; `version` is `updated_at` (the summary comment is edited in place). */
export function issueCommentRecord(row: Record<string, unknown>): GitHubRecord {
  return {
    kind: "issue_comment",
    id: num(row.id) ?? 0,
    version: str(row.updated_at),
    authorLogin: isRecord(row.user) ? str(row.user.login) : "",
    body: str(row.body),
    path: null,
    line: null,
    commitId: null,
    raw: row,
  };
}

// ---------------------------------------------------------------------------------------
// App implementation
// ---------------------------------------------------------------------------------------

/** The slice of `fetch` this port uses; a test fakes it without undici's `Response`. */
export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, readonly url: string, detail: string) {
    super(`GitHub ${status} on ${url}: ${detail}`);
  }
}

export interface AppGitHubPortOptions {
  appId: string;
  /** PEM private key of the App (tier-2 secret on the dev box, §7); never logged. */
  privateKeyPem: string;
  /** Connected user token used only for Codex summons (live V-1 probe). */
  summonToken: string;
  clock: Clock;
  fetch?: FetchLike;
  baseUrl?: string;
  userAgent?: string;
}

interface InstallationToken { token: string; expiresAt: number }
interface RepositoryHome { installationId: number; fullName: string }

const API_VERSION = "2022-11-28";
/** GitHub caps App JWTs at 10 minutes; issue 60 s in the past to absorb clock skew. */
const JWT_TTL_S = 540;
const JWT_SKEW_S = 60;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class AppGitHubPort implements GitHubPort {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private jwt: { value: string; expiresAt: number } | null = null;
  private readonly tokens = new Map<number, InstallationToken>();
  private homes = new Map<number, RepositoryHome>();

  constructor(private readonly options: AppGitHubPortOptions) {
    this.fetch = options.fetch ?? (undiciFetch as unknown as FetchLike);
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/u, "");
    this.userAgent = options.userAgent ?? "hive-review";
  }

  // --- authentication ---------------------------------------------------------------------

  /** RS256 App JWT (`iss` = app id), cached until shortly before it expires. */
  appJwt(): string {
    const nowS = Math.floor(this.options.clock.now().getTime() / 1000);
    if (this.jwt !== null && this.jwt.expiresAt - 30 > nowS) return this.jwt.value;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const exp = nowS + JWT_TTL_S;
    const payload = base64url(JSON.stringify({ iat: nowS - JWT_SKEW_S, exp, iss: this.options.appId }));
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(this.options.privateKeyPem);
    this.jwt = { value: `${header}.${payload}.${base64url(signature)}`, expiresAt: exp };
    return this.jwt.value;
  }

  private async appRequest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; link: string | null }> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const response = await this.fetch(url, {
      method,
      headers: this.headers(`Bearer ${this.appJwt()}`),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) throw new GitHubApiError(response.status, url, text.slice(0, 200));
    return { status: response.status, json: text === "" ? null : JSON.parse(text), link: response.headers.get("link") };
  }

  private headers(authorization: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization,
      "content-type": "application/json",
      "user-agent": this.userAgent,
      "x-github-api-version": API_VERSION,
      ...extra,
    };
  }

  /** Repository id → installation + full name, discovered once through the App's installations. */
  private async home(repositoryId: number): Promise<RepositoryHome> {
    const cached = this.homes.get(repositoryId);
    if (cached !== undefined) return cached;
    const homes = new Map<number, RepositoryHome>();
    const installations = await this.appRequest("GET", "/app/installations?per_page=100");
    for (const installation of Array.isArray(installations.json) ? installations.json : []) {
      const installationId = isRecord(installation) ? num(installation.id) : null;
      if (installationId === null) continue;
      const token = await this.installationToken(installationId);
      for (let page = 1; ; page += 1) {
        const listing = await this.tokenRequest(token, "GET", `/installation/repositories?per_page=100&page=${page}`);
        const repositories = isRecord(listing.json) && Array.isArray(listing.json.repositories) ? listing.json.repositories : [];
        for (const repository of repositories) {
          if (!isRecord(repository)) continue;
          const id = num(repository.id);
          if (id !== null) homes.set(id, { installationId, fullName: str(repository.full_name) });
        }
        if (repositories.length < 100) break;
      }
    }
    this.homes = homes;
    const found = homes.get(repositoryId);
    if (found === undefined) throw new GitHubApiError(404, `repository ${repositoryId}`, "not reachable through any installation of this App");
    return found;
  }

  private async installationToken(installationId: number): Promise<string> {
    const now = this.options.clock.now().getTime();
    const cached = this.tokens.get(installationId);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.token;
    const minted = await this.appRequest("POST", `/app/installations/${installationId}/access_tokens`);
    const token = isRecord(minted.json) ? str(minted.json.token) : "";
    const expiresAt = isRecord(minted.json) ? Date.parse(str(minted.json.expires_at)) : Number.NaN;
    if (token === "") throw new GitHubApiError(500, `/app/installations/${installationId}/access_tokens`, "no token in response");
    if (!Number.isFinite(expiresAt)) throw new GitHubApiError(500, "installation token", "invalid expires_at");
    this.tokens.set(installationId, { token, expiresAt });
    return token;
  }

  private async tokenRequest(
    token: string,
    method: string,
    path: string,
    options: { body?: unknown; etag?: string } = {},
  ): Promise<{ status: number; json: unknown; etag: string | null }> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const response = await this.fetch(url, {
      method,
      headers: this.headers(`Bearer ${token}`, options.etag === undefined ? {} : { "if-none-match": options.etag }),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    if (response.status === 304) return { status: 304, json: null, etag: options.etag ?? null };
    if (response.status < 200 || response.status >= 300) throw new GitHubApiError(response.status, url, text.slice(0, 200));
    return { status: response.status, json: text === "" ? null : JSON.parse(text), etag: response.headers.get("etag") };
  }

  /** A repository-scoped request under its installation token; `path` is relative to `/repos/{owner}/{repo}`. */
  private async repoRequest(
    repositoryId: number,
    method: string,
    path: string,
    options: { body?: unknown; etag?: string } = {},
  ): Promise<{ status: number; json: unknown; etag: string | null }> {
    const home = await this.home(repositoryId);
    const token = await this.installationToken(home.installationId);
    return this.tokenRequest(token, method, `/repos/${home.fullName}${path}`, options);
  }

  private async repoPages(repositoryId: number, path: string): Promise<unknown[]> {
    const separator = path.includes("?") ? "&" : "?";
    const items: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.repoRequest(repositoryId, "GET", `${path}${separator}per_page=100&page=${page}`);
      const batch = Array.isArray(result.json) ? result.json : [];
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  private async graphql(repositoryId: number, query: string, variables: Record<string, unknown>): Promise<unknown> {
    const home = await this.home(repositoryId);
    const token = await this.installationToken(home.installationId);
    const result = await this.tokenRequest(token, "POST", "/graphql", { body: { query, variables } });
    if (isRecord(result.json) && Array.isArray(result.json.errors) && result.json.errors.length > 0) {
      throw new GitHubApiError(200, "/graphql", JSON.stringify(result.json.errors).slice(0, 200));
    }
    return isRecord(result.json) ? result.json.data : null;
  }

  // --- reads (GitHubPort) -----------------------------------------------------------------

  async getPullRequest(repositoryId: number, prNumber: number, etag?: string): Promise<GitHubPullRequest | "not_modified"> {
    const result = await this.repoRequest(repositoryId, "GET", `/pulls/${prNumber}`, etag === undefined ? {} : { etag });
    if (result.status === 304) return "not_modified";
    const pr = result.json;
    if (!isRecord(pr)) throw new GitHubApiError(500, `/pulls/${prNumber}`, "no pull request object");
    const head = isRecord(pr.head) ? pr.head : {};
    const base = isRecord(pr.base) ? pr.base : {};
    const baseRepo = isRecord(base.repo) ? base.repo : {};
    const headSha = str(head.sha);
    const baseSha = str(base.sha);
    const mergeBaseSha = await this.mergeBase(repositoryId, baseSha, headSha);
    return {
      repositoryId: num(baseRepo.id) ?? repositoryId,
      prNumber: num(pr.number) ?? prNumber,
      owner: isRecord(baseRepo.owner) ? str(baseRepo.owner.login) : "",
      repo: str(baseRepo.name),
      title: str(pr.title),
      authorLogin: isRecord(pr.user) ? str(pr.user.login) : "",
      draft: pr.draft === true,
      state: pr.state === "closed" ? "closed" : "open",
      merged: pr.merged === true,
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      headSha,
      headRef: str(head.ref),
      baseRef: str(base.ref),
      baseSha,
      mergeBaseSha,
      etag: result.etag,
    };
  }

  private async mergeBase(repositoryId: number, baseSha: string, headSha: string): Promise<string> {
    const result = await this.repoRequest(repositoryId, "GET", `/compare/${baseSha}...${headSha}`);
    const mergeBase = isRecord(result.json) && isRecord(result.json.merge_base_commit) ? str(result.json.merge_base_commit.sha) : "";
    return mergeBase === "" ? baseSha : mergeBase;
  }

  async listReviews(repositoryId: number, prNumber: number): Promise<GitHubRecord[]> {
    const rows = await this.repoPages(repositoryId, `/pulls/${prNumber}/reviews`);
    return rows.filter(isRecord).map(reviewRecord);
  }

  async listReviewComments(repositoryId: number, prNumber: number): Promise<GitHubRecord[]> {
    const rows = await this.repoPages(repositoryId, `/pulls/${prNumber}/comments`);
    return rows.filter(isRecord).map(reviewCommentRecord);
  }

  async listIssueComments(repositoryId: number, prNumber: number): Promise<GitHubRecord[]> {
    const rows = await this.repoPages(repositoryId, `/issues/${prNumber}/comments`);
    return rows.filter(isRecord).map(issueCommentRecord);
  }

  async listIssueReactions(repositoryId: number, prNumber: number): Promise<GitHubReaction[]> {
    const rows = await this.repoPages(repositoryId, `/issues/${prNumber}/reactions`);
    return rows.filter(isRecord).map(row => ({ id: num(row.id) ?? 0, content: str(row.content), authorLogin: isRecord(row.user) ? str(row.user.login) : "", createdAt: str(row.created_at) }));
  }

  async listFiles(repositoryId: number, prNumber: number): Promise<GitHubChangedFile[]> {
    const rows = await this.repoPages(repositoryId, `/pulls/${prNumber}/files`);
    return rows.filter(isRecord).map((row) => ({ path: str(row.filename), sha: str(row.sha), status: str(row.status) }));
  }

  async getBlobSha(repositoryId: number, ref: string, path: string): Promise<string | null> {
    try {
      const result = await this.repoRequest(repositoryId, "GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
      return isRecord(result.json) && typeof result.json.sha === "string" ? result.json.sha : null;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  // --- redeliveries (§7 "Gaps") ------------------------------------------------------------

  async listFailedDeliveries(since: string): Promise<Array<{ id: number; guid: string }>> {
    const sinceMs = Date.parse(since);
    const failed: Array<{ id: number; guid: string }> = [];
    let next: string | null = "/app/hook/deliveries?per_page=100";
    while (next !== null) {
      const page: { json: unknown; link: string | null } = await this.appRequest("GET", next);
      const rows = Array.isArray(page.json) ? page.json : [];
      let olderThanWindow = false;
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const deliveredAt = Date.parse(str(row.delivered_at));
        if (!Number.isNaN(deliveredAt) && deliveredAt < sinceMs) {
          olderThanWindow = true;
          continue;
        }
        const statusCode = num(row.status_code) ?? 0;
        if (statusCode >= 200 && statusCode < 300 && row.status === "OK") continue;
        const id = num(row.id);
        if (id !== null) failed.push({ id, guid: str(row.guid) });
      }
      const cursor = /<([^>]+)>;\s*rel="next"/u.exec(page.link ?? "")?.[1];
      next = olderThanWindow || cursor === undefined ? null : cursor;
    }
    return failed;
  }

  async redeliver(id: number): Promise<void> {
    await this.appRequest("POST", `/app/hook/deliveries/${id}/attempts`);
  }

  // --- projections (module map §4 `ReviewGitHubPort`, implemented on the same identity) ---

  async createOrUpdateCheckRun(input: {
    repositoryId: number;
    headSha: string;
    existingId: number | null;
    name: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
  }): Promise<{ checkRunId: number }> {
    const body = {
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: input.conclusion,
      output: { title: input.title, summary: input.summary },
    };
    const result = input.existingId === null
      ? await this.repoRequest(input.repositoryId, "POST", "/check-runs", { body })
      : await this.repoRequest(input.repositoryId, "PATCH", `/check-runs/${input.existingId}`, { body });
    const checkRunId = isRecord(result.json) ? num(result.json.id) : null;
    if (checkRunId === null || checkRunId < 1) throw new GitHubApiError(500, "check run", "response has no positive id");
    return { checkRunId };
  }

  async createOrUpdateBoardComment(input: { repositoryId: number; prNumber: number; existingId: number | null; body: string }): Promise<{ commentId: number }> {
    const result = input.existingId === null
      ? await this.repoRequest(input.repositoryId, "POST", `/issues/${input.prNumber}/comments`, { body: { body: input.body } })
      : await this.repoRequest(input.repositoryId, "PATCH", `/issues/comments/${input.existingId}`, { body: { body: input.body } });
    return { commentId: (isRecord(result.json) ? num(result.json.id) : null) ?? input.existingId ?? 0 };
  }

  async postComment(input: { repositoryId: number; prNumber: number; body: string }): Promise<{ commentId: number; summonLogin: string }> {
    const home = await this.home(input.repositoryId);
    const result = await this.tokenRequest(this.options.summonToken, "POST", `/repos/${home.fullName}/issues/${input.prNumber}/comments`, { body: { body: input.body } });
    const row = isRecord(result.json) ? result.json : {};
    const commentId = num(row.id);
    const summonLogin = isRecord(row.user) ? str(row.user.login) : "";
    if (commentId === null || !Number.isInteger(commentId) || commentId < 1 || !summonLogin) {
      throw new GitHubApiError(result.status, `/repos/${home.fullName}/issues/${input.prNumber}/comments`, "summon response omitted its comment id or author login");
    }
    return { commentId, summonLogin };
  }

  async resolveThread(input: { repositoryId: number; commentId: number }): Promise<void> {
    const threadId = await this.threadIdForComment(input.repositoryId, input.commentId);
    await this.graphql(input.repositoryId, "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }", { id: threadId });
  }

  async unresolveThread(input: { repositoryId: number; commentId: number }): Promise<void> {
    const threadId = await this.threadIdForComment(input.repositoryId, input.commentId);
    await this.graphql(input.repositoryId, "mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id } } }", { id: threadId });
  }

  /** A review comment's thread node id: REST for the comment's PR, GraphQL to find the thread holding it. */
  private async threadIdForComment(repositoryId: number, commentId: number): Promise<string> {
    const home = await this.home(repositoryId);
    const [owner, name] = home.fullName.split("/");
    const comment = await this.repoRequest(repositoryId, "GET", `/pulls/comments/${commentId}`);
    const prNumber = Number.parseInt(str(isRecord(comment.json) ? comment.json.pull_request_url : "").split("/").pop() ?? "", 10);
    if (Number.isNaN(prNumber)) throw new GitHubApiError(404, `/pulls/comments/${commentId}`, "comment names no pull request");
    const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
          nodes { id comments(first: 100) { nodes { databaseId } } } } } } }`;
    let after: string | null = null;
    for (;;) {
      const data = await this.graphql(repositoryId, query, { owner, name, number: prNumber, after });
      const threads = isRecord(data) && isRecord(data.repository) && isRecord(data.repository.pullRequest) && isRecord(data.repository.pullRequest.reviewThreads)
        ? data.repository.pullRequest.reviewThreads
        : null;
      const nodes = threads !== null && Array.isArray(threads.nodes) ? threads.nodes : [];
      for (const thread of nodes) {
        if (!isRecord(thread) || !isRecord(thread.comments) || !Array.isArray(thread.comments.nodes)) continue;
        if (thread.comments.nodes.some((c) => isRecord(c) && c.databaseId === commentId)) return str(thread.id);
      }
      const pageInfo = threads !== null && isRecord(threads.pageInfo) ? threads.pageInfo : null;
      if (pageInfo === null || pageInfo.hasNextPage !== true) break;
      after = str(pageInfo.endCursor);
    }
    throw new GitHubApiError(404, `/pulls/comments/${commentId}`, "no review thread holds this comment");
  }
}

import assert from "node:assert/strict";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import test from "node:test";
import type { Clock } from "../../time.js";
import { AppGitHubPort, GitHubApiError, type FetchLike } from "./port.js";

// A throwaway RSA key generated per test process: obviously not the App's key.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = new Date("2026-09-06T12:00:00.000Z");
const clock: Clock = { now: () => NOW };
const APP_ID = "424242";
const FAKE_SUMMON_TOKEN = "connected-user-token-fake";
const FAKE_INSTALLATION_TOKEN = "installation-token-fake-not-real";

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

type Route = (call: Call) => { status?: number; json?: unknown; headers?: Record<string, string> } | undefined;

function fakeFetch(route: Route): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { method: init.method, url, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const reply = route(call) ?? { status: 404, json: { message: "no route" } };
    const headers = new Map(Object.entries(reply.headers ?? {}));
    return {
      status: reply.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (reply.json === undefined ? "" : JSON.stringify(reply.json)),
    };
  };
  return { fetch, calls };
}

/** The App plumbing every repository call needs: installations → token → repositories. */
function appRoutes(call: Call): ReturnType<Route> {
  if (call.url.endsWith("/app/installations?per_page=100")) return { json: [{ id: 11 }] };
  if (call.url.endsWith("/app/installations/11/access_tokens")) return { status: 201, json: { token: FAKE_INSTALLATION_TOKEN, expires_at: "2026-09-06T13:00:00Z" } };
  if (call.url.includes("/installation/repositories")) return { json: { repositories: [{ id: 1054, full_name: "Skrates/hive" }] } };
  return undefined;
}

const PR_JSON = {
  number: 66,
  title: "feat: adapter",
  draft: false,
  state: "open",
  merged: false,
  mergeable: null,
  user: { login: "gnomon-seat" },
  head: { sha: "a".repeat(40), ref: "gnomon/rsm-adapter" },
  base: { sha: "b".repeat(40), ref: "main", repo: { id: 1054, name: "hive", owner: { login: "Skrates" } } },
};

function port(route: Route) {
  const { fetch, calls } = fakeFetch((call) => appRoutes(call) ?? route(call));
  return { port: new AppGitHubPort({ appId: APP_ID, privateKeyPem: PRIVATE_KEY_PEM, summonToken: FAKE_SUMMON_TOKEN, clock, fetch }), calls };
}

test("App JWT: RS256 over {iat, exp, iss} with skew, verifiable with the public key, cached", () => {
  const { port: p } = port(() => undefined);
  const jwt = p.appJwt();
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header !== undefined && payload !== undefined && signature !== undefined);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iat: number; exp: number; iss: string };
  const nowS = Math.floor(NOW.getTime() / 1000);
  assert.equal(claims.iss, APP_ID);
  assert.equal(claims.iat, nowS - 60);
  assert.equal(claims.exp, nowS + 540);
  assert.ok(claims.exp - claims.iat <= 600, "GitHub caps App JWTs at ten minutes");
  assert.equal(verifySignature("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
  assert.equal(p.appJwt(), jwt, "cached while fresh");
});

test("getPullRequest: JWT for App routes, installation token for repo routes, one token mint, etag round trip", async () => {
  let pulls = 0;
  const { port: p, calls } = port((call) => {
    if (call.url.endsWith("/repos/Skrates/hive/pulls/66")) {
      pulls += 1;
      if (call.headers["if-none-match"] === 'W/"etag-1"') return { status: 304 };
      return { json: PR_JSON, headers: { etag: 'W/"etag-1"' } };
    }
    if (call.url.includes("/repos/Skrates/hive/compare/")) return { json: { merge_base_commit: { sha: "c".repeat(40) } } };
    return undefined;
  });
  const pr = await p.getPullRequest(1054, 66);
  assert.notEqual(pr, "not_modified");
  if (pr === "not_modified") return;
  assert.deepEqual(pr, {
    repositoryId: 1054,
    prNumber: 66,
    owner: "Skrates",
    repo: "hive",
    title: "feat: adapter",
    authorLogin: "gnomon-seat",
    draft: false,
    state: "open",
    merged: false,
    mergeable: null,
    headSha: "a".repeat(40),
    headRef: "gnomon/rsm-adapter",
    baseRef: "main",
    baseSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    etag: 'W/"etag-1"',
  });
  const jwt = p.appJwt();
  const appCalls = calls.filter((c) => c.url.includes("/app/"));
  assert.ok(appCalls.length >= 2);
  for (const call of appCalls) assert.equal(call.headers.authorization, `Bearer ${jwt}`);
  const repoCalls = calls.filter((c) => c.url.includes("/repos/"));
  for (const call of repoCalls) {
    assert.equal(call.headers.authorization, `Bearer ${FAKE_INSTALLATION_TOKEN}`);
    assert.equal(call.headers.accept, "application/vnd.github+json");
    assert.equal(call.headers["x-github-api-version"], "2022-11-28");
  }
  const compare = repoCalls.find((c) => c.url.includes("/compare/"));
  assert.ok(compare?.url.endsWith(`/compare/${"b".repeat(40)}...${"a".repeat(40)}`));

  const again = await p.getPullRequest(1054, 66, 'W/"etag-1"');
  assert.equal(again, "not_modified");
  assert.equal(pulls, 2);
  assert.equal(calls.filter((c) => c.url.endsWith("/access_tokens")).length, 1, "the installation token is cached");
  assert.equal(calls.filter((c) => c.url.endsWith("/app/installations?per_page=100")).length, 1, "the repository home is cached");
});

test("record listings: kinds, versions, reviewed heads and pagination", async () => {
  const review = { id: 5125461304, submitted_at: "2026-09-06T13:35:24Z", commit_id: "9".repeat(40), body: "### 💡 Codex Review", user: { login: "chatgpt-codex-connector[bot]" } };
  const reviewComment = { id: 3944094503, updated_at: "2026-09-06T13:35:24Z", commit_id: "4".repeat(40), original_commit_id: "9".repeat(40), path: "a.json", line: null, original_line: 7, body: "**x**", user: { login: "chatgpt-codex-connector[bot]" } };
  const issueComment = { id: 5560110170, updated_at: "2026-09-06T15:06:11Z", body: "Codex Review: Didn't find any major issues.", user: { login: "chatgpt-codex-connector[bot]" } };
  const page1 = Array.from({ length: 100 }, (_, i) => ({ ...issueComment, id: i + 1 }));
  const { port: p, calls } = port((call) => {
    if (call.url.includes("/pulls/66/reviews")) return { json: [review] };
    if (call.url.includes("/pulls/66/comments")) return { json: [reviewComment] };
    if (call.url.includes("/issues/66/comments?per_page=100&page=1")) return { json: page1 };
    if (call.url.includes("/issues/66/comments?per_page=100&page=2")) return { json: [issueComment] };
    if (call.url.includes("/pulls/66/files")) return { json: [{ filename: "src/a.ts", sha: "d".repeat(40), status: "modified" }] };
    return undefined;
  });
  const reviews = await p.listReviews(1054, 66);
  assert.deepEqual(reviews.map((r) => [r.kind, r.id, r.version, r.commitId, r.path, r.line]), [["review", 5125461304, "2026-09-06T13:35:24Z", "9".repeat(40), null, null]]);
  const comments = await p.listReviewComments(1054, 66);
  assert.deepEqual(comments.map((r) => [r.kind, r.id, r.version, r.commitId, r.path, r.line]), [["review_comment", 3944094503, "2026-09-06T13:35:24Z", "9".repeat(40), "a.json", 7]]);
  assert.deepEqual(comments[0]?.raw, reviewComment, "raw is kept verbatim for the source record");
  const issues = await p.listIssueComments(1054, 66);
  assert.equal(issues.length, 101, "a full page is followed by the next page");
  assert.equal(issues.at(-1)?.id, 5560110170);
  assert.equal(calls.filter((c) => c.url.includes("/issues/66/comments")).length, 2);
  assert.deepEqual(await p.listFiles(1054, 66), [{ path: "src/a.ts", sha: "d".repeat(40), status: "modified" }]);
});

test("getBlobSha: the contents sha at a ref; 404 is null; other errors throw GitHubApiError", async () => {
  const { port: p, calls } = port((call) => {
    if (call.url.includes("/contents/skills%2Fx%2FSKILL.md".replace("%2F", "/"))) return undefined;
    if (call.url.includes("/contents/skills/x/SKILL.md?ref=abc")) return { json: { sha: "e".repeat(40) } };
    if (call.url.includes("/contents/missing.md")) return { status: 404, json: { message: "Not Found" } };
    if (call.url.includes("/contents/boom.md")) return { status: 500, json: { message: "boom" } };
    return undefined;
  });
  assert.equal(await p.getBlobSha(1054, "abc", "skills/x/SKILL.md"), "e".repeat(40));
  assert.equal(await p.getBlobSha(1054, "abc", "missing.md"), null);
  await assert.rejects(() => p.getBlobSha(1054, "abc", "boom.md"), (error: unknown) => error instanceof GitHubApiError && error.status === 500);
  assert.ok(calls.some((c) => c.url.endsWith("/contents/skills/x/SKILL.md?ref=abc")));
});

test("§7 gaps: failed deliveries in the window are listed under the App JWT and redelivered", async () => {
  const { port: p, calls } = port((call) => {
    if (call.url.includes("/app/hook/deliveries?per_page=100")) {
      return {
        json: [
          { id: 1, guid: "g-ok", delivered_at: "2026-09-06T11:00:00Z", status: "OK", status_code: 200 },
          { id: 2, guid: "g-failed", delivered_at: "2026-09-06T10:00:00Z", status: "Service Unavailable", status_code: 503 },
          { id: 3, guid: "g-timeout", delivered_at: "2026-09-06T09:00:00Z", status: "timed out", status_code: 0 },
          { id: 4, guid: "g-old", delivered_at: "2026-09-04T09:00:00Z", status: "failed", status_code: 500 },
        ],
        headers: { link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_2>; rel="next"' },
      };
    }
    if (call.url.includes("/app/hook/deliveries/") && call.url.endsWith("/attempts")) return { status: 202, json: {} };
    return undefined;
  });
  const failed = await p.listFailedDeliveries("2026-09-05T12:00:00.000Z");
  assert.deepEqual(failed, [{ id: 2, guid: "g-failed" }, { id: 3, guid: "g-timeout" }]);
  assert.equal(calls.filter((c) => c.url.includes("/app/hook/deliveries?")).length, 1, "paging stops once a page reaches back past the window");
  await p.redeliver(2);
  const attempt = calls.find((c) => c.url.endsWith("/app/hook/deliveries/2/attempts"));
  assert.equal(attempt?.method, "POST");
  assert.equal(attempt?.headers.authorization, `Bearer ${p.appJwt()}`);
});

test("projections: check run create/update, board comment create/update, summons, thread resolve via GraphQL", async () => {
  const { port: p, calls } = port((call) => {
    if (call.url.endsWith("/check-runs") && call.method === "POST") return { status: 201, json: { id: 900 } };
    if (call.url.endsWith("/check-runs/900") && call.method === "PATCH") return { json: { id: 900 } };
    if (call.url.endsWith("/issues/66/comments") && call.method === "POST") return { status: 201, json: { id: 7000, user: { login: "RationallyPrime" } } };
    if (call.url.endsWith("/issues/comments/7000") && call.method === "PATCH") return { json: { id: 7000, user: { login: "RationallyPrime" } } };
    if (call.url.endsWith("/pulls/comments/3944094503")) return { json: { node_id: "PRRC_1", pull_request_url: "https://api.github.com/repos/Skrates/hive/pulls/66" } };
    if (call.url.endsWith("/graphql")) {
      const body = call.body as { query: string; variables: Record<string, unknown> };
      if (body.query.startsWith("query")) {
        return { json: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "PRRT_9", comments: { nodes: [{ databaseId: 3944094503 }] } }] } } } } } };
      }
      return { json: { data: { resolveReviewThread: { thread: { id: body.variables.id } } } } };
    }
    return undefined;
  });
  const created = await p.createOrUpdateCheckRun({ repositoryId: 1054, headSha: "a".repeat(40), existingId: null, name: "weave/review", conclusion: "failure", title: "hold", summary: "s" });
  assert.deepEqual(created, { checkRunId: 900 });
  const post = calls.find((c) => c.url.endsWith("/check-runs"));
  assert.deepEqual(post?.body, { name: "weave/review", head_sha: "a".repeat(40), status: "completed", conclusion: "failure", output: { title: "hold", summary: "s" } });
  await p.createOrUpdateCheckRun({ repositoryId: 1054, headSha: "a".repeat(40), existingId: 900, name: "weave/review", conclusion: "success", title: "ok", summary: "s" });
  assert.equal(calls.find((c) => c.url.endsWith("/check-runs/900"))?.method, "PATCH");
  assert.deepEqual(await p.createOrUpdateBoardComment({ repositoryId: 1054, prNumber: 66, existingId: null, body: "board" }), { commentId: 7000 });
  await p.createOrUpdateBoardComment({ repositoryId: 1054, prNumber: 66, existingId: 7000, body: "board 2" });
  assert.deepEqual(calls.find((c) => c.url.endsWith("/issues/comments/7000"))?.body, { body: "board 2" });
  assert.deepEqual(await p.postComment({ repositoryId: 1054, prNumber: 66, body: "@codex review" }), { commentId: 7000, summonLogin: "RationallyPrime" });
  const commentPosts = calls.filter(c => c.url.endsWith("/issues/66/comments") && c.method === "POST");
  assert.equal(commentPosts[0]?.headers.authorization, `Bearer ${FAKE_INSTALLATION_TOKEN}`, "the App owns the board");
  assert.equal(commentPosts[1]?.headers.authorization, `Bearer ${FAKE_SUMMON_TOKEN}`, "only summons use the connected user");
  await p.resolveThread({ repositoryId: 1054, commentId: 3944094503 });
  const mutation = calls.filter((c) => c.url.endsWith("/graphql")).at(-1)?.body as { query: string; variables: { id: string } };
  assert.ok(mutation.query.includes("resolveReviewThread"));
  assert.equal(mutation.variables.id, "PRRT_9");
  await p.unresolveThread({ repositoryId: 1054, commentId: 3944094503 });
  const unresolve = calls.filter((c) => c.url.endsWith("/graphql")).at(-1)?.body as { query: string };
  assert.ok(unresolve.query.includes("unresolveReviewThread"));
});

test("a non-2xx answer is a GitHubApiError naming the status and the URL, never a silent null", async () => {
  const { port: p } = port((call) => (call.url.endsWith("/pulls/66") ? { status: 403, json: { message: "rate limited" } } : undefined));
  await assert.rejects(() => p.getPullRequest(1054, 66), (error: unknown) => error instanceof GitHubApiError && error.status === 403 && error.url.endsWith("/repos/Skrates/hive/pulls/66"));
  await assert.rejects(() => p.getPullRequest(9999, 1), (error: unknown) => error instanceof GitHubApiError && error.status === 404);
});

test("PR reactions are read under App authentication with author identity", async () => {
  const { port: p, calls } = port(call => call.url.includes("/issues/66/reactions?")
    ? { json: [{ id: 7, content: "+1", user: { login: "chatgpt-codex-connector[bot]" }, created_at: "2026-09-06T12:00:00Z" }] } : undefined);
  assert.deepEqual(await p.listIssueReactions(1054, 66), [{ id: 7, content: "+1", authorLogin: "chatgpt-codex-connector[bot]", createdAt: "2026-09-06T12:00:00Z" }]);
  assert.equal(calls.at(-1)?.headers.authorization, `Bearer ${FAKE_INSTALLATION_TOKEN}`);
});


test("a check-run response without a positive id fails before recording a fake handle", async () => {
  const { port: p } = port(call => call.url.endsWith("/check-runs") ? { status: 201, json: {} } : undefined);
  await assert.rejects(p.createOrUpdateCheckRun({ repositoryId: 1054, headSha: "a".repeat(40), existingId: null,
    name: "weave/review", conclusion: "failure", title: "Pending", summary: "Pending review" }), /positive id/);
});

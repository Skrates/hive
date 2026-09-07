import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateExternalResult } from "../contract.js";
import { CODEX_LOGINS } from "../reducer.js";
import { classifyCodexRecord, findingPriority, type ClassifyContext, type CodexClassification } from "./classify.js";
import { issueCommentRecord, reviewCommentRecord, reviewRecord, type GitHubRecord } from "./port.js";

/** V-6: raw producer output captured read-only with `gh api` on 2026-09-06 (see select.py in the PR body). */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/codex");
const CODEX = "chatgpt-codex-connector[bot]";

type Raw = Record<string, unknown>;

function fixture(name: string): Raw {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Raw;
}

function record(name: string): GitHubRecord {
  const raw = fixture(name);
  const kind = name.split("-").at(-2);
  switch (kind) {
    case "review":
      return reviewRecord(raw);
    case "review_comment":
      return reviewCommentRecord(raw);
    case "issue_comment":
      return issueCommentRecord(raw);
    default:
      throw new Error(`${name} is not a source-record fixture`);
  }
}

/** A Review's known heads for a fixture whose footer is a short commit-ish: the real head where captured, else a test head extending the footer. */
function head(prefix: string, known?: string): string {
  if (known !== undefined) return known;
  return (prefix + "0".repeat(40)).slice(0, 40);
}

const HIVE_66_HEAD = "4df54b1c368a31d3f617c2f4c0672479724ccdad";

interface Expectation {
  classification: CodexClassification;
  context?: Partial<ClassifyContext>;
  /** For clean/findings: the 40-hex head the result must name. */
  head?: string;
  /** For findings: priorities in order, and the first finding's (path, line). */
  priorities?: string[];
  first?: { path: string; line: number | null };
  /** For availability signals. */
  reason?: "quota" | "connector";
}

const baseContext: ClassifyContext = { headSha: HIVE_66_HEAD, heads: [HIVE_66_HEAD], repository: "Skrates/hive", members: [], reviews: [], reviewComments: [], prReactions: [] };

/**
 * The expected table, authored by reading every fixture (not by running the classifier).
 * Every source-record fixture under test/fixtures/codex appears here exactly once.
 */
const EXPECTED: Record<string, Expectation> = {
  // --- the connector's findings round: a COMMENTED review whose findings are its member comments
  "hive-review-5125461304": {
    classification: "findings",
    context: { members: [record("hive-review_comment-3944094503"), record("hive-review_comment-3944094508")] },
    head: "9ae793d86be8a73a29717e55cb978ee120e72ad9",
    priorities: ["P1", "P2"],
    first: { path: "deploy/subscriptions/ariadne.json", line: 7 },
  },
  "sokrates-review-5125698267": {
    classification: "findings",
    context: {
      repository: "Skrates/sokrates",
      members: [record("sokrates-review_comment-3944312497"), record("sokrates-review_comment-3944312498"), record("sokrates-review_comment-3944312501")],
    },
    head: "977929d1c5fbf91ec14d6c69ef0ea69515c40d69",
    priorities: ["P1", "P2", "P2"],
    first: { path: "demo/ladder/rung-02/pair.yaml", line: 64 },
  },
  "weave-doctrine-review-5125806227": {
    classification: "findings",
    context: {
      repository: "RationallyPrime/weave-doctrine",
      members: [record("weave-doctrine-review_comment-3944427867"), record("weave-doctrine-review_comment-3944427871"), record("weave-doctrine-review_comment-3944427878")],
    },
    head: "4624ddcf91a768907997c2435a5e6a228788099c",
    priorities: ["P2", "P2", "P2"],
    first: { path: "services/doctrine-sync/doctrine-sync@.service", line: 51 },
  },
  // --- member and standalone review comments read alone: one finding each, at original_commit_id
  "hive-review_comment-3944094503": { classification: "findings", head: "9ae793d86be8a73a29717e55cb978ee120e72ad9", priorities: ["P1"], first: { path: "deploy/subscriptions/ariadne.json", line: 7 } },
  "hive-review_comment-3944094508": { classification: "findings", head: "9ae793d86be8a73a29717e55cb978ee120e72ad9", priorities: ["P2"], first: { path: "deploy/subscriptions/ariadne.json", line: 9 } },
  "sokrates-review_comment-3944312497": { classification: "findings", head: "977929d1c5fbf91ec14d6c69ef0ea69515c40d69", priorities: ["P1"], first: { path: "demo/ladder/rung-02/pair.yaml", line: 64 } },
  "sokrates-review_comment-3944312498": { classification: "findings", head: "977929d1c5fbf91ec14d6c69ef0ea69515c40d69", priorities: ["P2"], first: { path: "demo/ladder/rung-02/pair.yaml", line: 65 } },
  "sokrates-review_comment-3944312501": { classification: "findings", head: "977929d1c5fbf91ec14d6c69ef0ea69515c40d69", priorities: ["P2"], first: { path: "demo/ladder/rung-02/pair.yaml", line: 16 } },
  "weave-doctrine-review_comment-3944427867": { classification: "findings", head: "4624ddcf91a768907997c2435a5e6a228788099c", priorities: ["P2"], first: { path: "services/doctrine-sync/doctrine-sync@.service", line: 51 } },
  "weave-doctrine-review_comment-3944427871": { classification: "findings", head: "4624ddcf91a768907997c2435a5e6a228788099c", priorities: ["P2"], first: { path: "skills/ai-usage-deploy/references/acceptance.md", line: 24 } },
  "weave-doctrine-review_comment-3944427878": { classification: "findings", head: "4624ddcf91a768907997c2435a5e6a228788099c", priorities: ["P2"], first: { path: "universe/20-machines.md", line: 7 } },
  // the one P3 seen in the sweep; GitHub marked it outdated (`line: null`), so `original_line` carries the anchor
  // (the three sokrates members above are outdated the same way: lines 64, 65, 16 are their `original_line`)
  "sokrates-review_comment-3944637959": { classification: "findings", head: "721da3a66efce6dcb1be4a23e7d99221b2ab8bf4", priorities: ["P3"], first: { path: "scripts/devbox-ceremony-reset.sh", line: 45 } },
  "krepis-review_comment-3941210765": { classification: "findings", head: "e70bf3bbfa9613ffe935244da910ad8ec1900644", priorities: ["P1"], first: { path: ".github/scripts/merge_digest.py", line: 923 } },
  // --- the connector's clean comment: `Codex Review: Didn't find any major issues. <flourish>` + short footer
  "hive-issue_comment-5560110170": { classification: "clean", head: HIVE_66_HEAD },
  "sokrates-issue_comment-5560774852": { classification: "clean", context: { heads: [head("e97f021131")] }, head: head("e97f021131") },
  "krepis-issue_comment-5560216381": { classification: "clean", context: { heads: [head("a152efa8d3")] }, head: head("a152efa8d3") },
  "agent-affordances-issue_comment-5560777705": { classification: "clean", context: { heads: [head("c0cbb2d7bb")] }, head: head("c0cbb2d7bb") },
  // --- the connector's progress board (Completed / Failed), edited in place: recognised, verdict-less
  "hive-issue_comment-5560706393": { classification: "status" },
  "sokrates-issue_comment-5545090773": { classification: "status" },
  // --- availability signals (§6.D3): both quota wordings, the unconnected-repo error, the transient failure
  "sokrates-issue_comment-5350649768": { classification: "quota_refusal", reason: "quota" },
  "sokrates-issue_comment-5323219049": { classification: "quota_refusal", reason: "quota" },
  "sokrates-issue_comment-5301377491": { classification: "connector_error", reason: "connector" },
  "sokrates-issue_comment-5270304839": { classification: "connector_error", reason: "connector" },
  // --- the task channel: a clean verdict at an exact 40-hex head
  "sokrates-issue_comment-5414537249": { classification: "clean", context: { repository: "Skrates/sokrates" }, head: "8e4aa6304e3773ffbcdefee4aeb2a7e939ce04f7" },
  "sokrates-issue_comment-5413853994": { classification: "clean", context: { repository: "Skrates/sokrates" }, head: "0041fbc901f3efa35a390c14271a6d9055b7f263" },
  // --- the task channel: `## Review Finding **[P2] …**` anchored by own-repo permalinks
  "sokrates-issue_comment-5379989497": { classification: "findings", context: { repository: "Skrates/sokrates" }, head: "30aa11b154c3303bffc98e82ae3f23974f72c7d5", priorities: ["P2"], first: { path: "organon/src/organon/operation_config.py", line: 865 } },
  "sokrates-issue_comment-5379280751": { classification: "findings", context: { repository: "Skrates/sokrates" }, head: "743c29799066cc1041c088e83057e387878c95f7", priorities: ["P2"], first: { path: "organon/src/organon/operation_config.py", line: 736 } },
  // --- the connector delivering findings inline in an issue comment (permalink + badge title + body per block)
  "sokrates-issue_comment-5420521329": {
    classification: "findings",
    context: { repository: "Skrates/sokrates" },
    head: "b21a0e215207df98c7761e8e27d9f4b4af553c72",
    priorities: ["P1", "P1", "P2", "P2", "P2"],
    first: { path: "docs/active/product/source-configs/README.md", line: 12 },
  },
  // --- task work reports (`### Summary` / `### Outcome`): never verdicts
  "sokrates-issue_comment-5550157393": { classification: "unknown" },
  "sokrates-issue_comment-5411578823": { classification: "unknown" },
  "weave-doctrine-issue_comment-5553359131": { classification: "unknown", context: { repository: "RationallyPrime/weave-doctrine" } },
};

test("every source-record fixture is in the expected table and vice versa", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json") && !f.includes("-reaction-")).map((f) => f.replace(/\.json$/u, "")).sort();
  assert.deepEqual(files, Object.keys(EXPECTED).sort());
  assert.ok(files.length >= 30, `V-6 asks for ~30 producer records; have ${files.length}`);
});

test("every fixture is authored by the Codex connector login", () => {
  for (const name of Object.keys(EXPECTED)) {
    assert.equal(record(name).authorLogin, CODEX, name);
    assert.ok(CODEX_LOGINS.has(record(name).authorLogin));
  }
});

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`fixture ${name} ⇒ ${expected.classification}`, () => {
    const result = classifyCodexRecord(record(name), { ...baseContext, ...expected.context });
    assert.equal(result.classification, expected.classification, result.detail);
    if (expected.classification === "clean" || expected.classification === "findings") {
      assert.ok(result.external !== undefined, "an admitted verdict carries an ExternalResult");
      const validated = validateExternalResult(result.external);
      assert.equal(validated.ok, true, validated.ok ? "" : validated.detail);
      assert.equal(result.external.reviewed_head, expected.head);
      assert.equal(result.external.verdict, expected.classification);
      assert.equal(result.external.source_record.id, record(name).id);
      assert.equal(result.external.source_record.kind, record(name).kind);
      assert.equal(result.external.source_record.version, record(name).version);
      assert.equal(result.availability, undefined);
      if (expected.classification === "clean") assert.deepEqual(result.external.findings, []);
      else {
        assert.deepEqual(result.external.findings.map((f) => f.priority), expected.priorities);
        const first = result.external.findings[0];
        assert.ok(first !== undefined);
        assert.equal(first.path, expected.first?.path);
        assert.equal(first.line, expected.first?.line);
        // §3.5: the container is the record a finding was read out of — the member comment for
        // an envelope, the record itself otherwise — and the locator separates findings that
        // share one. `(container, locator)` is distinct even where the container is not.
        const containers = new Set(result.external.findings.map((f) => `${f.container_kind}:${f.container_id}`));
        const located = result.external.findings.map((f) => `${f.container_kind}:${f.container_id}#${f.locator}`);
        assert.equal(new Set(located).size, located.length, `distinct source locators: ${located.join(" ")}`);
        if (record(name).kind === "review") {
          assert.deepEqual([...containers], (expected.context?.members ?? []).map((m) => `review_comment:${m.id}`));
          assert.deepEqual(result.external.findings.map((f) => f.locator), result.external.findings.map(() => 0), "one finding per member comment");
        } else {
          assert.deepEqual([...containers], [`${record(name).kind}:${record(name).id}`], "the record itself is the container");
        }
        for (const finding of result.external.findings) {
          assert.ok(finding.title.length > 0 && !finding.title.includes("<sub>") && !finding.title.includes("Badge"), `title is prose: ${finding.title}`);
          assert.ok(!finding.body.includes("Useful? React"), "the connector's reaction footer is not finding body");
        }
      }
    } else if (expected.classification === "quota_refusal" || expected.classification === "connector_error") {
      assert.equal(result.external, undefined);
      assert.deepEqual(result.availability?.reason, expected.reason);
      assert.equal(result.availability?.available, false);
      assert.equal(result.availability?.until, null, "the classifier never knows the reset time; the reconciler fills it from the meter");
      assert.ok((result.availability?.evidence.length ?? 0) > 0);
    } else {
      // §7: status and unknown are recorded on the source record and never promoted
      assert.equal(result.external, undefined);
      assert.equal(result.availability, undefined);
      assert.ok(result.detail.length > 0);
    }
  });
}

test("the connector's acknowledgement in the wild is a 👀 reaction, not a comment, and is not a source record", () => {
  const reaction = fixture("sokrates-reaction-411796000");
  assert.equal(reaction.content, "eyes");
  assert.equal((reaction.user as Raw).login, CODEX);
  // Only the three record kinds exist (§7 step 2); a reaction has none of their shapes.
  assert.ok(!["review", "review_comment", "issue_comment"].includes(String(reaction.content)));
});

test("a clean comment whose footer extends no known head binds nothing and stays unknown (fail closed)", () => {
  const result = classifyCodexRecord(record("hive-issue_comment-5560110170"), { ...baseContext, heads: ["0000000000000000000000000000000000000000"] });
  assert.equal(result.classification, "unknown");
  assert.equal(result.external, undefined);
  const ambiguous = classifyCodexRecord(record("hive-issue_comment-5560110170"), { ...baseContext, heads: [HIVE_66_HEAD, "4df54b1c36" + "f".repeat(30)] });
  assert.equal(ambiguous.classification, "unknown", "two heads extending the footer is no binding");
});

test("a findings envelope with no readable members is unknown, never an empty findings result", () => {
  const result = classifyCodexRecord(record("hive-review-5125461304"), { ...baseContext, members: [] });
  assert.equal(result.classification, "unknown");
  assert.equal(result.external, undefined);
});

test("§6.F5: a badge-less finding is priority unknown — admitted, visible, blocking", () => {
  assert.equal(findingPriority("**Fix the thing**\n\nbody"), "unknown");
  assert.equal(findingPriority("![P0 Badge](https://img.shields.io/badge/P0-red?style=flat)"), "P0");
  assert.equal(findingPriority("**[P3] Title.**"), "P3");
  const badgeless = { ...record("hive-review_comment-3944094503"), body: "**Add Codex to cx53's service PATH**\n\nbody\n\nUseful? React with 👍 / 👎." };
  const result = classifyCodexRecord(badgeless, baseContext);
  assert.equal(result.classification, "findings");
  assert.equal(result.external?.findings[0]?.priority, "unknown");
  assert.equal(result.external?.findings[0]?.title, "Add Codex to cx53's service PATH");
  assert.equal(result.external?.findings[0]?.body, "body");
});

test("§3.5 the connector's nested badge tags leave nothing on the title", () => {
  // The producer writes `**<sub><sub>![P1 Badge](…)</sub></sub>  Title**`. A non-greedy
  // `<sub>.*?</sub>` matches the inner pair and leaves the outer `</sub>` on the front of every
  // title — every finding admitted from Skrates/hive#71 carried one. The exact fixture bytes:
  const nested = record("sokrates-issue_comment-5420521329");
  assert.ok(nested.body.includes("**<sub><sub>![P1 Badge]"), "the fixture carries the nested markup");
  const result = classifyCodexRecord(nested, { ...baseContext, repository: "Skrates/sokrates", heads: [head("f8b5e0e")] });
  assert.equal(result.classification, "findings");
  assert.deepEqual(result.external?.findings.map((f) => f.title), [
    "Expand the CRM URL before submitting the config",
    "Transfer the Postmark spec with the source config",
    "Relocate the Twenty SDL before deleting it",
    "Retire the active Meridian runbooks with the deleted driver",
    "Update the canonical inventory for the relocated fixtures",
  ]);
  // A single-`<sub>` wrapper and a bare title are unchanged by the same rule.
  const single = { ...record("hive-review_comment-3944094503"), body: "**<sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub>  Add Codex to cx53's service PATH**\n\nbody" };
  assert.equal(classifyCodexRecord(single, baseContext).external?.findings[0]?.title, "Add Codex to cx53's service PATH");
});

test("a reply inside a review thread is not a finding", () => {
  const reply = { ...record("hive-review_comment-3944094503"), raw: { ...(record("hive-review_comment-3944094503").raw as Raw), in_reply_to_id: 1 } };
  assert.equal(classifyCodexRecord(reply, baseContext).classification, "unknown");
});

test("verdict prose: the opening sentence is the claim, a withheld verdict is not clean", () => {
  const base = record("sokrates-issue_comment-5414537249");
  const at = (body: string) => classifyCodexRecord({ ...base, body }, { ...baseContext, repository: "Skrates/sokrates", heads: [HIVE_66_HEAD] });
  assert.equal(at("## Review verdict\n\n**No blocking findings.**\n\n[x](https://github.com/Skrates/sokrates/blob/" + HIVE_66_HEAD + "/a.py#L1)").classification, "clean");
  assert.equal(at("## Review verdict\n\nNo blocking findings could be ruled out.").classification, "unknown");
  assert.equal(at("## Review verdict\n\nNo blocking findings... yet").classification, "unknown");
  assert.equal(at("## Review Result — `initial` generation 2\n\nno findings.").classification, "unknown", "a terse clean verdict with no head binds nothing");
  assert.equal(at("## Verdict\n\nNo blocking findings.").classification, "unknown", "a bare heading is not a verdict heading");
  assert.equal(at("## Review verdict\n\n**No major issues found at exact head `" + "a".repeat(40) + "`.**").external?.reviewed_head, "a".repeat(40));
});

test("current clean producer: completed summary plus Codex PR approval, without a contradicting review", () => {
  const sha = "a".repeat(40);
  const summary = issueCommentRecord({ id: 99, user: { login: CODEX }, updated_at: "2026-09-06T19:00:00Z",
    body: `<!-- codex-pull-request-review-summary -->\n\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-09-06T19:00:00Z">now</relative-time> | \`${sha.slice(0,7)}\` | Manual request |` });
  const context: ClassifyContext = { ...baseContext, headSha: sha, heads: [sha], prReactions: [{ id: 8, content: "+1", authorLogin: CODEX, createdAt: "2026-09-06T19:00:00Z" }] };
  const clean = classifyCodexRecord(summary, context);
  assert.equal(clean.classification, "clean");
  assert.equal(clean.external?.reviewed_head, sha);
  assert.equal(validateExternalResult(clean.external).ok, true);
  assert.equal(classifyCodexRecord(summary, { ...context, prReactions: [] }).classification, "status");
  assert.equal(classifyCodexRecord(summary, { ...context, prReactions: [{ ...context.prReactions[0]!, authorLogin: "someone-else" }] }).classification, "status");
  assert.equal(classifyCodexRecord({ ...summary, authorLogin: "someone-else" }, context).classification, "status");
  assert.equal(classifyCodexRecord({ ...summary, body: summary.body.replace("✅ **Completed**", "🔄 **Running**") }, context).classification, "status");
  assert.equal(classifyCodexRecord(summary, { ...context, headSha: "b".repeat(40), heads: [sha, "b".repeat(40)] }).classification, "status", "an old thumbs-up cannot bless the new head");
  const findings = reviewRecord({ id: 7, commit_id: sha, user: { login: CODEX }, submitted_at: "2026-09-06T18:59:00Z", body: "findings" });
  assert.equal(classifyCodexRecord(summary, { ...context, reviews: [findings] }).classification, "status", "the review envelope owns its findings");
  assert.equal(classifyCodexRecord(summary, { ...context, reviewComments: [{ ...findings, kind: "review_comment" }] }).classification, "status");
});

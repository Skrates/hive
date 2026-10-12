// Generates the TypeScript for both of hive's JSON Schema contracts:
//
// - src/review/contract.generated.ts from the vendored review contract
//   (contracts/schemas/review-contract.schema.json). Design §2.1: hive consumes that
//   contract as generated TypeScript + Ajv over the same schema; its provenance is the
//   weave-doctrine SHA recorded in contracts/SOURCE.
// - src/attention/contract.generated.ts from hive's own attention contract
//   (contracts/attention/attention-v1.schema.json, ADR-0004). Hive owns that schema, so
//   its banner names the local file and no vendored provenance.
//
// Nothing generated is handwritten. `bun run check:contracts` runs this and fails on a git
// diff, so neither committed file can lag its schema.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const reviewSource = await readFile(resolve(root, "contracts/SOURCE"), "utf8");
const reviewSha = /^source_sha:\s*([0-9a-f]{40})\s*$/m.exec(reviewSource)?.[1];
if (!reviewSha) fail("contracts/SOURCE must record source_sha as a 40-hex SHA");

await generate({
  schemaPath: "contracts/schemas/review-contract.schema.json",
  title: "ReviewContract",
  outPath: "src/review/contract.generated.ts",
  provenance: [
    " * GENERATED — do not edit. Source: contracts/schemas/review-contract.schema.json,",
    ` * vendored from weave-doctrine@${reviewSha} (see contracts/SOURCE).`,
  ],
});

await generate({
  schemaPath: "contracts/attention/attention-v1.schema.json",
  title: "AttentionContract",
  outPath: "src/attention/contract.generated.ts",
  provenance: [
    " * GENERATED — do not edit. Source: contracts/attention/attention-v1.schema.json,",
    " * hive's own attention contract (ADR-0004); not vendored.",
  ],
});

async function generate({ schemaPath, title, outPath, provenance }) {
  const absoluteSchema = resolve(root, schemaPath);
  const schema = JSON.parse(await readFile(absoluteSchema, "utf8"));
  if (schema.title !== title || typeof schema.$defs !== "object") {
    fail(`${absoluteSchema} is not the ${title} (title ${title} with $defs)`);
  }
  const banner = [
    "/* eslint-disable */",
    "/**",
    ...provenance,
    " * Regenerate with `bun run check:contracts`.",
    " */",
  ].join("\n");

  const ts = await compile(schema, title, {
    bannerComment: banner,
    additionalProperties: false,
    strictIndexSignatures: true,
    declareExternallyReferenced: true,
    unreachableDefinitions: true,
    style: { printWidth: 100 },
  });

  const names = [...ts.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
  const numbered = names.filter((n) => /\d$/.test(n) && !(n in schema.$defs));
  if (numbered.length > 0) {
    fail(`generator minted disambiguated duplicates in ${outPath}: ${numbered.join(", ")} — the schema must name every type once`);
  }
  for (const def of Object.keys(schema.$defs)) {
    if (!names.includes(def)) fail(`no TypeScript type generated for ${schemaPath} $defs/${def}`);
  }

  const absoluteOut = resolve(root, outPath);
  await writeFile(absoluteOut, ts);
  process.stdout.write(`${absoluteOut}: ${names.length} types from ${Object.keys(schema.$defs).length} $defs\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

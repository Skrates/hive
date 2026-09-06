// Generates src/review/contract.generated.ts from the vendored review contract
// (contracts/schemas/review-contract.schema.json). Design §2.1: hive consumes the
// contract as generated TypeScript + Ajv over the same schema; nothing is handwritten.
// `bun run check:contracts` runs this and fails on a git diff, so the committed file
// can never lag the vendored schema.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(root, "contracts/schemas/review-contract.schema.json");
const sourcePath = resolve(root, "contracts/SOURCE");
const outPath = resolve(root, "src/review/contract.generated.ts");

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const source = await readFile(sourcePath, "utf8");
const sha = /^source_sha:\s*([0-9a-f]{40})\s*$/m.exec(source)?.[1];
if (!sha) fail("contracts/SOURCE must record source_sha as a 40-hex SHA");
if (schema.title !== "ReviewContract" || typeof schema.$defs !== "object") {
  fail(`${schemaPath} is not the review contract (title ReviewContract with $defs)`);
}

const banner = [
  "/* eslint-disable */",
  "/**",
  " * GENERATED — do not edit. Source: contracts/schemas/review-contract.schema.json,",
  ` * vendored from weave-doctrine@${sha} (see contracts/SOURCE).`,
  " * Regenerate with `bun run check:contracts`.",
  " */",
].join("\n");

const ts = await compile(schema, "ReviewContract", {
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
  fail(`generator minted disambiguated duplicates: ${numbered.join(", ")} — the schema must name every type once`);
}
for (const def of Object.keys(schema.$defs)) {
  if (!names.includes(def)) fail(`no TypeScript type generated for $defs/${def}`);
}

await writeFile(outPath, ts);
process.stdout.write(`${outPath}: ${names.length} types from ${Object.keys(schema.$defs).length} $defs\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * The review contract at hive's admission boundary (design §2.1).
 *
 * One JSON Schema — `contracts/schemas/review-contract.schema.json`, vendored from
 * weave-doctrine at the SHA recorded in `contracts/SOURCE` — is compiled once with Ajv
 * (strict, first error only) and every shape the broker admits or emits is validated by
 * `$ref` into its `$defs`. The types are generated from the same file
 * (`contract.generated.ts`, `bun run check:contracts`) and re-exported here, so every
 * other review module imports types from `./contract.js` and nothing else.
 *
 * §2.2: Ajv proves shape. Cross-item and process rules (unique finding ids, the
 * authorization table, revision fencing, …) are the reducer's and come back as their own
 * refusal codes; a failure here is always `malformed`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  Action,
  Batch,
  Consequence,
  Effect,
  ExternalResult,
  NormalizedResult,
  Policy,
  Principal,
  Receipt,
  Refusal,
  Review,
  ReviewKey,
  ReviewReport,
  ReviewResolution,
  ReviewState,
  Subject,
  Testimony,
} from "./contract.generated.js";

export type * from "./contract.generated.js";

/** Where the vendored schema lives relative to this module (identical depth in src/ and dist/). */
const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../contracts/schemas/review-contract.schema.json",
);

interface ContractSchema {
  $id: string;
  $defs: Record<string, unknown>;
}

export const contractSchema: ContractSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as ContractSchema;

/**
 * §2.2: strict so an unknown keyword in the vendored file is a loud failure at boot, not a
 * silently ignored constraint; `allErrors: false` because a refusal names one defect and the
 * producer corrects and resubmits (§E2).
 */
// ajv ships CommonJS with `module.exports.default = Ajv2020`; under NodeNext the default
// import is the module object, so the class is its `default` at both type and runtime level.
const Ajv2020 = Ajv2020Module.default;
const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: false });
ajv.addSchema(contractSchema);

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; code: "malformed"; detail: string };

export type ContractValidator<T> = (input: unknown) => Validated<T>;

function describe(errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (first === undefined) return "does not match the contract";
  const where = first.instancePath === "" ? "$" : `$${first.instancePath.replaceAll("/", ".")}`;
  const params = Object.keys(first.params).length > 0 ? ` ${JSON.stringify(first.params)}` : "";
  return `${where} ${first.message ?? first.keyword}${params}`;
}

/** Compile a validator for one named `$defs` entry of the vendored contract. */
export function contractValidator<T>(definition: string): ContractValidator<T> {
  if (!(definition in contractSchema.$defs)) {
    throw new Error(`review contract has no $defs/${definition}`);
  }
  const validate: ValidateFunction<T> = ajv.compile<T>({ $ref: `${contractSchema.$id}#/$defs/${definition}` });
  return (input: unknown): Validated<T> => {
    if (validate(input)) return { ok: true, value: input };
    return { ok: false, code: "malformed", detail: `${definition}: ${describe(validate.errors)}` };
  };
}

export const validateAction = contractValidator<Action>("Action");
export const validateBatch = contractValidator<Batch>("Batch");
export const validateConsequence = contractValidator<Consequence>("Consequence");
export const validateEffect = contractValidator<Effect>("Effect");
export const validateExternalResult = contractValidator<ExternalResult>("ExternalResult");
export const validateNormalizedResult = contractValidator<NormalizedResult>("NormalizedResult");
export const validatePolicy = contractValidator<Policy>("Policy");
export const validatePrincipal = contractValidator<Principal>("Principal");
export const validateReceipt = contractValidator<Receipt>("Receipt");
export const validateRefusal = contractValidator<Refusal>("Refusal");
export const validateReview = contractValidator<Review>("Review");
export const validateReviewKey = contractValidator<ReviewKey>("ReviewKey");
export const validateReviewState = contractValidator<ReviewState>("ReviewState");
export const validateReviewkitReport = contractValidator<ReviewReport>("ReviewReport");
export const validateReviewkitResolution = contractValidator<ReviewResolution>("ReviewResolution");
export const validateSubject = contractValidator<Subject>("Subject");
export const validateTestimony = contractValidator<Testimony>("Testimony");

/**
 * Corpus `model` property (the contract's top-level property name) → `$defs` name. The corpus
 * files are shared with weave-doctrine verbatim, so the mapping is derived from the schema's
 * own top-level `properties`, never listed by hand.
 */
export function definitionForModel(model: string): string {
  const properties = (contractSchema as unknown as { properties: Record<string, { $ref: string }> }).properties;
  const ref = properties[model]?.$ref;
  if (ref === undefined) throw new Error(`review contract exports no model named ${model}`);
  return ref.replace(/^#\/\$defs\//, "");
}

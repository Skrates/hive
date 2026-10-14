/**
 * The attention contract at hive's admission boundary (ADR-0004).
 *
 * One JSON Schema — `contracts/attention/attention-v1.schema.json`, owned by hive — is
 * compiled once with Ajv and every attention shape the broker or edge admits is validated by
 * `$ref` into its `$defs`. The types are generated from the same file
 * (`contract.generated.ts`, `bun run check:contracts`) and re-exported here, so every other
 * attention module imports types from `./contract.js` and nothing else.
 *
 * Ajv proves shape and bounds. Whether the broker agrees with a producer's judgement is not a
 * schema question and is never asked; state, ownership and revision rules are the reducer's.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  AttentionCommand,
  AttentionContinuationTarget,
  InterventionPacket,
  PacketAmendment,
  Receipt,
  SourceBindCommand,
  SourceFile,
} from "./contract.generated.js";

export type * from "./contract.generated.js";

/** Identical depth in src/ and dist/. */
const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../contracts/attention/attention-v1.schema.json",
);

interface ContractSchema {
  $id: string;
  $defs: Record<string, unknown>;
}

export const attentionSchema: ContractSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as ContractSchema;

/** The contract's schema version; the only one this broker speaks. */
export const ATTENTION_SCHEMA_VERSION = 1;

/** Total serialized command bound, checked at broker and edge ingress before buffering past it. */
export const MAX_ATTENTION_COMMAND_BYTES = 64 * 1024;

const Ajv2020 = Ajv2020Module.default;
// Strict, so an unknown keyword in the schema is a loud failure at boot. `strictRequired` is
// the one relaxation: Ajv's own discriminator demands `required: [tag]` on the union parent,
// and the local-path rule's `then: { required: ["edge_id"] }` names a property declared on
// its sibling — both are correct schemas that the strict-required lint cannot see through.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, discriminator: true });
ajv.addSchema(attentionSchema);

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; code: "schema_rejected"; detail: string };

export type AttentionValidator<T> = (input: unknown) => Validated<T>;

function describe(errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (first === undefined) return "does not match the contract";
  const where = first.instancePath === "" ? "$" : `$${first.instancePath.replaceAll("/", ".")}`;
  const params = Object.keys(first.params).length > 0 ? ` ${JSON.stringify(first.params)}` : "";
  return `${where} ${first.message ?? first.keyword}${params}`;
}

export function attentionValidator<T>(definition: string): AttentionValidator<T> {
  if (!(definition in attentionSchema.$defs)) throw new Error(`attention contract has no $defs/${definition}`);
  const validate: ValidateFunction<T> = ajv.compile<T>({ $ref: `${attentionSchema.$id}#/$defs/${definition}` });
  return (input: unknown): Validated<T> => {
    if (validate(input)) return { ok: true, value: input };
    return { ok: false, code: "schema_rejected", detail: `${definition}: ${describe(validate.errors)}` };
  };
}

export const validateAttentionCommand = attentionValidator<AttentionCommand>("AttentionCommand");
export const validateSourceBindCommand = attentionValidator<SourceBindCommand>("SourceBindCommand");
export const validateInterventionPacket = attentionValidator<InterventionPacket>("InterventionPacket");
export const validatePacketAmendment = attentionValidator<PacketAmendment>("PacketAmendment");
export const validateContinuationTarget = attentionValidator<AttentionContinuationTarget>("AttentionContinuationTarget");
export const validateReceipt = attentionValidator<Receipt>("Receipt");
export const validateSourceFile = attentionValidator<SourceFile>("SourceFile");

/**
 * Canonical UTC milliseconds for a schema-valid timestamp. The schema proves the shape; an
 * impossible calendar date (`2026-02-31T…`) still parses to NaN and is refused here rather
 * than persisted as text nobody can compare.
 */
export function canonicalInstant(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  // `Date` silently rolls 2026-02-31 over to March 3; the written calendar fields must survive
  // a round trip unchanged or the instant is refused.
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day
    || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second
  ) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

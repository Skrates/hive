/** Commander presentation names are UI; the vendored contract owns argument types and limits. */
import { Argument, InvalidArgumentError, Option } from "commander";
import { contractPropertyValidator, contractSchema } from "./contract.js";

function property(definition: string, field: string): { parse: (value: string) => string | number; required: boolean } {
  const object = contractSchema.$defs[definition] as {
    properties: Record<string, { type?: string; anyOf?: Array<{ type?: string }> }>;
    required: string[];
  };
  const schema = object.properties[field];
  if (!schema) throw new Error(`missing CLI schema ${definition}.${field}`);
  const validate = contractPropertyValidator(definition, field);
  return {
    required: object.required.includes(field) && !schema.anyOf?.some(arm => arm.type === "null"),
    parse(value) {
      const parsed = schema.type === "integer" || schema.type === "number" ? Number(value) : value;
      const result = validate(parsed);
      if (!result.ok) throw new InvalidArgumentError(result.detail);
      return parsed;
    },
  };
}

export function contractArgument(definition: string, field: string, syntax: string): Argument {
  return new Argument(syntax).argParser(property(definition, field).parse);
}

export function contractOption(definition: string, field: string, flags: string): Option {
  const schema = property(definition, field);
  return new Option(flags).makeOptionMandatory(schema.required).argParser(schema.parse);
}

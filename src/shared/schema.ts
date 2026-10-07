// Supports: SPEC-OUT-001 (EF-02), SPEC-CFG-002 (EF-01), SPEC-API-006 (schema-validated catalogue)
// JSON Schema validation (Ajv) with readable, path-qualified error messages.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** French messages for humans; English messages for the model (gap E-033). */
export function describeErrors(errors: readonly ErrorObject[] | null | undefined, language: "fr" | "en" = "fr"): string[] {
  if (!errors) return [];
  const fr = language === "fr";
  return errors.map((e) => {
    const where = e.instancePath === "" ? (fr ? "(racine)" : "(root)") : e.instancePath;
    if (e.keyword === "required") return fr ? `${where} : champ obligatoire manquant \`${String(e.params["missingProperty"])}\`` : `${where}: missing required field \`${String(e.params["missingProperty"])}\``;
    if (e.keyword === "additionalProperties") return fr ? `${where} : champ inattendu \`${String(e.params["additionalProperty"])}\`` : `${where}: unexpected field \`${String(e.params["additionalProperty"])}\``;
    if (e.keyword === "enum") return fr ? `${where} : valeur attendue parmi ${JSON.stringify(e.params["allowedValues"])}` : `${where}: expected one of ${JSON.stringify(e.params["allowedValues"])}`;
    return `${where}${fr ? " : " : ": "}${e.message ?? e.keyword}`;
  });
}

export function compileSchema<T>(schema: object): (data: unknown) => Validation<T> {
  const validate: ValidateFunction = ajv.compile(schema);
  return (data: unknown) => (validate(data) ? { ok: true, value: data as T } : { ok: false, errors: describeErrors(validate.errors) });
}

export function compileRaw(schema: object): ValidateFunction {
  return ajv.compile(schema);
}

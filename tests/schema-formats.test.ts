import { expect, spyOn, test } from "bun:test";
import { compileRaw, compileSchema, describeErrors } from "../src/shared/schema";

test("TECH — discriminated tool inputs tell the model the expected operation", () => {
  const validate = compileRaw({ type: "object", properties: { operation: { const: "object" } }, required: ["operation"] });
  expect(validate({ operation: "read" })).toBe(false);
  expect(describeErrors(validate.errors, "en").join(" ")).toContain('"object"');
  expect(describeErrors(validate.errors, "fr").join(" ")).toContain('"object"');
});

test("TECH — MCP UUID schemas validate identifiers without emitting unknown-format warnings", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const schema = { type: "object", properties: { target: { type: "string", format: "uuid" } }, required: ["target"], additionalProperties: false };
    const validate = compileRaw(schema);
    for (const target of ["10000000-0000-4000-8000-000000000001", "6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "00000000-0000-0000-0000-000000000000", "urn:uuid:10000000-0000-4000-8000-000000000001"]) expect(validate({ target })).toBe(true);
    for (const target of ["not-a-uuid", "10000000-0000-4000-8000", "10000000-0000-4000-8000-00000000000z", "10000000-0000-4000-8000-000000000001\n"]) expect(validate({ target })).toBe(false);
    expect(compileSchema(schema)({ target: "invalid" }).ok).toBe(false);
    expect(warning).not.toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});

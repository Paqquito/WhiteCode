// Implements: SPEC-CMD-029 (CA-01, local runtime snapshot), gap E-153.
export function heapSnapshot(): Uint8Array { return Buffer.from(Bun.generateHeapSnapshot("v8"), "utf8"); }

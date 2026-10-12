// Implements: SPEC-BLD-002 (EF-01 compile-time constants, EF-02 unknown name rejected at compile time, EF-04 single registry)
// Registry of build options (SPEC-CAD-003 § 4): disabled capabilities stay outside their runtime entry points.

import { BUILD_PROFILE, BUILD_VALUES } from "../identity/generated/build-flags";
import type { BuildFlagName } from "./build-options";
export type { BuildFlagName } from "./build-options";
export const BUILD_FLAGS = BUILD_VALUES;

/** Reads a build option. Only literal names of the registry type-check (EF-02). */
export function buildFlag(name: BuildFlagName): boolean {
  if (!Object.hasOwn(BUILD_FLAGS, name)) throw new Error(`Option de build inconnue : ${name}.`);
  return BUILD_FLAGS[name];
}
export function buildProfile(): string { return BUILD_PROFILE; }
export function buildInventory(): typeof BUILD_VALUES { return BUILD_VALUES; }

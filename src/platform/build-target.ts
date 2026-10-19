// Supports: SPEC-BLD-004 (EF-01, RG-01: libc constants derive from the executable target).
import { existsSync } from "node:fs";

export const BUILD_TARGETS = ["bun-windows-x64", "bun-windows-arm64", "bun-linux-x64", "bun-linux-arm64", "bun-linux-x64-musl", "bun-linux-arm64-musl", "bun-darwin-x64", "bun-darwin-arm64"] as const;

export function hostBuildTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const musl = os === "linux" && existsSync(`/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`);
  return `bun-${os}-${process.arch}${musl ? "-musl" : ""}`;
}

export function libcBuildValues(target: string = hostBuildTarget()): { readonly libc_variant_musl: boolean; readonly libc_variant_glibc: boolean } {
  if (!(BUILD_TARGETS as readonly string[]).includes(target)) throw new Error(`Cible de build invalide : ${target}.`);
  return { libc_variant_musl: target.includes("linux") && target.endsWith("-musl"), libc_variant_glibc: target.includes("linux") && !target.endsWith("-musl") };
}

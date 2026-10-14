// Supports: SPEC-MOD-010 (CA-03, persistence compatibility probe), gap E-169.
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ordinaryPrivateFile } from "../shared/private-text";
/** Probe only the product configuration folder; never create a file in the user's project. */
export function configurationWritable(folder: string): boolean {
  const path = join(folder, ".write-probe-" + randomUUID()); let fd: number | undefined;
  try {
    ordinaryPrivateFile(path, 0); mkdirSync(folder, { recursive: true, mode: 0o700 });
    if ((statSync(folder).mode & 0o222) === 0) return false;
    fd = openSync(path, "wx", 0o600); closeSync(fd); fd = undefined; unlinkSync(path); return true;
  } catch { return false; }
  finally { if (fd !== undefined) { try { closeSync(fd); unlinkSync(path); } catch { /* The probe never replaces an existing name. */ } } }
}

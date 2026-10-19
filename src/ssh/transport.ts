// Implements: SPEC-MOD-020 (system SSH, bounded probe and fingerprint-verified deployment).
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { startChild, type Child } from "../platform/process";

export function sshHost(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:\[\]-]{0,254}$/.test(value)) throw new Error("Hôte SSH invalide ; utilisez un hôte ou un alias de configuration SSH.");
  return value;
}
export function shellQuote(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 4096) throw new Error("Chemin SSH invalide.");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export function parseProbe(text: string): { arch: "x64" | "arm64"; home: string } {
  const [system, architecture, home, ...extra] = text.trimEnd().split("\n");
  if (system !== "Linux" || !["x86_64", "aarch64"].includes(architecture ?? "") || !home?.startsWith("/") || extra.length || /[\r\u0000-\u001f\u007f]/.test(home)) throw new Error("La session SSH exige un hôte Linux x64 ou arm64 et un dossier personnel absolu.");
  return { arch: architecture === "x86_64" ? "x64" : "arm64", home };
}
export interface SshTransport {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly host: string;
  readonly signal: AbortSignal;
  readonly program?: string;
}
export function openSsh(o: SshTransport, command: string, forwarding: readonly string[], output: (chunk: Buffer) => void, error: (chunk: Buffer) => void): Child {
  return startChild(o.program ?? "ssh", ["-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", ...forwarding, "--", sshHost(o.host), command], { cwd: o.cwd, env: o.env, keepInputOpen: true, onData: output, onErrorData: error });
}
export async function sshCommand(o: SshTransport, command: string, input?: Uint8Array): Promise<string> {
  o.signal.throwIfAborted();
  const chunks: Buffer[] = []; let bytes = 0, overflow = false;
  const child = openSsh(o, command, [], chunk => { bytes += chunk.length; if (bytes > 16384) { overflow = true; void child.killTree(100); } else chunks.push(chunk); }, () => {});
  const stop = () => { void child.killTree(100); };
  o.signal.addEventListener("abort", stop, { once: true }); const timeout = setTimeout(stop, 30000);
  try {
    if (o.signal.aborted) stop();
    if (input) child.input!.write(input); child.input!.end();
    const code = await child.exited;
    if (o.signal.aborted || code !== 0 || overflow) throw new Error("Connexion SSH ou opération distante impossible ; vérifiez l’hôte, les clés et ses droits.");
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timeout); o.signal.removeEventListener("abort", stop); }
}
export async function deploySsh(o: SshTransport, local: string, cache: string): Promise<{ executable: string; sha256: string; deployed: boolean }> {
  const stat = lstatSync(local);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 4 || stat.size > 256 * 1024 * 1024) throw new Error("Exécutable Linux ordinaire requis (256 Mio au plus).");
  const bytes = readFileSync(local);
  if (bytes.subarray(0, 4).toString("hex") !== "7f454c46") throw new Error("Le livrable fourni n’est pas un exécutable Linux ELF.");
  const sha256 = createHash("sha256").update(bytes).digest("hex"), executable = `${cache}/${sha256}`, target = shellQuote(executable), dir = shellQuote(cache);
  const installed = await sshCommand(o, `set -eu; umask 077; mkdir -p ${dir}; test ! -L ${dir}; if test -e ${target}; then test -f ${target}; test ! -L ${target}; sha256sum ${target}; else printf 'absent\\n'; fi`);
  if (installed.trim() !== "absent") {
    if (!installed.startsWith(sha256 + " ")) throw new Error("Empreinte du cache SSH incorrecte ; exécution refusée.");
    return { executable, sha256, deployed: false };
  }
  const temp = shellQuote(`${cache}/.upload-${randomUUID()}`);
  await sshCommand(o, `set -eu; umask 077; tmp=${temp}; trap 'rm -f "$tmp"' EXIT; cat > "$tmp"; test "$(sha256sum "$tmp" | cut -d ' ' -f 1)" = ${shellQuote(sha256)}; chmod 700 "$tmp"; ln "$tmp" ${target} || test "$(sha256sum ${target} | cut -d ' ' -f 1)" = ${shellQuote(sha256)}; sha256sum ${target}`, bytes);
  const checked = await sshCommand(o, `set -eu; test ! -L ${target}; sha256sum ${target}`);
  if (!checked.startsWith(sha256 + " ")) throw new Error("Vérification du déploiement SSH échouée.");
  return { executable, sha256, deployed: true };
}

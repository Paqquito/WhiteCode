// Supports: SPEC-API-029 (EF-02/03/07, different native principal for every hosted session).
import { chmodSync, chownSync, existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { currentPlatform, findExecutable } from "./system";
import { securePrivateDirectory } from "./private-file";
import { tryFileLock } from "./file-lock";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { writeAtomic } from "../tools/text-file";
import { runToCompletion } from "./process";
export interface HostedIsolationConfiguration { readonly firstUid: number; readonly lastUid: number }
const registry = "/var/lib/hosted-session-identities";
const pause = new Int32Array(new SharedArrayBuffer(4));
/** A successful signal is not confirmation: inspect again until no live member remains. */
export function confirmHostedStop(ports: { kill(): void; running(): boolean; now?: () => number; wait?: () => void }): void {
  const now = ports.now ?? Date.now, deadline = now() + 2000;
  for (;;) {
    ports.kill();
    if (!ports.running()) return;
    if (now() >= deadline) throw Error("Arrêt de processus hébergé non confirmé.");
    if (ports.wait) ports.wait(); else Atomics.wait(pause, 0, 0, 25);
  }
}
function runningProcess(matches: (pid: number, status: string, fields: string[]) => boolean): boolean {
  // Refuse an absent/inaccessible procfs rather than treating an empty directory as proof.
  if (!/^Pid:\s+\d+/m.test(readFileSync("/proc/self/status", "utf8"))) throw Error("Inspection noyau des processus impossible.");
  for (const name of readdirSync("/proc")) if (/^\d+$/.test(name)) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields.length < 3 || !/^[A-Za-z]$/.test(fields[0]!)) throw Error("État de processus noyau invalide.");
      if (fields[0] !== "Z" && fields[0] !== "X" && matches(Number(name), readFileSync(`/proc/${name}/status`, "utf8"), fields)) return true;
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return false;
}
/** Only a group created for one observed preparation child may be passed here; never the root UID. */
export function stopHostedPreparationGroup(pid: number): void {
  if (currentPlatform() !== "linux" || process.getuid?.() !== 0 || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw Error("Groupe de préparation invalide.");
  confirmHostedStop({
    kill() { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } },
    running: () => runningProcess((_pid, _status, fields) => Number(fields[2]) === pid),
  });
}
export function assertHostedControlFile(path: string): void {
  ordinaryPrivateFile(path, 1024 * 1024);
  const file = lstatSync(path), parent = lstatSync(dirname(path));
  if (currentPlatform() !== "linux" || process.getuid?.() !== 0 || !file.isFile() || file.uid !== 0 || (file.mode & 0o077) !== 0 || !parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o077) !== 0) throw Error("Le contrôle du travailleur exige un fichier root privé dans un répertoire root privé.");
}
function trustedExecutable(path: string): void {
  if (!isAbsolute(path)) throw Error("Exécutable système absolu requis.");
  const resolved = realpathSync(path), file = lstatSync(resolved);
  if (!file.isFile() || lstatSync(path).uid !== 0 || file.uid !== 0 || (file.mode & 0o022) !== 0 || (file.mode & 0o111) === 0) throw Error("L’exécutable de session doit appartenir à root et rester non modifiable par les sessions.");
  for (const location of new Set([path, resolved])) for (let parent = dirname(location);;) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) throw Error("Le chemin de l’exécutable doit rester contrôlé par root.");
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
}
/** Root owns the broker/worker control plane. A monotonically allocated UID can never read it or a previous session. */
export function hostedSessionIsolation(configuration: HostedIsolationConfiguration | undefined) {
  if (currentPlatform() !== "linux" || process.getuid?.() !== 0 || !configuration || !Number.isSafeInteger(configuration.firstUid) || !Number.isSafeInteger(configuration.lastUid) || configuration.firstUid < 65536 || configuration.lastUid < configuration.firstUid || configuration.lastUid > 2147483646) throw Error("Un travailleur hébergé exige Linux, un superviseur root et une plage UID réservée sans réemploi.");
  const setpriv = findExecutable("setpriv"); if (!setpriv) throw Error("L’enveloppe système setpriv est requise ; aucune exécution sans isolation n’est autorisée.");
  trustedExecutable(setpriv);
  const pkill = findExecutable("pkill"); if (!pkill) throw Error("L’arrêt des processus de l’identité de session exige pkill."); trustedExecutable(pkill);
  const { firstUid, lastUid } = configuration;
  for (const file of ["/etc/passwd", "/etc/group"]) {
    const conflicts = readFileSync(file, "utf8").split("\n").some(line => { const uid = Number(line.split(":")[2]); return Number.isInteger(uid) && uid >= firstUid && uid <= lastUid; });
    if (conflicts) throw Error("La plage de session recouvre un compte ou groupe système existant.");
  }
  for (const file of ["/etc/subuid", "/etc/subgid"]) if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n")) {
    const fields = line.split(":"), start = Number(fields[1]), count = Number(fields[2]);
    if (count > 0 && start <= lastUid && start + count - 1 >= firstUid) throw Error("La plage de session recouvre une allocation de sous-identifiants système.");
  }
  mkdirSync(registry, { recursive: true, mode: 0o700 }); ordinaryPrivateFile(join(registry, "counter.json"), 1024); securePrivateDirectory(registry);
  const allocate = () => {
    const file = join(registry, "counter.json"), release = tryFileLock(file + ".lock"); if (!release) throw Error("Allocation d’identité verrouillée ; réessayez.");
    try {
      const state: unknown = existsSync(file) ? JSON.parse(readPrivateText(file, 1024)) : { firstUid, lastUid, next: firstUid };
      if (!state || typeof state !== "object" || !("firstUid" in state) || state.firstUid !== firstUid || !("lastUid" in state) || state.lastUid !== lastUid || !("next" in state) || !Number.isSafeInteger(state.next) || Number(state.next) < firstUid || Number(state.next) > lastUid) throw Error("Plage d’identités différente, épuisée ou registre invalide. Aucun identifiant n’est réutilisé.");
      const uid = Number(state.next); writeAtomic(file, Buffer.from(JSON.stringify({ firstUid, lastUid, next: uid + 1 })), "linux", true); return uid;
    } finally { release(); }
  };
  return {
    prepare(root: string, directory: string) {
      ordinaryPrivateFile(join(root, ".path-check"), 0);
      const uid = allocate();
      const own = (path: string) => {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) { lchownSync(path, uid, uid); return; }
        if (stat.isDirectory()) { for (const name of readdirSync(path)) own(join(path, name)); chownSync(path, uid, uid); chmodSync(path, 0o700); return; }
        if (!stat.isFile() || stat.nlink !== 1) throw Error("Fichier de session spécial ou lié refusé.");
        chownSync(path, uid, uid); chmodSync(path, stat.mode & 0o111 ? 0o700 : 0o600);
      };
      own(directory);
      // Traversal is allowed, directory enumeration and mutation remain restricted to the root supervisor.
      chmodSync(root, 0o711);
      return {
        launch(file: string, args: readonly string[]) { trustedExecutable(file); return { file: setpriv, args: ["--reuid=" + uid, "--regid=" + uid, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs", "--", file, ...args] }; },
        stop() {
          confirmHostedStop({
            kill() { const result = runToCompletion(pkill, ["-KILL", "-u", String(uid)], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 1000 }); if (result.code !== 0 && result.code !== 1) throw Error("L’arrêt de l’identité de session n’a pas pu être confirmé."); },
            running: () => runningProcess((_pid, status) => { const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status); if (!ids) throw Error("Identité noyau de processus invalide."); return ids.slice(1).some(value => Number(value) === uid); }),
          });
        },
      };
    },
  };
}

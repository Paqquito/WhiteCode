// Implements: SPEC-INT-005 (optional local installation and durable first-connection welcome).
import { startChild } from "../platform/process";
import { currentPlatform, findExecutable } from "../platform/system";
import { readUserState, updateUserState } from "../config/user-state";
export async function prepareEditor(options: {
  kind: "vscode" | "jetbrains";
  extension?: string;
  enabled: boolean;
  disabled: boolean;
  cwd: string;
  environment: Record<string, string>;
  signal: AbortSignal;
  report: (text: string) => void;
  program?: { file: string; args: string[] };
}): Promise<void> {
  if (!options.enabled || options.disabled || !options.extension) return;
  const id = options.extension;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(id)) {
    options.report("Identifiant d’extension IDE invalide.");
    return;
  }
  const file =
    options.program?.file ??
    findExecutable(options.kind === "vscode" ? "code" : "idea");
  if (!file) {
    options.report(
      `Installation de l’extension impossible : installez ${id} dans votre IDE.`,
    );
    return;
  }
  const execute = async (args: string[]) => {
    let command = file,
      arguments_ = [...(options.program?.args ?? []), ...args];
    if (currentPlatform() === "windows" && /\.(cmd|bat)$/i.test(command)) {
      arguments_ = [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& " +
          [command, ...arguments_]
            .map((v) => "'" + v.replaceAll("'", "''") + "'")
            .join(" "),
      ];
      command = "powershell.exe";
    }
    let stdout = "";
    const child = startChild(command, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      onData: (chunk) => {
        if (stdout.length < 65536) stdout += chunk.toString();
      },
    });
    const stop = () => {
      void child.killTree(100);
    };
    const scope = AbortSignal.any([options.signal, AbortSignal.timeout(30000)]);
    scope.addEventListener("abort", stop, { once: true });
    try {
      if (scope.aborted) stop();
      const code = await child.exited;
      return { code, stdout };
    } finally {
      scope.removeEventListener("abort", stop);
    }
  };
  try {
    const present = await execute(
      options.kind === "vscode" ? ["--list-extensions"] : ["listPlugins"],
    );
    if (present.code !== 0) throw Error();
    if (
      present.stdout
        .split(/\s+/)
        .some((value) => value.toLowerCase() === id.toLowerCase())
    )
      return;
    const installed = await execute(
      options.kind === "vscode"
        ? ["--install-extension", id]
        : ["installPlugins", id],
    );
    if (installed.code !== 0) throw Error();
    options.report(`Extension IDE installée : ${id}.`);
  } catch {
    options.report(
      `Installation de l’extension impossible : installez ${id} manuellement dans votre IDE.`,
    );
  }
}
export async function welcomeEditor(
  kind: string,
  stateFile: string,
  report: (text: string) => void,
): Promise<void> {
  if ((readUserState(stateFile).ideWelcomes ?? []).includes(kind)) return;
  let first = false;
  await updateUserState(
    stateFile,
    (state) => {
      if ((state.ideWelcomes ?? []).includes(kind)) return state;
      first = true;
      return { ...state, ideWelcomes: [...(state.ideWelcomes ?? []), kind] };
    },
    currentPlatform(),
  );
  if (first)
    report(
      "IDE connecté : sélection jointe au contexte, comparaisons avant écriture et diagnostics disponibles ; /editor choisit la connexion.",
    );
}

// Implements: SPEC-MOD-015 (completed remote sessions, pinned Git branch and ordinary local history), gap E-196.
import { findExecutable } from "../platform/system";
import { runToCompletion } from "../platform/process";
import { sanitizeRemoteUrl } from "../engine/repository-state";
import type { CompanyAccount } from "../auth/company-account";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const canonical = (text: string) => {
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Adresse de dépôt HTTPS sans identifiant requise.");
  return url.href.replace(/\/?$/, "").replace(/\.git$/, "");
};
export async function resumeRemote(o: {
  id: string;
  account: CompanyAccount;
  project: string;
  environment: Record<string, string>;
  signal: AbortSignal;
  assertPolicy: () => void;
  redact: (text: string) => string;
}): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(o.id))
    throw new Error("Identifiant de session distante invalide.");
  o.assertPolicy();
  const profile = await o.account.profile();
  if (!profile)
    throw new Error(
      "Connectez votre compte avant de récupérer une session distante.",
    );
  const owner = {
    account: profile.account,
    organizationId: profile.organization.id,
  };
  const raw = await o.account.request(
    "sessions",
    o.id + "/export",
    undefined,
    o.signal,
    owner,
  );
  if (
    !object(raw) ||
    raw.status !== "completed" ||
    typeof raw.repository !== "string" ||
    typeof raw.branch !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(raw.branch) ||
    /\.\.|\/\/|@\{|\.lock(?:\/|$)|[./]$/.test(raw.branch) ||
    typeof raw.commit !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(raw.commit) ||
    !Array.isArray(raw.messages) ||
    raw.messages.length > 2000 ||
    Buffer.byteLength(JSON.stringify(raw.messages)) > 1048576
  )
    throw new Error("Session distante non terminée ou export invalide.");
  const messages = raw.messages.map((value) => {
    if (
      !object(value) ||
      !["user", "assistant"].includes(String(value.role)) ||
      typeof value.text !== "string" ||
      value.text.length > 65536
    )
      throw new Error("Historique d’export invalide ou incomplet.");
    return {
      role: value.role as "user" | "assistant",
      text: o.redact(value.text),
    };
  });
  const git = findExecutable("git");
  if (!git) throw new Error("Git requis pour récupérer la branche.");
  const run = (args: readonly string[], fail = true) => {
    o.signal.throwIfAborted();
    o.assertPolicy();
    const result = runToCompletion(
      git,
      ["-c", "core.hooksPath=", "--no-optional-locks", ...args],
      {
        cwd: o.project,
        env: { ...o.environment, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
        timeoutMs: 30000,
      },
    );
    if (fail && result.code !== 0)
      throw new Error(
        "Branche de la session distante introuvable ou inaccessible.",
      );
    return result;
  };
  const localRepository = sanitizeRemoteUrl(
    run(["config", "--get", "remote.origin.url"]).stdout.trim(),
  );
  if (
    !localRepository ||
    canonical(localRepository) !== canonical(raw.repository)
  )
    throw new Error(
      "Dépôt différent : la session attend " +
        o.redact(canonical(raw.repository)) +
        ". Aucune récupération Git effectuée.",
    );
  if (run(["status", "--porcelain", "--untracked-files=all"]).stdout.trim())
    throw new Error(
      "Modifications locales présentes : conservez-les avant la récupération ; aucun fichier modifié.",
    );
  if (
    run(
      ["config", "--get-regexp", "^filter\\..*\\.(smudge|process)$"],
      false,
    ).stdout.trim()
  )
    throw new Error(
      "Filtres Git exécutables présents : récupération automatique refusée.",
    );
  const local = run(
    ["rev-parse", "--verify", "refs/heads/" + raw.branch],
    false,
  );
  if (local.code === 0 && local.stdout.trim() !== raw.commit)
    throw new Error(
      "La branche locale contient une autre version ; aucune branche écrasée.",
    );
  run(["check-ref-format", "refs/heads/" + raw.branch]);
  run(["fetch", "--no-tags", "origin", "refs/heads/" + raw.branch]);
  if (run(["rev-parse", "FETCH_HEAD"]).stdout.trim() !== raw.commit)
    throw new Error(
      "La branche distante a changé depuis l’export ; récupération abandonnée.",
    );
  const current = await o.account.profile();
  if (
    !current ||
    current.account !== owner.account ||
    current.organization.id !== owner.organizationId
  )
    throw new Error("Compte modifié pendant la récupération.");
  if (run(["status", "--porcelain", "--untracked-files=all"]).stdout.trim())
    throw new Error(
      "Projet modifié pendant la récupération ; bascule abandonnée.",
    );
  run(
    local.code === 0
      ? ["checkout", "--no-overwrite-ignore", raw.branch]
      : ["checkout", "--no-overwrite-ignore", "-b", raw.branch, raw.commit],
  );
  if (run(["rev-parse", "HEAD"]).stdout.trim() !== raw.commit)
    throw new Error(
      "La branche locale a changé pendant la bascule ; aucun tour lancé.",
    );
  return messages;
}

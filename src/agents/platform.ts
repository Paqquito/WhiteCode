// Implements: SPEC-CMD-079 (validated local agent publication after an independent human confirmation), gap E-217.
import { createHash } from "node:crypto";
import { readPrivateText } from "../shared/private-text";
import { parseAgent, type AgentDefinition } from "./definitions";
import type { CompanyAccount } from "../auth/company-account";
import { containsSecret } from "../shared/secrets";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export async function agentsPlatform(
  args: string,
  o: {
    account: CompanyAccount;
    agents: () => ReadonlyMap<string, AgentDefinition>;
    denied: (file: string) => boolean;
    redact: (text: string) => string;
    confirm: (preview: string, signal: AbortSignal) => Promise<boolean>;
    assertPolicy: () => void;
    signal: AbortSignal;
  },
): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean),
    verb = words[0] ?? "list";
  if (
    !["list", "publish", "runs"].includes(verb) ||
    (verb === "publish"
      ? words.length !== 2
      : words.length > 2 || (verb === "list" && words.length > 1))
  )
    throw Error(
      "Usage : /agents-platform [list | publish <agent local> | runs [identifiant]].",
    );
  o.assertPolicy();
  o.signal.throwIfAborted();
  const binding = await o.account.sessionBinding(),
    profile = await o.account.profile();
  if (!profile || binding !== (await o.account.sessionBinding()))
    throw Error("Connexion au compte de la société requise.");
  const owner = {
    account: profile.account,
    organizationId: profile.organization.id,
  };
  if (verb !== "publish") {
    const id = words[1];
    if (id && !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw Error("Identifiant d’agent hébergé invalide.");
    const raw = await o.account.request(
      "account",
      verb === "list" ? "agents/list" : "agents/runs",
      id ? { id } : {},
      o.signal,
      owner,
    );
    o.assertPolicy();
    if (!object(raw) || !Array.isArray(raw.items) || raw.items.length > 100)
      throw Error("Réponse de la plateforme invalide.");
    return (
      "Données distantes non fiables :\n" +
      o.redact(JSON.stringify(raw.items, null, 2))
    );
  }
  const selected = o.agents().get(words[1]!);
  if (
    !selected?.file ||
    !["user", "project"].includes(selected.source) ||
    o.denied(selected.file)
  )
    throw Error(
      "Une définition utilisateur ou de projet lisible et valide est requise.",
    );
  const source = readPrivateText(selected.file, 65536),
    definition = parseAgent(
      source,
      selected.file,
      selected.source as "user" | "project",
      () => {},
    );
  if (
    typeof definition === "string" ||
    !definition.instructions.trim() ||
    definition.instructions.length > 32768
  )
    throw Error("Définition locale invalide ou excessive.");
  // Local executables, hooks, connector tokens, memory paths and permission modes are never exported.
  if (
    definition.hooks ||
    definition.connectors?.length ||
    definition.memory ||
    definition.startupInstruction
  )
    throw Error(
      "Retirez les crochets, connecteurs, mémoires et instructions de démarrage locales avant publication.",
    );
  const published = {
    schemaVersion: 1,
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    tools: definition.tools ?? [],
    excludedTools: definition.excludedTools,
    ...(definition.maxIterations
      ? { maxIterations: definition.maxIterations }
      : {}),
  };
  const text = JSON.stringify(published),
    digest = createHash("sha256").update(source).digest("hex");
  if (
    containsSecret(source) ||
    o.redact(source) !== source ||
    /["'][\w-]*(?:password|secret|token|api[_-]?key)["']\s*:\s*["'][^"']{6,}["']/i.test(
      source,
    )
  )
    throw Error("La définition peut contenir un secret ; publication refusée.");
  const preview =
    "Publier cet agent vers la plateforme de la société ?\n" + text;
  o.assertPolicy();
  if (!(await o.confirm(preview, o.signal)))
    return "Publication annulée ; aucune définition envoyée.";
  o.signal.throwIfAborted();
  o.assertPolicy();
  if (
    o.denied(selected.file) ||
    createHash("sha256")
      .update(readPrivateText(selected.file, 65536))
      .digest("hex") !== digest ||
    binding !== (await o.account.sessionBinding())
  )
    throw Error(
      "Définition, autorisation ou compte modifié pendant l’accord ; publication abandonnée.",
    );
  const raw = await o.account.request(
    "account",
    "agents/publish",
    published,
    o.signal,
    owner,
  );
  o.assertPolicy();
  if (
    !object(raw) ||
    typeof raw.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id)
  )
    throw Error("Accusé de publication invalide.");
  return (
    "Agent publié : " +
    raw.id +
    ". Consultez ses exécutions avec /agents-platform runs " +
    raw.id +
    "."
  );
}

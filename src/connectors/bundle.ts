// Implements: SPEC-EXT-016 (local MCPB 0.3 archives, confirmation and content-addressed cache), gap E-190.
import * as fs from "node:fs";
import { join, resolve, dirname, isAbsolute, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readConnectorZip } from "../platform/connector-zip";
interface Bundle {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly sha256: string;
  readonly server: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const file = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  !value
    .split("/")
    .some(
      (part) => !part || part === "." || part === ".." || part.includes(":"),
    );
export function parseConnectorBundle(
  bytes: Buffer,
  maxSize: number,
  platform: "windows" | "macos" | "linux" | "other",
): Bundle {
  if (platform === "other")
    throw Error(
      "Plateforme non prise en charge par les archives de connecteurs.",
    );
  const files = readConnectorZip(bytes, maxSize),
    source = files.get("manifest.json");
  if (!source || source.length > 65536)
    throw Error("Manifeste d’archive absent ou trop volumineux.");
  const raw: unknown = JSON.parse(source.toString("utf8"));
  if (
    !object(raw) ||
    raw.manifest_version !== "0.3" ||
    typeof raw.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.name) ||
    typeof raw.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/.test(
      raw.version,
    ) ||
    typeof raw.description !== "string" ||
    !raw.description.trim() ||
    raw.description.length > 2000 ||
    !object(raw.author) ||
    typeof raw.author.name !== "string" ||
    !raw.author.name ||
    !object(raw.server) ||
    !["node", "python", "binary"].includes(String(raw.server.type)) ||
    !file(raw.server.entry_point) ||
    !files.has(raw.server.entry_point) ||
    !object(raw.server.mcp_config)
  )
    throw Error("Manifeste MCPB 0.3 invalide.");
  if (
    raw.user_config !== undefined &&
    (!object(raw.user_config) || Object.keys(raw.user_config).length)
  )
    throw Error(
      "Cette version refuse les archives exigeant des options utilisateur ; aucun secret ne sera écrit dans la déclaration.",
    );
  const target =
    platform === "windows"
      ? "win32"
      : platform === "macos"
        ? "darwin"
        : "linux";
  if (
    object(raw.compatibility) &&
    raw.compatibility.platforms !== undefined &&
    (!Array.isArray(raw.compatibility.platforms) ||
      !raw.compatibility.platforms.includes(target))
  )
    throw Error("Plateforme non prise en charge par l’archive.");
  const common = raw.server.mcp_config,
    override =
      object(common.platform_overrides) &&
      object(common.platform_overrides[target])
        ? common.platform_overrides[target]
        : {},
    command = override.command ?? common.command,
    args = override.args ?? common.args ?? [],
    env = {
      ...(object(common.env) ? common.env : {}),
      ...(object(override.env) ? override.env : {}),
    };
  if (
    typeof command !== "string" ||
    !command ||
    command.length > 4096 ||
    command.startsWith("-") ||
    /[\u0000-\u001f]/.test(command) ||
    !Array.isArray(args) ||
    args.length > 100 ||
    args.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 8192 ||
        /[\u0000\r\n]/.test(value),
    ) ||
    Object.keys(env).length > 100 ||
    Object.entries(env).some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof value !== "string" ||
        value.length > 8192 ||
        /[\u0000]/.test(value),
    )
  )
    throw Error("Commande de connecteur invalide.");
  for (const value of [command, ...args, ...Object.values(env)])
    if (typeof value === "string" && /\$\{(?!__dirname\})/.test(value))
      throw Error("Variable de manifeste non prise en charge.");
  return {
    name: raw.name,
    version: raw.version,
    description: raw.description,
    files,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    server: {
      command,
      args: args as string[],
      env: env as Record<string, string>,
    },
  };
}
/** Returns a declaration only after the human reviewed the executable command and every extracted file. */
export async function installConnectorBundle(
  bundle: Bundle,
  o: { configDir: string; confirm: (summary: string) => Promise<boolean> },
): Promise<
  | {
      name: string;
      declaration: {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
    }
  | undefined
> {
  const root = resolve(o.configDir),
    target = join(
      root,
      "connectors",
      bundle.name,
      bundle.version,
      bundle.sha256,
    );
  if (
    !(await o.confirm(
      `Installer le connecteur ${bundle.name} ${bundle.version} ?\n${bundle.description}\nSHA-256 : ${bundle.sha256}\nCommande : ${bundle.server.command}\nArguments : ${JSON.stringify(bundle.server.args)}\nVariables : ${Object.keys(bundle.server.env).join(", ")}\nFichiers : ${[...bundle.files.keys()].join(", ")}`,
    ))
  )
    return;
  if (fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink())
    throw Error("Profil lié refusé.");
  const ensure = (path: string) => {
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
      throw Error("Cache hors du profil.");
    let parent = root;
    for (const component of rel.split(sep)) {
      const next = join(parent, component);
      try {
        fs.mkdirSync(next, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(next);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        fs.realpathSync(next) !== next
      )
        throw Error("Cache de connecteur lié.");
      parent = next;
    }
  };
  ensure(dirname(target));
  const verify = () => {
    let count = 0;
    const walk = (directory: string, prefix = "") => {
      const parent = fs.lstatSync(directory);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory
      )
        throw Error("Cache d’archive lié.");
      for (const entry of fs.readdirSync(directory)) {
        const name = prefix + entry,
          path = join(directory, entry),
          stat = fs.lstatSync(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (
            ![...bundle.files.keys()].some((file) =>
              file.startsWith(name + "/"),
            )
          )
            throw Error("Dossier supplémentaire dans le cache.");
          walk(path, name + "/");
        } else {
          const expected = bundle.files.get(name);
          if (
            !expected ||
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.size !== expected.length ||
            !fs.readFileSync(path).equals(expected)
          )
            throw Error("Cache d’archive altéré ; aucune commande lancée.");
          count++;
        }
      }
    };
    walk(target);
    if (count !== bundle.files.size) throw Error("Cache d’archive incomplet.");
  };
  if (fs.existsSync(target)) {
    if (
      fs.lstatSync(target).isSymbolicLink() ||
      !fs.lstatSync(target).isDirectory()
    )
      throw Error("Cache d’archive invalide.");
    verify();
  } else {
    const staging = join(dirname(target), ".candidate-" + randomUUID());
    fs.mkdirSync(staging, { mode: 0o700 });
    const initial = fs.lstatSync(staging);
    try {
      for (const [name, bytes] of bundle.files) {
        const path = join(staging, ...name.split("/"));
        fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path, bytes, { flag: "wx", mode: 0o700 });
      }
      fs.renameSync(staging, target);
      verify();
    } catch (error) {
      try {
        const stat = fs.lstatSync(staging);
        if (
          !stat.isSymbolicLink() &&
          stat.ino === initial.ino &&
          stat.dev === initial.dev &&
          fs.realpathSync(staging) === staging
        )
          fs.rmSync(staging, { recursive: true });
      } catch {}
      throw error;
    }
  }
  const expand = (value: string) => value.split("${__dirname}").join(target);
  let command = expand(bundle.server.command);
  if (!isAbsolute(command) && /[\\/]/.test(command)) {
    if (!file(command)) throw Error("Commande sortant de l’archive.");
    command = join(target, ...command.split("/"));
  }
  return {
    name: bundle.name,
    declaration: {
      command,
      args: bundle.server.args.map(expand),
      env: Object.fromEntries(
        Object.entries(bundle.server.env).map(([name, value]) => [
          name,
          expand(value),
        ]),
      ),
    },
  };
}

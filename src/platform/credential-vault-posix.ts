// Supports: SPEC-PER-027 (preferred macOS keychain and Linux Secret Service; no automatic unlock in automation), E-135.
import { dlopen, toArrayBuffer, type Pointer } from "bun:ffi";
import { currentPlatform, findExecutable } from "./system";
import { startChild } from "./process";
import { VaultUnavailable, type CredentialVault } from "./credential-vault";

const openMac = () => ({
  keychain: dlopen("/System/Library/Frameworks/Security.framework/Security", {
    SecKeychainFindGenericPassword: { args: ["ptr", "u32", "buffer", "u32", "buffer", "buffer", "buffer", "buffer"], returns: "i32" },
    SecKeychainAddGenericPassword: { args: ["ptr", "u32", "buffer", "u32", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
    SecKeychainItemModifyAttributesAndData: { args: ["ptr", "ptr", "u32", "buffer"], returns: "i32" },
    SecKeychainItemDelete: { args: ["ptr"], returns: "i32" },
    SecKeychainItemFreeContent: { args: ["ptr", "ptr"], returns: "i32" },
    SecKeychainGetUserInteractionAllowed: { args: ["buffer"], returns: "i32" },
    SecKeychainSetUserInteractionAllowed: { args: ["u8"], returns: "i32" },
  }),
  objects: dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", { CFRelease: { args: ["ptr"], returns: "void" } }),
});
let mac: ReturnType<typeof openMac> | undefined;
function macOperation<T>(interactive: boolean, operation: (api: ReturnType<typeof openMac>) => T): T {
  let api: ReturnType<typeof openMac>;
  try { api = mac ??= openMac(); } catch { throw new VaultUnavailable(); }
  const previous = Buffer.alloc(1);
  if (api.keychain.symbols.SecKeychainGetUserInteractionAllowed(previous) !== 0 || api.keychain.symbols.SecKeychainSetUserInteractionAllowed(interactive ? 1 : 0) !== 0) throw new VaultUnavailable(true);
  try { return operation(api); } finally { api.keychain.symbols.SecKeychainSetUserInteractionAllowed(previous[0]!); }
}
function checkMac(code: number): void { if (code !== 0) throw new VaultUnavailable([-25308, -25293, -128, -25315, -25291].includes(code)); }

const openLinux = () => ({
  secrets: dlopen("libsecret-1.so.0", {
    secret_service_get_sync: { args: ["u32", "ptr", "buffer"], returns: "ptr" },
    secret_service_search_sync: { args: ["ptr", "ptr", "ptr", "u32", "ptr", "buffer"], returns: "ptr" },
    secret_item_get_locked: { args: ["ptr"], returns: "i32" },
    secret_item_get_secret: { args: ["ptr"], returns: "ptr" },
    secret_value_get_text: { args: ["ptr"], returns: "cstring" },
    secret_value_unref: { args: ["ptr"], returns: "void" },
  }),
  memory: dlopen("libglib-2.0.so.0", {
    g_hash_table_new: { args: ["ptr", "ptr"], returns: "ptr" },
    g_hash_table_insert: { args: ["ptr", "buffer", "buffer"], returns: "i32" },
    g_hash_table_unref: { args: ["ptr"], returns: "void" },
    g_list_free: { args: ["ptr"], returns: "void" },
    g_error_free: { args: ["ptr"], returns: "void" },
  }),
  objects: dlopen("libgobject-2.0.so.0", { g_object_unref: { args: ["ptr"], returns: "void" } }),
});
let linux: ReturnType<typeof openLinux> | undefined;
function linuxRead(serviceName: string, account: string, interactive = false): string | undefined {
  let api: ReturnType<typeof openLinux>;
  try { api = linux ??= openLinux(); } catch { throw new VaultUnavailable(); }
  const error = Buffer.alloc(8), table = api.memory.symbols.g_hash_table_new(null, null);
  if (!table) throw new VaultUnavailable();
  const serviceKey = Buffer.from("service\0"), serviceValue = Buffer.from(serviceName + "\0");
  const accountKey = Buffer.from("account\0"), accountValue = Buffer.from(account + "\0");
  api.memory.symbols.g_hash_table_insert(table, serviceKey, serviceValue);
  api.memory.symbols.g_hash_table_insert(table, accountKey, accountValue);
  let service: bigint | Pointer | null = null, list: bigint | Pointer | null = null;
  try {
    service = api.secrets.symbols.secret_service_get_sync(2, null, error);
    if (!service || error.readBigUInt64LE()) throw new VaultUnavailable();
    // ALL + LOAD_SECRETS; only a human session may request the system unlock prompt.
    list = api.secrets.symbols.secret_service_search_sync(service, null, table, 2 | 8 | (interactive ? 4 : 0), null, error);
    if (error.readBigUInt64LE()) throw new VaultUnavailable(true); // An established service refusing access is never an absent vault.
    if (!list) return undefined;
    let entry = BigInt(list), found: string | undefined;
    while (entry) {
      const fields = Buffer.from(toArrayBuffer(entry, 0, 24)), item = fields.readBigUInt64LE();
      if (api.secrets.symbols.secret_item_get_locked(item)) throw new VaultUnavailable(true);
      const value = api.secrets.symbols.secret_item_get_secret(item);
      if (!value) throw new VaultUnavailable(true);
      try {
        const text = String(api.secrets.symbols.secret_value_get_text(value));
        if (found !== undefined && found !== text) throw new Error("Entrées du service de secrets en conflit.");
        found = text;
      } finally { api.secrets.symbols.secret_value_unref(value); }
      entry = fields.readBigUInt64LE(8);
    }
    return found;
  } finally {
    if (list) {
      let entry: bigint = BigInt(list);
      while (entry) {
        const fields = Buffer.from(toArrayBuffer(entry, 0, 24));
        api.objects.symbols.g_object_unref(fields.readBigUInt64LE()); entry = fields.readBigUInt64LE(8);
      }
      api.memory.symbols.g_list_free(list);
    }
    if (service) api.objects.symbols.g_object_unref(service);
    if (error.readBigUInt64LE()) api.memory.symbols.g_error_free(error.readBigUInt64LE());
    api.memory.symbols.g_hash_table_unref(table);
  }
}

async function secretTool(args: readonly string[], environment: Readonly<Record<string, string>>, value?: string): Promise<void> {
  const file = findExecutable("secret-tool");
  if (!file) throw new VaultUnavailable();
  const child = startChild(file, args, { cwd: "/", env: environment, ...(value === undefined ? {} : { input: value }), onData: () => {}, onErrorData: () => {} });
  const timeout = setTimeout(() => { void child.killTree(0); }, 30_000);
  try { if (await child.exited !== 0) throw new Error("Opération du service de secrets refusée."); }
  finally { clearTimeout(timeout); }
}

export function posixCredentialVault(interactive: boolean, environment: Readonly<Record<string, string>>): CredentialVault {
  if (currentPlatform() === "macos") return {
    read(service, account) {
      return macOperation(interactive, (api) => {
        const name = Buffer.from(service), user = Buffer.from(account), length = Buffer.alloc(4), data = Buffer.alloc(8), item = Buffer.alloc(8);
        const code = api.keychain.symbols.SecKeychainFindGenericPassword(null, name.length, name, user.length, user, length, data, item);
        if (code === -25300) return undefined;
        checkMac(code);
        try { return Buffer.from(toArrayBuffer(data.readBigUInt64LE(), 0, length.readUInt32LE())).toString("utf8"); }
        finally { api.keychain.symbols.SecKeychainItemFreeContent(null, data.readBigUInt64LE()); api.objects.symbols.CFRelease(item.readBigUInt64LE()); }
      });
    },
    write(service, account, value) {
      macOperation(interactive, (api) => {
        const name = Buffer.from(service), user = Buffer.from(account), bytes = Buffer.from(value), length = Buffer.alloc(4), data = Buffer.alloc(8), item = Buffer.alloc(8);
        try {
          const code = api.keychain.symbols.SecKeychainFindGenericPassword(null, name.length, name, user.length, user, length, data, item);
          if (code === -25300) { checkMac(api.keychain.symbols.SecKeychainAddGenericPassword(null, name.length, name, user.length, user, bytes.length, bytes, null)); return; }
          checkMac(code);
          try { checkMac(api.keychain.symbols.SecKeychainItemModifyAttributesAndData(item.readBigUInt64LE(), null, bytes.length, bytes)); }
          finally { api.keychain.symbols.SecKeychainItemFreeContent(null, data.readBigUInt64LE()); api.objects.symbols.CFRelease(item.readBigUInt64LE()); }
        } finally { bytes.fill(0); }
      });
    },
    remove(service, account) {
      macOperation(interactive, (api) => {
        const name = Buffer.from(service), user = Buffer.from(account), length = Buffer.alloc(4), data = Buffer.alloc(8), item = Buffer.alloc(8);
        const code = api.keychain.symbols.SecKeychainFindGenericPassword(null, name.length, name, user.length, user, length, data, item);
        if (code === -25300) return;
        checkMac(code);
        try { checkMac(api.keychain.symbols.SecKeychainItemDelete(item.readBigUInt64LE())); }
        finally { api.keychain.symbols.SecKeychainItemFreeContent(null, data.readBigUInt64LE()); api.objects.symbols.CFRelease(item.readBigUInt64LE()); }
      });
    },
  };
  return {
    read: (service, account) => linuxRead(service, account, interactive),
    async write(service, account, value) {
      // Creation in a desktop vault may request a system prompt; only a human login may initiate it in this tranche.
      if (!interactive) throw new Error("Création d'une entrée du service de secrets réservée à une connexion interactive.");
      if (Buffer.byteLength(value, "utf8") >= 8192) throw new Error("Identifiant trop volumineux pour cette version du service de secrets.");
      linuxRead(service, account, true);
      await secretTool(["store", "--label", service, "service", service, "account", account], environment, value);
      if (linuxRead(service, account) !== value) throw new Error("Écriture du service de secrets non vérifiée ; le fichier original est conservé.");
    },
    async remove(service, account) {
      if (linuxRead(service, account, interactive) === undefined) return;
      await secretTool(["clear", "service", service, "account", account], environment);
      if (linuxRead(service, account) !== undefined) throw new Error("Suppression des identifiants incomplète.");
    },
  };
}

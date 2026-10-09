// Implements: SPEC-CFG-003 (§ 5.1 macOS profile channel, § 12 protected local source), gap E-125.
// Core Foundation reads only forced preferences; no shell, environment expansion or direct plist fallback.
import { dlopen } from "bun:ffi";
import { currentPlatform } from "./system";

export interface ProfilePolicy {
  readonly text?: string;
  readonly error?: string;
}
export type ProfilePolicyReader = () => ProfilePolicy;

const MAX_BYTES = 1024 * 1024;
const UTF8 = 0x08000100;
const openApi = () => dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFStringCreateWithCString: { args: ["ptr", "buffer", "u32"], returns: "ptr" },
  CFPreferencesAppSynchronize: { args: ["ptr"], returns: "bool" },
  CFPreferencesAppValueIsForced: { args: ["ptr", "ptr"], returns: "bool" },
  CFPreferencesCopyAppValue: { args: ["ptr", "ptr"], returns: "ptr" },
  CFGetTypeID: { args: ["ptr"], returns: "u64" },
  CFStringGetTypeID: { args: [], returns: "u64" },
  CFStringGetLength: { args: ["ptr"], returns: "i64" },
  CFStringGetCString: { args: ["ptr", "buffer", "i64", "u32"], returns: "bool" },
  CFRelease: { args: ["ptr"], returns: "void" },
});
let api: ReturnType<typeof openApi> | undefined;

/** `Policy`, a forced JSON string in the compiled application domain. User and set-once values are ignored. */
export function readMacManagedProfile(domain: string): ProfilePolicy {
  if (currentPlatform() !== "macos") return {};
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(domain) || domain.length > 255) return { error: "invalid-domain" };
  try {
    const native = (api ??= openApi()).symbols;
    const application = native.CFStringCreateWithCString(null, Buffer.from(`${domain}\0`, "utf8"), UTF8);
    const key = native.CFStringCreateWithCString(null, Buffer.from("Policy\0", "utf8"), UTF8);
    let value: ReturnType<typeof native.CFPreferencesCopyAppValue> = null;
    try {
      if (!application || !key) return { error: "unavailable" };
      // CFPreferences caches reads: synchronise before every security check, without setting any preference.
      if (!native.CFPreferencesAppSynchronize(application)) return { error: "unverifiable-profile" };
      if (!native.CFPreferencesAppValueIsForced(key, application)) return {};
      value = native.CFPreferencesCopyAppValue(key, application);
      if (!native.CFPreferencesAppValueIsForced(key, application)) return { error: "profile-authority-changed" };
      if (!value || native.CFGetTypeID(value) !== native.CFStringGetTypeID()) return { error: "invalid-type" };
      const length = Number(native.CFStringGetLength(value));
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES) return { error: "invalid-size" };
      const bytes = Buffer.alloc(Math.min(length * 3, MAX_BYTES) + 1);
      if (!native.CFStringGetCString(value, bytes, bytes.length, UTF8)) return { error: "invalid-encoding-or-size" };
      const end = bytes.indexOf(0);
      if (end < 0 || end > MAX_BYTES) return { error: "invalid-size" };
      const text = bytes.subarray(0, end).toString("utf8");
      // The UTF-16 length also detects embedded NUL truncation, including JSON followed by another document.
      if (text.length !== length) return { error: "invalid-value" };
      return { text };
    } finally {
      if (value) native.CFRelease(value);
      if (key) native.CFRelease(key);
      if (application) native.CFRelease(application);
    }
  } catch {
    return { error: "unavailable" };
  }
}

// Supports: SPEC-INT-015 (window-scoped Win32 actions, protected capture and global emergency shortcut).
import { dlopen, JSCallback, type Pointer } from "bun:ffi";
import { policyPrincipal } from "./policy-principal";
import { captureComputerWindow } from "./computer-capture";

export interface ComputerWindow { readonly id: string; readonly pid: number; readonly startedAt: string; readonly executable: string; readonly title: string; readonly width: number; readonly height: number }
export interface ComputerDriver {
  windows(): ComputerWindow[];
  inspect(id: string): ComputerWindow;
  capture(window: ComputerWindow, signal: AbortSignal): Promise<Uint8Array>;
  click(window: ComputerWindow, x: number, y: number): void;
  type(window: ComputerWindow, character: string): void;
  close(): void;
}
const fail = () => new Error("Native application control unavailable or target changed.");
const load = () => ({
  user: dlopen("user32.dll", {
    EnumWindows: { args: ["function", "u64"], returns: "i32" }, IsWindowVisible: { args: ["u64"], returns: "i32" },
    GetWindowThreadProcessId: { args: ["u64", "buffer"], returns: "u32" }, GetWindowTextW: { args: ["u64", "buffer", "i32"], returns: "i32" },
    GetClientRect: { args: ["u64", "buffer"], returns: "i32" }, GetAncestor: { args: ["u64", "u32"], returns: "u64" },
    ChildWindowFromPointEx: { args: ["u64", "u64", "u32"], returns: "u64" }, MapWindowPoints: { args: ["u64", "u64", "buffer", "u32"], returns: "i32" },
    SendMessageTimeoutW: { args: ["u64", "u32", "u64", "u64", "u32", "u32", "buffer"], returns: "u64" },
    GetGUIThreadInfo: { args: ["u32", "buffer"], returns: "i32" }, GetWindowLongPtrW: { args: ["u64", "i32"], returns: "u64" },
    GetClassNameW: { args: ["u64", "buffer", "i32"], returns: "i32" },
    RegisterHotKey: { args: ["u64", "i32", "u32", "u32"], returns: "i32" }, UnregisterHotKey: { args: ["u64", "i32"], returns: "i32" },
    PeekMessageW: { args: ["buffer", "u64", "u32", "u32", "u32"], returns: "i32" },
  }),
  kernel: dlopen("kernel32.dll", { OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" }, CloseHandle: { args: ["u64"], returns: "i32" }, QueryFullProcessImageNameW: { args: ["u64", "u32", "buffer", "buffer"], returns: "i32" }, GetProcessTimes: { args: ["u64", "buffer", "buffer", "buffer", "buffer"], returns: "i32" } }),
  tokens: dlopen("advapi32.dll", { OpenProcessToken: { args: ["u64", "u32", "buffer"], returns: "i32" }, GetTokenInformation: { args: ["u64", "u32", "buffer", "u32", "buffer"], returns: "i32" }, IsValidSid: { args: ["ptr"], returns: "i32" }, GetLengthSid: { args: ["ptr"], returns: "u32" }, CopySid: { args: ["u32", "buffer", "ptr"], returns: "i32" } }),
});
/** No desktop capture or global pointer/keyboard injection: every action names an owned application window. */
export function openComputerDriver(stopped: () => void): ComputerDriver {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw new Error("Native computer control currently requires 64-bit Windows.");
  const native = load(), hotkey = 0x5a31, message = Buffer.alloc(48); let closed = false, principal: string;
  try { principal = policyPrincipal(); } catch (error) { Object.values(native).forEach(library => library.close()); throw error; }
  if (!native.user.symbols.RegisterHotKey(0n, hotkey, 0x4003, 0x13)) { Object.values(native).forEach(library => library.close()); throw new Error("Global emergency shortcut Ctrl+Alt+Pause is unavailable; application control is disabled."); }
  const poll = setInterval(() => { while (!closed && native.user.symbols.PeekMessageW(message, 0n, 0x312, 0x312, 1)) if (message.readBigUInt64LE(16) === BigInt(hotkey)) stopped(); }, 20); poll.unref();
  const inspect = (id: string): ComputerWindow => {
    if (closed || !/^[1-9][0-9]{0,19}$/.test(id)) throw fail(); const hwnd = BigInt(id);
    if (!native.user.symbols.IsWindowVisible(hwnd) || native.user.symbols.GetAncestor(hwnd, 2) !== hwnd) throw fail();
    const pid = Buffer.alloc(4); if (!native.user.symbols.GetWindowThreadProcessId(hwnd, pid)) throw fail();
    const processHandle = native.kernel.symbols.OpenProcess(0x1000, 0, pid.readUInt32LE()); if (!processHandle) throw fail(); let token = 0n;
    try {
      const tokenHandle = Buffer.alloc(8), info = Buffer.alloc(1024), length = Buffer.alloc(4);
      if (!native.tokens.symbols.OpenProcessToken(processHandle, 8, tokenHandle)) throw fail(); token = tokenHandle.readBigUInt64LE();
      if (!native.tokens.symbols.GetTokenInformation(token, 1, info, info.length, length) || length.readUInt32LE() > info.length) throw fail();
      const sidPointer = Number(info.readBigUInt64LE()) as Pointer;
      if (!Number.isSafeInteger(sidPointer) || !native.tokens.symbols.IsValidSid(sidPointer)) throw fail(); const size = native.tokens.symbols.GetLengthSid(sidPointer);
      if (size < 8 || size > 68) throw fail(); const sid = Buffer.alloc(size);
      if (!native.tokens.symbols.CopySid(size, sid, sidPointer) || principal !== `sid:${sid.toString("hex")}`) throw fail();
      const path = Buffer.alloc(65536), count = Buffer.alloc(4); count.writeUInt32LE(32768);
      if (!native.kernel.symbols.QueryFullProcessImageNameW(processHandle, 0, path, count)) throw fail();
      const created = Buffer.alloc(8); if (!native.kernel.symbols.GetProcessTimes(processHandle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw fail();
      const title = Buffer.alloc(2048), chars = native.user.symbols.GetWindowTextW(hwnd, title, 1024), rect = Buffer.alloc(16);
      if (!native.user.symbols.GetClientRect(hwnd, rect)) throw fail(); const width = rect.readInt32LE(8), height = rect.readInt32LE(12);
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 4194304) throw fail();
      return { id, pid: pid.readUInt32LE(), startedAt: created.readBigUInt64LE().toString(), executable: path.subarray(0, count.readUInt32LE() * 2).toString("utf16le"), title: title.subarray(0, Math.max(0, chars) * 2).toString("utf16le"), width, height };
    } finally { if (token) native.kernel.symbols.CloseHandle(token); native.kernel.symbols.CloseHandle(processHandle); }
  };
  const check = (target: ComputerWindow) => { const current = inspect(target.id); if (current.pid !== target.pid || current.startedAt !== target.startedAt || current.executable !== target.executable || current.title !== target.title || current.width !== target.width || current.height !== target.height) throw fail(); return BigInt(target.id); };
  const send = (hwnd: bigint, kind: number, value: bigint, parameter: bigint, timeout = 50) => { if (!native.user.symbols.SendMessageTimeoutW(hwnd, kind, value, parameter, 2, timeout, Buffer.alloc(8))) throw fail(); };
  return {
    inspect,
    windows() { const found: ComputerWindow[] = []; const callback = new JSCallback((hwnd: bigint) => { if (found.length < 200) { try { found.push(inspect(String(hwnd))); } catch { /* Unavailable or foreign windows have no authority. */ } } return 1; }, { args: ["u64", "u64"], returns: "i32" }); try { native.user.symbols.EnumWindows(callback.ptr!, 0n); } finally { callback.close(); } return found; },
    async capture(target, signal) { check(target); const bytes = await captureComputerWindow(target, signal); check(target); return bytes; },
    click(target, x, y) {
      const root = check(target); if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= target.width || y >= target.height) throw fail();
      const point = Buffer.alloc(8); point.writeInt32LE(x); point.writeInt32LE(y, 4); let hwnd = root;
      for (let depth = 0; depth < 16; depth++) { const child = native.user.symbols.ChildWindowFromPointEx(hwnd, point.readBigUInt64LE(), 7); if (!child || child === hwnd) break; native.user.symbols.MapWindowPoints(hwnd, child, point, 1); hwnd = child; }
      if (native.user.symbols.GetAncestor(hwnd, 2) !== root) throw fail(); const parameter = BigInt((point.readInt32LE(4) & 0xffff) << 16 | (point.readInt32LE() & 0xffff)) & 0xffffffffn;
      check(target); send(hwnd, 0x201, 1n, parameter); check(target); send(hwnd, 0x202, 0n, parameter);
    },
    type(target, character) {
      const root = check(target), pid = Buffer.alloc(4), thread = native.user.symbols.GetWindowThreadProcessId(root, pid), info = Buffer.alloc(72); info.writeUInt32LE(72);
      if (!native.user.symbols.GetGUIThreadInfo(thread, info)) throw fail(); const focus = info.readBigUInt64LE(16), name = Buffer.alloc(512), chars = native.user.symbols.GetClassNameW(focus, name, 256);
      if (!focus || native.user.symbols.GetAncestor(focus, 2) !== root || !/edit/i.test(name.subarray(0, Math.max(0, chars) * 2).toString("utf16le")) || (native.user.symbols.GetWindowLongPtrW(focus, -16) & 0x20n) !== 0n || character.length !== 1 || /[\u0000-\u001f\u007f]/.test(character)) throw fail(); check(target); send(focus, 0x102, BigInt(character.charCodeAt(0)), 1n);
    },
    close() { if (closed) return; closed = true; clearInterval(poll); native.user.symbols.UnregisterHotKey(0n, hotkey); Object.values(native).forEach(library => library.close()); },
  };
}

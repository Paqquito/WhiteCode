// Supports: SPEC-INT-015 (independent native Win32 application; no product driver or mocked UI).
import { dlopen } from "bun:ffi";
const api = dlopen("user32.dll", {
  CreateWindowExW: { args: ["u32", "buffer", "buffer", "u32", "i32", "i32", "i32", "i32", "u64", "u64", "u64", "ptr"], returns: "u64" },
  DestroyWindow: { args: ["u64"], returns: "i32" }, SetFocus: { args: ["u64"], returns: "u64" },
  ShowWindow: { args: ["u64", "i32"], returns: "i32" }, UpdateWindow: { args: ["u64"], returns: "i32" },
  PeekMessageW: { args: ["buffer", "u64", "u32", "u32", "u32"], returns: "i32" }, TranslateMessage: { args: ["buffer"], returns: "i32" }, DispatchMessageW: { args: ["buffer"], returns: "u64" },
  SendMessageW: { args: ["u64", "u32", "u64", "u64"], returns: "u64" }, GetWindowTextW: { args: ["u64", "buffer", "i32"], returns: "i32" },
  SetWindowTextW: { args: ["u64", "buffer"], returns: "i32" }, SendInput: { args: ["u32", "buffer", "i32"], returns: "u32" },
  RegisterHotKey: { args: ["u64", "i32", "u32", "u32"], returns: "i32" }, UnregisterHotKey: { args: ["u64", "i32"], returns: "i32" },
});
const wide = (text: string) => Buffer.from(text + "\0", "utf16le"), title = "Owned Native Control Fixture " + process.pid;
const root = api.symbols.CreateWindowExW(0, wide("STATIC"), wide(title), 0x10cf0000, 50, 50, 340, 220, 0n, 0n, 0n, null);
if (!root) throw Error("Native fixture window creation failed.");
const button = api.symbols.CreateWindowExW(0, wide("BUTTON"), wide("Probe action"), 0x50000003, 20, 20, 180, 30, root, 0n, 0n, null);
const edit = api.symbols.CreateWindowExW(0, wide("EDIT"), wide(""), 0x50800000, 20, 70, 250, 30, root, 0n, 0n, null);
if (!button || !edit) throw Error("Native fixture controls unavailable."); api.symbols.ShowWindow(root, 1); api.symbols.UpdateWindow(root); api.symbols.SetFocus(edit);
console.log(JSON.stringify({ ready: true, window: String(root), button: String(button), pid: process.pid, title }));
const message = Buffer.alloc(48), timer = setInterval(() => { while (api.symbols.PeekMessageW(message, 0n, 0, 0, 1)) { api.symbols.TranslateMessage(message); api.symbols.DispatchMessageW(message); } }, 5);
let input = "";
process.stdin.setEncoding("utf8"); process.stdin.on("data", part => { input += part; for (;;) { const end = input.indexOf("\n"); if (end < 0) break; const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
  if (request.action === "hotkey") { const keys = [[0x11, 0], [0x12, 0], [0x13, 0], [0x13, 2], [0x12, 2], [0x11, 2]], events = Buffer.alloc(keys.length * 40); keys.forEach(([key, flags], i) => { events.writeUInt32LE(1, i * 40); events.writeUInt16LE(key!, i * 40 + 8); events.writeUInt32LE(flags!, i * 40 + 12); }); console.log(JSON.stringify({ id: request.id, sent: api.symbols.SendInput(keys.length, events, 40) })); }
  else if (request.action === "reserve_hotkey") console.log(JSON.stringify({ id: request.id, registered: api.symbols.RegisterHotKey(0n, 0x5a32, 0x4003, 0x13) }));
  else if (request.action === "rename") { api.symbols.SetWindowTextW(root, wide(request.title)); console.log(JSON.stringify({ id: request.id, renamed: true })); }
  else { const text = Buffer.alloc(4096), count = api.symbols.GetWindowTextW(edit, text, 2048); console.log(JSON.stringify({ id: request.id, checked: Number(api.symbols.SendMessageW(button, 0xf0, 0n, 0n)), text: text.subarray(0, count * 2).toString("utf16le") })); }
} });
const close = () => { clearInterval(timer); api.symbols.UnregisterHotKey(0n, 0x5a32); api.symbols.DestroyWindow(root); api.close(); process.exit(0); }; process.stdin.on("end", close); process.on("SIGTERM", close);

// Implements: SPEC-VOX-001 (lazy native microphone capture; PCM never written to disk).
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ordinaryPrivateFile } from "../shared/private-text";
import { writeAtomic } from "../tools/text-file";
import { mkdirSync } from "node:fs";
import { startChild } from "./process";
import { findExecutable, type PlatformName } from "./system";
import type { MicrophoneCapture } from "../voice/input";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

// WinMM owns four prepared input buffers. Terminating the helper releases the device with its process.
const WINDOWS_AUDIO = buildFlag("ui_dictation") ? String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class MicrophoneInput {
 static volatile bool Running=true;
 [StructLayout(LayoutKind.Sequential, Pack=2)] public struct Format { public ushort tag,channels; public uint rate,average; public ushort align,bits,extra; }
 [StructLayout(LayoutKind.Sequential)] public struct Header { public IntPtr data; public uint size,recorded; public UIntPtr user; public uint flags,loops; public IntPtr next; public UIntPtr reserved; }
 [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr device,uint id,ref Format format,IntPtr callback,IntPtr instance,uint flags);
 [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr device,IntPtr header,uint size);
 [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr device,IntPtr header,uint size);
 [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr device);
 [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr device);
 [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr device,IntPtr header,uint size);
 [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr device);
 static void Check(uint result) { if(result!=0)throw new IOException("Microphone input unavailable."); }
 public static void Run() {
  Console.Error.WriteLine("AUDIO_READY");if(Console.ReadLine()!="start")return;
  new Thread(delegate(){Console.OpenStandardInput().ReadByte();Running=false;}){IsBackground=true}.Start();
  Format format=new Format{tag=1,channels=1,rate=16000,average=32000,align=2,bits=16,extra=0};
  IntPtr device; Check(waveInOpen(out device,UInt32.MaxValue,ref format,IntPtr.Zero,IntPtr.Zero,0));
  IntPtr[] headers=new IntPtr[4],data=new IntPtr[4];uint size=(uint)Marshal.SizeOf(typeof(Header));
  try {
   for(int i=0;i<4;i++){data[i]=Marshal.AllocHGlobal(3200);headers[i]=Marshal.AllocHGlobal((int)size);Marshal.StructureToPtr(new Header{data=data[i],size=3200},headers[i],false);Check(waveInPrepareHeader(device,headers[i],size));Check(waveInAddBuffer(device,headers[i],size));}
   Check(waveInStart(device));Stream output=Console.OpenStandardOutput();byte[] bytes=new byte[3200];
   while(Running){for(int i=0;i<4;i++){Header header=(Header)Marshal.PtrToStructure(headers[i],typeof(Header));if((header.flags&1)!=0){int count=(int)Math.Min(header.recorded,3200);if(count>0){Marshal.Copy(header.data,bytes,0,count);output.Write(bytes,0,count);output.Flush();}header.recorded=0;Marshal.StructureToPtr(header,headers[i],false);Check(waveInAddBuffer(device,headers[i],size));}}Thread.Sleep(5);}
  }finally{waveInReset(device);for(int i=0;i<4;i++){if(headers[i]!=IntPtr.Zero){waveInUnprepareHeader(device,headers[i],size);Marshal.FreeHGlobal(headers[i]);}if(data[i]!=IntPtr.Zero)Marshal.FreeHGlobal(data[i]);}waveInClose(device);}
 }
}
` : "";
export function windowsAudioScript(compileOnly = false): string {
  if (!buildFlag("ui_dictation")) throw Error("Microphone capture unavailable in this build.");
  return (
    "$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n" +
    WINDOWS_AUDIO +
    "\n'@\n" +
    (compileOnly
      ? "Write-Output 'MICROPHONE_HELPER_COMPILED'"
      : "[MicrophoneInput]::Run()")
  );
}
const MAC_AUDIO = buildFlag("ui_dictation") ? String.raw`
import Foundation
import AVFoundation
FileHandle.standardError.write(Data("AUDIO_READY\n".utf8))
guard readLine() == "start" else { exit(0) }
DispatchQueue.global().async { _ = FileHandle.standardInput.availableData; exit(0) }
let status = AVCaptureDevice.authorizationStatus(for: .audio)
if status == .denied || status == .restricted { exit(2) }
if status == .notDetermined {
 let permission = DispatchSemaphore(value: 0)
 var allowed = false
 AVCaptureDevice.requestAccess(for: .audio) { granted in allowed = granted; permission.signal() }
 if permission.wait(timeout: .now()+10) != .success || !allowed { exit(2) }
}
let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0, format.channelCount > 0,
 let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
 let converter = AVAudioConverter(from: format, to: target) else { exit(2) }
let output = FileHandle.standardOutput
let lock = NSLock()
input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
 let count = AVAudioFrameCount(ceil(Double(buffer.frameLength)*16000/format.sampleRate)+16)
 guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: count) else { return }
 var provided = false
 var failure: NSError?
 converter.convert(to: converted, error: &failure) { _, state in
  if provided { state.pointee = .noDataNow; return nil }
  provided = true; state.pointee = .haveData; return buffer
 }
 guard failure == nil, let samples = converted.int16ChannelData?[0], converted.frameLength > 0 else { return }
 let data = Data(bytes: samples, count: Int(converted.frameLength)*2)
 lock.lock(); output.write(data); lock.unlock()
}
engine.prepare()
do { try engine.start() } catch { exit(2) }
RunLoop.main.run()
` : "";
export const nativeAudioSources = {
  macos: MAC_AUDIO,
  linux: buildFlag("ui_dictation") ?
    'printf "AUDIO_READY\\n" >&2; IFS= read -r start; [ "$start" = start ] || exit 0; exec 3<&0; "$1" --quiet --format=S16_LE --rate=16000 --channels=1 --type=raw & capture=$!; ( IFS= read -r stop <&3; kill "$capture" 2>/dev/null ) & watcher=$!; trap \'kill "$capture" "$watcher" 2>/dev/null; wait "$capture" "$watcher" 2>/dev/null\' EXIT INT TERM; wait "$capture"; status=$?; kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null; exit "$status"' : "",
} as const;
async function macProgram(options: AudioOptions): Promise<string> {
  if (!buildFlag("ui_dictation")) throw Error("Microphone capture unavailable in this build.");
  const compiler = [
    "/Library/Developer/CommandLineTools/usr/bin/swiftc",
    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc",
  ].find(existsSync);
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.applicationId))
    throw Error("Invalid audio application identifier.");
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.${options.applicationId}.microphone</string><key>NSMicrophoneUsageDescription</key><string>Capture du microphone uniquement pendant l’appui sur la touche de dictée.</string></dict></plist>`;
  const hash = createHash("sha256")
      .update(MAC_AUDIO + plist)
      .digest("hex"),
    root = join(options.configDir, "audio-helpers", hash),
    binary = join(root, "capture");
  ordinaryPrivateFile(binary, 16777216);
  if (existsSync(binary)) return binary;
  if (!compiler) throw Error("Native audio helper compiler unavailable.");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = join(root, "input.swift"),
    info = join(root, "Info.plist"),
    temporary = join(root, "capture.partial-" + randomUUID());
  writeAtomic(source, Buffer.from(MAC_AUDIO), "macos", true);
  writeAtomic(info, Buffer.from(plist), "macos", true);
  const child = startChild(
      compiler,
      [
        source,
        "-o",
        temporary,
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        info,
      ],
      { cwd: root, env: options.environment, onData: () => {} },
    ),
    scope = AbortSignal.any([options.signal, AbortSignal.timeout(30000)]),
    stop = () => {
      void child.killTree(50);
    };
  scope.addEventListener("abort", stop, { once: true });
  try {
    if (scope.aborted) stop();
    const code = await child.exited;
    scope.throwIfAborted();
    if (code !== 0) throw Error("Native audio helper compilation failed.");
    ordinaryPrivateFile(temporary, 16777216);
    chmodSync(temporary, 0o700);
    renameSync(temporary, binary);
    return binary;
  } finally {
    scope.removeEventListener("abort", stop);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export interface AudioOptions {
  readonly platform: PlatformName;
  readonly configDir: string;
  readonly applicationId: string;
  readonly cwd: string;
  readonly environment: Record<string, string>;
  readonly signal: AbortSignal;
  readonly frame: (bytes: Uint8Array) => void;
  readonly failed: () => void;
}
export async function captureMicrophone(
  options: AudioOptions,
): Promise<MicrophoneCapture> {
  if (!buildFlag("ui_dictation")) throw Error("Microphone capture unavailable in this build.");
  options.signal.throwIfAborted();
  let file: string | undefined, args: string[];
  if (options.platform === "windows") {
    file = findExecutable("powershell.exe");
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsAudioScript(), "utf16le").toString("base64"),
    ];
  } else if (options.platform === "macos") {
    file = await macProgram(options);
    args = [];
  } else {
    const recorder = findExecutable("arecord");
    if (!recorder) throw Error("Microphone input unavailable.");
    file = findExecutable("sh");
    args = ["-c", nativeAudioSources.linux, "audio-helper", recorder];
  }
  if (!file) throw Error("Microphone input unavailable.");
  options.signal.throwIfAborted();
  let stopping = false,
    stopped: Promise<void> | undefined;
  let ready = false,
    errorText = "";
  const child = startChild(file, args, {
    cwd: options.cwd,
    env: options.environment,
    keepInputOpen: true,
    onData: (bytes) => {
      if (!stopping && !options.signal.aborted) options.frame(bytes);
    },
    onErrorData: (bytes) => {
      if (ready || stopping || options.signal.aborted) return;
      errorText = (errorText + bytes.toString("utf8")).slice(-1024);
      if (errorText.split(/\r?\n/).includes("AUDIO_READY")) {
        ready = true;
        child.input?.write("start\n");
      }
    },
  });
  const stop = (): Promise<void> => {
      stopping = true;
      return (stopped ??= (async () => {
        options.signal.removeEventListener("abort", abort);
        child.input?.end();
        await child.killTree(50);
        await child.exited;
      })());
    },
    abort = () => {
      void stop();
    };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) void stop();
  void child.exited
    .then(() => {
      if (!stopping && !options.signal.aborted) options.failed();
    })
    .catch(() => {
      if (!stopping) options.failed();
    });
  return { stop };
}

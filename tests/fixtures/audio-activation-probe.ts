// Generate helper text and try only an already cancelled capture; no microphone or OS compiler is opened.
import { captureMicrophone, windowsAudioScript, nativeAudioSources } from "../../src/platform/audio";
let script: string | undefined, scriptError: string | undefined, captureError: string | undefined;
try { script = windowsAudioScript(true); } catch (error) { scriptError = (error as Error).message; }
const abort = new AbortController(); abort.abort(Error("Probe cancelled before capture."));
try { await captureMicrophone({ platform: "windows", configDir: import.meta.dir, cwd: import.meta.dir, applicationId: "private-probe", environment: {}, signal: abort.signal, frame: () => { throw Error("Unexpected capture frame."); }, failed: () => { throw Error("Unexpected capture failure callback."); } }); }
catch (error) { captureError = (error as Error).message; }
console.log(JSON.stringify({ script, scriptError, captureError, nativeAudioSources }));

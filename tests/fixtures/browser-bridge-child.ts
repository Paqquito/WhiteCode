// Supports: SPEC-INT-011 (native interprocess ownership of a browser profile).
import { BrowserBridge } from "../../src/integrations/browser-bridge";
const [configDir, slug, id] = process.argv.slice(2);
if (!configDir || !slug || !id) throw Error("Missing native browser fixture arguments.");
const bridge = new BrowserBridge({ configDir, slug, product: "Native Browser Fixture", extensionId: () => id, permitted: () => true, changed: () => {} });
try { await bridge.start(); console.log("Unexpected competing owner."); process.exitCode = 2; }
catch (error) { if (!(error instanceof Error) || !error.message.includes("autre session")) throw error; console.log("Native profile ownership refused."); }
finally { await bridge.close(); }

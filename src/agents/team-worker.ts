// Supports: SPEC-AGT-012, SPEC-AGT-015 (independent teammate conversation and bounded orphan lifetime).
import { readPrivateText } from "../shared/private-text";
import { ownedByCurrentUser } from "../platform/private-file";
import { TeamChannel } from "./team-channel";
import { join } from "node:path";
import { Conversation } from "../engine/conversation";
import { runTurn } from "../engine/loop";
import { NEUTRAL_HOOKS } from "../extension-points/hooks";
import type { Tool, ToolContext } from "../tools/types";
import type { ModelEvent, ModelRequest, ToolCall, ToolResultPart } from "../providers/types";
import type { LoopDeps } from "../engine/loop";
import type { TurnResult } from "../engine/events";
import { compileRaw, describeErrors } from "../shared/schema";

export interface PanelSetup {
  readonly system: Conversation["system"]; readonly tools: Conversation["tools"];
  readonly model: LoopDeps["model"]; readonly maxOutputTokens: number; readonly thinking: LoopDeps["thinking"];
  readonly effort?: LoopDeps["effort"];
  readonly maxIterations?: number; readonly maxOutputContinuations: number; readonly maxStopHookContinuations: number;
}
export interface PanelBootstrap { readonly folder: string; readonly token: string; readonly name: string; readonly nonce: string; readonly cwd: string; readonly orphanMs: number }
export interface PanelStatus { readonly state: "starting" | "active" | "idle"; readonly sequence: number; readonly result?: TurnResult; readonly pid: number }
export async function waitForTeamLeader(current: () => string | undefined, life: AbortSignal, callSignal: AbortSignal): Promise<string> { let leader: string | undefined; while (!(leader = current())) { life.throwIfAborted(); callSignal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 50)); } life.throwIfAborted(); callSignal.throwIfAborted(); return leader; }

export async function runTeamWorker(file: string, signal: AbortSignal, write: (text: string) => void, environment: Readonly<Record<string, string>>): Promise<number> {
  if (Object.keys(environment).some(key => !["TERM", "LANG"].includes(key))) throw new Error("Team worker inherited an unexpected environment; startup refused.");
  if (!ownedByCurrentUser(file)) throw new Error("Foreign team bootstrap.");
  const boot = JSON.parse(readPrivateText(file, 8192)) as PanelBootstrap;
  if (!/^[a-f0-9]{64}$/.test(boot.token) || !/^[a-f0-9-]{36}$/.test(boot.nonce) || !/^[a-z][a-z0-9-]{0,47}$/.test(boot.name) || typeof boot.folder !== "string" || typeof boot.cwd !== "string" || !Number.isSafeInteger(boot.orphanMs) || boot.orphanMs < 1000 || boot.orphanMs > 24 * 60 * 60 * 1000) throw new Error("Invalid team bootstrap.");
  process.chdir(boot.cwd);
  const life = new AbortController(), scope = AbortSignal.any([signal, life.signal]);
  let leader: string | undefined, lastSeen = Date.now(), conversation: Conversation | undefined, work: Promise<void> | undefined;
  let status: PanelStatus = { state: "starting", sequence: 0, pid: process.pid };
  const requestCounter = { count: 0 };
  const control = join(boot.folder, "leader.json");
  const waitLeader = (callSignal: AbortSignal) => waitForTeamLeader(() => leader, scope, callSignal);
  const call = async (method: string, value: unknown, callSignal = scope) => channel.request(await waitLeader(callSignal), method, { token: boot.token, name: boot.name, nonce: boot.nonce, value }, callSignal);
  const channel = new TeamChannel(boot.folder, boot.cwd, `${boot.nonce}/${boot.name}`, async (from, method, raw) => {
    const envelope = raw as { token?: unknown; value?: unknown };
    if (from !== leader || envelope?.token !== boot.token) throw new Error("Foreign team leader.");
    lastSeen = Date.now();
    if (method === "status") return status;
    if (method === "stop") { life.abort(); return true; }
    if (method !== "turn" || work) throw new Error("Teammate is already working or request is invalid.");
    const input = envelope.value as { setup: PanelSetup; prompt: string; sequence: number };
    if (typeof input.prompt !== "string" || Buffer.byteLength(input.prompt) > 1024 * 1024 || input.sequence !== status.sequence + 1 || !input.setup || input.setup.tools.length > 1000) throw new Error("Invalid teammate turn.");
    const setup = input.setup;
    conversation ??= new Conversation(setup.system, setup.tools);
    // A resumed leader may tighten the view; only the fresh leader's admitted definitions are advertised.
    conversation.replaceTools(setup.tools);
    const tools = setup.tools.map(definition => ({
      ...definition, description: () => definition.description,
      flags: () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
      isEnabled: () => true, ruleSubject: () => ({ kind: "none" as const }), permissionContribution: () => "allow" as const, summary: () => definition.name,
      async execute(input: unknown, ctx: ToolContext) {
        const result = await call("tool", { callId: crypto.randomUUID(), name: definition.name, input } satisfies ToolCall, ctx.signal) as ToolResultPart;
        return { content: result.content, isError: result.isError ?? false };
      },
    } as Tool<never>));
    const validators = new Map(tools.map(tool => [tool.name, compileRaw(tool.inputSchema)]));
    const registry = { list: () => tools, get: (name: string) => tools.find(tool => tool.name === name), validateInput: (tool: Tool<never>, input: unknown) => { const validate = validators.get(tool.name)!; return validate(input) ? [] : describeErrors(validate.errors); } };
    status = { state: "active", sequence: input.sequence, pid: process.pid }; write(`Coéquipier ${boot.name} : travail en cours.\n`);
    work = (async () => {
      try {
        const result = await runTurn({ ...setup, requestCounter, conversation: conversation!, hooks: NEUTRAL_HOOKS, emit: () => {},
          provider: { id: setup.model.provider, async *stream(request: ModelRequest, requestSignal: AbortSignal) { const events = await call("model", request, requestSignal) as ModelEvent[]; for (const event of events) yield event; } },
          executor: { registry, hooks: NEUTRAL_HOOKS, authorities: {}, permissionContext: () => ({ mode: "unrestricted", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: boot.cwd, home: boot.cwd, platform: "linux" }), toolContext: requestSignal => ({ signal: requestSignal } as ToolContext), concurrency: 1, toolTimeoutMs: boot.orphanMs },
        }, input.prompt, scope);
        status = { state: "idle", sequence: input.sequence, pid: process.pid, result };
        write(`Coéquipier ${boot.name} : inactif ; compte rendu conservé pour le chef.\n`);
      } finally { work = undefined; }
    })();
    void work.catch(() => { life.abort(); });
    return true;
  });
  await channel.ready;
  const heartbeat = async () => {
    try {
      if (!ownedByCurrentUser(control)) throw new Error("Foreign team leader registration.");
      const info = JSON.parse(readPrivateText(control, 4096)) as { token: string; peer: string };
      if (info.token !== boot.token || !channel.peers.list().some(peer => peer.address === info.peer && peer.cwd === boot.cwd)) throw new Error("Team leader unavailable.");
      if (leader && leader !== info.peer) channel.disconnected(leader);
      leader = info.peer;
      await channel.request(leader, "heartbeat", { token: boot.token, name: boot.name, nonce: boot.nonce }, AbortSignal.timeout(2000)); lastSeen = Date.now();
    } catch { if (leader) channel.disconnected(leader); leader = undefined; }
    if (Date.now() - lastSeen > boot.orphanMs) life.abort();
  };
  try { while (!scope.aborted) { await heartbeat(); await new Promise(resolve => setTimeout(resolve, 250)); } await work; return 0; }
  finally { life.abort(); await channel.close(); }
}

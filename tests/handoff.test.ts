import { profiledTest } from "./helpers/profiled-test";
import { test, expect } from "bun:test";
import { handoffHistory, handoffState } from "../src/remote/handoff-state";
import { handoff } from "../src/remote/handoff";
import type { HandoffGit } from "../src/remote/handoff-git";
import { handoffDigest } from "../src/remote/handoff-state";
const internalProfileTest = profiledTest(import.meta.path, "internal");
test("TECH — CMD091 transfer metadata rejects traversal and incomplete history instead of truncating", () => {
  expect(() => handoffState({ branch: "../bad" })).toThrow();
  expect(() => handoffHistory(Array.from({ length: 257 }, () => ({ role: "system_note", text: "old" })))).toThrow();
  expect(handoffHistory([{ role: "user", parts: [{ type: "text", text: "continue" }] }])).toHaveLength(1);
  expect(() => handoffHistory([{ role: "user", parts: [{ type: "text", text: "token=fixturecredential" }] }])).toThrow();
});

function fixture() {
  const state=handoffState({version:1,repository:"https://forge.example.test/team/repo.git",branch:"main",base:"a".repeat(40),index:"b".repeat(40),snapshot:"c".repeat(40),transferBranch:"handoff/00000000-0000-0000-0000-000000000000"});
  const messages=[{role:"user",parts:[{type:"text",text:"continue"}]}],digest=handoffDigest(state,messages),events:string[]=[];
  let statusReads=0,failActivation=false,failStop=false,stopped=false,binding="same";
  const git={recovery:"refs/session-handoff/fixture",inspect:async()=>({...state,dirty:true}),capture:async()=>{events.push("capture");return state;},publish:async()=>{events.push("publish");},recover:async()=>{events.push("recover");},run:async(args:string[])=>Buffer.from(args[0]==="status"?"":state.base),close:()=>{events.push("close");}} as unknown as HandoffGit;
  const account={profile:async()=>({account:"member",organization:{id:"org"}}),sessionBinding:async()=>binding,request:async(_service:string,path:string)=>{
    if(path==="key-status")return{repositoryAccessible:true,delegatedKey:true};
    if(path==="handoff"){events.push("create");return{id:"session",url:"https://service.example.test/sessions/session"};}
    if(path.endsWith("handoff-activate")){events.push("activate");if(failActivation)throw Error("lost response");return{handoffPhase:"active",handoffDigest:digest};}
    if(path.endsWith("stop")){events.push("stop");if(failStop)throw Error("lost stop");stopped=true;return{status:"stopped",workerStopped:true};}
    if(path.endsWith("status")){statusReads++;if(failStop&&stopped)throw Error("lost status");return{status:"running",handoffPhase:"ready",handoffDigest:digest};}
    throw Error("unexpected path");
  }};
  return {events,state,get statusReads(){return statusReads;},failActivation:()=>{failActivation=true;},failStop:()=>{failStop=true;},replace:()=>{binding="new";},options:{account:account as any,git,environment:"second",webUrl:"https://service.example.test/",history:()=>messages,redact:(s:string)=>s,confirm:async()=>true,assertPolicy:()=>{},report:()=>{}}};
}
{
const test = internalProfileTest;
test("TECH — CMD091 a lost activation and unconfirmed stop freezes local execution and retains the recovery ref", async()=>{
  const f=fixture();f.failActivation();f.failStop();const result=await handoff(f.options,AbortSignal.timeout(1000));
  expect(result.transferred).toBe(true);expect(result.note).toContain("incertaine");expect(f.events).toEqual(["capture","publish","create","activate","stop","close"]);
});
}
{
const test = internalProfileTest;
test("TECH — CMD091 a lost activation response recovers locally only after a confirmed worker stop",async()=>{
  const f=fixture();f.failActivation();await expect(handoff(f.options,AbortSignal.timeout(1000))).rejects.toThrow("restaurées");
  expect(f.events).toEqual(["capture","publish","create","activate","stop","recover","close"]);
});
}
{
const test = internalProfileTest;
test("TECH — CMD091 replacing login during consent abandons before any Git mutation",async()=>{
  const f=fixture();f.options.confirm=async()=>{f.replace();return true;};await expect(handoff(f.options,AbortSignal.timeout(1000))).rejects.toThrow("Connexion remplacée");expect(f.events).toEqual(["recover","close"]);
});
}
{
const test = internalProfileTest;
test("TECH — CMD091 cancellation after capture restores with a fresh cleanup lifetime",async()=>{
  const f=fixture(),cancel=new AbortController();f.options.git.publish=async()=>{cancel.abort();throw Error("cancelled upload");};
  await expect(handoff(f.options,cancel.signal)).rejects.toThrow("restaurées");expect(f.events).toEqual(["capture","recover","close"]);
});
}

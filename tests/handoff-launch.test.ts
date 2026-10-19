// Supports: SPEC-CMD-091, SPEC-PER-023 (handoff Git shares mandatory hosted routing and revocation tracking).
import {test,expect} from "bun:test";
import { HandoffGit } from "../src/remote/handoff-git";
import { workspace } from "./helpers/env";
import { findExecutable } from "../src/platform/system";
test("TECH — each actual handoff Git process passes through the imposed launch envelope and child observer", async()=>{
 const ws=workspace(),git=findExecutable("git");if(!git)throw Error("Native Git required");
 let launched=0,spawned=0,closed=0,children=0;
 const transfer=new HandoffGit({git,cwd:ws.project,environment:{PATH:process.env.PATH??"",GEMINI_API_KEY:"synthetic-known-key"},launch:(file,args,_cwd,environment)=>{launched++;expect(file).toBe(git);expect(args).toContain("--version");expect(environment).not.toHaveProperty("GEMINI_API_KEY");return{file,args:[...args],environment,fds:[],spawned:()=>{spawned++;},close:()=>{closed++;}};},child:child=>{expect(child.pid).toBeGreaterThan(0);children++;}});
 expect((await transfer.run(["--version"],AbortSignal.timeout(5000))).toString()).toContain("git version");
 expect([launched,spawned,closed,children]).toEqual([1,1,1,1]);
});

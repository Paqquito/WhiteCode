// Supports: SPEC-EXT-013 (activation and ordinary reloading without a catalogue).
import { expect, test } from "bun:test";
import { cli, ROOT, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productEnv } from "./helpers/hooks";

test("SPEC-EXT-013/CA-01 — an offline bundled extension is inactive by default and its skill appears after activation and reload", async () => {
  const ws = workspace(),
    p = new ScriptedProvider([]),
    h = new Host(ws, {
      provider: p,
      init: { decisionAuthority: true },
      answers: {
        confirm_escalation: (params) => ({
          decision: "confirm",
          escalationId: params["escalationId"],
        }),
      },
      userConfig: {
        engine: { control: { allowEscalation: true } },
        skills: { discovery: { enabled: false } },
      },
    });
  try {
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/skill-list" }),
      ),
    ).not.toContain("review-kit:checklist");
    const config = join(ws.configHome, "config.json"),
      before = JSON.parse(readFileSync(config, "utf8"));
    const enabled = await cli(
      ["extension", "enable", "review-kit@bundled"],
      ws,
      { userConfig: before },
    );
    expect(enabled.code).toBe(0);
    expect(readFileSync(config, "utf8")).toContain(
      '"review-kit@bundled": true',
    );
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/reload-extensions" }),
      ),
    ).toContain("review-kit@bundled");
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/skill-list" }),
      ),
    ).toContain("review-kit:checklist");
    const listed = await cli(["extension", "list", "--json"], ws, {
      userConfig: JSON.parse(readFileSync(config, "utf8")),
    });
    expect(JSON.parse(listed.stdout)).toContainEqual(
      expect.objectContaining({
        name: "review-kit",
        catalog: "bundled",
        bundled: true,
      }),
    );
    const removed = await cli(
      ["extension", "remove", "review-kit@bundled", "--force"],
      ws,
    );
    expect(removed.code).not.toBe(0);
    expect(removed.stderr).toContain("seulement être désactivées");
    expect(p.requests).toHaveLength(0);
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 20000);

test("TECH — failed bundled publication accepts only the exact guarded concurrent content and refuses absent, divergent or linked files", async () => {
  for(const mode of ["published","absent","divergent","linked"]){
    const ws=workspace(), entry=ws.write("publication.ts",`
import {mock} from 'bun:test';
import {mkdirSync,writeFileSync,linkSync} from 'node:fs';
import {dirname,join} from 'node:path';
const mode=${JSON.stringify(mode)}, directory=${JSON.stringify(ws.configHome)};
mock.module(${JSON.stringify(join(ROOT,"src/tools/text-file.ts"))},()=>({writeAtomic(path,bytes){
  mkdirSync(dirname(path),{recursive:true});
  if(mode==='published')writeFileSync(path,bytes);
  if(mode==='divergent')writeFileSync(path,'divergent');
  if(mode==='linked'){const foreign=join(directory,'foreign');writeFileSync(foreign,bytes);linkSync(foreign,path);}
  throw new Error('SYNTHETIC_PUBLISH_FAILURE');
}}));
const {ensureBundled}=await import(${JSON.stringify(join(ROOT,"src/extensions/bundled.ts"))});
try{ensureBundled(directory);console.log(JSON.stringify({accepted:true}));}
catch(error){console.log(JSON.stringify({accepted:false,message:error.message}));}
`);
    const child=Bun.spawn([process.execPath,"--no-env-file",entry],{cwd:ws.project,env:productEnv(ws),stdout:"pipe",stderr:"pipe"});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(code,stderr).toBe(0);const outcome=JSON.parse(stdout);expect(outcome.accepted).toBe(mode==="published");
    if(mode!=="published")expect(outcome.message).toBe("SYNTHETIC_PUBLISH_FAILURE");
  }
},10000);

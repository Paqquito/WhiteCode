// Implements: SPEC-OBS-003, SPEC-API-025 (consent cache and bounded aggregate-only service export).
// Supports: gap E-173 (five-minute in-memory organization preference cache).
import { randomUUID } from "node:crypto";
import type { EngineEvent } from "../engine/events";
import type { CompanyAccount } from "../auth/company-account";
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
type Metric="api_requests"|"input_tokens"|"output_tokens"|"tool_calls"|"tool_errors"|"duration_ms";
interface Account {profile():Promise<{organization:{id:string}}|undefined>;request:CompanyAccount["request"]}
export class OrganizationMetrics {
  #organization:string|undefined;#allowed=false;#expires=0;#reason="autorisation inconnue";#refreshing:Promise<void>|undefined;#sending:Promise<void>|undefined;
  readonly #values=new Map<Metric,number>();
  constructor(readonly options:{account:Account;enabled:()=>boolean;now?:()=>number}){}
  get status():string{return this.options.enabled()?this.#reason:"refus local ou géré";}
  refresh(signal:AbortSignal):Promise<void>{if(this.#refreshing)return this.#refreshing;const task=this.#refresh(signal);this.#refreshing=task;void task.finally(()=>{if(this.#refreshing===task)this.#refreshing=undefined;}).catch(()=>{});return task;}
  async #refresh(signal:AbortSignal):Promise<void>{
    if(!this.options.enabled()){this.#allowed=false;this.#values.clear();return;}
    const now=this.options.now?.()??Date.now();
    try{const profile=await this.options.account.profile();if(!profile){this.#allowed=false;this.#organization=undefined;this.#values.clear();this.#reason="compte non connecté";return;}
      if(profile.organization.id===this.#organization&&now<this.#expires)return;
      const raw=await this.options.account.request("metrics","preferences",undefined,signal,{organizationId:profile.organization.id});
      if(!object(raw)||raw.organizationId!==profile.organization.id||typeof raw.eligible!=="boolean"||typeof raw.optOut!=="boolean")throw new Error("Invalid organization preferences");
      if(this.#organization!==profile.organization.id)this.#values.clear();this.#organization=profile.organization.id;this.#expires=now+300000;this.#allowed=raw.eligible&&!raw.optOut;this.#reason=raw.optOut?"refus de l’organisation":raw.eligible?"métriques agrégées autorisées":"compte non éligible";if(!this.#allowed)this.#values.clear();
    }catch{if(now>=this.#expires){this.#allowed=false;this.#values.clear();this.#reason="autorisation inconnue";}}
  }
  record(event:EngineEvent):void{if(!this.options.enabled()||!this.#allowed||(this.options.now?.()??Date.now())>=this.#expires){this.#values.clear();return;}
    const add=(key:Metric,value:number)=>{if(Number.isFinite(value)&&value>=0)this.#values.set(key,Math.min(1e12,(this.#values.get(key)??0)+value));};
    if(event.type==="usage"){add("api_requests",1);add("input_tokens",event.usage.inputTokens);add("output_tokens",event.usage.outputTokens);}
    if(event.type==="tool_result"){add("tool_calls",1);if(event.isError)add("tool_errors",1);}
    if(event.type==="turn_completed")add("duration_ms",event.result.durationMs);
  }
  flush(signal:AbortSignal):Promise<void>{if(this.#sending)return this.#sending;const task=this.#flush(signal);this.#sending=task;void task.finally(()=>{if(this.#sending===task)this.#sending=undefined;}).catch(()=>{});return task;}
  async #flush(signal:AbortSignal):Promise<void>{await this.refresh(signal);if(!this.options.enabled()||!this.#allowed||!this.#values.size)return;
    let profile:{organization:{id:string}}|undefined;try{profile=await this.options.account.profile();}catch{this.#allowed=false;this.#values.clear();return;}if(profile?.organization.id!==this.#organization){this.#allowed=false;this.#values.clear();return;}
    const batch=Object.fromEntries(this.#values);this.#values.clear();try{await this.options.account.request("metrics","batches",{id:randomUUID(),organizationId:this.#organization,metrics:batch},signal,{organizationId:this.#organization!});}catch{for(const[key,value]of Object.entries(batch))this.#values.set(key as Metric,Math.min(1e12,(this.#values.get(key as Metric)??0)+value));}
  }
}

// Implements: SPEC-IHM-032 CA-01/02 (deterministic skeleton, local animation and reactions), SPEC-CMD-012 CA-01.
// Supports: gap E-180. This module is eliminated from the standard public distribution.
import{createHash}from"node:crypto";
export interface CompanionSoul{readonly name:string;readonly personality:"patient"|"lively"}
export function companionSkeleton(identifier:string|undefined){const bytes=createHash("sha256").update("companion-v1:"+(identifier??"generic")).digest();return{species:["sprout","moth","pebble"][bytes[0]!%3]!,rarity:bytes[1]!<8?"rare":"common",eyes:["oo","••","^^"][bytes[2]!%3]!,crest:bytes[3]!%2===0};}
export function companionName(identifier:string|undefined):string{const skeleton=companionSkeleton(identifier);return skeleton.species==="sprout"?"Pousse":skeleton.species==="moth"?"Lueur":"Galet";}
export class Companion{
 readonly skeleton:ReturnType<typeof companionSkeleton>;#reaction="";#until=0;
 constructor(identifier:string|undefined,readonly soul:()=>CompanionSoul|undefined,readonly enabled:()=>boolean,readonly reduced:()=>boolean){this.skeleton=companionSkeleton(identifier);}
 react(success:boolean,now=Date.now()):void{if(!this.enabled()||this.reduced())return;this.#reaction=success?"Une étape de plus.":"Prenons le temps.";this.#until=now+4000;}
 frame(columns:number,now=Date.now()):readonly string[]{const soul=this.soul();if(!this.enabled()||!soul||columns<100)return[];const phase=this.reduced()?0:Math.floor(now/500)%2,eyes=phase?"--":this.skeleton.eyes;return[this.skeleton.crest?"  *  ":"     ",` (${eyes}) `,` ${phase?"/":"~"}__~ `,soul.name,...(now<this.#until?[this.#reaction]:[])];}
}

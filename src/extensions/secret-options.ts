// Implements: SPEC-EXT-015 CA-01 (native vault only, independently scoped secret options).
// Supports: gap E-178. Values are supplied only to runtime contributions, never prompt definitions.
import{createHash}from"node:crypto";import{resolve}from"node:path";
import type{CredentialVault}from"../platform/credential-vault";
import{compileRaw}from"../shared/schema";import{describeExtension}from"./extension";import type{ActiveExtension}from"./load";
export class ExtensionSecretOptions{
  constructor(readonly o:{vault:CredentialVault;service:string;configDir:string}){}
  #account(id:string,name:string):string{return"extension-option:"+createHash("sha256").update(JSON.stringify([resolve(this.o.configDir).replace(/\\/g,"/"),id,name])).digest("hex");}
  definitions(root:string):Record<string,Record<string,unknown>>{return(describeExtension(root,false).optionsSchema?.["properties"]??{})as Record<string,Record<string,unknown>>;}
  async set(id:string,root:string,name:string,value:string):Promise<void>{const def=this.definitions(root)[name];if(!def||def["secret"]!==true)throw Error("Option secrète inconnue.");const{secret:_secret,default:_default,...schema}=def;if(!value||Buffer.byteLength(value)>2500||!compileRaw(schema)(value))throw Error("Valeur secrète invalide ou trop volumineuse.");const account=this.#account(id,name);await this.o.vault.write(this.o.service,account,value);if(await this.o.vault.read(this.o.service,account)!==value)throw Error("Option non confirmée dans le trousseau.");}
  async load(active:readonly ActiveExtension[]):Promise<Record<string,Record<string,string>>>{const result:Record<string,Record<string,string>>={};for(const extension of active){const ext=describeExtension(extension.root,extension.origin==="session"),id=extension.id??`${ext.name}@${extension.origin}`;for(const[name,def]of Object.entries(this.definitions(extension.root))){if(def["secret"]!==true)continue;try{const value=await this.o.vault.read(this.o.service,this.#account(id,name)),{secret:_secret,default:_default,...schema}=def;if(typeof value==="string"&&Buffer.byteLength(value)<=2500&&compileRaw(schema)(value))(result[id]??={})[name]=value;}catch{/* unavailable vault leaves the contribution disabled */}}}return result;}
}

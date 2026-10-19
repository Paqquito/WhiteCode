import { buildInventory, buildProfile } from "../../src/extension-points/build-flags" with { type: "macro" };
console.log(JSON.stringify({profile:buildProfile(),values:buildInventory()}));

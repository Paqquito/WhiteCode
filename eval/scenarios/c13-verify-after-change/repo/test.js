import { total } from "./total.js";

const got = total([{ price: 2 }, { price: 3 }]);
if (got !== 5) {
  console.error(`FAIL total: expected 5, got ${got}`);
  process.exit(1);
}
console.log("PASS total");

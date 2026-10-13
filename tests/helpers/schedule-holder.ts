// Supports: SPEC-PLA-001 CA-02; isolated holder terminated by its parent test.
import { Scheduler } from "../../src/schedule/engine";
const [folder, lock, time] = process.argv.slice(2);
const engine = new Scheduler({ folder: folder!, lock: lock!, now: () => Number(time), random: () => 0, maxActive: () => 50, maxAgeDays: () => 7, submit: () => true, missed: async () => false, warn: () => {} });
await engine.tick();
process.stdout.write(engine.leader ? "leader\n" : "passive\n");
process.stdin.resume();
process.stdin.on("end", () => { engine.close(); process.exit(0); });

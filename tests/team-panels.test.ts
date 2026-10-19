import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, linkSync } from "node:fs";
import { TeamPanels } from "../src/agents/team-panels";
import { workspace } from "./helpers/env";

test("TECH — the original leader holds one kernel lease and changed account/project bindings cannot attach", async () => {
  const root = workspace().root, file = join(root, "state.json"), options = { file, binding: "original-session-project-account", cwd: root, tmp: root, env: {}, orphanMs: 1000 };
  const leader = new TeamPanels(options);
  try { await leader.ready(); expect(() => new TeamPanels(options)).toThrow("live leader"); expect(() => new TeamPanels({ ...options, binding: "other-account" })).toThrow("original leader"); }
  finally { await leader.close(); }
  const resumed = new TeamPanels(options); try { await resumed.ready(); expect(resumed.snapshot).toBeUndefined(); } finally { await resumed.close(); }
});

test("TECH — unread team notices remain until the leader acknowledges the sampled request", async () => {
  const root = workspace().root, file = join(root, "state.json"), options = { file, binding: "leader-binding", cwd: root, tmp: root, env: {}, orphanMs: 1000 };
  const leader = new TeamPanels(options); let first: string;
  try { await leader.ready(); first = leader.remember({ type: "message", from: "reader", text: "UNREAD_MESSAGE_51" }); leader.remember({ type: "idle", from: "reader", text: "UNREAD_REPORT_51" }); expect(leader.unread).toHaveLength(2); }
  finally { await leader.close(); }
  const resumed = new TeamPanels(options);
  try { await resumed.ready(); expect(resumed.unread.map(item => item.notice.text)).toEqual(["UNREAD_MESSAGE_51", "UNREAD_REPORT_51"]); resumed.acknowledge([first!]); expect(resumed.unread.map(item => item.notice.text)).toEqual(["UNREAD_REPORT_51"]); expect(JSON.parse(readFileSync(file, "utf8")).inbox).toHaveLength(1); }
  finally { await resumed.close(); }
});

test("TECH — linked team metadata is rejected before a leader is registered", async () => {
  const root = workspace().root, file = join(root, "state.json"), options = { file, binding: "leader-binding", cwd: root, tmp: root, env: {}, orphanMs: 1000 };
  const leader = new TeamPanels(options); await leader.ready(); await leader.close();
  const link = join(root, "linked.json"); linkSync(file, link); expect(() => new TeamPanels({ ...options, file: link })).toThrow();
});

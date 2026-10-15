// Isolated native Git repository with persistent fictitious author information for product commit tests.
import { workspace } from "./env";
import { productEnv } from "./hooks";
export function gitProject() {
  const ws = workspace(),
    env = productEnv(ws),
    git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: ws.project, env });
      if (result.exitCode !== 0) throw Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  ws.write("project/code.ts", "export const value=1;\n");
  ws.write("project/unrelated.txt", "original\n");
  git("add", ".");
  git("commit", "-qm", "feat: initial fixture");
  ws.write("project/code.ts", "export const value=2;\n");
  return { ws, env, git };
}

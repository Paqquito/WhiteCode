// Supports: SPEC-MOD-030 (native URL registration and argument-safe terminal launch); E-223.
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { findExecutable, type PlatformName } from "./system";
import { startChild } from "./process";
import { productProcess } from "./product-process";
import { ordinaryPrivateFile } from "../shared/private-text";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
async function execute(
  file: string,
  args: readonly string[],
  o: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number },
): Promise<{ code: number | null }> {
  const child = startChild(file, args, {
      cwd: o.cwd,
      env: o.env,
      onData: () => {},
      onErrorData: () => {},
    }),
    timer = setTimeout(() => void child.killTree(0), o.timeoutMs);
  try {
    return { code: await child.exited };
  } finally {
    clearTimeout(timer);
  }
}
const ps = (v: string) => "'" + v.replaceAll("'", "''") + "'";
const sh = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
const win = (v: string) =>
  '"' + v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
export async function deepLinkRegistration(o: {
  scheme: string;
  platform: PlatformName;
  config: string;
  home: string;
  environment: Readonly<Record<string, string>>;
  powerShell?: string;
}): Promise<boolean> {
  if (!buildFlag("deep_links")) throw Error("Deep links unavailable in this build.");
  if (!/^[a-z][a-z0-9+.-]{1,63}$/.test(o.scheme)) return false;
  const command = productProcess(["--open-link"]),
    args = [command.file, ...command.args];
  if (o.platform === "windows") {
    if (!o.powerShell) return false;
    const key = "HKCU:\\Software\\Classes\\" + o.scheme,
      invoke = [...args.map(win), '"%1"'].join(" ");
    const script = `$ErrorActionPreference='Stop';$k=${ps(key)};New-Item -Path $k -Force|Out-Null;Set-Item -LiteralPath $k -Value ${ps("URL:" + o.scheme)};New-ItemProperty -LiteralPath $k -Name 'URL Protocol' -Value '' -PropertyType String -Force|Out-Null;New-Item -Path ($k+'\\shell\\open\\command') -Force|Out-Null;Set-Item -LiteralPath ($k+'\\shell\\open\\command') -Value ${ps(invoke)}`;
    return (
      (
        await execute(
          o.powerShell,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { cwd: o.home, env: o.environment, timeoutMs: 3000 },
        )
      ).code === 0
    );
  }
  if (o.platform === "linux") {
    const root = join(o.home, ".local", "share", "applications");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const name = o.scheme + "-url.desktop",
      target = join(root, name);
    ordinaryPrivateFile(target, 65536);
    const quote = (v: string) =>
      '"' + v.replace(/[\\"`$]/g, "\\$&").replaceAll("%", "%%") + '"';
    writeFileSync(
      target,
      `[Desktop Entry]\nType=Application\nName=${o.scheme}\nNoDisplay=true\nTerminal=false\nExec=${args.map(quote).join(" ")} %u\nMimeType=x-scheme-handler/${o.scheme};\n`,
      { mode: 0o600 },
    );
    const xdg = findExecutable("xdg-mime");
    return (
      !!xdg &&
      (
        await execute(xdg, ["default", name, "x-scheme-handler/" + o.scheme], {
          cwd: o.home,
          env: o.environment,
          timeoutMs: 3000,
        })
      ).code === 0
    );
  }
  const compile = findExecutable("osacompile"),
    register =
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (!compile || !existsSync(register)) return false;
  const folder = join(o.config, "deep-links"),
    source = join(folder, "handler.applescript"),
    app = join(folder, o.scheme + ".app");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  ordinaryPrivateFile(source, 65536);
  const literal = (v: string) =>
    '"' + v.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  writeFileSync(
    source,
    `on open location incoming\n do shell script ${literal(args.map(sh).join(" ") + " ")} & quoted form of incoming\nend open location\n`,
    { mode: 0o600 },
  );
  if (
    (
      await execute(compile, ["-o", app, source], {
        cwd: o.home,
        env: o.environment,
        timeoutMs: 5000,
      })
    ).code !== 0
  )
    return false;
  const plist = join(app, "Contents", "Info.plist"),
    buddy = "/usr/libexec/PlistBuddy";
  for (const instruction of [
    "Add :CFBundleURLTypes array",
    "Add :CFBundleURLTypes:0 dict",
    "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
    `Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${o.scheme}`,
  ])
    if (
      (
        await execute(buddy, ["-c", instruction, plist], {
          cwd: o.home,
          env: o.environment,
          timeoutMs: 1000,
        })
      ).code !== 0
    )
      return false;
  return (
    (
      await execute(register, ["-f", app], {
        cwd: o.home,
        env: o.environment,
        timeoutMs: 3000,
      })
    ).code === 0
  );
}
export async function launchDeepLink(o: {
  url: string;
  cwd: string;
  platform: PlatformName;
  environment: Readonly<Record<string, string>>;
  powerShell?: string;
  terminal?: string;
}): Promise<boolean> {
  if (!buildFlag("deep_links")) throw Error("Deep links unavailable in this build.");
  const command = productProcess(["--link-input", o.url]);
  if (o.platform === "windows") {
    const terminal = o.terminal ?? findExecutable("wt");
    if (terminal)
      return (
        (
          await execute(
            terminal,
            ["-d", o.cwd, "--", command.file, ...command.args],
            { cwd: o.cwd, env: o.environment, timeoutMs: 3000 },
          )
        ).code === 0
      );
    if (!o.powerShell) return false;
    const args = [
      "-NoExit",
      "-Command",
      "& " + [command.file, ...command.args].map(ps).join(" "),
    ]
      .map(win)
      .join(" ");
    return (
      (
        await execute(
          o.powerShell,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Start-Process -WindowStyle Normal -WorkingDirectory ${ps(o.cwd)} -FilePath ${ps(o.powerShell)} -ArgumentList ${ps(args)}`,
          ],
          { cwd: o.cwd, env: o.environment, timeoutMs: 3000 },
        )
      ).code === 0
    );
  }
  if (o.platform === "macos") {
    if (o.terminal)
      return (
        (
          await execute(o.terminal, [command.file, ...command.args], {
            cwd: o.cwd,
            env: o.environment,
            timeoutMs: 3000,
          })
        ).code === 0
      );
    const script =
        "cd " +
        sh(o.cwd) +
        " && " +
        [command.file, ...command.args].map(sh).join(" "),
      literal =
        '"' + script.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    return (
      (
        await execute(
          "/usr/bin/osascript",
          [
            "-e",
            'tell application "Terminal" to do script ' + literal,
            "-e",
            'tell application "Terminal" to activate',
          ],
          { cwd: o.cwd, env: o.environment, timeoutMs: 3000 },
        )
      ).code === 0
    );
  }
  const terminal = o.terminal ?? findExecutable("x-terminal-emulator");
  return (
    !!terminal &&
    (
      await execute(terminal, ["-e", command.file, ...command.args], {
        cwd: o.cwd,
        env: o.environment,
        timeoutMs: 3000,
      })
    ).code === 0
  );
}

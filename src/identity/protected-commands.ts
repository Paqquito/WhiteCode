// Implements: SPEC-CAD-002 (Q-05: system commands protected against a PRODUCT_CLI collision)
// Embedded, extensible list: POSIX utilities, Windows and PowerShell built-ins, common development tools.

export const PROTECTED_COMMANDS: ReadonlySet<string> = new Set([
  // POSIX utilities
  "alias", "ar", "at", "awk", "basename", "batch", "bc", "cal", "cat", "cd", "chgrp", "chmod", "chown",
  "cksum", "cmp", "comm", "command", "cp", "crontab", "csplit", "cut", "date", "dd", "df", "diff",
  "dirname", "du", "echo", "ed", "env", "ex", "expand", "expr", "false", "file", "find", "fold",
  "getconf", "getopts", "grep", "hash", "head", "iconv", "id", "join", "kill", "less", "link", "ln",
  "locale", "logger", "logname", "lp", "ls", "m4", "mailx", "make", "man", "mkdir", "mkfifo", "more",
  "mv", "newgrp", "nice", "nl", "nohup", "od", "paste", "patch", "pathchk", "pax", "pr", "printf",
  "ps", "pwd", "read", "renice", "rm", "rmdir", "sed", "sh", "sleep", "sort", "split", "strings",
  "stty", "tabs", "tail", "tee", "test", "time", "touch", "tput", "tr", "true", "tsort", "tty",
  "type", "ulimit", "umask", "unalias", "uname", "unexpand", "uniq", "unlink", "vi", "wait", "wc",
  "who", "xargs", "bash", "zsh", "fish", "ssh", "scp", "sudo", "su", "top", "curl", "wget", "tar",
  "zip", "unzip", "gzip", "less", "which", "whoami", "clear", "history", "exit", "source",
  // Windows and PowerShell built-ins
  "assoc", "attrib", "break", "call", "chdir", "cls", "cmd", "color", "copy", "del", "dir", "erase",
  "for", "ftype", "goto", "if", "md", "mklink", "move", "path", "pause", "popd", "prompt", "pushd",
  "rd", "ren", "rename", "set", "setlocal", "shift", "start", "title", "ver", "verify", "vol",
  "where", "xcopy", "robocopy", "powershell", "pwsh", "tasklist", "taskkill", "sc", "reg", "net",
  "netsh", "ipconfig", "ping", "tracert", "choco", "winget", "wsl", "gci", "gi", "gp", "iex", "iwr",
  // Development tools
  "git", "svn", "hg", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "node", "deno", "python",
  "python3", "pip", "pip3", "pipx", "uv", "poetry", "ruby", "gem", "bundle", "rake", "go", "cargo",
  "rustc", "rustup", "java", "javac", "mvn", "gradle", "dotnet", "gcc", "g++", "cc", "clang", "cmake",
  "docker", "podman", "kubectl", "helm", "terraform", "brew", "apt", "apt-get", "dnf", "yum", "pacman",
  "code", "vim", "nvim", "emacs", "nano", "tsc", "php", "composer", "perl", "swift", "kotlin",
]);

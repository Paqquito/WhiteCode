Runs a command in a non-interactive shell and returns its combined output and exit code.

- The working directory persists between calls: after `cd sub`, the next command runs in `sub`. It is reset to the project folder if it leaves the allowed folders.
- Standard input is closed: commands that wait for input get end-of-file. Use non-interactive options (for example `--yes`, `-y`, `--no-pager`, `CI=1`).
- A non-zero exit code is reported in the result; it is not a tool error.
- Long outputs keep their beginning and end; the complete output is saved to a file whose path is given.
- A default time limit applies; set `timeout` (milliseconds) for longer commands, within the maximum.
- Prefer the dedicated tools for files: `read_file`, `find_files`, `search_content`, `edit_file`, `write_file`. Keep the shell for the project's own commands (build, tests, version control).
- Quote paths that contain spaces. Chain dependent commands with `&&`.
- Give a short `description` of what the command does.
- Set `detached` to true for a command that keeps running (a development server, a watcher, a long build): it becomes a background task, you get its id at once and keep working; you are notified when it ends, and background_output reads its output.

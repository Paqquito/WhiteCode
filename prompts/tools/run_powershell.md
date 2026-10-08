Runs a PowerShell command non-interactively and returns its output and exit code.

- The working directory persists between calls (`Set-Location` / `cd`); it is reset to the project folder if it leaves the allowed folders.
- Standard input is closed: never use cmdlets that prompt (`Read-Host`, `Get-Credential`) or open windows (`Out-GridView`). Add `-Confirm:$false` where a cmdlet would ask.
- The user profile is not loaded. Output is UTF-8.
- A non-zero exit code is reported in the result; text on the error stream of a program that exits with 0 is not a failure.
- Long outputs keep their beginning and end; the complete output is saved to a file whose path is given.
- Deleting items, stopping processes, and changing the registry or security settings always require the user's confirmation.
- Prefer the dedicated tools for files: `read_file`, `find_files`, `search_content`, `edit_file`, `write_file`.
- Give a short `description` of what the command does.
- Set `detached` to true for a command that keeps running (a development server, a watcher, a long build): it becomes a background task, you get its id at once and keep working; you are notified when it ends, and background_output reads its output.

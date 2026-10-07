Searches file contents with a regular expression (ripgrep syntax).

- `mode`: `files` (default) lists the files that match; `lines` shows matching lines as `path:line:text`, with optional context lines (`before`, `after`, `around`, shown as `path-line-text`); `count` gives the number of matches per file.
- Filter files with `glob` (for example `*.ts` or `src/**/*.py`) or `type` (for example `py`, `ts`, `rust`, `md`, or `env`, `ini`, `conf`, `properties` for configuration files). Leave the filter out when you do not know the file type: a filtered search never looks at the other files.
- `ignore_case` makes the search case-insensitive; `multiline` lets the expression span lines.
- Escape special characters of the expression: to find `func(`, search `func\(`.
- Results are paginated with `offset` and `limit`; the total is always given. `limit` 0 returns everything and can be very costly: prefer narrowing the search.
- Files excluded by `.gitignore` and `.ignore` files and binary files are skipped.

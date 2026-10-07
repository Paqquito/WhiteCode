Finds files whose path matches a glob pattern.

- `pattern` is relative to the searched folder and supports `*`, `**`, `?`, `[...]` and `{a,b}`, for example `**/*.ts` or `src/{api,cli}/**/*.md`. A pattern without `/` matches at any depth: `guide.md` finds `docs/guides/guide.md`.
- When you do not know the extension of a file, list the folder with `*` rather than guessing extensions one by one.
- `path` is the folder to search; by default, the working directory.
- Files excluded by `.gitignore` and `.ignore` files are skipped, as is the internal folder of the version control system.
- Results are absolute paths, most recently modified first; long lists are truncated and the total is given.
- To search inside file contents, use `search_content`.

Creates a file, or replaces the whole content of an existing file.

- `path` must be an absolute path; missing parent folders are created.
- To overwrite an existing file, read it completely first with `read_file` in this session; if it changed since your read, read it again.
- Prefer `edit_file` for changes to part of a file: it sends only the modified passage.
- The encoding and line endings of an existing file are kept; a new file uses UTF-8.
- Use `update_notebook_cell` for notebooks (`.ipynb`).
- Do not create documentation or other files that the task does not need.

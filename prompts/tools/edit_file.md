Replaces a passage of a text file with new text.

- `path` must be an absolute path. Read the file with `read_file` in this session before editing it (a partial read is enough).
- `old_text` must identify the passage exactly, including indentation and spaces. Never include the line numbers shown by `read_file`.
- The edit fails when `old_text` occurs more than once: add surrounding lines to make it unique, or set `all_occurrences` to replace every occurrence (for renames, for example).
- `new_text` must differ from `old_text`. An empty `new_text` deletes the passage.
- To create a file, give a path that does not exist and an empty `old_text`.
- Small differences of quotes, line endings or indentation are tolerated when they designate a single passage; the result then says how the passage was found.
- Use `update_notebook_cell` for notebooks (`.ipynb`).

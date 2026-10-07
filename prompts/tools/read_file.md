Reads a file from the local file system and returns its content.

- `path` must be an absolute path.
- Text files come back with line numbers, one line per row, in the form `<number><TAB><content>`; numbering starts at 1 and always reflects the real line numbers of the file. The line numbers are not part of the file: never copy them into an edit.
- Without `offset` and `limit`, the beginning of the file is returned, up to a default number of lines. For large files, read a range with `offset` (first line, starting at 1) and `limit` (number of lines).
- Very long lines are cut, and any truncation is stated at the end of the result.
- Several independent files can be read in parallel by issuing several calls in the same response.
- Reading a directory fails: search for files instead.
- Notebooks (`.ipynb`) come back as their cells, each with its index (counted from 1), id when present, type, source and outputs.
- Images (PNG, JPEG, GIF, WebP) are attached to the result when the model accepts images.
- PDF documents come back as the text of their pages. A long document is read by ranges: give `pages`, such as `3` or `3-7`.

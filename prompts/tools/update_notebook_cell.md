Modifies one cell of a Jupyter notebook (`.ipynb`).

- `path` must be an absolute path. Read the notebook with `read_file` in this session first.
- `cell_id` designates the cell by its id, or by its index counted from 1 as shown by `read_file`.
- `mode`: `replace` (default) replaces the source of the cell and clears the outputs of a code cell; `insert` adds a new cell after `cell_id` (at the top when `cell_id` is omitted) and requires `cell_type`; `delete` removes the cell.
- Other cells, their order and the notebook metadata are left unchanged.

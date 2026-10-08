Reads the output of a background task of this session (a command, an agent or a monitor) and tells whether it still runs.

- By default it waits for the end of the task, at most `timeout` milliseconds (30 s); with `block` false it answers at once.
- You get the end of the output and the path of the whole output file, readable with read_file.

Loads a skill listed in the system instructions and gives you its instructions, to follow for the rest of the task.

- `name` is the name of the skill, as listed; `arguments` is the text the skill works on, when it expects some.
- Load a skill before starting a task it matches, not after.
- Files the instructions mention are in the folder of the skill: read them with read_file when you need them.

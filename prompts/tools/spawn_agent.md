Starts a sub-agent on a task and returns its final report. The sub-agent works in its own context: it does not see this conversation, so `prompt` must hold everything it needs (the goal, the files or places involved, what to report).

- Use it for broad searches, explorations or independent tasks whose details you do not need in this conversation; for a single file or a precise search, use the tools directly.
- Several calls in one response run at the same time: start independent tasks together.
- `role` chooses the agent among those listed below (default `general`). `description` names the task in a few words, for the user.
- `resume` continues an agent of this session, with its earlier context, on a new `prompt`; its id is in the report of its last run.
- The sub-agent never has more rights than you: the same permission rules apply to its actions, and only the report comes back.

Replaces your task list with the view you send. Use it for any task of three steps or more, or that touches several files, so that you and the user can follow the progress.

- Send the whole list each time: every item you want to keep, with its `id` from the last result; an item without `id` is a new task; a task you leave out is removed.
- `status` is `pending`, `in_progress` or `completed`. Keep exactly one task `in_progress` at a time, and mark a task `completed` only when its work is really done and verified.
- `content` says what the task is ("Run the tests"); `progress_label` says it as an ongoing action ("Running the tests").
- Tasks owned by other agents are shown to you but never changed by your view. If the list changed since your last update, the call is refused and you get the current list: send your view again from it.

Creates a task in the task list of this session, the same list as update_todo_list. A task without owner is free: an agent claims it by setting itself as owner with work_item_update, unless the task is blocked by another one that is not completed.

- Use work_item_list to see the tasks, their status, owner and blocks, and work_item_get for the detail of one.

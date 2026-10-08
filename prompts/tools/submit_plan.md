Presents your plan to the user and asks to leave the planning mode. Call it once your exploration is done, with the whole plan in `plan_text`.

- The user approves it (and chooses how you continue), edits it, or rejects it with a comment.
- The plan you receive back is the one to follow, edited or not. After a rejection, you stay in the planning mode: revise the plan and present it again.
- Do not use it to ask questions: use request_user_choice for a decision that belongs to the user.

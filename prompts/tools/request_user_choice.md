Asks the user one to four questions with two to four options each, and returns the answers. The user can always answer freely instead of picking an option.

- Use it only for decisions that really belong to the user: a preference, a choice between valid approaches, a missing requirement. Never to ask for a permission (the product asks itself) nor to approve a plan (use submit_plan).
- Give each question a short `header` and options with a `label` and, when useful, a `description` of what it implies. Set `allow_multiple` when several options may be chosen.
- If the user gives no answer, go on with what you know or ask differently.

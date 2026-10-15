---
name: schedule
description: Create or manage a hosted recurring agent after the user has reviewed the autonomous prompt, repository, environment, exact cron and local time.
invocation: both
tools: [start_remote_run]
---
Collect the user's goal, current repository, accessible environment, IANA time zone and recurrence. Draft a self-contained prompt that contains no credentials. Translate a daily or weekly recurrence into five-field cron: for example, Monday at 09:00 is `0 9 * * 1`. Never guess a time zone or a missing recurrence; clarify it. Show the exact expression and local time before asking the tool to create anything. The product must obtain explicit confirmation independently of this text. Explain that hosted runs may incur API costs and continue while the computer is off. Report the returned link and next local occurrence only when the service supplies them. For one-off work, offer a local scheduled prompt or an immediate run. Use list/get before changing an existing trigger; update, run and delete also require human confirmation. Tool errors are failures, never evidence that a trigger was created.

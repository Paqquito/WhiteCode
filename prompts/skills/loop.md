---
name: loop
description: "Repeat an explicitly recurring user request in this local session at a bounded interval. Use scheduled prompts only for recurring work, and keep ordinary execution permissions."
argumentsHelp: "[30s..24h] <recurring request>"
tools: [schedule_list]
---
Set up a recurring request: ${ARGS}

1. Use `schedule_create` with `intervalSeconds` between 30 and 86400, `durable: false`, and the requested prompt. If no interval was supplied, use 600 seconds or explain an appropriate bounded interval. Never schedule a one-off task with this skill.
2. Report the returned id, interval and next occurrence. Recurring work incurs model usage at each iteration. The loop ends with this session.
3. Run each occurrence under the session's ordinary permissions. An occurrence is skipped when the session is busy; iterations must never overlap.
4. Stop immediately on a user request or when the prompt's stopping condition is met, using `schedule_delete`. To adapt the interval, delete the previous trigger and create its bounded replacement. Never leave the previous loop active.

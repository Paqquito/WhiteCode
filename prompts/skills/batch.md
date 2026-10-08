---
name: batch
description: "Apply a large, mechanical change (migration, refactoring, mass renaming) by splitting it into independent units run in parallel by several agents, each in its own isolated copy and branch. Use it when one change touches many files in the same way."
argumentsHelp: "<instruction>"
---
The user wants this large change applied: ${ARGS}

The planning mode is active: change nothing before the user has approved the split.

1. Study. Explore the repository and list every element concerned (files, symbols, call sites). Count them.
2. Split. Group the elements into independent units: no unit should depend on the changes of another. Between 1 and {%MAX_AGENTS%} units; fewer when the change is small. When the change cannot be split into independent units, say so and propose to apply it sequentially instead.
3. Submit the split with `submit_plan`: for each unit, its name, its files, the branch it will use (`batch/<short-name>`), and the targeted checks (tests) that will confirm it. Wait for the approval.
4. Execute, once approved. For each unit, create an isolated working copy with `run_shell`: `git worktree add -b batch/<short-name> <folder outside the project> HEAD`. Then start one agent per unit with `spawn_agent` (`detached: true`), never more than {%MAX_AGENTS%} at once. Give each agent its working copy, its files, the exact change, the checks to run, and these instructions: apply the change only in its working copy, run the targeted checks, commit on its branch, then open a merge request with the tools of the forge when they are available (for example `gh pr create`), or leave the branch as it is when no forge is available. An agent never merges anything.
5. Follow the agents with `background_output`. The failure of one unit never stops the others.
6. Synthesise: the units that succeeded, with the link of their merge request or the name of their branch; the units that failed, with the reason; the conflicts between units that turned out to be dependent. Remove the working copies of the units that succeeded once their branch is pushed (`git worktree remove`); keep the others for inspection.

Never merge a branch yourself, and never push without the permission of the user.

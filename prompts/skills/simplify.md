---
name: simplify
description: "Review the code changed recently and simplify it without changing its behaviour: reuse existing functions, remove dead code that was added, simplify the logic, follow the idioms of the project."
---
Review the code changed recently and simplify it. ${ARGS}

The current changes of the repository:

{%CURRENT_DIFF%}

1. Stay within the changed code: never touch code that the changes do not concern.
2. List the improvements, by order of value:
   - a function or a block that duplicates a helper that already exists in the project: search the project for it (`search_content`), then call the helper instead;
   - dead code or unused imports that the changes added;
   - logic that can be simpler, without changing what it does;
   - code that does not follow the idioms and conventions of the surrounding code;
   - obvious inefficiencies.
3. Apply the corrections with the ordinary tools. Never change the behaviour; the existing tests must still pass: run them when you know how.
4. Summarise what you changed and why. When there is no recent change, say so and stop.

When the changes are very large, split the review by group of files and delegate each group to an agent.

---
name: skill-from-session
description: "Turn what was done in this session into a reusable skill, parameterised and reviewed by the user before it is saved."
invocation: user
argumentsHelp: "[what to capture]"
---
Capture the work of this session as a reusable skill. What to capture, according to the user: ${ARGS}

The session so far:

{%SESSION_DIGEST%}

1. Analyse the session: the goal, the steps that worked, the tools used, the decisions taken.
2. Generalise: turn what varied into arguments (`$1`, `$2`, or `${ARGS}` for the whole text) and remove what was specific to this case. When the session is too short to give a useful procedure, propose a minimal skill or stop.
3. Propose the document, in this form:

```
---
name: <kebab-case name, not already used>
description: "<one line: what it does and when to use it, with examples of requests>"
argumentsHelp: "<what the arguments are>"
tools: [<the rules of the tools actually used, never broader, for example "run_shell(npm run release *)">]
context: inline
---
<the procedure, step by step>
```

4. Ask for the corrections of the user, and apply them. Save only once the user approves the document, with `write_file`, in the scope the user chooses: `{%USER_SKILLS%}/<name>/definition.md` (for the user) or `{%PROJECT_SKILLS%}/<name>/definition.md` (for the project). The skill is available at once.

Never put a secret of the session (key, token, password, private address) in the skill.

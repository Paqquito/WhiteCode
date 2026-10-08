---
name: debug
description: "Investigate a problem of the agent itself (a hook that does not fire, a connector that fails, an unexpected refusal) from its debug journal."
invocation: user
argumentsHelp: "[description of the problem]"
tools: ["read_file", "search_content", "find_files"]
---
The user reports a problem with the agent itself: ${ARGS}

{%DEBUG_JOURNAL%}

Analyse the journal in the light of this description:
- Quote the relevant lines of the journal, as they are, and explain what each one shows.
- Give the most likely causes, then the correction of each (a setting, a filter of a hook, a rule).
- Use only reading and searching tools. Change no setting nor file: propose the change, and apply it only if the user asks for it explicitly.
- The journal hides secrets; never try to recover one.
- When the journal is very large, read its end and search it for the terms of the problem rather than reading it whole.

---
name: shortcut-help
description: "Consult the current keyboard action catalogue and effective bindings before changing a shortcut. Invoke for user requests about keyboard customisation; ordinary file writes still require permission."
invocation: model
tools: [read_file]
---
Help customise keyboard shortcuts for the user's request: ${ARGS}

The configuration file is {%KEYBINDINGS_FILE%}. Read it before editing an existing file. If it does not exist, create a JSON object with a `bindings` object. Each key is an action id and each value is a combination string or an array of strings. Example: `{"bindings":{"input.submit":"ctrl+enter"}}`.
Use lower-case modifier names (`ctrl`, `alt`, `shift`) joined with `+` and a key (`enter`, `f2`, a letter, or an arrow name). Multi-step key sequences are unsupported in this version; never invent sequence syntax. An empty string disables an action, except essential actions. Dialog bindings win over input bindings, then application bindings. Custom bindings win within their context; show any conflict and preserve the essential interrupt, cancel and exit actions.

{%KEYBINDINGS_REFERENCE%}

The file overrides user settings and reloads after saving. These effective bindings reflect current settings and the existing file. This reference is read-only; use ordinary writing tools and obtain their required approval. Never claim that a shortcut changed before a successful write.

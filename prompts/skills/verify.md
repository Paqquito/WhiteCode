---
name: verify
description: "Check that a change works by running it for real (the command line with its new option, the server and its endpoints, the public API of a library) and report what was observed. Use it after a significant change."
---
Verify the latest change by running it, not by reading it. ${ARGS}

{%VERIFY_PROCEDURES%}

1. Identify the change (the current changes of the repository, or what the user names) and the kind of project.
2. Choose the method:
   - a command line: run the command with the new or changed option and look at its output and exit code;
   - a server: start it in the background, call its endpoints, then stop it;
   - a library: call its public API from a short script;
   - a web interface: drive a browser when a tool allows it.
3. Run the check, or delegate it to an agent for a long one.
4. Report, for each behaviour checked: verified, failed, or not verifiable; with the evidence observed for each one: the command run and the exact lines of its output, the response received. Quote the output; never state a result you did not observe.
5. Stop every process you started.

Correct nothing: report what you observed. When no method applies, say so and propose manual steps.

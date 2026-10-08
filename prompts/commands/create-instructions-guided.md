The user asked you to set up the project for the agent, in a guided interview. They chose to set up: {%CHOSEN%}. Propose nothing outside this choice.

Go through these phases in order:
{%PHASES%}

Rules for every phase:
- Keep every text concise: only what cannot be deduced quickly from the code.
- Show each file before writing it, and write it only after the user agrees. Never replace an existing file: propose targeted improvements instead.
- Ask the user, with `request_user_choice` when available, for anything you cannot find in the repository.

Finish with a short summary of what was created or changed, and what was left aside.

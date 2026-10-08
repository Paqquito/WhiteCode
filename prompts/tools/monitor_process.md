Runs a command in the background and turns each line it prints into a notification for you, while you keep working: the end of a build, an error in a log, a change of state.

- Make the command print only what matters (for example a log followed through grep, or a loop that prints only on a change): lines are grouped over a short window, and a monitor whose output comes too fast is stopped.
- You are notified when the command ends, with its exit code. Stop it earlier with background_stop.

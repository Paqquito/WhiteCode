---
name: memory-consolidation
description: Consolidate project memories in a visible, cancellable background task with a verified backup.
invocation: both
tools: [consolidate_memory]
---
Call consolidate_memory once. Report the returned task identifier, or explain why it could not start. The product uses the same lock for manual and automatic consolidation. Do not edit memory directly to bypass that lock. The worker orients itself using the index, gathers relevant facts, consolidates overlaps and clarifies obsolete facts while preserving user feedback. Work continues in the background and can be stopped from the tasks panel.

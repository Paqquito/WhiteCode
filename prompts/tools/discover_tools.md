Loads the full definition of deferred tools, so that you can call them. Deferred tools are announced by name only, in a system reminder; calling one before loading it fails.

- `select:name_a,name_b` loads exactly the tools named.
- Keywords (`tickets search`) return the deferred tools whose name and description match best.
- `+word keywords` requires `word` in the tool name and ranks the matches by the other keywords.

A loaded tool stays available for the rest of the session. If nothing matches, rephrase the query with other words.

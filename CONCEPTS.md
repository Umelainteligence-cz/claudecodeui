# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Context usage

### Token budget
A session's current context occupancy, as the agent's context window holds it right now. It is the tokens used against the window's total. It is never the turn's cumulative bill.
*Avoid: token usage (when it means the bill)*

When nothing honest can be measured, the budget is unknown (null) rather than zero, and the interface hides the reading instead of showing a number.

### Context window
The maximum number of tokens the session's model can hold in one request. It is taken from what the SDK reports for that model when known, and otherwise from a configured or built-in fallback. Every budget states which of the two it used.

### Compaction
The agent replacing the conversation so far with a summary to free context room. It is started by the user (manual) or by the agent near its limit (auto). It is marked in the transcript by a compaction boundary, with the summary folded into it.

### Post-compact reading
The token budget measured right after a compaction, from the agent's own breakdown of what the context now contains. It is remembered against that compaction boundary so that reloaded history shows the same value the live session did.

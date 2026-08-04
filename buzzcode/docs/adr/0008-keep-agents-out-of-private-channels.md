---
status: superseded by ADR-0014
---

# Keep agents out of private channels

Remote agents may be invoked only in open channels inside a server project, and may search the open-channel history across that project. Private channels are human-only and are excluded from agent-searchable project knowledge. This avoids separate public and private memory states for the same agent and prevents private discussion from resurfacing through agent responses, at the cost of making agent assistance unavailable in private conversations.

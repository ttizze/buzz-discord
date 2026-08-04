# Record local agent actions as delegated actions

A local agent may read and write across servers explicitly enabled by its owner, up to the owner's permissions. Every resulting action records the local agent as executor and the user as delegator rather than impersonating the user. This preserves useful cross-server automation while keeping authorship auditable and allowing access to be revoked per server.

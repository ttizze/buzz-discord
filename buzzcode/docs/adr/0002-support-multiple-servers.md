# Support multiple servers per user

One Buzzcode service will host multiple isolated servers, and a user may join and switch between them in the same application. Every channel, project, and server-scoped resource belongs to exactly one server. Establishing this boundary from the start avoids a later rewrite of identity, authorization, and persistence, despite adding isolation requirements to the initial design.

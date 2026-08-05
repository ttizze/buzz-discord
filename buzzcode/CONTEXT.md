# Buzzcode

Buzzcode is a shared workspace where people and agents communicate and work together.

## Language

**Handle**:
A global, unique, lowercase username such as `@phibi` used for exact account lookup and disambiguation. It is secondary to Display Name in ordinary presentation. A user's stable database identity remains its internal subject, so an existing Direct Message or User Mention survives later Handle changes. Display names and Server Nicknames are presentation and may overlap; email is reserved for authentication and invitations.
_Avoid_: Email address, display name, internal subject

**Display Name**:
A non-unique, account-wide presentation name used as the user's primary visible identity. People pickers match both Display Name and Handle, show Handle secondarily when disambiguation is needed, and store the selected user's stable identity rather than either name.
_Avoid_: Handle, Server Nickname, email address

**Server Nickname**:
An optional, non-unique presentation name for one member inside one server. It is reserved for a later server-profile feature; once introduced, it takes priority over Display Name when rendering that member or a User Mention within the server, but never renames a cross-server Direct Message.
_Avoid_: Display Name, Handle, role

**Server**:
An isolated collaboration space containing its own channels, members, and projects. A user may belong to and switch between multiple servers, and a server remains usable for chat without a connected remote environment.
_Avoid_: Workspace, community, tenant

**Member**:
A user admitted to a server. Membership grants access to every open channel and open project, while private channels and private projects require explicit access.
_Avoid_: Agent, participant

**Owner**:
The single member responsible for a server, including deleting the server and transferring ownership.
_Avoid_: Admin

**Admin**:
A member permitted to manage server members, channels, projects, remote environments, and agent settings, but not server deletion or ownership transfer.
_Avoid_: Owner, moderator

**Member Role**:
The standard server role, permitted to read and post in open areas, use private channels and projects to which the member was added, and invoke remote agents in accessible project channels without managing server configuration.
_Avoid_: Custom role, guest

**Project**:
A named work context whose organization depends on its scope. A personal project supplies context to an agent direct message, while a server project groups channels; neither owns an agent or stores messages itself.
_Avoid_: Workspace, channel, repository, conversation

**Personal Project**:
A project owned by one user that connects the user's local folder to a local agent and is selectable as work context in a direct message with that agent. It contains no channels and cannot be attached to a human direct message.
_Avoid_: Private server project

**Server Project**:
A project belonging to one server that groups channels and selects one Remote Environment plus a Git repository on that VPS. Creating one requires an Online Buzzcode Host and a valid repository; if its Host goes Offline, its channels remain writable while remote agents become unavailable. It never connects to a member's local computer and does not isolate its repository from other agents on the same VPS.
_Avoid_: Personal project

**Open Project**:
A server project available to every server member. All channels inside it share that visibility.
_Avoid_: Public channel category

**Private Project**:
A server project whose channels and searchable conversation history are available only to explicitly added members and server administrators. Its privacy is enforced by Buzzcode, not by filesystem isolation from other agents or the VPS administrator.
_Avoid_: Sandbox, separate server

**Archived Project**:
A former server project whose remote execution and agents are disconnected and whose channels are read-only but remain searchable. Archiving it does not disconnect its Remote Environment from other projects. A server project with message history is archived rather than deleted.
_Avoid_: Deleted project, inactive host

**Remote Environment**:
One admin-provided VPS registered to exactly one server and represented by one Buzzcode Host. A server may have multiple remote environments, and each server project selects exactly one of them. One remote environment may serve multiple projects; their folders are working contexts rather than security boundaries.
_Avoid_: Member computer, local environment

**Buzzcode Host**:
The `buzzcode-host` machine-side service that establishes an outbound ACP connection and exposes authorized folders and agent capabilities. The desktop app runs it locally for personal use, while each VPS Host represents one Remote Environment, belongs to exactly one server, and may expose separate folders to multiple projects assigned to that VPS.
_Avoid_: SSH target, central agent

**ACP Connection**:
The stable ACP v1 JSON-RPC lifecycle used end to end for agent initialization, sessions, prompts, updates, permissions, and cancellation. Buzzcode carries ACP over an authenticated outbound WebSocket between the service and Buzzcode Host, and the Host bridges it to the agent's standard ACP stdio transport.
_Avoid_: Nostr event, proprietary agent protocol, ACP v2 draft

**Channel**:
A server message stream created either directly under the server or inside exactly one project. Its placement never changes. A project channel inherits its parent project's visibility, while a direct server channel is explicitly open or private.
_Avoid_: Conversation, thread

**Open Channel**:
A direct server channel available to every server member. It has no project working context, so remote agents cannot be invoked there. Once it contains a message, it cannot become private.
_Avoid_: Public thread

**Private Channel**:
A direct server channel available to explicitly added members and server administrators. It has no project working context, so remote agents cannot be invoked there. Once it contains a message, it cannot become open.
_Avoid_: Private project, group direct message

**Direct Message**:
A one-to-one message stream between a user and either one other human or one local agent outside any server hierarchy. Group direct messages do not exist. A human recipient is selected from a people picker that searches shared-server or existing-DM peers by Display Name or Handle, plus global exact-Handle lookup; the selected stable user identity and Handle must agree when the Direct Message is created. Exact Handle knowledge permits first contact in v1, without a separate friend or Message Request flow. A personal project may be selected as context only when the other party is an agent.
_Avoid_: Channel, conversation

**User Mention**:
A message reference to one stable user identity. Typing after `@` searches members who can access the current channel by Display Name and Handle; choosing a candidate stores the user identity, not the typed name. It renders with the current Display Name, so renaming never changes who was mentioned. Once Server Nicknames exist, they also participate in search and take presentation priority inside that server.
_Avoid_: Plain text name, email address, Agent Mention

**Agent**:
An independent AI execution endpoint, such as Codex or Claude Code, that can be invoked from a channel or direct message and can author messages. Agents are not users, members, or a shared abstract actor type.
_Avoid_: User, member, project, conversation, actor

**Message Author**:
The user or agent that produced a message. Agent-authored messages also identify the user who requested or delegated the work.
_Avoid_: Actor

**Local Agent**:
An agent running on a user's computer for direct messages and personal projects. With explicit per-server delegation, it may search and act across servers within its owner's permissions, but it is never connected to a server project.
_Avoid_: Remote agent

**Remote Agent**:
A normal agent process running on the Remote Environment selected by a server project, with shell, file, and browser capabilities available on that VPS. A project folder supplies its starting context but does not prevent access to other resources on the same VPS; it has no implicit access to another Remote Environment.
_Avoid_: Local agent

**Agent Mention**:
A project-channel message that names a remote agent and starts a request. A direct reply to an agent-authored message continues with that agent without another mention, while ordinary channel messages never trigger an agent. The parent project determines the starting folder and conversation scope.
_Avoid_: Channel-agent binding

**Agent Run**:
An independently tracked execution started by an agent mention and continued by direct replies to that agent's output. Each server-project run receives its own Git branch and worktree so runs may execute in parallel, and records status, cancellation, output destination, requester, and audit history without creating a visible conversation or thread.
_Avoid_: Conversation, thread, channel

**Project Knowledge**:
A project's searchable channel history available to agents invoked within that project. Knowledge never crosses projects; access to a private project's knowledge requires membership in that project.
_Avoid_: Agent session, private history

**Delegated Agent Action**:
An action performed by a local agent under its owner's authority. The record identifies both the agent as executor and the user as delegator, and cannot exceed the user's permission in a server the user explicitly enabled.
_Avoid_: User action, impersonation

**Reply**:
A message that references any earlier message while remaining in the channel timeline where every channel member can see it. The timeline stays flat and chronological, and each reply references only its immediate target.
_Avoid_: Thread, thread reply

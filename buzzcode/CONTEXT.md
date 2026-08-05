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
An isolated collaboration space containing its own channels, members, and projects. A user may belong to and switch between multiple servers, and a server remains usable for chat without an Online Computer.
_Avoid_: Workspace, community, tenant

**Member**:
A user admitted to a server. Membership grants access to every open channel and open project, while private channels and private projects require explicit access.
_Avoid_: Agent, participant

**Owner**:
The single member responsible for a server, including deleting the server and transferring ownership.
_Avoid_: Admin

**Admin**:
A member permitted to manage server members, channels, projects, Computers, and agent settings, but not server deletion or ownership transfer.
_Avoid_: Owner, moderator

**Member Role**:
The standard server role, permitted to read and post in open areas, use private channels and projects to which the member was added, and invoke available agents in accessible project channels without managing server configuration.
_Avoid_: Custom role, guest

**Project**:
A work context created by selecting one Project Folder on one Computer. Its display name is the selected folder's name and is not entered separately. A Personal Project supplies context to an Agent Direct Message, while a Server Project groups Channels; neither owns an Agent or stores Messages itself.
_Avoid_: Workspace, channel, repository, conversation

**Personal Project**:
A Project visible only to its owner, added from a folder local to the Computer where the user creates it and selectable as work context in a Direct Message with an Agent. It contains no Channels and cannot be attached to a human Direct Message.
_Avoid_: Private server project

**Server Project**:
A Project shared through one Server and added from a folder local to the Computer where it is created. Other permitted Members can see it and its Channels from any Computer, while file access and Agent execution route to its bound Computer; if that Computer is Offline, its Channels remain writable while its files and Agents are unavailable.
_Avoid_: Personal project

**Open Project**:
A server project available to every server member. All channels inside it share that visibility.
_Avoid_: Public channel category

**Private Project**:
A Server Project whose Channels and searchable conversation history are available only to explicitly added Members and Server administrators. Its privacy is enforced by Buzzcode, not by filesystem isolation from other Agents or the bound Computer's owner.
_Avoid_: Sandbox, separate server

**Archived Project**:
An inactive Server Project whose Computer execution and Agents are disconnected and whose Channels are read-only but remain searchable. Archiving it does not disconnect its Computer from other Projects, and a Server Project with Message history is archived rather than deleted.
_Avoid_: Deleted project, inactive host

**Computer**:
A user's computer or a VPS running a Buzzcode Host. A Project is implicitly bound to the Computer on which its folder is added; users do not select another Computer while creating it, one Computer may back Projects in multiple Servers, and a VPS is not a separate Project concept.
_Avoid_: Remote Environment, execution target, host

**Project Folder**:
The folder selected from the local filesystem of the Computer where a Project is added. It supplies the Project's starting work context, may be inside or outside a Git repository, and is not a filesystem sandbox for Agents running with that Computer user's permissions.
_Avoid_: Repository, workspace, folder allowlist

**Buzzcode Host**:
The machine-side service that connects one Computer to Buzzcode and performs that Computer's folder browsing and Agent execution. It is infrastructure behind the Computer rather than a Project creation choice, and it does not require a preconfigured Project Folder or repository list.
_Avoid_: Computer, SSH target, central agent, project location

**ACP Connection**:
The stable ACP v1 JSON-RPC lifecycle used end to end for agent initialization, sessions, prompts, updates, permissions, and cancellation. Buzzcode carries ACP over an authenticated outbound WebSocket between the service and Buzzcode Host, and the Host bridges it to the agent's standard ACP stdio transport.
_Avoid_: Nostr event, proprietary agent protocol, ACP v2 draft

**Channel**:
A server message stream created either directly under the server or inside exactly one project. Its placement never changes. A project channel inherits its parent project's visibility, while a direct server channel is explicitly open or private.
_Avoid_: Conversation, thread

**Open Channel**:
A direct server Channel available to every Server Member. It has no Project work context, so Agents cannot be invoked there. Once it contains a Message, it cannot become private.
_Avoid_: Public thread

**Private Channel**:
A direct server Channel available to explicitly added Members and Server administrators. It has no Project work context, so Agents cannot be invoked there. Once it contains a Message, it cannot become open.
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
An Agent running on the user's current Computer. It may be used by Direct Messages, Personal Projects, and Server Projects whose folders were added from that Computer, subject to the user's and Server's permissions.
_Avoid_: Central agent

**Remote Agent**:
An Agent reached through a Project's bound Computer when that Computer is not the user's current Computer, including an Agent running on a VPS or another permitted Computer. It has that Computer user's shell, file, and browser capabilities; the Project Folder is its starting context rather than a sandbox.
_Avoid_: VPS agent, server-owned agent

**Agent Mention**:
A Project Channel Message that names an Agent available on the Project's bound Computer and starts a request. A direct Reply to an Agent-authored Message continues with that Agent without another mention, while ordinary Channel Messages never trigger an Agent; the parent Project determines the Computer, starting folder, and conversation scope.
_Avoid_: Channel-agent binding

**Agent Run**:
An independently tracked execution started by an Agent Mention and continued by direct Replies to that Agent's output. It follows the selected Agent's normal folder and Git behavior, including worktrees when supported and applicable, and records status, cancellation, output destination, requester, and audit history without creating a visible Conversation or Thread.
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

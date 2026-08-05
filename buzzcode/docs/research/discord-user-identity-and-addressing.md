# Discord user identity and addressing

Status: primary-source research, checked 2026-08-05

This note records Discord's current distinction between usernames, display
names, nicknames, mentions, and Direct Message addressing. It then translates
that behavior into concrete guidance for Buzzcode. Discord's consumer Help
Center is the authority for visible product behavior; its Developer
Documentation is used to confirm the underlying identifiers and payloads.

## Summary

Discord does not make people type a unique username for every interaction.
The unique username is the account-wide address used to connect to or verify a
person. Once a person is in the current context, Discord primarily presents a
non-unique display name or context-specific nickname and lets users find them
by those names.

The important separation is:

| Concept | Uniqueness and scope | Primary use |
| --- | --- | --- |
| User ID | Stable and global | Stored identity, DM recipient, mention target |
| Username | Unique, global, lowercase | Exact account lookup, adding friends, identity verification |
| Display name | Non-unique and global | Primary visible name outside nickname contexts |
| Server nickname | Non-unique and server-scoped | Primary visible name inside one server |
| Friend nickname | Non-unique and viewer-scoped | Primary visible name for one person's view of a friend |

For Buzzcode, a Handle should remain globally unique, but it should not be the
only searchable name in a people picker or mention autocomplete. Any selected
person must resolve to and be stored as an internal user ID.

## Verified Discord behavior

### Username

Discord's current consumer username is global, unique, case-insensitive, and
forced lowercase. It is 2-32 characters and permits `a-z`, `0-9`, `_`, and
`.` with no consecutive periods. Discord describes it as the identifier used
for friend requests and for validating who a person is. When a desired
username is taken, the user must distinguish it with numbers, underscores, or
periods. See [New Usernames & Display
Names](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names)
and [Evolving Usernames on Discord](https://discord.com/blog/usernames).

Adding a friend by text requires the exact username; an approximate or display
name lookup is not accepted by that flow. A friend request can also be started
from a known user's profile or server member entry, where the user has already
been resolved. See [How do I add friends on
Discord?](https://support.discord.com/hc/en-us/articles/218344397-How-do-I-add-friends-on-Discord).

The generic Developer Documentation currently describes the `username` field
as "not unique across the platform." That generic API description should not
be used as an identity guarantee. The current consumer account contract above
says new usernames are unique, while Discord's API consistently uses the
immutable snowflake `id` for references. See the [Discord User
Resource](https://docs.discord.com/developers/resources/user#user-object-user-structure).

### Display name

The display name is the primary account-wide presentation. It can contain
spaces, emoji, upper-case, and non-Latin characters, and it is not unique.
Discord shows it prominently in DMs and servers when no more-specific nickname
exists. The unique username remains available alongside it to validate which
person is being viewed. See [New Usernames & Display
Names](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names).

### Server and friend nicknames

Discord applies a presentation priority rather than replacing account
identity:

1. A server nickname takes priority inside that server.
2. A friend nickname takes priority in the viewer's applicable DM surfaces.
3. Otherwise, the display name is shown.
4. The username remains inspectable on the profile for disambiguation.

Server nicknames may be changed by the member or by someone with the relevant
server permission. Discord explicitly says a user can be `@`-mentioned by
either username or server nickname and can be found by either in the server
member-management search. See [Server
Nicknames](https://support.discord.com/hc/en-us/articles/219070107-Server-Nicknames)
and [New Usernames & Display
Names](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names).

The server member API models the same separation: the member has an optional
server-scoped `nick`, while the nested user object retains account identity.
The official member search endpoint matches a prefix against username or
nickname. See [Guild Member Object](https://docs.discord.com/developers/resources/guild#guild-member-object-guild-member-structure)
and [Search Guild Members](https://docs.discord.com/developers/resources/guild#search-guild-members).

### Mentions and autocomplete

Discord's main username article is explicit: in a server, people can be
searched for mention by display name or username. If a server nickname is set,
the completed mention displays that nickname; otherwise it displays the
account display name. See [Where are Display Names and Usernames
Used?](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names#h_01GZDHQ8FV8F7554H65MWK0B19).

Discord also documents an experimental desktop Mention Suggestions feature.
Within the current text channel, DM, or group message, it matches username,
display name, server nickname, and custom friend nickname among people who can
view that context. Matching happens locally against data already loaded in the
client. This experiment is useful corroboration, but Buzzcode should not copy
its local-data limitation as a product requirement. See [Mention Suggestions
FAQ](https://support.discord.com/hc/en-us/articles/35692242798743-Mention-Suggestions-FAQ).

The typed name is only an input mechanism. A stored Discord user mention is
`<@USER_ID>`, and message payloads expose mentioned user objects. Notification
controls likewise accept user IDs. Renaming the user therefore changes the
rendered label without changing who was mentioned. See [Message
Formatting](https://docs.discord.com/developers/reference#message-formatting)
and [Allowed Mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object).

### Finding people and starting DMs

Discord separates finding an unknown account from returning to a known DM:

- The Add Friend text flow requires the exact unique username.
- A known person can be selected from a profile or server member context.
- Quick Switcher's `@` filter navigates to existing DMs; it is not documented
  as a global account directory. See [Quick
  Switcher](https://support.discord.com/hc/en-us/articles/115000070311-Quick-Switcher).
- At the protocol level, opening a DM takes `recipient_id`, not a username or
  display name. See [Create
  DM](https://docs.discord.com/developers/resources/user#create-dm).

Discord normally permits a non-friend in a shared server to send a DM, subject
to per-user and per-server privacy controls. First contact may be placed in
Message Requests, and Discord's default setting allows DMs from people in a
shared server. See [Blocking & Privacy
Settings](https://support.discord.com/hc/en-us/articles/217916488-Blocking-Privacy-Settings),
[Message Requests](https://support.discord.com/hc/en-us/articles/7924992471191-Message-Requests),
and [Why isn't my DM going
through?](https://support.discord.com/hc/en-us/articles/360060145013-Why-isn-t-my-DM-going-through).

Closing a Discord private-message channel does not destroy its identity; the
same DM can be reopened with the recipient. See [Delete/Close
Channel](https://docs.discord.com/developers/resources/channel#deleteclose-channel).

## Buzzcode implications

### Data model

Buzzcode should keep these fields orthogonal:

- `users.id` or the existing stable subject: immutable identity.
- `users.handle`: global unique address, normalized like a Discord username.
- `users.display_name`: global non-unique presentation.
- `server_members.nickname`: optional server-scoped non-unique presentation.
- A future friend nickname, if implemented, must be keyed by both owner user ID
  and target user ID; it must not modify the target user's profile.

Direct Message participant rows and mention entities must store the stable user
ID, never a Handle, display name, nickname, or email. Handle changes must not
fork an existing DM or invalidate old mentions.

### Mention UX

In a server channel, typing after `@` should search accessible server members
by all of:

- server nickname;
- display name;
- Handle.

Each suggestion should show the context name prominently and `@handle` as
secondary disambiguation. Duplicate display names and duplicate nicknames are
valid and should produce multiple candidates. Selecting one inserts a mention
entity targeting the user's stable ID. Render the mention using server
nickname, then display name, then Handle as fallback.

An agent mention should use the same picker interaction but resolve to an agent
ID and remain a distinct domain type from a user mention.

### DM UX

Replace a Handle-only "start DM" text field with a people picker:

- Search known or eligible people by display name and Handle.
- Show display name prominently and `@handle` secondarily.
- Allow exact `@handle` lookup for someone not already visible in a local list.
- If display names collide, require the user to select a concrete result; never
  guess from the text.
- Send the selected stable user ID to the DM creation endpoint.

The DM list and header should primarily show display name, not Handle. Handle
belongs in search results, profile surfaces, and ambiguous identity checks.
Server nicknames should not rename a cross-server DM. If friend nicknames are
not part of Buzzcode v1, the DM presentation falls back directly to display
name.

Buzzcode currently has no Discord-style friend graph. A Discord-like v1 can
still support the useful parts without adding one immediately:

1. Search people who share at least one accessible server by display name or
   Handle.
2. Permit exact Handle lookup for cross-server DM initiation if the product
   intentionally supports it.
3. Resolve the chosen result to internal user ID.
4. Add privacy/message-request policy before allowing unsolicited global DMs
   in a public SaaS; Discord does not treat global username knowledge as
   unconditional permission to deliver a DM.

### Minimum acceptance cases

- Two users with the same display name both appear in mention and DM search,
  distinguished by Handle.
- Typing either a display-name prefix or Handle prefix finds an accessible
  server member for mention.
- Typing a server-nickname prefix finds the member and inserts the same user-ID
  mention.
- A completed mention renders the server nickname when present and display
  name otherwise.
- Renaming Handle, display name, or server nickname does not change the target
  of an old mention or create a second DM.
- Starting a DM from a selected display-name result sends the internal user ID,
  not the displayed text.
- The DM header/list primarily presents display name and uses Handle only for
  disambiguation.

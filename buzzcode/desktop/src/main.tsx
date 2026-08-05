import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type AuditEntry,
  type AuthSession,
  acceptInvitation,
  type Channel,
  type ChannelMessage,
  completeDesktopLogin,
  createChannel,
  createChannelMessage,
  createInvitation,
  createServer,
  deleteServer,
  listAudit,
  listChannelMessages,
  listChannels,
  listMembers,
  listServers,
  loginUrl,
  logout,
  readAuthSession,
  readDurableState,
  type Server,
  type ServerMember,
  startDesktopLogin,
  subscribeToServerEvents,
  transferOwnership,
  updateMemberRole,
  writeDurableState,
} from "./api";
import "./styles.css";

function AuthenticatedApp({
  session,
}: {
  session: AuthSession & { authenticated: true };
}) {
  const [servers, setServers] = useState<readonly Server[] | null>(null);
  const [activeServer, setActiveServer] = useState<Server | null>(null);
  const [serverName, setServerName] = useState("");
  const [channels, setChannels] = useState<readonly Channel[] | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [channelName, setChannelName] = useState("");
  const [messages, setMessages] = useState<readonly ChannelMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<number | undefined>();
  const [messageDraft, setMessageDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChannelMessage | null>(null);
  const [durableValue, setDurableValue] = useState("Loading…");
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [members, setMembers] = useState<readonly ServerMember[]>([]);
  const [audit, setAudit] = useState<readonly AuditEntry[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [createdInvite, setCreatedInvite] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const managementRequestVersion = useRef(0);
  const messageChannelId = useRef<string | null>(null);

  const mergeMessages = useCallback(
    (
      current: readonly ChannelMessage[],
      incoming: readonly ChannelMessage[],
    ): readonly ChannelMessage[] => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) byId.set(message.id, message);
      return [...byId.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );
    },
    [],
  );

  const reloadServers = useCallback(async (preferredId?: string) => {
    const loaded = await listServers();
    setServers(loaded);
    setActiveServer((current) => {
      const wanted = preferredId ?? current?.id;
      return loaded.find((server) => server.id === wanted) ?? loaded[0] ?? null;
    });
  }, []);

  const reloadManagement = useCallback(async (serverId: string) => {
    const requestVersion = ++managementRequestVersion.current;
    const [loadedMembers, loadedAudit] = await Promise.all([
      listMembers(serverId),
      listAudit(serverId),
    ]);
    if (requestVersion !== managementRequestVersion.current) return;
    setMembers(loadedMembers);
    setAudit(loadedAudit);
  }, []);

  const reloadChannels = useCallback(async (serverId: string) => {
    const loaded = await listChannels(serverId);
    setChannels(loaded);
    setActiveChannel((current) => {
      if (
        current !== null &&
        loaded.some((channel) => channel.id === current.id)
      ) {
        return current;
      }
      return loaded[0] ?? null;
    });
  }, []);

  const reloadMessages = useCallback(
    async (serverId: string, channelId: string) => {
      const page = await listChannelMessages(serverId, channelId);
      if (messageChannelId.current !== channelId) return;
      setMessages((current) => mergeMessages(current, page.messages));
      setNextBefore(page.nextBefore);
    },
    [mergeMessages],
  );

  useEffect(() => {
    void reloadServers();
  }, [reloadServers]);

  useEffect(() => {
    if (activeServer === null) return;
    let current = true;
    setConnected(false);
    setChannels(null);
    setActiveChannel(null);
    messageChannelId.current = null;
    setMessages([]);
    setNextBefore(undefined);
    setReplyingTo(null);
    void reloadManagement(activeServer.id);
    void reloadChannels(activeServer.id);
    void readDurableState(activeServer.id).then((state) => {
      if (!current) return;
      setDurableValue(state.value);
      setDraft(state.value);
    });
    const unsubscribe = subscribeToServerEvents(
      activeServer.id,
      (event) => {
        if (!current) return;
        if (event.type === "durableStateChanged") {
          setDurableValue(event.state.value);
          setDraft(event.state.value);
        } else if (
          event.type === "membershipChanged" ||
          event.type === "serverDeleted"
        ) {
          void reloadServers(activeServer.id);
          void reloadManagement(activeServer.id);
        } else if (event.type === "channelCreated") {
          setChannels((existing) => {
            if (existing?.some((channel) => channel.id === event.channel.id)) {
              return existing;
            }
            return [...(existing ?? []), event.channel];
          });
          setActiveChannel((currentChannel) => currentChannel ?? event.channel);
        } else if (
          event.type === "messageCreated" &&
          event.message.channelId === messageChannelId.current
        ) {
          setMessages((existing) => mergeMessages(existing, [event.message]));
        }
      },
      (connected) => {
        if (current) {
          setConnected(connected);
          if (connected) {
            void reloadChannels(activeServer.id);
            if (messageChannelId.current !== null) {
              void reloadMessages(activeServer.id, messageChannelId.current);
            }
          }
        }
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [
    activeServer,
    mergeMessages,
    reloadChannels,
    reloadManagement,
    reloadMessages,
    reloadServers,
  ]);

  useEffect(() => {
    if (activeServer === null || activeChannel === null) return;
    messageChannelId.current = activeChannel.id;
    setMessages([]);
    setNextBefore(undefined);
    setReplyingTo(null);
    void reloadMessages(activeServer.id, activeChannel.id);
  }, [activeChannel, activeServer, reloadMessages]);

  async function addServer() {
    const server = await createServer(serverName);
    setServers((current) => [...(current ?? []), server]);
    setActiveServer(server);
    setServerName("");
  }

  async function addChannel() {
    if (activeServer === null) return;
    const channel = await createChannel(activeServer.id, channelName);
    setChannels((current) => [
      ...(current ?? []).filter((item) => item.id !== channel.id),
      channel,
    ]);
    setActiveChannel(channel);
    setChannelName("");
  }

  async function sendMessage() {
    if (activeServer === null || activeChannel === null) return;
    const message = await createChannelMessage(
      activeServer.id,
      activeChannel.id,
      messageDraft,
      replyingTo?.id,
    );
    setMessages((current) => mergeMessages(current, [message]));
    setMessageDraft("");
    setReplyingTo(null);
  }

  async function loadOlderMessages() {
    if (
      activeServer === null ||
      activeChannel === null ||
      nextBefore === undefined
    ) {
      return;
    }
    const page = await listChannelMessages(
      activeServer.id,
      activeChannel.id,
      nextBefore,
    );
    setMessages((current) => mergeMessages(current, page.messages));
    setNextBefore(page.nextBefore);
  }

  async function save() {
    if (activeServer === null) return;
    const state = await writeDurableState(activeServer.id, draft);
    setDurableValue(state.value);
  }

  async function inviteMember() {
    if (activeServer === null) return;
    const invitation = await createInvitation(activeServer.id, inviteEmail);
    setCreatedInvite(invitation.token);
    setInviteEmail("");
    await reloadManagement(activeServer.id);
  }

  async function joinServer() {
    const server = await acceptInvitation(inviteCode);
    setInviteCode("");
    await reloadServers(server.id);
  }

  async function changeRole(member: ServerMember, role: "admin" | "member") {
    if (activeServer === null) return;
    await updateMemberRole(activeServer.id, member.subject, role);
    await reloadManagement(activeServer.id);
  }

  async function makeOwner(member: ServerMember) {
    if (activeServer === null) return;
    await transferOwnership(activeServer.id, member.subject);
    await reloadServers(activeServer.id);
    await reloadManagement(activeServer.id);
  }

  async function removeActiveServer() {
    if (activeServer === null) return;
    await deleteServer(activeServer.id);
    await reloadServers();
  }

  const joinServerForm = (
    <>
      <label htmlFor="invitation-code">Invitation code</label>
      <div className="composer">
        <input
          id="invitation-code"
          value={inviteCode}
          onChange={(event) => setInviteCode(event.target.value)}
        />
        <button type="button" onClick={() => void joinServer()}>
          Join Server
        </button>
      </div>
    </>
  );

  if (servers === null) return <main className="shell">Loading…</main>;
  if (servers.length === 0 || activeServer === null) {
    return (
      <main className="shell">
        <section className="card">
          <p data-testid="signed-in-user">{session.user.email}</p>
          <h1>Create your first Server</h1>
          <label htmlFor="server-name">Server name</label>
          <div className="composer">
            <input
              id="server-name"
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
            />
            <button type="button" onClick={() => void addServer()}>
              Create Server
            </button>
          </div>
          {joinServerForm}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Independent application vertical</p>
        <h1>Buzzcode</h1>
        <h2 data-testid="active-server-name">{activeServer.name}</h2>
        <p data-testid="active-member-role">
          {activeServer.role === "owner"
            ? "Owner"
            : activeServer.role === "admin"
              ? "Admin"
              : "Member"}
        </p>
        <nav aria-label="Servers">
          {servers.map((server) => (
            <button
              key={server.id}
              type="button"
              data-server-id={server.id}
              onClick={() => setActiveServer(server)}
            >
              {server.name}
            </button>
          ))}
        </nav>
        <section className="chat-layout" aria-label="Server Channels">
          <aside className="channel-sidebar">
            <div className="section-heading">
              <h3>Channels</h3>
              <span>{connected ? "Live" : "Connecting"}</span>
            </div>
            <nav aria-label="Channels" className="channel-list">
              {channels?.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  data-channel-id={channel.id}
                  aria-current={activeChannel?.id === channel.id}
                  onClick={() => setActiveChannel(channel)}
                >
                  <span aria-hidden="true">#</span> {channel.name}
                </button>
              ))}
            </nav>
            {(activeServer.role === "owner" ||
              activeServer.role === "admin") && (
              <div className="channel-create">
                <label htmlFor="channel-name">Channel name</label>
                <div className="composer compact">
                  <input
                    id="channel-name"
                    value={channelName}
                    maxLength={80}
                    onChange={(event) => setChannelName(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={channelName.trim() === ""}
                    onClick={() => void addChannel()}
                  >
                    Create Channel
                  </button>
                </div>
              </div>
            )}
          </aside>
          <section className="channel-panel">
            {activeChannel === null ? (
              <div className="channel-empty">
                <h3>No channels yet</h3>
                <p>Create an Open Channel to start talking with the Server.</p>
              </div>
            ) : (
              <>
                <header className="channel-header">
                  <div>
                    <h3 data-testid="active-channel-name">
                      # {activeChannel.name}
                    </h3>
                    <p>Open Channel · visible to every Server Member</p>
                  </div>
                </header>
                <div
                  className="message-timeline"
                  role="log"
                  aria-label="Messages"
                  aria-live="polite"
                >
                  {nextBefore !== undefined && (
                    <button
                      className="load-older"
                      type="button"
                      onClick={() => void loadOlderMessages()}
                    >
                      Load older messages
                    </button>
                  )}
                  {messages.length === 0 && (
                    <p className="channel-empty">No messages yet.</p>
                  )}
                  {messages.map((message) => (
                    <article
                      className="message"
                      key={message.id}
                      data-message-id={message.id}
                    >
                      {message.replyTo !== undefined && (
                        <div className="reply-reference">
                          <strong>{message.replyTo.authorDisplayName}</strong>
                          <span>{message.replyTo.content}</span>
                        </div>
                      )}
                      <div className="message-meta">
                        <strong>{message.authorDisplayName}</strong>
                        <time dateTime={message.createdAt}>
                          {new Date(message.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <p>{message.content}</p>
                      <button
                        className="reply-button"
                        type="button"
                        aria-label={`Reply to ${message.authorDisplayName}`}
                        onClick={() => setReplyingTo(message)}
                      >
                        Reply
                      </button>
                    </article>
                  ))}
                </div>
                <div className="message-composer">
                  {replyingTo !== null && (
                    <div className="replying-to">
                      <span>
                        Replying to{" "}
                        <strong>{replyingTo.authorDisplayName}</strong>
                      </span>
                      <button
                        type="button"
                        aria-label="Cancel reply"
                        onClick={() => setReplyingTo(null)}
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (messageDraft.trim() !== "") void sendMessage();
                    }}
                  >
                    <label className="sr-only" htmlFor="message-content">
                      Message #{activeChannel.name}
                    </label>
                    <input
                      id="message-content"
                      value={messageDraft}
                      maxLength={4000}
                      placeholder={`Message #${activeChannel.name}`}
                      onChange={(event) => setMessageDraft(event.target.value)}
                    />
                    <button type="submit" disabled={messageDraft.trim() === ""}>
                      Send
                    </button>
                  </form>
                </div>
              </>
            )}
          </section>
        </section>
        <label htmlFor="new-server-name">New Server name</label>
        <div className="composer">
          <input
            id="new-server-name"
            value={serverName}
            onChange={(event) => setServerName(event.target.value)}
          />
          <button type="button" onClick={() => void addServer()}>
            Create another Server
          </button>
        </div>
        {joinServerForm}
        <p data-testid="signed-in-user">{session.user.email}</p>
        <button
          type="button"
          onClick={() => void logout().then(() => window.location.reload())}
        >
          Sign out
        </button>
        <p className="lede">
          Durable PostgreSQL state delivered over typed HTTP and WebSocket APIs.
        </p>
        <dl className="status-grid">
          <div>
            <dt>Realtime</dt>
            <dd data-testid="realtime-status">
              {connected ? "Connected" : "Disconnected"}
            </dd>
          </div>
          <div>
            <dt>Durable value</dt>
            <dd data-testid="durable-value">{durableValue}</dd>
          </div>
        </dl>
        <label htmlFor="durable-value-input">Durable value</label>
        <div className="composer">
          <input
            id="durable-value-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="button" onClick={() => void save()}>
            Save
          </button>
        </div>
        <section aria-labelledby="members-heading">
          <h3 id="members-heading">Members</h3>
          {(activeServer.role === "owner" || activeServer.role === "admin") && (
            <>
              <label htmlFor="invite-email">Invite email</label>
              <div className="composer">
                <input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
                <button type="button" onClick={() => void inviteMember()}>
                  Create invitation
                </button>
              </div>
              {createdInvite !== "" && (
                <output data-testid="invitation-code">{createdInvite}</output>
              )}
            </>
          )}
          <ul className="member-list">
            {members.map((member) => (
              <li key={member.subject} data-member-subject={member.subject}>
                <span>
                  {member.displayName} ({member.email})
                </span>
                {member.role === "owner" ||
                (activeServer.role !== "owner" &&
                  activeServer.role !== "admin") ? (
                  <strong>
                    {member.role === "owner"
                      ? "Owner"
                      : member.role === "admin"
                        ? "Admin"
                        : "Member"}
                  </strong>
                ) : (
                  <>
                    <select
                      aria-label={`Role for ${member.email}`}
                      value={member.role}
                      onChange={(event) =>
                        void changeRole(
                          member,
                          event.target.value as "admin" | "member",
                        )
                      }
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    {activeServer.role === "owner" && (
                      <button
                        type="button"
                        onClick={() => void makeOwner(member)}
                      >
                        Transfer ownership
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="audit-heading">
          <h3 id="audit-heading">Audit history</h3>
          <ol data-testid="audit-history">
            {audit.map((entry) => (
              <li key={entry.id}>{entry.action}</li>
            ))}
          </ol>
        </section>
        {activeServer.role === "owner" && (
          <button
            className="danger"
            type="button"
            onClick={() => void removeActiveServer()}
          >
            Delete Server
          </button>
        )}
      </section>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState("");

  useEffect(() => {
    void readAuthSession().then(setSession);
  }, []);

  async function signIn() {
    if (!("__TAURI_INTERNALS__" in window)) {
      window.location.assign(loginUrl());
      return;
    }
    setSigningIn(true);
    setSignInError("");
    try {
      const login = await startDesktopLogin();
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(login.loginUrl);
      for (let attempt = 0; attempt < 800; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        if (!(await completeDesktopLogin(login.completionToken))) continue;
        const authenticated = await readAuthSession();
        setSession(authenticated);
        setSigningIn(false);
        return;
      }
      throw new Error("sign-in timed out");
    } catch (error) {
      setSignInError(
        error instanceof Error ? error.message : "Buzzcode sign-in failed",
      );
      setSigningIn(false);
    }
  }

  if (session === null) {
    return <main className="shell">Loading…</main>;
  }
  if (!session.authenticated) {
    return (
      <main className="shell">
        <section className="card">
          <p className="eyebrow">Passwordless authentication</p>
          <h1>Sign in to Buzzcode</h1>
          <p className="lede">
            Use the passkey registered when your account was activated.
          </p>
          <button
            type="button"
            disabled={signingIn}
            onClick={() => void signIn()}
          >
            {signingIn ? "Waiting for passkey…" : "Sign in with a passkey"}
          </button>
          {signInError !== "" && <p role="alert">{signInError}</p>}
        </section>
      </main>
    );
  }
  return <AuthenticatedApp session={session} />;
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type AuditEntry,
  type AuthSession,
  acceptInvitation,
  createInvitation,
  createServer,
  deleteServer,
  listAudit,
  listMembers,
  listServers,
  loginUrl,
  logout,
  readAuthSession,
  readDurableState,
  type Server,
  type ServerMember,
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
  const [durableValue, setDurableValue] = useState("Loading…");
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [members, setMembers] = useState<readonly ServerMember[]>([]);
  const [audit, setAudit] = useState<readonly AuditEntry[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [createdInvite, setCreatedInvite] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const managementRequestVersion = useRef(0);

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

  useEffect(() => {
    void reloadServers();
  }, [reloadServers]);

  useEffect(() => {
    if (activeServer === null) return;
    let current = true;
    setConnected(false);
    void reloadManagement(activeServer.id);
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
        } else {
          void reloadServers(activeServer.id);
          void reloadManagement(activeServer.id);
        }
      },
      (connected) => {
        if (current) {
          setConnected(connected);
          if (!connected) void reloadServers();
        }
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [activeServer, reloadManagement, reloadServers]);

  async function addServer() {
    const server = await createServer(serverName);
    setServers((current) => [...(current ?? []), server]);
    setActiveServer(server);
    setServerName("");
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

  useEffect(() => {
    void readAuthSession().then(setSession);
  }, []);

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
            onClick={() => window.location.assign(loginUrl())}
          >
            Sign in with a passkey
          </button>
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

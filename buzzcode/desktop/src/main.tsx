import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type AuthSession,
  createServer,
  listServers,
  loginUrl,
  logout,
  readAuthSession,
  readDurableState,
  type Server,
  subscribeToServerEvents,
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

  useEffect(() => {
    void listServers().then((loaded) => {
      setServers(loaded);
      setActiveServer(loaded[0] ?? null);
    });
  }, []);

  useEffect(() => {
    if (activeServer === null) return;
    let current = true;
    setConnected(false);
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
        }
      },
      (connected) => {
        if (current) setConnected(connected);
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [activeServer]);

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
          {activeServer.role === "owner" ? "Owner" : activeServer.role}
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

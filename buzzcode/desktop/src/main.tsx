import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type AuthSession,
  loginUrl,
  logout,
  readAuthSession,
  readDurableState,
  subscribeToServerEvents,
  writeDurableState,
} from "./api";
import "./styles.css";

function AuthenticatedApp({
  session,
}: {
  session: AuthSession & { authenticated: true };
}) {
  const [durableValue, setDurableValue] = useState("Loading…");
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    void readDurableState().then((state) => {
      setDurableValue(state.value);
      setDraft(state.value);
    });
    return subscribeToServerEvents((event) => {
      if (event.type === "durableStateChanged") {
        setDurableValue(event.state.value);
        setDraft(event.state.value);
      }
    }, setConnected);
  }, []);

  async function save() {
    const state = await writeDurableState(draft);
    setDurableValue(state.value);
  }

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Independent application vertical</p>
        <h1>Buzzcode</h1>
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

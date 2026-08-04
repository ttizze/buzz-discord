import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  readDurableState,
  subscribeToServerEvents,
  writeDurableState,
} from "./api";
import "./styles.css";

function App() {
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

const root = document.getElementById("root");
if (root === null) {
  throw new Error("root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

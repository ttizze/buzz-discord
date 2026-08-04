export type DurableState = Readonly<{
  value: string;
}>;

export type ServerEvent = Readonly<{
  type: "durableStateChanged";
  state: DurableState;
}>;

const e2eApiOrigin =
  import.meta.env.MODE === "e2e"
    ? new URLSearchParams(window.location.search).get("apiOrigin")
    : null;
const apiOrigin =
  e2eApiOrigin ??
  import.meta.env.VITE_BUZZCODE_API_ORIGIN ??
  "http://127.0.0.1:3100";
const websocketOrigin = apiOrigin.replace(/^http/, "ws");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDurableState(value: unknown): DurableState {
  if (!isRecord(value) || typeof value.value !== "string") {
    throw new Error("Buzzcode API returned an invalid durable state");
  }
  return { value: value.value };
}

function parseServerEvent(value: unknown): ServerEvent {
  if (
    !isRecord(value) ||
    value.type !== "durableStateChanged" ||
    !isRecord(value.state)
  ) {
    throw new Error("Buzzcode API returned an invalid server event");
  }
  return { type: value.type, state: parseDurableState(value.state) };
}

async function parseResponse<T>(
  response: Response,
  parse: (value: unknown) => T,
): Promise<T> {
  if (!response.ok) {
    throw new Error(`Buzzcode API returned ${response.status}`);
  }
  return parse(await response.json());
}

export async function readDurableState(): Promise<DurableState> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/bootstrap`),
    parseDurableState,
  );
}

export async function writeDurableState(value: string): Promise<DurableState> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/bootstrap`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }),
    parseDurableState,
  );
}

export function subscribeToServerEvents(
  onEvent: (event: ServerEvent) => void,
  onConnectionChange: (connected: boolean) => void,
): () => void {
  const websocket = new WebSocket(`${websocketOrigin}/api/events`);
  websocket.addEventListener("open", () => onConnectionChange(true));
  websocket.addEventListener("close", () => onConnectionChange(false));
  websocket.addEventListener("message", (message) => {
    const event = parseServerEvent(JSON.parse(String(message.data)) as unknown);
    onEvent(event);
  });
  return () => websocket.close();
}

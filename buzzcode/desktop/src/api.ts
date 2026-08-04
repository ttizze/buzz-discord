export type DurableState = Readonly<{
  value: string;
}>;

export type ServerEvent = Readonly<{
  type: "durableStateChanged";
  state: DurableState;
}>;

export type AuthSession =
  | Readonly<{ authenticated: false }>
  | Readonly<{
      authenticated: true;
      user: Readonly<{ email: string; displayName: string }>;
    }>;

export type Server = Readonly<{
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
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

function parseAuthSession(value: unknown): AuthSession {
  if (!isRecord(value) || typeof value.authenticated !== "boolean") {
    throw new Error("Buzzcode API returned an invalid authentication session");
  }
  if (!value.authenticated) return { authenticated: false };
  if (
    !isRecord(value.user) ||
    typeof value.user.email !== "string" ||
    typeof value.user.displayName !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid authenticated user");
  }
  return {
    authenticated: true,
    user: { email: value.user.email, displayName: value.user.displayName },
  };
}

function parseServer(value: unknown): Server {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !["owner", "admin", "member"].includes(String(value.role))
  ) {
    throw new Error("Buzzcode API returned an invalid Server");
  }
  return { id: value.id, name: value.name, role: value.role as Server["role"] };
}

export async function listServers(): Promise<readonly Server[]> {
  const response = await fetch(`${apiOrigin}/api/servers`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value))
    throw new Error("Buzzcode API returned an invalid Server list");
  return value.map(parseServer);
}

export async function createServer(name: string): Promise<Server> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/servers`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    parseServer,
  );
}

export function loginUrl(): string {
  return `${apiOrigin}/api/auth/login`;
}

export async function readAuthSession(): Promise<AuthSession> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/auth/session`, { credentials: "include" }),
    parseAuthSession,
  );
}

export async function logout(): Promise<void> {
  const response = await fetch(`${apiOrigin}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
}

export async function readDurableState(
  serverId: string,
): Promise<DurableState> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/bootstrap`,
      {
        credentials: "include",
      },
    ),
    parseDurableState,
  );
}

export async function writeDurableState(
  serverId: string,
  value: string,
): Promise<DurableState> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/bootstrap`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      },
    ),
    parseDurableState,
  );
}

export function subscribeToServerEvents(
  serverId: string,
  onEvent: (event: ServerEvent) => void,
  onConnectionChange: (connected: boolean) => void,
): () => void {
  const websocket = new WebSocket(
    `${websocketOrigin}/api/servers/${encodeURIComponent(serverId)}/events`,
  );
  websocket.addEventListener("open", () => onConnectionChange(true));
  websocket.addEventListener("close", () => onConnectionChange(false));
  websocket.addEventListener("message", (message) => {
    const event = parseServerEvent(JSON.parse(String(message.data)) as unknown);
    onEvent(event);
  });
  return () => websocket.close();
}

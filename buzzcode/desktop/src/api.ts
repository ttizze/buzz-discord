export type DurableState = Readonly<{
  value: string;
}>;

export type ServerEvent =
  | Readonly<{
      type: "durableStateChanged";
      state: DurableState;
    }>
  | Readonly<{ type: "membershipChanged" }>
  | Readonly<{ type: "serverDeleted" }>
  | Readonly<{ type: "channelCreated"; channel: Channel }>
  | Readonly<{ type: "channelAccessChanged" }>
  | Readonly<{ type: "projectsChanged" }>
  | Readonly<{ type: "messageCreated"; message: ChannelMessage }>
  | Readonly<{
      type: "messageChanged";
      channelId: string;
      messageId: string;
    }>;

export type AuthSession =
  | Readonly<{ authenticated: false }>
  | Readonly<{
      authenticated: true;
      user: Readonly<{
        subject: string;
        email: string;
        handle: string;
        displayName: string;
      }>;
    }>;

export type DesktopLogin = Readonly<{
  loginUrl: string;
  completionToken: string;
}>;

export type Server = Readonly<{
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
}>;

export type Channel = Readonly<{
  id: string;
  name: string;
  visibility: "open" | "private";
  memberSubjects: readonly string[];
}>;

export type ChannelMessage = Readonly<{
  id: string;
  sequence: number;
  channelId: string;
  content?: string;
  authorSubject: string;
  authorDisplayName: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  replyTo?: Readonly<{
    id: string;
    content?: string;
    authorDisplayName: string;
    deleted: boolean;
  }>;
  reactions: readonly Readonly<{
    emoji: string;
    count: number;
    reacted: boolean;
  }>[];
  mentions: readonly MessageMention[];
}>;

export type MessagePage = Readonly<{
  messages: readonly ChannelMessage[];
  nextBefore?: number;
}>;

export type DirectMessage = Readonly<{
  id: string;
  peerUserId: string;
  peerHandle: string;
  peerDisplayName: string;
}>;

export type UserSearchResult = Readonly<{
  userId: string;
  handle: string;
  displayName: string;
}>;

export type MentionInput = Readonly<{
  userId: string;
  start: number;
  end: number;
}>;

export type MessageMention = UserSearchResult & MentionInput;

export type DirectMessageMessage = Readonly<{
  id: string;
  sequence: number;
  directMessageId: string;
  content?: string;
  authorSubject: string;
  authorDisplayName: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  replyTo?: ChannelMessage["replyTo"];
  reactions: ChannelMessage["reactions"];
}>;

export type DirectMessagePage = Readonly<{
  messages: readonly DirectMessageMessage[];
  nextBefore?: number;
}>;

export type DirectMessageEvent =
  | Readonly<{ type: "directMessageChanged"; directMessageId: string }>
  | Readonly<{
      type: "messageCreated";
      directMessageId: string;
      message: DirectMessageMessage;
    }>
  | Readonly<{
      type: "messageChanged";
      directMessageId: string;
      messageId: string;
    }>;

export type ServerMember = Readonly<{
  subject: string;
  email: string;
  handle: string;
  displayName: string;
  role: Server["role"];
}>;

export type ServerInvitation = Readonly<{
  token: string;
  email: string;
}>;

export type HostPairingCode = Readonly<{
  code: string;
  expiresAt: string;
}>;

export type Computer = Readonly<{
  id: string;
  name: string;
  status: "online" | "offline" | "reconnecting" | "revoked";
  createdAt: string;
  lastSeenAt?: string;
}>;

export type ServerProject = Readonly<{
  id: string;
  name: string;
  computerId: string;
  computerName: string;
  computerStatus: Computer["status"];
  folderPath: string;
  visibility: "open";
  channels: readonly Channel[];
}>;

export type AuditEntry = Readonly<{
  id: number;
  actorSubject: string;
  action: string;
  targetSubject?: string;
  detail: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

const e2eApiOrigin =
  import.meta.env.MODE === "e2e"
    ? new URLSearchParams(window.location.search).get("apiOrigin")
    : null;
const apiOrigin =
  e2eApiOrigin ??
  import.meta.env.VITE_BUZZCODE_API_ORIGIN ??
  "http://localhost:3100";
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
    isRecord(value) &&
    value.type === "channelCreated" &&
    isRecord(value.channel)
  ) {
    return { type: value.type, channel: parseChannel(value.channel) };
  }
  if (
    isRecord(value) &&
    value.type === "messageCreated" &&
    isRecord(value.message)
  ) {
    return { type: value.type, message: parseChannelMessage(value.message) };
  }
  if (
    isRecord(value) &&
    value.type === "messageChanged" &&
    typeof value.channelId === "string" &&
    typeof value.messageId === "string"
  ) {
    return {
      type: value.type,
      channelId: value.channelId,
      messageId: value.messageId,
    };
  }
  if (
    isRecord(value) &&
    (value.type === "membershipChanged" ||
      value.type === "serverDeleted" ||
      value.type === "channelAccessChanged" ||
      value.type === "projectsChanged")
  ) {
    return { type: value.type };
  }
  if (
    !isRecord(value) ||
    value.type !== "durableStateChanged" ||
    !isRecord(value.state)
  ) {
    throw new Error("Buzzcode API returned an invalid server event");
  }
  return { type: value.type, state: parseDurableState(value.state) };
}

function parseChannel(value: unknown): Channel {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !["open", "private"].includes(String(value.visibility)) ||
    !Array.isArray(value.memberSubjects) ||
    !value.memberSubjects.every((subject) => typeof subject === "string")
  ) {
    throw new Error("Buzzcode API returned an invalid Channel");
  }
  return {
    id: value.id,
    name: value.name,
    visibility: value.visibility as Channel["visibility"],
    memberSubjects: value.memberSubjects,
  };
}

function parseChannelMessage(value: unknown): ChannelMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.sequence !== "number" ||
    typeof value.channelId !== "string" ||
    (value.content !== null && typeof value.content !== "string") ||
    typeof value.authorSubject !== "string" ||
    typeof value.authorDisplayName !== "string" ||
    typeof value.createdAt !== "string" ||
    (value.editedAt !== null &&
      value.editedAt !== undefined &&
      typeof value.editedAt !== "string") ||
    (value.deletedAt !== null &&
      value.deletedAt !== undefined &&
      typeof value.deletedAt !== "string") ||
    !Array.isArray(value.reactions)
  ) {
    throw new Error("Buzzcode API returned an invalid Channel Message");
  }
  const reply = value.replyTo;
  if (
    reply !== undefined &&
    reply !== null &&
    (!isRecord(reply) ||
      typeof reply.id !== "string" ||
      (reply.content !== null && typeof reply.content !== "string") ||
      typeof reply.authorDisplayName !== "string" ||
      typeof reply.deleted !== "boolean")
  ) {
    throw new Error("Buzzcode API returned an invalid Reply target");
  }
  if (value.mentions !== undefined && !Array.isArray(value.mentions)) {
    throw new Error("Buzzcode API returned invalid Message mentions");
  }
  return {
    id: value.id,
    sequence: value.sequence,
    channelId: value.channelId,
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    authorSubject: value.authorSubject,
    authorDisplayName: value.authorDisplayName,
    createdAt: value.createdAt,
    ...(typeof value.editedAt === "string" ? { editedAt: value.editedAt } : {}),
    ...(typeof value.deletedAt === "string"
      ? { deletedAt: value.deletedAt }
      : {}),
    ...(isRecord(reply)
      ? {
          replyTo: {
            id: String(reply.id),
            ...(typeof reply.content === "string"
              ? { content: reply.content }
              : {}),
            authorDisplayName: String(reply.authorDisplayName),
            deleted: Boolean(reply.deleted),
          },
        }
      : {}),
    reactions: value.reactions.map((reaction) => {
      if (
        !isRecord(reaction) ||
        typeof reaction.emoji !== "string" ||
        typeof reaction.count !== "number" ||
        typeof reaction.reacted !== "boolean"
      ) {
        throw new Error("Buzzcode API returned an invalid Reaction");
      }
      return {
        emoji: reaction.emoji,
        count: reaction.count,
        reacted: reaction.reacted,
      };
    }),
    mentions: Array.isArray(value.mentions)
      ? value.mentions.map((mention) => {
          const user = parseUserSearchResult(mention);
          if (
            !isRecord(mention) ||
            typeof mention.start !== "number" ||
            typeof mention.end !== "number" ||
            mention.start < 0 ||
            mention.end <= mention.start
          ) {
            throw new Error("Buzzcode API returned an invalid Message mention");
          }
          return { ...user, start: mention.start, end: mention.end };
        })
      : [],
  };
}

function parseDirectMessage(value: unknown): DirectMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.peerUserId !== "string" ||
    typeof value.peerHandle !== "string" ||
    typeof value.peerDisplayName !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid Direct Message");
  }
  return {
    id: value.id,
    peerUserId: value.peerUserId,
    peerHandle: value.peerHandle,
    peerDisplayName: value.peerDisplayName,
  };
}

function parseUserSearchResult(value: unknown): UserSearchResult {
  if (
    !isRecord(value) ||
    typeof value.userId !== "string" ||
    typeof value.handle !== "string" ||
    typeof value.displayName !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid user search result");
  }
  return {
    userId: value.userId,
    handle: value.handle,
    displayName: value.displayName,
  };
}

function parseDirectMessageMessage(value: unknown): DirectMessageMessage {
  if (!isRecord(value) || typeof value.directMessageId !== "string") {
    throw new Error("Buzzcode API returned an invalid Direct Message message");
  }
  const channelShape = parseChannelMessage({
    ...value,
    channelId: value.directMessageId,
  });
  const { channelId: _channelId, ...message } = channelShape;
  return { ...message, directMessageId: value.directMessageId };
}

function parseDirectMessageEvent(value: unknown): DirectMessageEvent {
  if (
    !isRecord(value) ||
    typeof value.directMessageId !== "string" ||
    !["directMessageChanged", "messageCreated", "messageChanged"].includes(
      String(value.type),
    )
  ) {
    throw new Error("Buzzcode API returned an invalid Direct Message event");
  }
  if (value.type === "directMessageChanged") {
    return { type: value.type, directMessageId: value.directMessageId };
  }
  if (value.type === "messageCreated" && isRecord(value.message)) {
    return {
      type: value.type,
      directMessageId: value.directMessageId,
      message: parseDirectMessageMessage(value.message),
    };
  }
  if (value.type === "messageChanged" && typeof value.messageId === "string") {
    return {
      type: value.type,
      directMessageId: value.directMessageId,
      messageId: value.messageId,
    };
  }
  throw new Error("Buzzcode API returned an invalid Direct Message event");
}

function parseMember(value: unknown): ServerMember {
  if (
    !isRecord(value) ||
    typeof value.subject !== "string" ||
    typeof value.email !== "string" ||
    typeof value.handle !== "string" ||
    typeof value.displayName !== "string" ||
    !["owner", "admin", "member"].includes(String(value.role))
  ) {
    throw new Error("Buzzcode API returned an invalid Server member");
  }
  return {
    subject: value.subject,
    email: value.email,
    handle: value.handle,
    displayName: value.displayName,
    role: value.role as ServerMember["role"],
  };
}

function parseInvitation(value: unknown): ServerInvitation {
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    typeof value.email !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid invitation");
  }
  return { token: value.token, email: value.email };
}

function parseHostPairingCode(value: unknown): HostPairingCode {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid Host pairing code");
  }
  return { code: value.code, expiresAt: value.expiresAt };
}

function parseComputer(value: unknown): Computer {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !["online", "offline", "reconnecting", "revoked"].includes(
      String(value.status),
    ) ||
    typeof value.createdAt !== "string" ||
    (value.lastSeenAt !== undefined &&
      value.lastSeenAt !== null &&
      typeof value.lastSeenAt !== "string")
  ) {
    throw new Error("Buzzcode API returned an invalid Computer");
  }
  return {
    id: value.id,
    name: value.name,
    status: value.status as Computer["status"],
    createdAt: value.createdAt,
    ...(typeof value.lastSeenAt === "string"
      ? { lastSeenAt: value.lastSeenAt }
      : {}),
  };
}

function parseServerProject(value: unknown): ServerProject {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.computerId !== "string" ||
    typeof value.computerName !== "string" ||
    !["online", "offline", "reconnecting", "revoked"].includes(
      String(value.computerStatus),
    ) ||
    typeof value.folderPath !== "string" ||
    value.visibility !== "open" ||
    !Array.isArray(value.channels)
  ) {
    throw new Error("Buzzcode API returned an invalid Server Project");
  }
  return {
    id: value.id,
    name: value.name,
    computerId: value.computerId,
    computerName: value.computerName,
    computerStatus: value.computerStatus as Computer["status"],
    folderPath: value.folderPath,
    visibility: value.visibility,
    channels: value.channels.map(parseChannel),
  };
}

function parseAuditEntry(value: unknown): AuditEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.actorSubject !== "string" ||
    typeof value.action !== "string" ||
    (value.targetSubject !== undefined &&
      value.targetSubject !== null &&
      typeof value.targetSubject !== "string") ||
    !isRecord(value.detail) ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid audit entry");
  }
  return {
    id: value.id,
    actorSubject: value.actorSubject,
    action: value.action,
    ...(typeof value.targetSubject === "string"
      ? { targetSubject: value.targetSubject }
      : {}),
    detail: value.detail,
    createdAt: value.createdAt,
  };
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
    typeof value.user.subject !== "string" ||
    typeof value.user.email !== "string" ||
    typeof value.user.handle !== "string" ||
    typeof value.user.displayName !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid authenticated user");
  }
  return {
    authenticated: true,
    user: {
      subject: value.user.subject,
      email: value.user.email,
      handle: value.user.handle,
      displayName: value.user.displayName,
    },
  };
}

function parseDesktopLogin(value: unknown): DesktopLogin {
  if (
    !isRecord(value) ||
    typeof value.loginUrl !== "string" ||
    typeof value.completionToken !== "string"
  ) {
    throw new Error("Buzzcode API returned an invalid desktop login");
  }
  return {
    loginUrl: value.loginUrl,
    completionToken: value.completionToken,
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

export async function listChannels(
  serverId: string,
): Promise<readonly Channel[]> {
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value))
    throw new Error("Buzzcode API returned an invalid Channel list");
  return value.map(parseChannel);
}

export async function createChannel(
  serverId: string,
  name: string,
  visibility: Channel["visibility"] = "open",
  memberSubjects: readonly string[] = [],
): Promise<Channel> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, visibility, memberSubjects }),
      },
    ),
    parseChannel,
  );
}

export async function updateChannel(
  serverId: string,
  channelId: string,
  visibility: Channel["visibility"],
  memberSubjects: readonly string[],
): Promise<Channel> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility, memberSubjects }),
      },
    ),
    parseChannel,
  );
}

export async function listChannelMessages(
  serverId: string,
  channelId: string,
  before?: number,
): Promise<MessagePage> {
  const query =
    before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages${query}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Buzzcode API returned an invalid Message page");
  }
  if (
    value.nextBefore !== undefined &&
    value.nextBefore !== null &&
    typeof value.nextBefore !== "number"
  ) {
    throw new Error("Buzzcode API returned an invalid Message cursor");
  }
  return {
    messages: value.messages.map(parseChannelMessage),
    ...(typeof value.nextBefore === "number"
      ? { nextBefore: value.nextBefore }
      : {}),
  };
}

export async function createChannelMessage(
  serverId: string,
  channelId: string,
  content: string,
  replyToMessageId?: string,
  mentions: readonly MentionInput[] = [],
): Promise<ChannelMessage> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, replyToMessageId, mentions }),
      },
    ),
    parseChannelMessage,
  );
}

export async function getChannelMessage(
  serverId: string,
  channelId: string,
  messageId: string,
): Promise<ChannelMessage> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { credentials: "include" },
    ),
    parseChannelMessage,
  );
}

export async function editChannelMessage(
  serverId: string,
  channelId: string,
  messageId: string,
  content: string,
  mentions?: readonly MentionInput[],
): Promise<ChannelMessage> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, mentions }),
      },
    ),
    parseChannelMessage,
  );
}

export async function deleteChannelMessage(
  serverId: string,
  channelId: string,
  messageId: string,
): Promise<ChannelMessage> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE", credentials: "include" },
    ),
    parseChannelMessage,
  );
}

export async function setMessageReaction(
  serverId: string,
  channelId: string,
  messageId: string,
  emoji: string,
  reacted: boolean,
): Promise<ChannelMessage> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: reacted ? "POST" : "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji }),
      },
    ),
    parseChannelMessage,
  );
}

export async function listDirectMessages(): Promise<readonly DirectMessage[]> {
  const response = await fetch(`${apiOrigin}/api/direct-messages`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new Error("Buzzcode API returned an invalid Direct Message list");
  }
  return value.map(parseDirectMessage);
}

export async function startDirectMessage(
  peerUserId: string,
  peerHandle: string,
): Promise<DirectMessage> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/direct-messages`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peerUserId, peerHandle }),
    }),
    parseDirectMessage,
  );
}

export async function searchUsers(
  query: string,
): Promise<readonly UserSearchResult[]> {
  const response = await fetch(
    `${apiOrigin}/api/users/search?q=${encodeURIComponent(query)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new Error("Buzzcode API returned an invalid user search response");
  }
  return value.map(parseUserSearchResult);
}

export async function searchMentionCandidates(
  serverId: string,
  channelId: string,
  query: string,
): Promise<readonly UserSearchResult[]> {
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/mention-suggestions?q=${encodeURIComponent(query)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new Error("Buzzcode API returned invalid mention suggestions");
  }
  return value.map(parseUserSearchResult);
}

function directMessageMessagesUrl(directMessageId: string): string {
  return `${apiOrigin}/api/direct-messages/${encodeURIComponent(directMessageId)}/messages`;
}

export async function listDirectMessageMessages(
  directMessageId: string,
  before?: number,
): Promise<DirectMessagePage> {
  const query =
    before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
  const response = await fetch(
    `${directMessageMessagesUrl(directMessageId)}${query}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Buzzcode API returned an invalid Direct Message page");
  }
  if (
    value.nextBefore !== undefined &&
    value.nextBefore !== null &&
    typeof value.nextBefore !== "number"
  ) {
    throw new Error("Buzzcode API returned an invalid Direct Message cursor");
  }
  return {
    messages: value.messages.map(parseDirectMessageMessage),
    ...(typeof value.nextBefore === "number"
      ? { nextBefore: value.nextBefore }
      : {}),
  };
}

export async function createDirectMessageMessage(
  directMessageId: string,
  content: string,
  replyToMessageId?: string,
): Promise<DirectMessageMessage> {
  return parseResponse(
    await fetch(directMessageMessagesUrl(directMessageId), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, replyToMessageId }),
    }),
    parseDirectMessageMessage,
  );
}

async function mutateDirectMessageMessage(
  directMessageId: string,
  messageId: string,
  method: "GET" | "PATCH" | "DELETE",
  body?: Readonly<Record<string, unknown>>,
): Promise<DirectMessageMessage> {
  return parseResponse(
    await fetch(
      `${directMessageMessagesUrl(directMessageId)}/${encodeURIComponent(messageId)}`,
      {
        method,
        credentials: "include",
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
    ),
    parseDirectMessageMessage,
  );
}

export function getDirectMessageMessage(
  directMessageId: string,
  messageId: string,
): Promise<DirectMessageMessage> {
  return mutateDirectMessageMessage(directMessageId, messageId, "GET");
}

export function editDirectMessageMessage(
  directMessageId: string,
  messageId: string,
  content: string,
): Promise<DirectMessageMessage> {
  return mutateDirectMessageMessage(directMessageId, messageId, "PATCH", {
    content,
  });
}

export function deleteDirectMessageMessage(
  directMessageId: string,
  messageId: string,
): Promise<DirectMessageMessage> {
  return mutateDirectMessageMessage(directMessageId, messageId, "DELETE");
}

export async function setDirectMessageReaction(
  directMessageId: string,
  messageId: string,
  emoji: string,
  reacted: boolean,
): Promise<DirectMessageMessage> {
  return parseResponse(
    await fetch(
      `${directMessageMessagesUrl(directMessageId)}/${encodeURIComponent(messageId)}/reactions`,
      {
        method: reacted ? "POST" : "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji }),
      },
    ),
    parseDirectMessageMessage,
  );
}

export async function createInvitation(
  serverId: string,
  email: string,
): Promise<ServerInvitation> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/invitations`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
    ),
    parseInvitation,
  );
}

export async function createHostPairingCode(): Promise<HostPairingCode> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/host-pairing-codes`, {
      method: "POST",
      credentials: "include",
    }),
    parseHostPairingCode,
  );
}

export async function listComputers(): Promise<readonly Computer[]> {
  const response = await fetch(`${apiOrigin}/api/computers`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new Error("Buzzcode API returned an invalid Computer list");
  }
  return value.map(parseComputer);
}

export async function revokeComputer(computerId: string): Promise<void> {
  const response = await fetch(
    `${apiOrigin}/api/computers/${encodeURIComponent(computerId)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
}

export async function registerComputer(
  installationId: string,
  name: string,
): Promise<Computer> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/computers/register`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId, name }),
    }),
    parseComputer,
  );
}

export async function listProjects(
  serverId: string,
): Promise<readonly ServerProject[]> {
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/projects`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new Error("Buzzcode API returned an invalid Project list");
  }
  return value.map(parseServerProject);
}

export async function createProject(
  serverId: string,
  name: string,
  computerId: string,
  folderPath: string,
): Promise<ServerProject> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/projects`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, computerId, folderPath }),
      },
    ),
    parseServerProject,
  );
}

export async function createProjectChannel(
  serverId: string,
  projectId: string,
  name: string,
): Promise<Channel> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/projects/${encodeURIComponent(projectId)}/channels`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
    ),
    parseChannel,
  );
}

export async function acceptInvitation(token: string): Promise<Server> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/invitations/accept`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
    parseServer,
  );
}

export async function listMembers(
  serverId: string,
): Promise<readonly ServerMember[]> {
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/members`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value))
    throw new Error("Buzzcode API returned an invalid member list");
  return value.map(parseMember);
}

export async function updateMemberRole(
  serverId: string,
  subject: string,
  role: "admin" | "member",
): Promise<ServerMember> {
  return parseResponse(
    await fetch(
      `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(subject)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      },
    ),
    parseMember,
  );
}

export async function transferOwnership(
  serverId: string,
  newOwnerSubject: string,
): Promise<void> {
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/owner`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerSubject }),
    },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
}

export async function deleteServer(serverId: string): Promise<void> {
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
}

export async function listAudit(
  serverId: string,
): Promise<readonly AuditEntry[]> {
  const response = await fetch(
    `${apiOrigin}/api/servers/${encodeURIComponent(serverId)}/audit`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value))
    throw new Error("Buzzcode API returned an invalid audit log");
  return value.map(parseAuditEntry);
}

export function loginUrl(): string {
  return `${apiOrigin}/api/auth/login`;
}

export async function startDesktopLogin(): Promise<DesktopLogin> {
  return parseResponse(
    await fetch(`${apiOrigin}/api/auth/desktop/start`, {
      method: "POST",
      credentials: "include",
    }),
    parseDesktopLogin,
  );
}

export async function completeDesktopLogin(
  completionToken: string,
): Promise<boolean> {
  const response = await fetch(`${apiOrigin}/api/auth/desktop/complete`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken }),
  });
  if (response.status === 202) return false;
  if (!response.ok) throw new Error(`Buzzcode API returned ${response.status}`);
  return true;
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
  let stopped = false;
  let websocket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  const connect = () => {
    websocket = new WebSocket(
      `${websocketOrigin}/api/servers/${encodeURIComponent(serverId)}/events`,
    );
    websocket.addEventListener("open", () => onConnectionChange(true));
    websocket.addEventListener("close", () => {
      onConnectionChange(false);
      if (!stopped) reconnectTimer = window.setTimeout(connect, 500);
    });
    websocket.addEventListener("message", (message) => {
      const event = parseServerEvent(
        JSON.parse(String(message.data)) as unknown,
      );
      onEvent(event);
    });
  };
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    websocket?.close();
  };
}

export function subscribeToDirectMessageEvents(
  onEvent: (event: DirectMessageEvent) => void,
  onConnectionChange: (connected: boolean) => void,
): () => void {
  let stopped = false;
  let websocket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  const connect = () => {
    websocket = new WebSocket(`${websocketOrigin}/api/direct-messages/events`);
    websocket.addEventListener("open", () => onConnectionChange(true));
    websocket.addEventListener("close", () => {
      onConnectionChange(false);
      if (!stopped) reconnectTimer = window.setTimeout(connect, 500);
    });
    websocket.addEventListener("message", (message) => {
      onEvent(parseDirectMessageEvent(JSON.parse(String(message.data))));
    });
  };
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    websocket?.close();
  };
}

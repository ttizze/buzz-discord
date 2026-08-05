import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type AgentMentionInput,
  type AgentSearchResult,
  type AuditEntry,
  type AuthSession,
  acceptInvitation,
  buzzcodeApiOrigin,
  type Channel,
  type ChannelMessage,
  type Computer,
  completeDesktopLogin,
  createChannel,
  createChannelMessage,
  createHostPairingCode,
  createInvitation,
  createProject,
  createProjectChannel,
  createServer,
  deleteChannelMessage,
  deleteServer,
  editChannelMessage,
  getChannelMessage,
  listAudit,
  listChannelMessages,
  listChannels,
  listComputers,
  listMembers,
  listProjects,
  listServers,
  loginUrl,
  logout,
  type MentionInput,
  readAuthSession,
  readDurableState,
  registerComputer,
  revokeComputer,
  type Server,
  type ServerMember,
  type ServerProject,
  searchAgentMentionCandidates,
  searchMentionCandidates,
  setMessageReaction,
  startDesktopLogin,
  subscribeToServerEvents,
  transferOwnership,
  type UserSearchResult,
  updateChannel,
  updateMemberRole,
  writeDurableState,
} from "./api";
import {
  chooseProjectFolder,
  currentComputerIdentity,
  startComputerHost,
} from "./computer";
import { DirectMessagesPanel } from "./DirectMessagesPanel";
import "./styles.css";
import { useModalDialog } from "./useModalDialog";

function ChannelMemberPicker({
  members,
  selectedSubjects,
  onChange,
}: {
  members: readonly ServerMember[];
  selectedSubjects: readonly string[];
  onChange: (subjects: readonly string[]) => void;
}) {
  return (
    <fieldset className="channel-member-picker">
      <legend>Private Channel members</legend>
      {members
        .filter((member) => member.role === "member")
        .map((member) => (
          <label key={member.subject}>
            <input
              type="checkbox"
              checked={selectedSubjects.includes(member.subject)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...new Set([...selectedSubjects, member.subject])]
                    : selectedSubjects.filter(
                        (subject) => subject !== member.subject,
                      ),
                )
              }
            />
            Allow {member.displayName} @{member.handle}
          </label>
        ))}
    </fieldset>
  );
}

function memberRoleLabel(role: ServerMember["role"]): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Member";
}

function MemberIdentity({ member }: { member: ServerMember }) {
  return (
    <span>
      {member.displayName} (@{member.handle})
    </span>
  );
}

type DraftUserMention = UserSearchResult &
  Readonly<{ kind: "user"; start: number; end: number }>;
type DraftAgentMention = AgentSearchResult &
  Readonly<{ kind: "agent"; start: number; end: number }>;
type DraftMention = DraftUserMention | DraftAgentMention;
type MentionCandidate =
  | (UserSearchResult & Readonly<{ kind: "user" }>)
  | (AgentSearchResult & Readonly<{ kind: "agent" }>);

function reconcileDraftMentions(
  previous: string,
  next: string,
  mentions: readonly DraftMention[],
): readonly DraftMention[] {
  let prefix = 0;
  while (prefix < previous.length && previous[prefix] === next[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix++;
  }
  const removedEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  return mentions.flatMap((mention) => {
    if (mention.end <= prefix) return [mention];
    if (mention.start >= removedEnd) {
      return [
        { ...mention, start: mention.start + delta, end: mention.end + delta },
      ];
    }
    return [];
  });
}

function apiMentions(
  content: string,
  mentions: readonly DraftMention[],
): readonly MentionInput[] {
  const codePointIndex = (codeUnitIndex: number) =>
    Array.from(content.slice(0, codeUnitIndex)).length;
  return mentions.flatMap((mention) =>
    mention.kind === "user"
      ? [
          {
            userId: mention.userId,
            start: codePointIndex(mention.start),
            end: codePointIndex(mention.end),
          },
        ]
      : [],
  );
}

function apiAgentMentions(
  content: string,
  mentions: readonly DraftMention[],
): readonly AgentMentionInput[] {
  const codePointIndex = (codeUnitIndex: number) =>
    Array.from(content.slice(0, codeUnitIndex)).length;
  return mentions.flatMap((mention) =>
    mention.kind === "agent"
      ? [
          {
            agentId: mention.agentId,
            start: codePointIndex(mention.start),
            end: codePointIndex(mention.end),
          },
        ]
      : [],
  );
}

function editableMentions(
  content: string,
  mentions: readonly (UserSearchResult & MentionInput)[],
): readonly DraftMention[] {
  const characters = Array.from(content);
  const codeUnitIndex = (codePointIndex: number) =>
    characters.slice(0, codePointIndex).join("").length;
  return mentions.map((mention) => ({
    ...mention,
    kind: "user" as const,
    start: codeUnitIndex(mention.start),
    end: codeUnitIndex(mention.end),
  }));
}

function AuthenticatedApp({
  session,
}: {
  session: AuthSession & { authenticated: true };
}) {
  const [activeArea, setActiveArea] = useState<"home" | "server">(() =>
    window.localStorage.getItem("buzzcode.active-area") === "home"
      ? "home"
      : "server",
  );
  const [membersOpen, setMembersOpen] = useState(
    () => window.matchMedia("(min-width: 75.0625rem)").matches,
  );
  const [navigationOpen, setNavigationOpen] = useState(false);
  const settingsDialog = useModalDialog();
  const channelDialog = useModalDialog();
  const channelAccessDialog = useModalDialog();
  const projectChannelDialog = useModalDialog();
  const [servers, setServers] = useState<readonly Server[] | null>(null);
  const [activeServer, setActiveServer] = useState<Server | null>(null);
  const [serverName, setServerName] = useState("");
  const [channels, setChannels] = useState<readonly Channel[] | null>(null);
  const [projects, setProjects] = useState<readonly ServerProject[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [channelName, setChannelName] = useState("");
  const [channelVisibility, setChannelVisibility] =
    useState<Channel["visibility"]>("open");
  const [newChannelMembers, setNewChannelMembers] = useState<readonly string[]>(
    [],
  );
  const [channelAccessMembers, setChannelAccessMembers] = useState<
    readonly string[]
  >([]);
  const [currentComputer, setCurrentComputer] = useState<Computer | null>(null);
  const [channelProject, setChannelProject] = useState<ServerProject | null>(
    null,
  );
  const [projectChannelName, setProjectChannelName] = useState("");
  const [messages, setMessages] = useState<readonly ChannelMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<number | undefined>();
  const [messageDraft, setMessageDraft] = useState("");
  const [draftMentions, setDraftMentions] = useState<readonly DraftMention[]>(
    [],
  );
  const [mentionCandidates, setMentionCandidates] = useState<
    readonly MentionCandidate[]
  >([]);
  const [replyingTo, setReplyingTo] = useState<ChannelMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editMentions, setEditMentions] = useState<readonly DraftMention[]>([]);
  const [durableValue, setDurableValue] = useState("Loading…");
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [members, setMembers] = useState<readonly ServerMember[]>([]);
  const [audit, setAudit] = useState<readonly AuditEntry[]>([]);
  const [computers, setComputers] = useState<readonly Computer[]>([]);
  const [hostPairingCode, setHostPairingCode] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [createdInvite, setCreatedInvite] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const managementRequestVersion = useRef(0);
  const computerRequestVersion = useRef(0);
  const localComputerId = useRef<string | null>(null);
  const messageChannelId = useRef<string | null>(null);
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const navigationToggle = useRef<HTMLButtonElement | null>(null);
  const navigationDrawer = useRef<HTMLElement | null>(null);
  const memberToggle = useRef<HTMLButtonElement | null>(null);
  const memberDrawer = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const wideLayout = window.matchMedia("(min-width: 75.0625rem)");
    const syncMemberPanel = () => setMembersOpen(wideLayout.matches);
    wideLayout.addEventListener("change", syncMemberPanel);
    return () => wideLayout.removeEventListener("change", syncMemberPanel);
  }, []);

  useEffect(() => {
    if (!navigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("[aria-modal='true']") !== null
      ) {
        return;
      }
      event.preventDefault();
      setNavigationOpen(false);
      window.requestAnimationFrame(() => navigationToggle.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);

  useEffect(() => {
    if (!membersOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("[aria-modal='true']") !== null
      ) {
        return;
      }
      event.preventDefault();
      setMembersOpen(false);
      window.requestAnimationFrame(() => memberToggle.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [membersOpen]);

  function toggleNavigation(trigger: HTMLButtonElement) {
    navigationToggle.current = trigger;
    setNavigationOpen((current) => {
      const next = !current;
      if (next) {
        window.requestAnimationFrame(() => navigationDrawer.current?.focus());
      }
      return next;
    });
  }

  function toggleMembers(trigger: HTMLButtonElement) {
    memberToggle.current = trigger;
    setMembersOpen((current) => {
      const next = !current;
      if (next) {
        window.requestAnimationFrame(() => memberDrawer.current?.focus());
      }
      return next;
    });
  }

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
      const wanted =
        preferredId ??
        current?.id ??
        window.localStorage.getItem("buzzcode.active-server");
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

  const reloadComputers = useCallback(async () => {
    const requestVersion = ++computerRequestVersion.current;
    const loaded = await listComputers();
    if (requestVersion === computerRequestVersion.current) {
      setComputers(loaded);
      if (localComputerId.current !== null) {
        setCurrentComputer(
          loaded.find(
            (computer) =>
              computer.id === localComputerId.current &&
              computer.status === "online",
          ) ?? null,
        );
      }
    }
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      const identity = await currentComputerIdentity();
      const registration = await registerComputer(
        identity.installationId,
        identity.name,
      );
      localComputerId.current = registration.id;
      await startComputerHost(
        buzzcodeApiOrigin(),
        registration.id,
        registration.credential,
      );
      for (let attempt = 0; current && attempt < 40; attempt += 1) {
        const loaded = await listComputers();
        const computer = loaded.find((item) => item.id === registration.id);
        if (computer?.status === "online") {
          setCurrentComputer(computer);
          setComputers(loaded);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (current) {
        setCurrentComputer(null);
        void reloadComputers();
      }
    })();
    return () => {
      current = false;
    };
  }, [reloadComputers]);

  const reloadChannels = useCallback(async (serverId: string) => {
    const [loaded, loadedProjects] = await Promise.all([
      listChannels(serverId),
      listProjects(serverId),
    ]);
    setChannels(loaded);
    setProjects(loadedProjects);
    const availableChannels = [
      ...loaded,
      ...loadedProjects.flatMap((project) => project.channels),
    ];
    setActiveChannel((current) => {
      const wanted =
        current?.id ??
        window.localStorage.getItem(`buzzcode.active-channel.${serverId}`);
      const refreshed = availableChannels.find(
        (channel) => channel.id === wanted,
      );
      if (
        refreshed !== undefined &&
        current !== null &&
        refreshed.name === current.name &&
        refreshed.visibility === current.visibility &&
        refreshed.memberSubjects.length === current.memberSubjects.length &&
        refreshed.memberSubjects.every(
          (subject, index) => subject === current.memberSubjects[index],
        )
      ) {
        return current;
      }
      if (refreshed !== undefined) return refreshed;
      return availableChannels[0] ?? null;
    });
  }, []);

  useEffect(() => {
    window.localStorage.setItem("buzzcode.active-area", activeArea);
  }, [activeArea]);

  useEffect(() => {
    if (activeServer === null) return;
    window.localStorage.setItem("buzzcode.active-server", activeServer.id);
  }, [activeServer]);

  useEffect(() => {
    if (activeServer === null || activeChannel === null) return;
    window.localStorage.setItem(
      `buzzcode.active-channel.${activeServer.id}`,
      activeChannel.id,
    );
  }, [activeChannel, activeServer]);

  const reloadMessages = useCallback(
    async (serverId: string, channelId: string) => {
      const page = await listChannelMessages(serverId, channelId);
      if (messageChannelId.current !== channelId) return;
      setMessages((current) => mergeMessages(current, page.messages));
      setNextBefore(page.nextBefore);
    },
    [mergeMessages],
  );

  const applyMessageUpdate = useCallback(
    (updated: ChannelMessage) => {
      setMessages((current) =>
        mergeMessages(current, [updated]).map((message) => {
          if (message.replyTo?.id !== updated.id) return message;
          return {
            ...message,
            replyTo: {
              id: message.replyTo.id,
              authorDisplayName: message.replyTo.authorDisplayName,
              deleted: updated.deletedAt !== undefined,
              ...(updated.content !== undefined
                ? { content: updated.content }
                : {}),
            },
          };
        }),
      );
    },
    [mergeMessages],
  );

  const refreshMessage = useCallback(
    async (serverId: string, channelId: string, messageId: string) => {
      const updated = await getChannelMessage(serverId, channelId, messageId);
      if (messageChannelId.current === channelId) applyMessageUpdate(updated);
    },
    [applyMessageUpdate],
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
    setDraftMentions([]);
    setMentionCandidates([]);
    setEditingMessageId(null);
    setEditMentions([]);
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
        } else if (event.type === "channelAccessChanged") {
          void reloadChannels(activeServer.id);
          void reloadManagement(activeServer.id);
        } else if (event.type === "projectsChanged") {
          void reloadChannels(activeServer.id);
          void reloadComputers();
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
        } else if (
          event.type === "messageChanged" &&
          event.channelId === messageChannelId.current
        ) {
          void refreshMessage(
            activeServer.id,
            event.channelId,
            event.messageId,
          );
          void reloadManagement(activeServer.id);
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
    reloadComputers,
    reloadManagement,
    reloadMessages,
    reloadServers,
    refreshMessage,
  ]);

  useEffect(() => {
    if (activeServer === null || activeChannel === null) return;
    messageChannelId.current = activeChannel.id;
    setMessages([]);
    setNextBefore(undefined);
    setReplyingTo(null);
    setDraftMentions([]);
    setMentionCandidates([]);
    setEditingMessageId(null);
    setChannelAccessMembers(activeChannel.memberSubjects);
    void reloadMessages(activeServer.id, activeChannel.id);
  }, [activeChannel, activeServer, reloadMessages]);

  useEffect(() => {
    if (activeServer === null || activeChannel === null) return;
    const match = messageDraft.match(/(?:^|\s)@([^@\n]*)$/);
    const query = match?.[1]?.trim() ?? "";
    if (
      query === "" ||
      draftMentions.some((mention) => mention.end === messageDraft.length)
    ) {
      setMentionCandidates([]);
      return;
    }
    let current = true;
    const timeout = window.setTimeout(() => {
      void Promise.all([
        searchAgentMentionCandidates(activeServer.id, activeChannel.id, query),
        searchMentionCandidates(activeServer.id, activeChannel.id, query),
      ])
        .then(([agents, people]) => {
          if (current)
            setMentionCandidates([
              ...agents.map((agent) => ({ ...agent, kind: "agent" as const })),
              ...people.map((person) => ({ ...person, kind: "user" as const })),
            ]);
        })
        .catch(() => {
          if (current) setMentionCandidates([]);
        });
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timeout);
    };
  }, [activeChannel, activeServer, draftMentions, messageDraft]);

  function selectMention(person: MentionCandidate) {
    const match = messageDraft.match(/(?:^|\s)@([^@\n]*)$/);
    if (match?.index === undefined) return;
    const start = match.index + match[0].lastIndexOf("@");
    const label = `@${person.displayName}`;
    const nextDraft = `${messageDraft.slice(0, start)}${label}`;
    const adjusted = reconcileDraftMentions(
      messageDraft,
      nextDraft,
      draftMentions,
    );
    setDraftMentions([
      ...adjusted,
      { ...person, start, end: start + label.length },
    ]);
    setMessageDraft(nextDraft);
    setMentionCandidates([]);
    window.requestAnimationFrame(() => {
      messageInputRef.current?.focus();
      messageInputRef.current?.setSelectionRange(
        nextDraft.length,
        nextDraft.length,
      );
    });
  }

  function selectServer(server: Server) {
    if (activeServer?.id !== server.id) {
      managementRequestVersion.current += 1;
      computerRequestVersion.current += 1;
      messageChannelId.current = null;
      setChannels(null);
      setProjects([]);
      setActiveChannel(null);
      setMessages([]);
      setNextBefore(undefined);
      setMembers([]);
      setAudit([]);
      setHostPairingCode("");
      setDurableValue("Loading…");
      setDraft("");
      setMessageDraft("");
      setDraftMentions([]);
      setMentionCandidates([]);
      setReplyingTo(null);
      setEditingMessageId(null);
      setChannelAccessMembers([]);
      setChannelProject(null);
      setProjectChannelName("");
    }
    setActiveServer(server);
    setActiveArea("server");
    setNavigationOpen(false);
  }

  async function addServer() {
    const server = await createServer(serverName);
    setServers((current) => [...(current ?? []), server]);
    selectServer(server);
    setServerName("");
  }

  async function addChannel() {
    if (activeServer === null) return;
    const channel = await createChannel(
      activeServer.id,
      channelName,
      channelVisibility,
      channelVisibility === "private" ? newChannelMembers : [],
    );
    setChannels((current) => [
      ...(current ?? []).filter((item) => item.id !== channel.id),
      channel,
    ]);
    setActiveChannel(channel);
    setChannelName("");
    setChannelVisibility("open");
    setNewChannelMembers([]);
    channelDialog.close();
  }

  async function addProject() {
    if (activeServer === null || currentComputer === null) return;
    const folderPath = await chooseProjectFolder();
    if (folderPath === null) return;
    const project = await createProject(
      activeServer.id,
      currentComputer.id,
      folderPath,
    );
    setProjects((current) => [...current, project]);
  }

  async function addProjectChannel() {
    if (activeServer === null || channelProject === null) return;
    const channel = await createProjectChannel(
      activeServer.id,
      channelProject.id,
      projectChannelName,
    );
    setProjects((current) =>
      current.map((project) =>
        project.id === channelProject.id
          ? { ...project, channels: [...project.channels, channel] }
          : project,
      ),
    );
    setActiveChannel(channel);
    setProjectChannelName("");
    setChannelProject(null);
    projectChannelDialog.close();
  }

  async function saveChannelAccess() {
    if (activeServer === null || activeChannel === null) return;
    const channel = await updateChannel(
      activeServer.id,
      activeChannel.id,
      activeChannel.visibility,
      channelAccessMembers,
    );
    setChannels(
      (current) =>
        current?.map((item) => (item.id === channel.id ? channel : item)) ?? [
          channel,
        ],
    );
    setActiveChannel(channel);
    await reloadManagement(activeServer.id);
    channelAccessDialog.close();
  }

  async function sendMessage() {
    if (activeServer === null || activeChannel === null) return;
    const message = await createChannelMessage(
      activeServer.id,
      activeChannel.id,
      messageDraft,
      replyingTo?.id,
      apiMentions(messageDraft, draftMentions),
      apiAgentMentions(messageDraft, draftMentions),
    );
    setMessages((current) => mergeMessages(current, [message]));
    setMessageDraft("");
    setDraftMentions([]);
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

  async function saveMessageEdit(messageId: string) {
    if (activeServer === null || activeChannel === null) return;
    const updated = await editChannelMessage(
      activeServer.id,
      activeChannel.id,
      messageId,
      editDraft,
      apiMentions(editDraft, editMentions),
    );
    applyMessageUpdate(updated);
    setEditingMessageId(null);
    setEditDraft("");
    setEditMentions([]);
  }

  async function removeMessage(messageId: string) {
    if (activeServer === null || activeChannel === null) return;
    const updated = await deleteChannelMessage(
      activeServer.id,
      activeChannel.id,
      messageId,
    );
    applyMessageUpdate(updated);
    if (replyingTo?.id === messageId) setReplyingTo(null);
  }

  async function toggleReaction(message: ChannelMessage, emoji: string) {
    if (activeServer === null || activeChannel === null) return;
    const reaction = message.reactions.find((item) => item.emoji === emoji);
    const updated = await setMessageReaction(
      activeServer.id,
      activeChannel.id,
      message.id,
      emoji,
      !(reaction?.reacted ?? false),
    );
    applyMessageUpdate(updated);
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

  async function createPairingCode() {
    const pairing = await createHostPairingCode();
    setHostPairingCode(pairing.code);
  }

  async function revokeSelectedComputer(computer: Computer) {
    await revokeComputer(computer.id);
    if (currentComputer?.id === computer.id) setCurrentComputer(null);
    await reloadComputers();
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
        <DirectMessagesPanel
          session={session}
          onSignOut={() => void logout().then(() => window.location.reload())}
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="server-rail" data-testid="server-rail">
        <button
          className="server-rail-home"
          type="button"
          aria-label="Home"
          aria-current={activeArea === "home"}
          onClick={() => setActiveArea("home")}
        >
          <span aria-hidden="true">B</span>
        </button>
        <div className="server-rail-divider" />
        <nav aria-label="Servers">
          {servers.map((server) => (
            <button
              className="server-rail-server"
              key={server.id}
              type="button"
              aria-label={server.name}
              aria-current={
                activeArea === "server" && activeServer.id === server.id
              }
              data-server-id={server.id}
              onClick={() => selectServer(server)}
            >
              <span aria-hidden="true">{server.name.slice(0, 2)}</span>
            </button>
          ))}
        </nav>
        <button
          className="server-rail-add"
          type="button"
          aria-label="Add or join a Server"
          onClick={(event) => {
            setActiveArea("server");
            void reloadComputers();
            settingsDialog.open(event.currentTarget);
            window.setTimeout(
              () =>
                document
                  .querySelector<HTMLElement>("#new-server-name")
                  ?.focus(),
              0,
            );
          }}
        >
          <span aria-hidden="true">+</span>
        </button>
      </aside>
      <section
        className="server-workspace"
        data-navigation-open={navigationOpen}
        data-members-open={membersOpen}
        hidden={activeArea !== "server"}
      >
        <section className="chat-layout">
          <aside
            ref={navigationDrawer}
            className="channel-sidebar"
            data-testid="context-sidebar"
            tabIndex={-1}
          >
            <header className="server-context-header">
              <div>
                <h2 data-testid="active-server-name">{activeServer.name}</h2>
                <p data-testid="active-member-role">
                  {activeServer.role === "owner"
                    ? "Owner"
                    : activeServer.role === "admin"
                      ? "Admin"
                      : "Member"}
                </p>
              </div>
              <div className="server-context-actions">
                <span className="connection-status">
                  <span className="connection-dot" data-connected={connected} />
                  <span className="sr-only" data-testid="realtime-status">
                    {connected ? "Connected" : "Disconnected"}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label="Server Settings"
                  onClick={(event) => {
                    void reloadComputers();
                    settingsDialog.open(event.currentTarget);
                  }}
                >
                  ⚙
                </button>
              </div>
            </header>
            <div className="section-heading">
              <h3>Channels</h3>
              {(activeServer.role === "owner" ||
                activeServer.role === "admin") && (
                <button
                  type="button"
                  aria-label="Add Channel"
                  onClick={(event) => channelDialog.open(event.currentTarget)}
                >
                  +
                </button>
              )}
            </div>
            <nav aria-label="Channels" className="channel-list">
              {channels?.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  data-channel-id={channel.id}
                  aria-current={activeChannel?.id === channel.id}
                  onClick={() => {
                    setActiveChannel(channel);
                    setNavigationOpen(false);
                  }}
                >
                  <span aria-hidden="true">#</span> {channel.name}
                </button>
              ))}
            </nav>
            <div className="section-heading projects-heading">
              <h3>Projects</h3>
              {(activeServer.role === "owner" ||
                activeServer.role === "admin") && (
                <button
                  type="button"
                  aria-label="Add Project"
                  disabled={currentComputer === null}
                  onClick={() => void addProject()}
                >
                  +
                </button>
              )}
            </div>
            <div className="project-list" data-testid="project-list">
              {projects.map((project) => (
                <section className="project-category" key={project.id}>
                  <div className="project-category-heading">
                    <div>
                      <h4>{project.name}</h4>
                      <span
                        className={`project-computer-status ${project.computerStatus}`}
                        data-testid={`project-computer-status-${project.id}`}
                      >
                        {project.computerName} · {project.computerStatus}
                      </span>
                    </div>
                    {(activeServer.role === "owner" ||
                      activeServer.role === "admin") && (
                      <button
                        type="button"
                        aria-label={`Add Channel to ${project.name}`}
                        onClick={(event) => {
                          setChannelProject(project);
                          setProjectChannelName("");
                          projectChannelDialog.open(event.currentTarget);
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>
                  <nav
                    aria-label={`${project.name} Channels`}
                    className="channel-list project-channel-list"
                  >
                    {project.channels.map((channel) => (
                      <button
                        key={channel.id}
                        type="button"
                        data-channel-id={channel.id}
                        aria-current={activeChannel?.id === channel.id}
                        onClick={() => {
                          setActiveChannel(channel);
                          setNavigationOpen(false);
                        }}
                      >
                        <span aria-hidden="true">#</span> {channel.name}
                      </button>
                    ))}
                  </nav>
                </section>
              ))}
            </div>
            <div className="current-user-panel">
              <span className="user-avatar" aria-hidden="true">
                {session.user.displayName.slice(0, 1)}
              </span>
              <span>
                <strong>{session.user.displayName}</strong>
                <small data-testid="account-handle">
                  @{session.user.handle}
                </small>
              </span>
              <button
                type="button"
                aria-label="Sign out"
                onClick={() =>
                  void logout().then(() => window.location.reload())
                }
              >
                ↪
              </button>
            </div>
          </aside>
          <section
            className="channel-panel"
            aria-label="Server Channels"
            data-testid="content-pane"
          >
            {activeChannel === null ? (
              <>
                <header className="channel-header">
                  <button
                    ref={navigationToggle}
                    className="navigation-toggle"
                    type="button"
                    aria-label="Toggle Channels"
                    aria-expanded={navigationOpen}
                    onClick={(event) => toggleNavigation(event.currentTarget)}
                  >
                    ☰
                  </button>
                  <h3>No channels yet</h3>
                  <button
                    ref={memberToggle}
                    className="members-toggle"
                    type="button"
                    aria-label="Toggle Members"
                    aria-expanded={membersOpen}
                    onClick={(event) => toggleMembers(event.currentTarget)}
                  >
                    Members
                  </button>
                </header>
                <div className="channel-empty">
                  <p>
                    Create an Open Channel to start talking with the Server.
                  </p>
                </div>
              </>
            ) : (
              <>
                <header className="channel-header">
                  <button
                    ref={navigationToggle}
                    className="navigation-toggle"
                    type="button"
                    aria-label="Toggle Channels"
                    aria-expanded={navigationOpen}
                    onClick={(event) => toggleNavigation(event.currentTarget)}
                  >
                    ☰
                  </button>
                  <div>
                    <h3 data-testid="active-channel-name">
                      # {activeChannel.name}
                    </h3>
                    <p>
                      {activeChannel.visibility === "open"
                        ? "Open Channel · visible to every Server Member"
                        : "Private Channel · visible to selected Members and Server managers"}
                    </p>
                  </div>
                  <button
                    ref={memberToggle}
                    className="members-toggle"
                    type="button"
                    aria-label="Toggle Members"
                    aria-expanded={membersOpen}
                    onClick={(event) => toggleMembers(event.currentTarget)}
                  >
                    Members
                  </button>
                  {activeChannel.visibility === "private" &&
                    (activeServer.role === "owner" ||
                      activeServer.role === "admin") && (
                      <button
                        type="button"
                        aria-label="Edit Channel Access"
                        onClick={(event) =>
                          channelAccessDialog.open(event.currentTarget)
                        }
                      >
                        Access
                      </button>
                    )}
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
                      data-message-author-kind={message.authorKind}
                    >
                      {message.replyTo !== undefined && (
                        <div className="reply-reference">
                          <strong>{message.replyTo.authorDisplayName}</strong>
                          <span>
                            {message.replyTo.deleted
                              ? "Message deleted"
                              : message.replyTo.content}
                          </span>
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
                        {message.editedAt !== undefined &&
                          message.deletedAt === undefined && (
                            <span>edited</span>
                          )}
                      </div>
                      {message.deletedAt !== undefined ? (
                        <p className="deleted-message">Message deleted</p>
                      ) : editingMessageId === message.id ? (
                        <form
                          className="edit-message"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (editDraft.trim() !== "") {
                              void saveMessageEdit(message.id);
                            }
                          }}
                        >
                          <label
                            className="sr-only"
                            htmlFor={`edit-${message.id}`}
                          >
                            Edit message by {message.authorDisplayName}
                          </label>
                          <input
                            id={`edit-${message.id}`}
                            value={editDraft}
                            maxLength={4000}
                            onChange={(event) => {
                              const nextDraft = event.target.value;
                              setEditMentions((current) =>
                                reconcileDraftMentions(
                                  editDraft,
                                  nextDraft,
                                  current,
                                ),
                              );
                              setEditDraft(nextDraft);
                            }}
                          />
                          <button
                            type="submit"
                            disabled={editDraft.trim() === ""}
                          >
                            Save edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMessageId(null);
                              setEditMentions([]);
                            }}
                          >
                            Cancel edit
                          </button>
                        </form>
                      ) : (
                        <p>{message.content}</p>
                      )}
                      {message.deletedAt === undefined && (
                        <>
                          <fieldset className="reaction-list">
                            <legend className="sr-only">Reactions</legend>
                            {["👍", "❤️", "😂"].map((emoji) => {
                              const reaction = message.reactions.find(
                                (item) => item.emoji === emoji,
                              );
                              return (
                                <button
                                  key={emoji}
                                  type="button"
                                  aria-label={`React with ${emoji}`}
                                  aria-pressed={reaction?.reacted ?? false}
                                  onClick={() =>
                                    void toggleReaction(message, emoji)
                                  }
                                >
                                  {emoji}
                                  {reaction !== undefined && (
                                    <span>{reaction.count}</span>
                                  )}
                                </button>
                              );
                            })}
                          </fieldset>
                          <div className="message-actions">
                            <button
                              type="button"
                              aria-label={`Reply to ${message.authorDisplayName}`}
                              onClick={() => setReplyingTo(message)}
                            >
                              Reply
                            </button>
                            {message.authorKind === "user" &&
                              message.authorSubject ===
                                session.user.subject && (
                                <button
                                  type="button"
                                  aria-label={`Edit message by ${message.authorDisplayName}`}
                                  onClick={() => {
                                    setEditingMessageId(message.id);
                                    setEditDraft(message.content ?? "");
                                    setEditMentions(
                                      editableMentions(
                                        message.content ?? "",
                                        message.mentions,
                                      ),
                                    );
                                  }}
                                >
                                  Edit
                                </button>
                              )}
                            {((message.authorKind === "user" &&
                              message.authorSubject === session.user.subject) ||
                              activeServer.role === "owner" ||
                              activeServer.role === "admin") && (
                              <button
                                type="button"
                                aria-label={`Delete message by ${message.authorDisplayName}`}
                                onClick={() => void removeMessage(message.id)}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </>
                      )}
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
                      ref={messageInputRef}
                      id="message-content"
                      value={messageDraft}
                      maxLength={4000}
                      placeholder={`Message #${activeChannel.name}`}
                      onChange={(event) => {
                        const nextDraft = event.target.value;
                        setDraftMentions((current) =>
                          reconcileDraftMentions(
                            messageDraft,
                            nextDraft,
                            current,
                          ),
                        );
                        setMessageDraft(nextDraft);
                      }}
                    />
                    <button type="submit" disabled={messageDraft.trim() === ""}>
                      Send
                    </button>
                    {mentionCandidates.length > 0 && (
                      <div className="mention-picker-results">
                        {mentionCandidates.map((candidate) => (
                          <button
                            key={
                              candidate.kind === "agent"
                                ? `agent-${candidate.agentId}`
                                : `user-${candidate.userId}`
                            }
                            type="button"
                            onClick={() => selectMention(candidate)}
                          >
                            <strong>{candidate.displayName}</strong>
                            <span>@{candidate.handle}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </form>
                </div>
              </>
            )}
          </section>
        </section>
        <aside
          ref={memberDrawer}
          className="member-sidebar"
          data-testid="member-sidebar"
          data-open={membersOpen}
          tabIndex={-1}
        >
          <section aria-labelledby="members-heading">
            <h3 id="members-heading">Members</h3>
            <ul className="member-list">
              {members.map((member) => (
                <li key={member.subject} data-member-subject={member.subject}>
                  <MemberIdentity member={member} />
                  <strong>{memberRoleLabel(member.role)}</strong>
                </li>
              ))}
            </ul>
          </section>
        </aside>
        {channelDialog.isOpen && (
          <div className="settings-backdrop">
            <section
              ref={channelDialog.dialogRef}
              className="channel-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-channel-heading"
            >
              <header>
                <div>
                  <p className="eyebrow">{activeServer.name}</p>
                  <h2 id="create-channel-heading">Create Channel</h2>
                </div>
                <button
                  ref={channelDialog.closeButtonRef}
                  type="button"
                  aria-label="Close Create Channel"
                  onClick={channelDialog.close}
                >
                  ×
                </button>
              </header>
              <div className="channel-create">
                <label htmlFor="channel-name">Channel name</label>
                <input
                  id="channel-name"
                  value={channelName}
                  maxLength={80}
                  onChange={(event) => setChannelName(event.target.value)}
                />
                <label htmlFor="channel-visibility">Channel visibility</label>
                <select
                  id="channel-visibility"
                  value={channelVisibility}
                  onChange={(event) =>
                    setChannelVisibility(
                      event.target.value as Channel["visibility"],
                    )
                  }
                >
                  <option value="open">Open</option>
                  <option value="private">Private</option>
                </select>
                {channelVisibility === "private" && (
                  <ChannelMemberPicker
                    members={members}
                    selectedSubjects={newChannelMembers}
                    onChange={setNewChannelMembers}
                  />
                )}
                <button
                  type="button"
                  disabled={channelName.trim() === ""}
                  onClick={() => void addChannel()}
                >
                  Create Channel
                </button>
              </div>
            </section>
          </div>
        )}
        {projectChannelDialog.isOpen && channelProject !== null && (
          <div className="settings-backdrop">
            <section
              ref={projectChannelDialog.dialogRef}
              className="channel-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-project-channel-heading"
            >
              <header>
                <div>
                  <p className="eyebrow">{channelProject.name}</p>
                  <h2 id="create-project-channel-heading">
                    Create Project Channel
                  </h2>
                </div>
                <button
                  ref={projectChannelDialog.closeButtonRef}
                  type="button"
                  aria-label="Close Create Project Channel"
                  onClick={projectChannelDialog.close}
                >
                  ×
                </button>
              </header>
              <div className="channel-create">
                <label htmlFor="project-channel-name">
                  Project Channel name
                </label>
                <input
                  id="project-channel-name"
                  value={projectChannelName}
                  maxLength={80}
                  onChange={(event) =>
                    setProjectChannelName(event.target.value)
                  }
                />
                <button
                  type="button"
                  disabled={projectChannelName.trim() === ""}
                  onClick={() => void addProjectChannel()}
                >
                  Create Project Channel
                </button>
              </div>
            </section>
          </div>
        )}
        {channelAccessDialog.isOpen && activeChannel !== null && (
          <div className="settings-backdrop">
            <section
              ref={channelAccessDialog.dialogRef}
              className="channel-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="channel-access-heading"
            >
              <header>
                <div>
                  <p className="eyebrow"># {activeChannel.name}</p>
                  <h2 id="channel-access-heading">Channel Access</h2>
                </div>
                <button
                  ref={channelAccessDialog.closeButtonRef}
                  type="button"
                  aria-label="Close Channel Access"
                  onClick={channelAccessDialog.close}
                >
                  ×
                </button>
              </header>
              <div className="channel-create">
                <ChannelMemberPicker
                  members={members}
                  selectedSubjects={channelAccessMembers}
                  onChange={setChannelAccessMembers}
                />
                <button type="button" onClick={() => void saveChannelAccess()}>
                  Save Channel access
                </button>
              </div>
            </section>
          </div>
        )}
        {settingsDialog.isOpen && (
          <div className="settings-backdrop">
            <section
              ref={settingsDialog.dialogRef}
              className="server-settings"
              role="dialog"
              aria-modal="true"
              aria-labelledby="server-settings-heading"
            >
              <header>
                <div>
                  <p className="eyebrow">{activeServer.name}</p>
                  <h2 id="server-settings-heading">Server Settings</h2>
                </div>
                <button
                  ref={settingsDialog.closeButtonRef}
                  type="button"
                  aria-label="Close Server Settings"
                  onClick={settingsDialog.close}
                >
                  ×
                </button>
              </header>
              <div className="server-settings-content">
                <section aria-labelledby="server-access-heading">
                  <h3 id="server-access-heading">Servers</h3>
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
                </section>
                <section aria-labelledby="server-state-heading">
                  <h3 id="server-state-heading">Server state</h3>
                  <dl className="status-grid">
                    <div>
                      <dt>Realtime</dt>
                      <dd>{connected ? "Connected" : "Disconnected"}</dd>
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
                <section aria-labelledby="manage-members-heading">
                  <h3 id="manage-members-heading">Manage Members</h3>
                  {(activeServer.role === "owner" ||
                    activeServer.role === "admin") && (
                    <>
                      <label htmlFor="invite-email">Invite email</label>
                      <div className="composer">
                        <input
                          id="invite-email"
                          type="email"
                          value={inviteEmail}
                          onChange={(event) =>
                            setInviteEmail(event.target.value)
                          }
                        />
                        <button
                          type="button"
                          onClick={() => void inviteMember()}
                        >
                          Create invitation
                        </button>
                      </div>
                      {createdInvite !== "" && (
                        <output data-testid="invitation-code">
                          {createdInvite}
                        </output>
                      )}
                    </>
                  )}
                  <ul className="member-list">
                    {members.map((member) => (
                      <li
                        key={member.subject}
                        data-member-subject={member.subject}
                      >
                        <MemberIdentity member={member} />
                        {member.role === "owner" ||
                        (activeServer.role !== "owner" &&
                          activeServer.role !== "admin") ? (
                          <strong>{memberRoleLabel(member.role)}</strong>
                        ) : (
                          <>
                            <select
                              aria-label={`Role for @${member.handle}`}
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
                <section aria-labelledby="computers-heading">
                  <h3 id="computers-heading">Computers</h3>
                  <button
                    type="button"
                    onClick={() => void createPairingCode()}
                  >
                    Create pairing code
                  </button>
                  {hostPairingCode !== "" && (
                    <output data-testid="host-pairing-code">
                      {hostPairingCode}
                    </output>
                  )}
                  <ul
                    className="remote-environment-list"
                    data-testid="computer-list"
                  >
                    {computers.map((computer) => (
                      <li
                        key={computer.id}
                        data-testid={`computer-${computer.id}`}
                      >
                        <span>{computer.name}</span>
                        <strong className={`host-status ${computer.status}`}>
                          {computer.status === "reconnecting"
                            ? "Reconnecting"
                            : computer.status[0].toUpperCase() +
                              computer.status.slice(1)}
                        </strong>
                        {computer.status !== "revoked" && (
                          <button
                            type="button"
                            className="danger"
                            aria-label={`Revoke ${computer.name}`}
                            onClick={() =>
                              void revokeSelectedComputer(computer)
                            }
                          >
                            Revoke
                          </button>
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
              </div>
            </section>
          </div>
        )}
      </section>
      <DirectMessagesPanel
        session={session}
        hidden={activeArea !== "home"}
        onSignOut={() => void logout().then(() => window.location.reload())}
      />
    </main>
  );
}

function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionConnectionFailed, setSessionConnectionFailed] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState("");

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    const loadSession = async () => {
      try {
        const loaded = await readAuthSession();
        if (!active) return;
        setSessionConnectionFailed(false);
        setSession(loaded);
      } catch {
        if (!active) return;
        setSessionConnectionFailed(true);
        retryTimer = window.setTimeout(() => void loadSession(), 500);
      }
    };
    void loadSession();
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
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
    return (
      <main className="shell">
        {sessionConnectionFailed ? "Connecting to Buzzcode…" : "Loading…"}
      </main>
    );
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

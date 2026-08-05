import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AuthSession,
  createDirectMessageMessage,
  type DirectMessage,
  type DirectMessageMessage,
  deleteDirectMessageMessage,
  editDirectMessageMessage,
  getDirectMessageMessage,
  listDirectMessageMessages,
  listDirectMessages,
  searchUsers,
  setDirectMessageReaction,
  startDirectMessage,
  subscribeToDirectMessageEvents,
  type UserSearchResult,
} from "./api";

type SignedInSession = AuthSession & { authenticated: true };

function mergeMessages(
  current: readonly DirectMessageMessage[],
  incoming: readonly DirectMessageMessage[],
): readonly DirectMessageMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function DirectMessagesPanel({ session }: { session: SignedInSession }) {
  const [directMessages, setDirectMessages] = useState<
    readonly DirectMessage[]
  >([]);
  const [active, setActive] = useState<DirectMessage | null>(null);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [people, setPeople] = useState<readonly UserSearchResult[]>([]);
  const [peopleStatus, setPeopleStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [messages, setMessages] = useState<readonly DirectMessageMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<DirectMessageMessage | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const activeId = useRef<string | null>(null);

  const reloadDirectMessages = useCallback(async (preferredId?: string) => {
    const loaded = await listDirectMessages();
    setDirectMessages(loaded);
    setActive((current) => {
      const wanted = preferredId ?? current?.id;
      return loaded.find((item) => item.id === wanted) ?? current;
    });
  }, []);

  const reloadMessages = useCallback(async (directMessageId: string) => {
    const page = await listDirectMessageMessages(directMessageId);
    if (activeId.current === directMessageId) setMessages(page.messages);
  }, []);

  const applyMessage = useCallback((updated: DirectMessageMessage) => {
    setMessages((current) =>
      mergeMessages(current, [updated]).map((message) => {
        if (message.replyTo?.id !== updated.id) return message;
        return {
          ...message,
          replyTo: {
            id: message.replyTo.id,
            authorDisplayName: message.replyTo.authorDisplayName,
            deleted: updated.deletedAt !== undefined,
            ...(updated.content === undefined
              ? {}
              : { content: updated.content }),
          },
        };
      }),
    );
  }, []);

  useEffect(() => {
    void reloadDirectMessages();
    let current = true;
    const unsubscribe = subscribeToDirectMessageEvents(
      (event) => {
        if (!current) return;
        if (event.type === "directMessageChanged") {
          void reloadDirectMessages(event.directMessageId);
        } else if (
          event.type === "messageCreated" &&
          event.directMessageId === activeId.current
        ) {
          applyMessage(event.message);
        } else if (
          event.type === "messageChanged" &&
          event.directMessageId === activeId.current
        ) {
          void getDirectMessageMessage(
            event.directMessageId,
            event.messageId,
          ).then(applyMessage);
        }
      },
      (isConnected) => {
        if (!current) return;
        setConnected(isConnected);
        if (isConnected) {
          void reloadDirectMessages();
          if (activeId.current !== null) void reloadMessages(activeId.current);
        }
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [applyMessage, reloadDirectMessages, reloadMessages]);

  useEffect(() => {
    activeId.current = active?.id ?? null;
    setMessages([]);
    setReplyingTo(null);
    setEditingId(null);
    if (active !== null) void reloadMessages(active.id);
  }, [active, reloadMessages]);

  useEffect(() => {
    const query = peopleQuery.trim();
    if (query === "") {
      setPeople([]);
      setPeopleStatus("idle");
      return;
    }
    let current = true;
    setPeople([]);
    setPeopleStatus("loading");
    const timeout = window.setTimeout(() => {
      void searchUsers(query)
        .then((results) => {
          if (!current) return;
          setPeople(results);
          setPeopleStatus("ready");
        })
        .catch(() => {
          if (current) setPeopleStatus("error");
        });
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timeout);
    };
  }, [peopleQuery]);

  async function openDirectMessage(person: UserSearchResult) {
    const created = await startDirectMessage(person.userId);
    setPeopleQuery("");
    setPeople([]);
    await reloadDirectMessages(created.id);
    setActive(created);
  }

  async function sendMessage() {
    if (active === null || draft.trim() === "") return;
    const created = await createDirectMessageMessage(
      active.id,
      draft,
      replyingTo?.id,
    );
    applyMessage(created);
    setDraft("");
    setReplyingTo(null);
  }

  async function saveEdit(messageId: string) {
    if (active === null || editDraft.trim() === "") return;
    applyMessage(
      await editDirectMessageMessage(active.id, messageId, editDraft),
    );
    setEditingId(null);
  }

  async function removeMessage(messageId: string) {
    if (active === null) return;
    applyMessage(await deleteDirectMessageMessage(active.id, messageId));
  }

  async function toggleReaction(message: DirectMessageMessage, emoji: string) {
    if (active === null) return;
    const reaction = message.reactions.find((item) => item.emoji === emoji);
    applyMessage(
      await setDirectMessageReaction(
        active.id,
        message.id,
        emoji,
        !(reaction?.reacted ?? false),
      ),
    );
  }

  return (
    <section className="direct-messages card" aria-labelledby="dm-heading">
      <header className="section-heading">
        <h2 id="dm-heading">Direct Messages</h2>
        <span data-testid="dm-realtime-status">
          {connected ? "Connected" : "Disconnected"}
        </span>
      </header>
      <div className="dm-person-picker">
        <label htmlFor="direct-message-person">
          Find or start a conversation
        </label>
        <input
          id="direct-message-person"
          value={peopleQuery}
          placeholder="Search by Display Name or @username"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setPeopleQuery(event.target.value)}
        />
        {peopleQuery.trim() !== "" && (
          <div className="dm-person-results">
            {people.map((person) => (
              <button
                key={person.userId}
                type="button"
                onClick={() => void openDirectMessage(person)}
              >
                <strong>{person.displayName}</strong>
                <span>@{person.handle}</span>
              </button>
            ))}
            {peopleStatus === "loading" && <p>Searching…</p>}
            {peopleStatus === "ready" && people.length === 0 && (
              <p>No one found.</p>
            )}
            {peopleStatus === "error" && <p>Search is unavailable.</p>}
          </div>
        )}
      </div>
      <div className="dm-layout">
        <nav aria-label="Direct Messages" className="channel-list">
          {directMessages.map((directMessage) => (
            <button
              key={directMessage.id}
              type="button"
              data-direct-message-id={directMessage.id}
              aria-current={active?.id === directMessage.id}
              onClick={() => setActive(directMessage)}
            >
              {directMessage.peerDisplayName}
            </button>
          ))}
        </nav>
        <section className="channel-panel">
          {active === null ? (
            <p className="channel-empty">Choose a person to start talking.</p>
          ) : (
            <>
              <h3 data-testid="active-dm-name">{active.peerDisplayName}</h3>
              <div
                className="message-timeline"
                role="log"
                aria-label="Direct Message messages"
              >
                {messages.map((message) => (
                  <article
                    className="message"
                    key={message.id}
                    data-dm-message-id={message.id}
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
                      {message.editedAt !== undefined &&
                        message.deletedAt === undefined && <span>edited</span>}
                    </div>
                    {message.deletedAt !== undefined ? (
                      <p className="deleted-message">Message deleted</p>
                    ) : editingId === message.id ? (
                      <form
                        className="edit-message"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveEdit(message.id);
                        }}
                      >
                        <label
                          className="sr-only"
                          htmlFor={`dm-edit-${message.id}`}
                        >
                          Edit message by {message.authorDisplayName}
                        </label>
                        <input
                          id={`dm-edit-${message.id}`}
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                        />
                        <button type="submit">Save edit</button>
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
                          {message.authorSubject === session.user.subject && (
                            <>
                              <button
                                type="button"
                                aria-label={`Edit message by ${message.authorDisplayName}`}
                                onClick={() => {
                                  setEditingId(message.id);
                                  setEditDraft(message.content ?? "");
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete message by ${message.authorDisplayName}`}
                                onClick={() => void removeMessage(message.id)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
              {replyingTo !== null && (
                <div className="replying-to">
                  Replying to <strong>{replyingTo.authorDisplayName}</strong>
                  <button type="button" onClick={() => setReplyingTo(null)}>
                    Cancel reply
                  </button>
                </div>
              )}
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage();
                }}
              >
                <label className="sr-only" htmlFor={`dm-message-${active.id}`}>
                  Message {active.peerDisplayName}
                </label>
                <input
                  id={`dm-message-${active.id}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" disabled={draft.trim() === ""}>
                  Send Direct Message
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

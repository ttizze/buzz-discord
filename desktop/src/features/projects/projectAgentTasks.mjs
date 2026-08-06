const JOB_REQUEST = 43001;
const JOB_ACCEPTED = 43002;
const JOB_PROGRESS = 43003;
const JOB_RESULT = 43004;
const JOB_CANCEL = 43005;
const JOB_ERROR = 43006;

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function rootReference(event) {
  return (
    event.tags.find(
      (tag) => tag[0] === "e" && (tag[3] === "root" || tag.length < 4),
    )?.[1] ?? null
  );
}

function titleFor(event) {
  const subject = tagValue(event, "subject")?.trim();
  if (subject) return subject;
  const firstLine = event.content.trim().split("\n")[0] || "Untitled task";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

export function parseProjectAgentTasks(events, repoAddress, channelId) {
  const scoped = events
    .filter(
      (event) =>
        tagValue(event, "a") === repoAddress &&
        tagValue(event, "h") === channelId,
    )
    .sort(
      (left, right) =>
        left.created_at - right.created_at || left.id.localeCompare(right.id),
    );
  const roots = scoped.filter(
    (event) => event.kind === JOB_REQUEST && rootReference(event) == null,
  );

  return roots
    .map((root) => {
      const agentPubkey = tagValue(root, "p") ?? "";
      const taskEvents = scoped.filter(
        (event) => event.id === root.id || rootReference(event) === root.id,
      );
      let status = "queued";
      for (const event of taskEvents) {
        const isAgentEntry =
          event.kind >= JOB_ACCEPTED &&
          event.kind <= JOB_ERROR &&
          event.kind !== JOB_CANCEL;
        if (
          isAgentEntry &&
          event.pubkey.toLowerCase() !== agentPubkey.toLowerCase()
        ) {
          continue;
        }
        if (event.kind === JOB_REQUEST) {
          status = "queued";
        } else if (event.kind === JOB_ACCEPTED || event.kind === JOB_PROGRESS) {
          status = "running";
        } else if (event.kind === JOB_CANCEL) {
          status = "canceled";
        } else if (event.kind === JOB_ERROR) {
          status = "failed";
        } else if (event.kind === JOB_RESULT && status !== "canceled") {
          status = "completed";
        }
      }
      return {
        id: root.id,
        title: titleFor(root),
        prompt: root.content,
        projectAddress: repoAddress,
        channelId,
        agentPubkey,
        createdBy: root.pubkey,
        createdAt: root.created_at,
        updatedAt: taskEvents.at(-1)?.created_at ?? root.created_at,
        status,
        events: taskEvents,
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function observerEventsForTask(task) {
  return task.events
    .filter((event) => event.kind >= JOB_ACCEPTED && event.kind <= JOB_ERROR)
    .map((event) => {
      try {
        return JSON.parse(event.content);
      } catch {
        return null;
      }
    })
    .filter((event) => event && typeof event.kind === "string");
}

export function promptsForTask(task) {
  return task.events
    .filter((event) => event.kind === JOB_REQUEST)
    .map((event) => ({
      id: event.id,
      content: event.content,
      createdAt: event.created_at,
      author: event.pubkey,
    }));
}

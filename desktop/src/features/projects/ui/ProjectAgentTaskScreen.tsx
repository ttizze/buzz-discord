import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleAlert,
  Laptop,
  Loader2,
  SendHorizontal,
  Server,
} from "lucide-react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
  useStartManagedAgentMutation,
} from "@/features/agents/hooks";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { ManagedAgentSessionPanel } from "@/features/agents/ui/ManagedAgentSessionPanel";
import { buildTranscriptState } from "@/features/agents/ui/agentSessionTranscript";
import type { TranscriptItem } from "@/features/agents/ui/agentSessionTypes";
import { type Project, useProjectQuery } from "@/features/projects/hooks";
import {
  useCreateProjectAgentTaskMutation,
  useProjectAgentTasksQuery,
  useReplyProjectAgentTaskMutation,
} from "@/features/projects/projectAgentTaskHooks";
import {
  observerEventsForTask,
  promptsForTask,
  type ProjectAgentTask,
} from "@/features/projects/projectAgentTasks.mjs";
import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { getComputerIdentity } from "@/shared/api/tauriComputers";
import { KIND_MANAGED_AGENT } from "@/shared/constants/kinds";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

type AgentChoice = {
  pubkey: string;
  name: string;
  active: boolean;
  managed: boolean;
  avatarUrl: string | null;
  status: "running" | "stopped" | "deployed" | "not_deployed";
};

function useAgentChoices(project: Project | null | undefined) {
  const managedQuery = useManagedAgentsQuery();
  const relayQuery = useRelayAgentsQuery();
  const computerQuery = useQuery({
    queryKey: ["computer-identity"],
    queryFn: getComputerIdentity,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const bindingsQuery = useQuery({
    enabled: Boolean(project?.computerId && project?.owner),
    queryKey: ["project-computer-agents", project?.owner, project?.computerId],
    queryFn: async () => {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_MANAGED_AGENT],
        authors: [project?.owner ?? ""],
        limit: 1_000,
      });
      return new Set(
        events.flatMap((event) => {
          try {
            const content = JSON.parse(event.content) as {
              computer_id?: string;
            };
            if (content.computer_id !== project?.computerId) return [];
            const agent = event.tags.find((tag) => tag[0] === "d")?.[1];
            return agent ? [normalizePubkey(agent)] : [];
          } catch {
            return [];
          }
        }),
      );
    },
    staleTime: 30_000,
  });
  return React.useMemo(() => {
    const choices = new Map<string, AgentChoice>();
    const isLegacyProject = !project?.computerId;
    const isLocalComputer =
      isLegacyProject || computerQuery.data?.computerId === project?.computerId;
    const boundAgents = bindingsQuery.data ?? new Set<string>();
    for (const agent of managedQuery.data ?? []) {
      if (!isLocalComputer || agent.backend.type !== "local") continue;
      choices.set(normalizePubkey(agent.pubkey), {
        pubkey: normalizePubkey(agent.pubkey),
        name: agent.name,
        active: isManagedAgentActive(agent),
        managed: true,
        avatarUrl: agent.avatarUrl,
        status: agent.status,
      });
    }
    for (const agent of relayQuery.data ?? []) {
      const pubkey = normalizePubkey(agent.pubkey);
      if (!isLegacyProject && !boundAgents.has(pubkey)) continue;
      if (choices.has(pubkey)) continue;
      choices.set(pubkey, {
        pubkey,
        name: agent.name,
        active: agent.status !== "offline",
        managed: false,
        avatarUrl: null,
        status: agent.status === "offline" ? "stopped" : "deployed",
      });
    }
    return [...choices.values()].sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [
    bindingsQuery.data,
    computerQuery.data?.computerId,
    managedQuery.data,
    project?.computerId,
    relayQuery.data,
  ]);
}

function userPromptItem(
  prompt: ReturnType<typeof promptsForTask>[number],
): TranscriptItem {
  return {
    id: `prompt-${prompt.id}`,
    type: "message",
    renderClass: "message",
    role: "user",
    title: "You",
    text: prompt.content,
    timestamp: new Date(prompt.createdAt * 1_000).toISOString(),
    messageId: prompt.id,
  };
}

function transcriptForTask(task: ProjectAgentTask) {
  const observerEvents = observerEventsForTask(task);
  const items = buildTranscriptState(observerEvents).items;
  const prompts = promptsForTask(task)
    .filter(
      (prompt) =>
        !items.some(
          (item) =>
            item.type === "message" &&
            item.role === "user" &&
            item.text.trim() === prompt.content.trim(),
        ),
    )
    .map(userPromptItem);
  return [...items, ...prompts].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

const STATUS_LABELS = {
  queued: "Queued",
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
} as const;

function TaskStatus({ task }: { task: ProjectAgentTask }) {
  const terminal = task.status === "completed";
  const failed = task.status === "failed" || task.status === "canceled";
  return (
    <Badge className="gap-1.5" variant="outline">
      {terminal ? (
        <CheckCircle2 className="size-3.5 text-emerald-500" />
      ) : failed ? (
        <CircleAlert className="size-3.5 text-destructive" />
      ) : (
        <Loader2 className="size-3.5 animate-spin text-blue-500" />
      )}
      {STATUS_LABELS[task.status]}
    </Badge>
  );
}

export function ProjectAgentTaskScreen({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { goProject } = useAppNavigation();
  const projectQuery = useProjectQuery(projectId);
  const project = projectQuery.data;
  const tasksQuery = useProjectAgentTasksQuery(project);
  const choices = useAgentChoices(project);
  const task =
    tasksQuery.data?.find((candidate) => candidate.id === taskId) ?? null;

  if (projectQuery.isPending || (taskId !== "new" && tasksQuery.isPending)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Project not found.
      </div>
    );
  }
  if (taskId === "new") {
    return <NewTask project={project} choices={choices} />;
  }
  if (!task) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Agent task not found.
      </div>
    );
  }

  const agent = choices.find(
    (choice) => choice.pubkey === task.agentPubkey,
  ) ?? {
    pubkey: task.agentPubkey,
    name: `Agent ${truncatePubkey(task.agentPubkey)}`,
    active: false,
    managed: false,
    avatarUrl: null,
    status: "stopped" as const,
  };
  const transcript = transcriptForTask(task);
  const observerEvents = observerEventsForTask(task);

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="project-agent-task-screen"
    >
      <header className="flex items-center gap-3 border-b px-5 py-3">
        <Button
          aria-label="Back to project"
          onClick={() => void goProject(project.id)}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Bot className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">
            {project.name} / Agent tasks
          </p>
          <h1 className="truncate text-base font-semibold">{task.title}</h1>
        </div>
        <TaskStatus task={task} />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ManagedAgentSessionPanel
          agent={agent}
          autoTail
          channelId={task.channelId}
          className="h-full rounded-none border-0 shadow-none"
          emptyDescription="The task is queued for this agent."
          panelPadding={false}
          rawEventsOverride={observerEvents}
          showHeader={false}
          showRaw={false}
          transcriptContentClassName="mx-auto max-w-3xl px-6 py-8"
          transcriptOverride={transcript}
        />
      </div>
      <ReplyComposer project={project} task={task} />
    </main>
  );
}

function NewTask({
  project,
  choices,
}: {
  project: NonNullable<ReturnType<typeof useProjectQuery>["data"]>;
  choices: AgentChoice[];
}) {
  const { goProject } = useAppNavigation();
  const create = useCreateProjectAgentTaskMutation(project);
  const startAgent = useStartManagedAgentMutation();
  const identityQuery = useIdentityQuery();
  const [title, setTitle] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [agentPubkey, setAgentPubkey] = React.useState(
    choices[0]?.pubkey ?? "",
  );
  React.useEffect(() => {
    if (!agentPubkey && choices[0]) setAgentPubkey(choices[0].pubkey);
  }, [agentPubkey, choices]);
  const canRunOnComputer =
    project.computerAccess !== "personal" ||
    normalizePubkey(identityQuery.data?.pubkey ?? "") ===
      normalizePubkey(project.owner);
  const submit = async () => {
    const agent = choices.find((choice) => choice.pubkey === agentPubkey);
    if (!agent || !prompt.trim()) return;
    try {
      if (agent.managed && !agent.active)
        await startAgent.mutateAsync(agent.pubkey);
      const event = await create.mutateAsync({
        agentPubkey: agent.pubkey,
        prompt: prompt.trim(),
        title: title.trim() || prompt.trim().split("\n")[0].slice(0, 72),
      });
      await goProject(project.id, { taskId: event.id });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start task.",
      );
    }
  };
  return (
    <main
      className="h-full overflow-y-auto bg-background px-6 py-8"
      data-testid="project-agent-task-new"
    >
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <p className="text-sm text-muted-foreground">
            {project.name} / Agent tasks
          </p>
          <h1 className="mt-1 text-2xl font-semibold">New agent task</h1>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 p-3">
          {project.computerAccess !== "personal" ? (
            <Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Laptop className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {project.computerName ?? "Project computer"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {project.workspacePath ?? "Workspace path unavailable"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {project.computerAccess !== "personal"
                ? "Community members can run Codex on this computer."
                : "Only the computer owner can start agents here."}
            </p>
          </div>
        </div>
        {!canRunOnComputer ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            This is a personal computer. Only its owner can start an agent.
          </p>
        ) : null}
        {!project.projectChannelId ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            Link a channel to this project first. Its membership controls who
            can see the task.
          </p>
        ) : null}
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="task-title">
            Title
          </label>
          <Input
            id="task-title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Release readiness review"
            value={title}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="task-agent">
            Agent
          </label>
          <select
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            id="task-agent"
            onChange={(event) => setAgentPubkey(event.target.value)}
            value={agentPubkey}
          >
            {choices.map((choice) => (
              <option key={choice.pubkey} value={choice.pubkey}>
                {choice.name}
                {choice.active ? "" : " (offline)"}
              </option>
            ))}
          </select>
          {choices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No local ACP agent is registered on this project computer.
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="task-prompt">
            Task
          </label>
          <Textarea
            className="min-h-48 text-base"
            id="task-prompt"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask the agent to inspect the repository, run tools, and report back…"
            value={prompt}
          />
        </div>
        <div className="flex justify-end">
          <Button
            disabled={
              !project.projectChannelId ||
              !canRunOnComputer ||
              !agentPubkey ||
              !prompt.trim() ||
              create.isPending
            }
            onClick={() => void submit()}
          >
            <SendHorizontal className="mr-2 size-4" />
            Start task
          </Button>
        </div>
      </div>
    </main>
  );
}

function ReplyComposer({
  project,
  task,
}: {
  project: NonNullable<ReturnType<typeof useProjectQuery>["data"]>;
  task: ProjectAgentTask;
}) {
  const reply = useReplyProjectAgentTaskMutation(project, task);
  const identityQuery = useIdentityQuery();
  const [content, setContent] = React.useState("");
  const canReply =
    project.computerAccess !== "personal" ||
    normalizePubkey(identityQuery.data?.pubkey ?? "") ===
      normalizePubkey(project.owner);
  const submit = async () => {
    if (!canReply || !content.trim()) return;
    try {
      await reply.mutateAsync(content.trim());
      setContent("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to send follow-up.",
      );
    }
  };
  return (
    <div className="border-t bg-background px-5 py-3">
      <div className="mx-auto flex max-w-3xl gap-2">
        <Textarea
          className="min-h-11 resize-none"
          disabled={!canReply}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Follow up on this task…"
          value={content}
        />
        <Button
          aria-label="Send follow-up"
          disabled={!canReply || !content.trim() || reply.isPending}
          onClick={() => void submit()}
          size="icon"
        >
          <SendHorizontal className="size-4" />
        </Button>
      </div>
    </div>
  );
}

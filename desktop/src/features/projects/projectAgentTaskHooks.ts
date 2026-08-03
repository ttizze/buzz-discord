import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Project } from "@/features/projects/hooks";
import {
  parseProjectAgentTasks,
  type ProjectAgentTask,
} from "@/features/projects/projectAgentTasks.mjs";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import {
  KIND_JOB_ACCEPTED,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_JOB_PROGRESS,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
} from "@/shared/constants/kinds";

const JOB_KINDS = [
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
];

function queryKey(project: Project | null | undefined) {
  return [
    "project-agent-tasks",
    project?.projectAddress ?? project?.repoAddress ?? "none",
  ] as const;
}

function projectAddress(project: Project): string {
  return project.projectAddress ?? project.repoAddress;
}

async function fetchProjectAgentTasks(project: Project) {
  if (!project.projectChannelId) return [];
  // Keep request roots in a separate query so a long Codex-visible execution
  // cannot push its own task identity out of a mixed 1,000-event window.
  const baseFilter = {
    "#a": [projectAddress(project)],
    "#h": [project.projectChannelId],
    limit: 1_000,
  };
  const [requests, lifecycle] = await Promise.all([
    relayClient.fetchEvents({ ...baseFilter, kinds: [KIND_JOB_REQUEST] }),
    relayClient.fetchEvents({
      ...baseFilter,
      kinds: JOB_KINDS.filter((kind) => kind !== KIND_JOB_REQUEST),
    }),
  ]);
  const events = [
    ...new Map(
      [...requests, ...lifecycle].map((event) => [event.id, event]),
    ).values(),
  ];
  return parseProjectAgentTasks(
    events,
    projectAddress(project),
    project.projectChannelId,
  );
}

export function useProjectAgentTasksQuery(project: Project | null | undefined) {
  return useQuery({
    enabled: Boolean(project?.projectChannelId),
    queryKey: queryKey(project),
    queryFn: () => fetchProjectAgentTasks(project as Project),
    refetchInterval: 2_000,
  });
}

async function publish(kind: number, content: string, tags: string[][]) {
  const event = await signRelayEvent({ kind, content, tags });
  await relayClient.publishEvent(
    event,
    "Timed out publishing the agent task.",
    "Failed to publish the agent task.",
  );
  return event;
}

export function useCreateProjectAgentTaskMutation(project: Project) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentPubkey,
      prompt,
      title,
    }: {
      agentPubkey: string;
      prompt: string;
      title: string;
    }) => {
      if (!project.projectChannelId) {
        throw new Error(
          "Link a channel to this project before starting a task.",
        );
      }
      return publish(KIND_JOB_REQUEST, prompt, [
        ["h", project.projectChannelId],
        ["a", projectAddress(project)],
        ...(project.workspacePath
          ? [["workspace", project.workspacePath]]
          : []),
        ...(project.computerId ? [["computer-id", project.computerId]] : []),
        ["computer-access", project.computerAccess ?? "personal"],
        ["project-owner", project.owner],
        ["p", agentPubkey],
        ["subject", title],
      ]);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKey(project) });
    },
  });
}

export function useReplyProjectAgentTaskMutation(
  project: Project,
  task: ProjectAgentTask,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      publish(KIND_JOB_REQUEST, content, [
        ["h", task.channelId],
        ["a", projectAddress(project)],
        ...(project.workspacePath
          ? [["workspace", project.workspacePath]]
          : []),
        ...(project.computerId ? [["computer-id", project.computerId]] : []),
        ["computer-access", project.computerAccess ?? "personal"],
        ["project-owner", project.owner],
        ["p", task.agentPubkey],
        ["e", task.id, "", "root"],
      ]),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKey(project) });
    },
  });
}

export function useCancelProjectAgentTaskMutation(
  project: Project,
  task: ProjectAgentTask,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      publish(KIND_JOB_CANCEL, "", [
        ["h", task.channelId],
        ["a", projectAddress(project)],
        ["p", task.agentPubkey],
        ["e", task.id, "", "root"],
      ]),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKey(project) });
    },
  });
}

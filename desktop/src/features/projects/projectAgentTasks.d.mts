import type { RelayEvent } from "@/shared/api/types";
import type { ObserverEvent } from "@/features/agents/ui/agentSessionTypes";

export type ProjectAgentTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type ProjectAgentTask = {
  id: string;
  title: string;
  prompt: string;
  projectAddress: string;
  channelId: string;
  agentPubkey: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  status: ProjectAgentTaskStatus;
  events: RelayEvent[];
};

export function parseProjectAgentTasks(
  events: RelayEvent[],
  repoAddress: string,
  channelId: string,
): ProjectAgentTask[];
export function observerEventsForTask(task: ProjectAgentTask): ObserverEvent[];
export function promptsForTask(task: ProjectAgentTask): Array<{
  id: string;
  content: string;
  createdAt: number;
  author: string;
}>;

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  eventToProject,
  fetchProjects,
  type Project,
  projectsQueryKey,
} from "@/features/projects/hooks";
import { channelsQueryKey } from "@/features/channels/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { createChannel, signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { KIND_SHARED_PROJECT } from "@/shared/constants/kinds";

export type CreateProjectInput = {
  name: string;
  description?: string;
  workspacePath: string;
  computerId: string;
  computerName: string;
  computerAccess: "personal" | "shared";
  gitRepository: boolean;
};

function projectDtagFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Publishes a computer-hosted shared project to the community relay. */
async function createProject(input: CreateProjectInput): Promise<Project> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Project name is required.");
  }
  const dtag = projectDtagFromName(name);
  if (!dtag) {
    throw new Error("Project name must include letters or numbers.");
  }
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(input.workspacePath)) {
    throw new Error("Choose a local project folder first.");
  }

  const identity = await getIdentity();
  const existing = await fetchProjects();
  const ownerPubkey = identity.pubkey.toLowerCase();
  if (
    existing.some(
      (project) =>
        project.owner.toLowerCase() === ownerPubkey && project.dtag === dtag,
    )
  ) {
    throw new Error(`You already have a project named "${dtag}".`);
  }

  const description = input.description?.trim() ?? "";
  const projectChannel = await createChannel({
    name: dtag,
    channelType: "stream",
    visibility: "open",
    description: description || `Project channel for ${name}`,
  });
  const tags: string[][] = [
    ["d", dtag],
    ["name", name],
    ["project-channel", projectChannel.id],
    ["workspace", input.workspacePath],
    ["computer-id", input.computerId],
    ["computer", input.computerName],
    ["computer-access", input.computerAccess],
    ["git", input.gitRepository ? "true" : "false"],
  ];
  if (description) {
    tags.push(["description", description]);
  }
  const event = await signRelayEvent({
    kind: KIND_SHARED_PROJECT,
    content: description,
    tags,
  });

  await relayClient.publishEvent(
    event,
    "Timed out creating project.",
    "Failed to create project.",
  );

  return eventToProject(event, getCachedRelayOrigin());
}

/** Mutation that creates a project and inserts it into the projects cache. */
export function useCreateProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.setQueryData<Project[]>(projectsQueryKey, (current = []) => [
        project,
        ...current,
      ]);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      void queryClient.invalidateQueries({ queryKey: channelsQueryKey });
    },
  });
}

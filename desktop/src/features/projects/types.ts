export type Project = {
  id: string;
  dtag: string;
  name: string;
  description: string;
  cloneUrls: string[];
  webUrl: string | null;
  owner: string;
  contributors: string[];
  createdAt: number;
  projectChannelId: string | null;
  status: string;
  defaultBranch: string;
  repoAddress: string;
  projectAddress?: string;
  source?: "workspace" | "repository";
  workspacePath?: string | null;
  computerId?: string | null;
  computerName?: string | null;
  computerAccess?: "personal" | "shared";
  gitRepository?: boolean;
};

export type RepoState = {
  branches: Array<{ name: string; commit: string }>;
  tags: Array<{ name: string; commit: string }>;
  head: string | null;
  updatedAt: number;
};

export type ProjectActivitySummary = {
  repoAddress: string;
  issueCount: number;
  prCount: number;
  commitCount: number;
  activityCount: number;
  updatedAt: number;
  participantPubkeys: string[];
  latestCommit: {
    author: string | null;
    commit: string;
    createdAt: number;
    title: string;
  } | null;
  /** Activity event counts bucketed by local-time day key ("YYYY-MM-DD"). */
  activityByDay: Record<string, number>;
};

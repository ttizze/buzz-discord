import * as React from "react";
import { useLocation } from "@tanstack/react-router";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FolderGit2,
  LoaderCircle,
  Plus,
} from "lucide-react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { ActiveChannelTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import type { Project } from "@/features/projects/hooks";
import { useProjectAgentTasksQuery } from "@/features/projects/projectAgentTaskHooks";
import type { ChannelSection } from "@/features/sidebar/lib/useChannelSections";
import { ChannelContextMenuItems } from "@/features/sidebar/ui/ChannelContextMenu";
import { ChannelMenuButton } from "@/features/sidebar/ui/SidebarSection";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar";
import { Skeleton } from "@/shared/ui/skeleton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";

type ProjectSidebarTreeProps = {
  activeWorkingByChannelId: ReadonlyMap<string, ActiveChannelTurnSummary>;
  assignments?: Record<string, string>;
  channels: Channel[];
  expandedProjectId: string | null;
  isLoading: boolean;
  mutedChannelIds?: ReadonlySet<string>;
  onAssignChannel?: (channelId: string, sectionId: string) => void;
  onCreateSectionForChannel?: (channelId: string) => void;
  onDeleteChannel?: (channel: Channel) => void;
  onLeaveChannel?: (channel: Channel) => void;
  onMarkChannelRead?: (
    channelId: string,
    lastMessageAt: string | null | undefined,
  ) => void;
  onMarkChannelUnread?: (channelId: string) => void;
  onMuteChannel?: (channelId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectProjects: () => void;
  onStarChannel?: (channelId: string) => void;
  onUnassignChannel?: (channelId: string) => void;
  onUnmuteChannel?: (channelId: string) => void;
  onUnstarChannel?: (channelId: string) => void;
  projects: Project[];
  sections?: ChannelSection[];
  selectedChannelId: string | null;
  selectedProjectId: string | null;
  selectedView: string;
  starredChannelIds?: ReadonlySet<string>;
  unreadChannelCounts: ReadonlyMap<string, number>;
  unreadChannelIds: ReadonlySet<string>;
};

function ProjectSubsection({
  children,
  action,
  testId,
  title,
}: {
  children?: React.ReactNode;
  action?: React.ReactNode;
  testId: string;
  title: string;
}) {
  return (
    <div className="w-full" data-project-subsection={testId}>
      <div className="flex h-7 items-center px-2 text-2xs font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/60">
        <span data-testid={`${testId}-title`}>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function ProjectAgentTasksSection({ project }: { project: Project }) {
  const { goProject } = useAppNavigation();
  const location = useLocation();
  const tasksQuery = useProjectAgentTasksQuery(project);
  const selectedTaskId = new URLSearchParams(location.searchStr).get("taskId");
  return (
    <ProjectSubsection
      action={
        <button
          aria-label={`New agent task in ${project.name}`}
          className="ml-auto flex size-5 items-center justify-center rounded hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={() => void goProject(project.id, { taskId: "new" })}
          type="button"
        >
          <Plus className="size-3.5" />
        </button>
      }
      testId={`project-${project.dtag}-agent-tasks`}
      title="Agent tasks"
    >
      {tasksQuery.isPending ? (
        <div className="px-2 pb-1 text-xs text-sidebar-foreground/45">
          Loading…
        </div>
      ) : tasksQuery.data?.length ? (
        <SidebarMenu data-testid={`project-${project.dtag}-agent-task-list`}>
          {tasksQuery.data.map((task) => (
            <SidebarMenuItem key={task.id}>
              <SidebarMenuButton
                className="gap-2"
                isActive={selectedTaskId === task.id}
                onClick={() => void goProject(project.id, { taskId: task.id })}
                tooltip={task.title}
                type="button"
              >
                {task.status === "completed" ? (
                  <CheckCircle2 className="size-3.5 text-emerald-500" />
                ) : task.status === "failed" || task.status === "canceled" ? (
                  <CircleAlert className="size-3.5 text-destructive" />
                ) : (
                  <LoaderCircle className="size-3.5 text-blue-500" />
                )}
                <span className="truncate">{task.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      ) : (
        <button
          className="flex w-full items-center gap-2 rounded px-2 pb-1 text-left text-xs text-sidebar-foreground/45 hover:text-sidebar-foreground"
          onClick={() => void goProject(project.id, { taskId: "new" })}
          type="button"
        >
          <Bot className="size-3.5" /> New task
        </button>
      )}
    </ProjectSubsection>
  );
}

function ProjectsHeader({
  onSelectProjects,
}: {
  onSelectProjects: () => void;
}) {
  return (
    <div className="relative">
      <SidebarGroupLabel asChild>
        <button
          className="w-fit cursor-pointer uppercase tracking-[0.12em] hover:text-sidebar-foreground focus-visible:text-sidebar-foreground"
          data-testid="open-projects-view"
          onClick={onSelectProjects}
          type="button"
        >
          Projects
        </button>
      </SidebarGroupLabel>
      <button
        aria-label="Open projects"
        className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        onClick={onSelectProjects}
        title="Open projects"
        type="button"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

export function ProjectSidebarTree({
  activeWorkingByChannelId,
  assignments,
  channels,
  expandedProjectId,
  isLoading,
  mutedChannelIds,
  onAssignChannel,
  onCreateSectionForChannel,
  onDeleteChannel,
  onLeaveChannel,
  onMarkChannelRead,
  onMarkChannelUnread,
  onMuteChannel,
  onSelectChannel,
  onSelectProject,
  onSelectProjects,
  onStarChannel,
  onUnassignChannel,
  onUnmuteChannel,
  onUnstarChannel,
  projects,
  sections,
  selectedChannelId,
  selectedProjectId,
  selectedView,
  starredChannelIds,
  unreadChannelCounts,
  unreadChannelIds,
}: ProjectSidebarTreeProps) {
  const channelsById = React.useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  );
  return (
    <SidebarGroup
      className="select-none pb-0 pt-0"
      data-testid="project-sidebar-tree"
    >
      <ProjectsHeader onSelectProjects={onSelectProjects} />
      <SidebarGroupContent>
        {isLoading ? (
          <div
            className="space-y-2 px-2 py-1"
            data-testid="project-sidebar-loading"
          >
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-4/5" />
          </div>
        ) : projects.length > 0 ? (
          <SidebarMenu>
            {projects.map((project) => {
              const isExpanded = project.id === expandedProjectId;
              const linkedChannel = project.projectChannelId
                ? channelsById.get(project.projectChannelId)
                : undefined;

              return (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    className="gap-1.5"
                    data-project-id={project.id}
                    data-testid={`project-sidebar-${project.dtag}`}
                    isActive={
                      selectedView === "projects" &&
                      selectedProjectId === project.id
                    }
                    onClick={() => onSelectProject(project.id)}
                    tooltip={project.name}
                    type="button"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 transition-transform",
                        isExpanded && "rotate-90",
                      )}
                    />
                    <FolderGit2 className="size-4" />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                  </SidebarMenuButton>

                  {isExpanded ? (
                    <div className="ml-4 border-l border-sidebar-border/55 pl-1">
                      <ProjectSubsection
                        testId={`project-${project.dtag}-channels`}
                        title="Channels"
                      >
                        {linkedChannel ? (
                          <SidebarMenu
                            data-testid={`project-${project.dtag}-channel-list`}
                          >
                            <ContextMenu>
                              <ContextMenuTrigger asChild>
                                <SidebarMenuItem className="group/menu-item">
                                  <ChannelMenuButton
                                    activeWorking={activeWorkingByChannelId.get(
                                      linkedChannel.id,
                                    )}
                                    channel={linkedChannel}
                                    hasUnread={unreadChannelIds.has(
                                      linkedChannel.id,
                                    )}
                                    isActive={
                                      selectedView === "channel" &&
                                      selectedChannelId === linkedChannel.id
                                    }
                                    isMuted={mutedChannelIds?.has(
                                      linkedChannel.id,
                                    )}
                                    onSelectChannel={onSelectChannel}
                                    unreadCount={
                                      unreadChannelCounts.get(
                                        linkedChannel.id,
                                      ) ?? 0
                                    }
                                  />
                                </SidebarMenuItem>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ChannelContextMenuItems
                                  assignments={assignments}
                                  channel={linkedChannel}
                                  hasUnread={unreadChannelIds.has(
                                    linkedChannel.id,
                                  )}
                                  isMuted={mutedChannelIds?.has(
                                    linkedChannel.id,
                                  )}
                                  isStarred={starredChannelIds?.has(
                                    linkedChannel.id,
                                  )}
                                  onAssignChannel={onAssignChannel}
                                  onCreateSectionForChannel={
                                    onCreateSectionForChannel
                                  }
                                  onDeleteChannel={onDeleteChannel}
                                  onLeaveChannel={onLeaveChannel}
                                  onMarkChannelRead={onMarkChannelRead}
                                  onMarkChannelUnread={onMarkChannelUnread}
                                  onMuteChannel={onMuteChannel}
                                  onStarChannel={onStarChannel}
                                  onUnassignChannel={onUnassignChannel}
                                  onUnmuteChannel={onUnmuteChannel}
                                  onUnstarChannel={onUnstarChannel}
                                  sections={sections}
                                />
                              </ContextMenuContent>
                            </ContextMenu>
                          </SidebarMenu>
                        ) : (
                          <p className="px-2 pb-1 text-xs text-sidebar-foreground/45">
                            No linked channels
                          </p>
                        )}
                      </ProjectSubsection>

                      <ProjectAgentTasksSection project={project} />
                    </div>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        ) : (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={onSelectProjects}
                tooltip="Create a project"
                type="button"
              >
                <FolderGit2 className="size-4" />
                <span>No projects yet</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

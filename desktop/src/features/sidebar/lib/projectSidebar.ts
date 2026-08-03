export type SidebarProjectReference = {
  id: string;
  projectChannelId: string | null;
};

/**
 * Chooses the project whose nested navigation should be visible.
 *
 * A project detail route wins. Channel routes then recover their owning
 * project from the existing project-channel link. Outside either context the
 * first project stays open, matching an accordion-style project navigator.
 */
export function resolveExpandedProjectId(
  projects: readonly SidebarProjectReference[],
  selectedProjectId: string | null,
  selectedChannelId: string | null,
): string | null {
  if (
    selectedProjectId &&
    projects.some((project) => project.id === selectedProjectId)
  ) {
    return selectedProjectId;
  }

  if (selectedChannelId) {
    const linkedProject = projects.find(
      (project) => project.projectChannelId === selectedChannelId,
    );
    if (linkedProject) return linkedProject.id;
  }

  return projects[0]?.id ?? null;
}

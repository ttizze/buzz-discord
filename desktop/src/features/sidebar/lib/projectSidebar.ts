export type SidebarProjectReference = {
  id: string;
  projectChannelId: string | null;
};

/**
 * Chooses the project whose nested navigation should be visible.
 *
 * A project detail route wins. Channel routes then recover their owning
 * project from the existing project-channel link. The projects overview may
 * opt into expanding the first project; unrelated routes remain collapsed so
 * an async project query cannot move channel rows out from under the user.
 */
export function resolveExpandedProjectId(
  projects: readonly SidebarProjectReference[],
  selectedProjectId: string | null,
  selectedChannelId: string | null,
  expandFirstProject = false,
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

  return expandFirstProject ? (projects[0]?.id ?? null) : null;
}

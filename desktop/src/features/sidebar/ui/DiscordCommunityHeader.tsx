import type { Community } from "@/features/communities/types";

export function DiscordCommunityHeader({
  community,
}: {
  community: Community | null;
}) {
  return (
    <div
      className="mx-[3px] flex h-13 shrink-0 items-center border-b border-sidebar-border/70 px-3"
      data-testid="discord-community-header"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-sidebar-foreground">
          {community?.name ?? "Buzz"}
        </div>
        <div className="text-xs text-muted-foreground">Server</div>
      </div>
    </div>
  );
}

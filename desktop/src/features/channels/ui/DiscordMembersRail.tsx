import { Bot, Crown, ShieldCheck, UsersRound } from "lucide-react";
import * as React from "react";

import { useChannelMembersQuery } from "@/features/channels/hooks";
import { useClassifiedMembers } from "@/features/channels/lib/useClassifiedMembers";
import { formatMemberName } from "@/features/channels/lib/memberUtils";
import { useChannelWorkingAgentPubkeys } from "@/features/agents/agentWorkingSignal";
import { usePresenceQuery } from "@/features/presence/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import type {
  Channel,
  ChannelMember,
  PresenceStatus,
} from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { UserAvatar } from "@/shared/ui/UserAvatar";

type DiscordMembersRailProps = {
  channel: Channel | null;
  currentPubkey?: string;
  onOpenMembers?: () => void;
};

function presenceDotClass(status: PresenceStatus) {
  if (status === "online") return "bg-emerald-500";
  if (status === "away") return "bg-amber-400";
  return "bg-muted-foreground/35";
}

function MemberRow({
  currentPubkey,
  isAgent,
  member,
  profile,
  status,
  working,
}: {
  currentPubkey?: string;
  isAgent: boolean;
  member: ChannelMember;
  profile: {
    avatarUrl: string | null;
    displayName: string | null;
  } | null;
  status: PresenceStatus;
  working: boolean;
}) {
  const displayName =
    profile?.displayName?.trim() ||
    member.displayName?.trim() ||
    formatMemberName(member, currentPubkey);

  return (
    <div
      className={cn(
        "group flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-sidebar-foreground/75 transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-foreground",
        status === "offline" && !working && "opacity-55 hover:opacity-100",
      )}
      data-testid={`discord-member-${member.pubkey}`}
    >
      <div className="relative shrink-0">
        <UserAvatar
          avatarUrl={profile?.avatarUrl ?? null}
          displayName={displayName}
          size="sm"
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-sidebar",
            working ? "animate-pulse bg-violet-500" : presenceDotClass(status),
          )}
        />
        <span className="sr-only">{status}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium">{displayName}</span>
          {member.role === "owner" ? (
            <Crown
              aria-label="Owner"
              className="h-3 w-3 shrink-0 text-amber-500"
            />
          ) : member.role === "admin" ? (
            <ShieldCheck
              aria-label="Admin"
              className="h-3 w-3 shrink-0 text-sky-500"
            />
          ) : null}
        </div>
        {isAgent ? (
          <div
            className={cn(
              "flex items-center gap-1 text-xs text-muted-foreground",
              working && "font-medium text-violet-500",
            )}
          >
            <Bot className={cn("h-3 w-3", working && "animate-pulse")} />
            <span>
              {working
                ? "Working now"
                : status === "offline"
                  ? "Offline"
                  : "Ready"}
            </span>
          </div>
        ) : member.role === "owner" || member.role === "admin" ? (
          <div className="text-xs capitalize text-muted-foreground">
            {member.role}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MemberGroup({
  currentPubkey,
  isAgent,
  label,
  members,
  presence,
  profiles,
  workingAgentPubkeys,
}: {
  currentPubkey?: string;
  isAgent: boolean;
  label: string;
  members: ChannelMember[];
  presence: Record<string, PresenceStatus> | undefined;
  profiles:
    | Record<
        string,
        {
          avatarUrl: string | null;
          displayName: string | null;
        }
      >
    | undefined;
  workingAgentPubkeys: ReadonlySet<string>;
}) {
  if (members.length === 0) return null;

  return (
    <section>
      <h2 className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label} — {members.length}
      </h2>
      <div className="space-y-0.5">
        {members.map((member) => {
          const pubkey = normalizePubkey(member.pubkey);
          return (
            <MemberRow
              key={member.pubkey}
              currentPubkey={currentPubkey}
              isAgent={isAgent}
              member={member}
              profile={profiles?.[pubkey] ?? null}
              status={presence?.[pubkey] ?? "offline"}
              working={isAgent && workingAgentPubkeys.has(pubkey)}
            />
          );
        })}
      </div>
    </section>
  );
}

export function DiscordMembersRail({
  channel,
  currentPubkey,
  onOpenMembers,
}: DiscordMembersRailProps) {
  const membersQuery = useChannelMembersQuery(channel?.id ?? null);
  const members = membersQuery.data ?? [];
  const { bots, people } = useClassifiedMembers(members, currentPubkey);
  const workingAgentPubkeys = useChannelWorkingAgentPubkeys(channel?.id);
  const workingAgentPubkeySet = React.useMemo(
    () => new Set(workingAgentPubkeys),
    [workingAgentPubkeys],
  );
  const pubkeys = React.useMemo(
    () => members.map((member) => member.pubkey),
    [members],
  );
  const profilesQuery = useUsersBatchQuery(pubkeys);
  const presenceQuery = usePresenceQuery(pubkeys);
  const admins = React.useMemo(
    () =>
      people.filter(
        (member) => member.role === "owner" || member.role === "admin",
      ),
    [people],
  );
  const regularPeople = React.useMemo(
    () =>
      people.filter(
        (member) => member.role !== "owner" && member.role !== "admin",
      ),
    [people],
  );
  const onlinePeople = React.useMemo(
    () =>
      regularPeople.filter(
        (member) =>
          (presenceQuery.data?.[normalizePubkey(member.pubkey)] ??
            "offline") !== "offline",
      ),
    [regularPeople, presenceQuery.data],
  );
  const offlinePeople = React.useMemo(
    () =>
      regularPeople.filter(
        (member) =>
          (presenceQuery.data?.[normalizePubkey(member.pubkey)] ??
            "offline") === "offline",
      ),
    [regularPeople, presenceQuery.data],
  );

  if (!channel || !onOpenMembers) return null;

  return (
    <aside
      aria-label="Channel members"
      className="hidden w-60 shrink-0 flex-col border-l border-sidebar-border/70 bg-sidebar xl:flex"
      data-testid="discord-members-rail"
    >
      <button
        className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border/70 px-4 text-left transition-colors hover:bg-sidebar-accent/70"
        onClick={onOpenMembers}
        type="button"
      >
        <span>
          <span className="block text-sm font-semibold text-sidebar-foreground">
            Members
          </span>
          <span className="block text-xs text-muted-foreground">
            Manage people and roles
          </span>
        </span>
        <UsersRound className="h-4 w-4 text-muted-foreground" />
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {membersQuery.isPending ? (
          <div className="space-y-2 px-2 pt-4">
            {["one", "two", "three", "four", "five"].map((key) => (
              <div
                className="h-8 animate-pulse rounded-md bg-sidebar-accent/70"
                key={key}
              />
            ))}
          </div>
        ) : (
          <>
            <MemberGroup
              currentPubkey={currentPubkey}
              isAgent
              label="Agents"
              members={bots}
              presence={presenceQuery.data}
              profiles={profilesQuery.data?.profiles}
              workingAgentPubkeys={workingAgentPubkeySet}
            />
            <MemberGroup
              currentPubkey={currentPubkey}
              isAgent={false}
              label="Admins"
              members={admins}
              presence={presenceQuery.data}
              profiles={profilesQuery.data?.profiles}
              workingAgentPubkeys={workingAgentPubkeySet}
            />
            <MemberGroup
              currentPubkey={currentPubkey}
              isAgent={false}
              label="Online"
              members={onlinePeople}
              presence={presenceQuery.data}
              profiles={profilesQuery.data?.profiles}
              workingAgentPubkeys={workingAgentPubkeySet}
            />
            <MemberGroup
              currentPubkey={currentPubkey}
              isAgent={false}
              label="Offline"
              members={offlinePeople}
              presence={presenceQuery.data}
              profiles={profilesQuery.data?.profiles}
              workingAgentPubkeys={workingAgentPubkeySet}
            />
          </>
        )}
      </div>
    </aside>
  );
}

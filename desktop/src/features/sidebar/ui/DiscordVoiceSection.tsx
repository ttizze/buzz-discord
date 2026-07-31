import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { useChannelMembersQuery } from "@/features/channels/hooks";
import { canStartHuddleInChannel } from "@/features/channels/lib/huddleAvailability";
import { useHuddle } from "@/features/huddle";
import { HuddleIndicator } from "@/features/huddle/components/HuddleIndicator";
import { buildHuddleChannelName } from "@/features/huddle/lib/huddleChannelName";
import { formatHuddleActionError } from "@/features/huddle/lib/huddleError";
import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

export function pickDiscordVoiceChannel(
  channels: Channel[],
  selectedChannelId: string | null,
): Channel | null {
  const streams = channels.filter(
    (channel) =>
      channel.channelType === "stream" && channel.archivedAt === null,
  );
  return (
    streams.find((channel) => channel.id === selectedChannelId) ??
    streams.find((channel) => channel.name.toLowerCase() === "general") ??
    streams[0] ??
    null
  );
}

export function DiscordVoiceSection({
  channels,
  currentPubkey,
  selectedChannelId,
}: {
  channels: Channel[];
  currentPubkey?: string;
  selectedChannelId: string | null;
}) {
  const channel = React.useMemo(
    () => pickDiscordVoiceChannel(channels, selectedChannelId),
    [channels, selectedChannelId],
  );
  const membersQuery = useChannelMembersQuery(channel?.id ?? null);
  const members = membersQuery.data ?? [];
  const { startHuddle, isStarting } = useHuddle();
  const queryClient = useQueryClient();
  const normalizedCurrentPubkey = currentPubkey
    ? normalizePubkey(currentPubkey)
    : null;
  const selfMember =
    members.find(
      (member) => normalizePubkey(member.pubkey) === normalizedCurrentPubkey,
    ) ?? null;
  const canStart =
    channel !== null &&
    canStartHuddleInChannel({ channel, currentPubkey, selfMember });

  if (!channel) return null;

  return (
    <section
      className="group/sidebar-section select-none px-[3px]"
      data-testid="discord-voice-section"
    >
      <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Voice
      </div>
      <div className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-sidebar-accent">
        <HuddleIndicator
          channelId={channel.id}
          className="h-8 w-8 shrink-0 border-0 bg-transparent shadow-none hover:bg-sidebar-border/40"
          testIdPrefix="discord-voice"
          onStart={async () => {
            try {
              await startHuddle(
                channel.id,
                [],
                buildHuddleChannelName({
                  channel,
                  currentPubkey,
                  members,
                }),
              );
              void queryClient.invalidateQueries({ queryKey: ["channels"] });
            } catch (error) {
              console.error("Failed to start voice room:", error);
              toast.error(formatHuddleActionError(error, "start"));
            }
          }}
          startDisabled={!canStart || isStarting}
          wording="voice-room"
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-sidebar-foreground/85">
            {channel.name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Voice room
          </div>
        </div>
      </div>
    </section>
  );
}

part of '../channel_detail_page.dart';

class _StreamingMessageBubble extends ConsumerWidget {
  final StreamingAgentMessage message;
  final Map<String, String> channelNames;
  final String currentChannelId;

  const _StreamingMessageBubble({
    required this.message,
    required this.channelNames,
    required this.currentChannelId,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pubkey = message.agentPubkey.toLowerCase();
    final profile =
        ref.watch(userCacheProvider.select((cache) => cache[pubkey])) ??
        ref.read(userCacheProvider.notifier).get(pubkey);
    final displayName = profile?.label ?? shortPubkey(message.agentPubkey);

    return Semantics(
      liveRegion: true,
      label: '$displayName is responding',
      child: Padding(
        key: ValueKey('streaming-agent-message-${message.turnId}'),
        padding: const EdgeInsets.only(top: Grid.xs),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _UserAvatar(profile: profile, pubkey: message.agentPubkey),
            const SizedBox(width: messageAvatarContentGap),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: Grid.half),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(bottom: Grid.quarter),
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              displayName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: messageUsernameTextStyle.copyWith(
                                color: context.colors.onSurface,
                              ),
                            ),
                          ),
                          const SizedBox(width: Grid.half),
                          Text(
                            'live',
                            style: messageTimestampTextStyle.copyWith(
                              color: context.colors.primary,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Flexible(
                          child: MessageContent(
                            content: message.text,
                            mentionNames: const {},
                            agentMentionPubkeys: const {},
                            channelNames: channelNames,
                            tags: const [],
                            baseStyle: messageBodyTextStyle.copyWith(
                              color: context.colors.onSurface,
                            ),
                            scaleEmojiOnly: false,
                            onChannelTap: (channelId) {
                              openChannelLink(
                                context: context,
                                ref: ref,
                                channelId: channelId,
                                currentChannelId: currentChannelId,
                              );
                            },
                            onMentionTap: (mentionedPubkey) =>
                                showUserProfileSheet(context, mentionedPubkey),
                          ),
                        ),
                        const SizedBox(width: Grid.quarter),
                        Padding(
                          padding: const EdgeInsets.only(bottom: 3),
                          child: Container(
                            width: 2,
                            height: 16,
                            decoration: BoxDecoration(
                              color: context.colors.primary,
                              borderRadius: BorderRadius.circular(Radii.sm),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

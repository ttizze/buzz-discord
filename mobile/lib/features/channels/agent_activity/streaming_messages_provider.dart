import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'observer_models.dart';
import 'observer_subscription.dart';

/// An in-progress assistant message reconstructed from encrypted ACP observer
/// chunks. It is transient UI state and is never added to message history.
@immutable
class StreamingAgentMessage {
  final String agentPubkey;
  final String turnId;
  final String text;
  final DateTime startedAt;

  const StreamingAgentMessage({
    required this.agentPubkey,
    required this.turnId,
    required this.text,
    required this.startedAt,
  });
}

class _StreamingMessageAccumulator {
  final String turnId;
  final DateTime startedAt;
  String text = '';
  String? _messageId;
  bool _sealed = false;

  _StreamingMessageAccumulator({required this.turnId, required this.startedAt});

  void addChunk(String messageId, String chunk) {
    if (_sealed || _messageId != messageId) {
      text = chunk;
      _messageId = messageId;
      _sealed = false;
      return;
    }
    text += chunk;
  }

  void seal() {
    _sealed = true;
  }
}

String _extractObserverText(dynamic content) {
  if (content is Map) {
    final text = content['text'];
    return text is String ? text : '';
  }
  if (content is List) {
    return content
        .whereType<Map>()
        .map((item) => item['text'])
        .whereType<String>()
        .join();
  }
  return '';
}

/// Reconstruct active assistant text for one channel from observer frames.
/// Completed and failed turns are removed immediately, leaving the relay's
/// durable signed message as the canonical history row.
List<StreamingAgentMessage> buildStreamingAgentMessages(
  Map<String, List<ObserverFrame>> framesByAgent,
  String channelId,
) {
  final result = <StreamingAgentMessage>[];

  for (final entry in framesByAgent.entries) {
    final activeTurns = <String, _StreamingMessageAccumulator>{};
    for (final frame in entry.value) {
      if (frame.channelId != channelId) continue;
      final turnId = frame.turnId;
      if (turnId == null || turnId.isEmpty) continue;

      if (frame.kind == 'turn_started') {
        activeTurns[turnId] = _StreamingMessageAccumulator(
          turnId: turnId,
          startedAt:
              DateTime.tryParse(frame.timestamp) ??
              DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        );
        continue;
      }
      if (frame.kind == 'turn_completed' || frame.kind == 'turn_error') {
        activeTurns.remove(turnId);
        continue;
      }
      if (frame.kind != 'acp_read') continue;

      final accumulator = activeTurns[turnId];
      if (accumulator == null) continue;
      final payload = frame.payload;
      if (payload is! Map) continue;
      final params = payload['params'];
      if (params is! Map) continue;
      final update = params['update'];
      if (update is! Map) {
        continue;
      }
      if (update['sessionUpdate'] != 'agent_message_chunk') {
        accumulator.seal();
        continue;
      }
      final messageId = update['messageId'];
      accumulator.addChunk(
        messageId is String ? messageId : turnId,
        _extractObserverText(update['content']),
      );
    }

    for (final accumulator in activeTurns.values) {
      final text = accumulator.text;
      if (text.isEmpty) continue;
      result.add(
        StreamingAgentMessage(
          agentPubkey: entry.key,
          turnId: accumulator.turnId,
          text: text,
          startedAt: accumulator.startedAt,
        ),
      );
    }
  }

  result.sort((a, b) => a.startedAt.compareTo(b.startedAt));
  return List.unmodifiable(result);
}

final streamingAgentMessagesProvider =
    Provider.family<List<StreamingAgentMessage>, String>((ref, channelId) {
      final relayState = ref.watch(observerRelayProvider);
      return buildStreamingAgentMessages(relayState.framesByAgent, channelId);
    });

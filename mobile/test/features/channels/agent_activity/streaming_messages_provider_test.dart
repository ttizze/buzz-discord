import 'package:buzz/features/channels/agent_activity/observer_models.dart';
import 'package:buzz/features/channels/agent_activity/streaming_messages_provider.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('combines active assistant chunks for the selected channel', () {
    final messages = buildStreamingAgentMessages({
      'agent-a': [
        _frame(seq: 1, kind: 'turn_started'),
        _chunk(seq: 2, content: {'text': 'Hello '}),
        _chunk(
          seq: 3,
          content: [
            {'type': 'text', 'text': 'world'},
          ],
        ),
      ],
    }, 'channel-a');

    expect(messages, hasLength(1));
    expect(messages.single.agentPubkey, 'agent-a');
    expect(messages.single.turnId, 'turn-a');
    expect(messages.single.text, 'Hello world');
  });

  test('removes completed and failed turns', () {
    final completed = buildStreamingAgentMessages({
      'agent-a': [
        _frame(seq: 1, kind: 'turn_started'),
        _chunk(seq: 2, content: {'text': 'Working'}),
        _frame(seq: 3, kind: 'turn_completed'),
      ],
    }, 'channel-a');
    final failed = buildStreamingAgentMessages({
      'agent-a': [
        _frame(seq: 1, kind: 'turn_started'),
        _chunk(seq: 2, content: {'text': 'Working'}),
        _frame(seq: 3, kind: 'turn_error'),
      ],
    }, 'channel-a');

    expect(completed, isEmpty);
    expect(failed, isEmpty);
  });

  test('shows only the newest assistant segment after a tool update', () {
    final messages = buildStreamingAgentMessages({
      'agent-a': [
        _frame(seq: 1, kind: 'turn_started'),
        _chunk(seq: 2, content: {'text': 'I will check.'}),
        _update(seq: 3, updateType: 'tool_call'),
        _chunk(seq: 4, content: {'text': 'Here is the result.'}),
      ],
    }, 'channel-a');

    expect(messages.single.text, 'Here is the result.');
  });

  test('ignores frames from another channel', () {
    final messages = buildStreamingAgentMessages({
      'agent-a': [
        _frame(seq: 1, kind: 'turn_started', channelId: 'channel-b'),
        _chunk(seq: 2, content: {'text': 'Not here'}, channelId: 'channel-b'),
      ],
    }, 'channel-a');

    expect(messages, isEmpty);
  });
}

ObserverFrame _chunk({
  required int seq,
  required dynamic content,
  String channelId = 'channel-a',
}) => ObserverFrame(
  seq: seq,
  timestamp: '2026-08-01T00:00:0${seq}Z',
  kind: 'acp_read',
  channelId: channelId,
  turnId: 'turn-a',
  payload: {
    'method': 'session/update',
    'params': {
      'update': {'sessionUpdate': 'agent_message_chunk', 'content': content},
    },
  },
);

ObserverFrame _frame({
  required int seq,
  required String kind,
  String channelId = 'channel-a',
}) => ObserverFrame(
  seq: seq,
  timestamp: '2026-08-01T00:00:0${seq}Z',
  kind: kind,
  channelId: channelId,
  turnId: 'turn-a',
  payload: const {},
);

ObserverFrame _update({required int seq, required String updateType}) =>
    ObserverFrame(
      seq: seq,
      timestamp: '2026-08-01T00:00:0${seq}Z',
      kind: 'acp_read',
      channelId: 'channel-a',
      turnId: 'turn-a',
      payload: {
        'method': 'session/update',
        'params': {
          'update': {'sessionUpdate': updateType},
        },
      },
    );

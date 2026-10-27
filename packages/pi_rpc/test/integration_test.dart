@Tags(['integration'])
library;

import 'dart:io';

import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

/// Talks to a real `pi --mode rpc` process from `runtime/`. Makes no model
/// calls unless PI_RPC_LIVE_MODEL is set (e.g. `cc-switch-deep-seek/deepseek-flash`).
void main() {
  final config = PiRuntimeLocator.defaultConfig(
    workingDirectory: Directory.systemTemp.createTempSync('pi_rpc_it_').path,
    searchRoots: [Directory.current.path],
    extraArgs: ['--no-session'],
  );
  final liveModel = Platform.environment['PI_RPC_LIVE_MODEL'];

  late PiRpcClient client;

  setUp(() async => client = await PiRpcClient.launch(config!));
  tearDown(() => client.dispose());

  test('queries state, models, levels and commands', () async {
    final state = await client.getState();
    expect(state.sessionId, isNotEmpty);
    expect(state.isStreaming, isFalse);
    expect(await client.getAvailableModels(), isNotEmpty);
    expect(await client.getAvailableThinkingLevels(), contains('off'));
    await client.getCommands();
    expect(await client.getMessages(), isEmpty);
  });

  test('rejects an unknown model with a readable error', () async {
    await expectLater(client.setModel('nope', 'nope'), throwsA(isA<PiRpcException>()));
  });

  test('new_session resets the session id', () async {
    final before = (await client.getState()).sessionId;
    expect(await client.newSession(), isTrue);
    expect((await client.getState()).sessionId, isNot(before));
  });

  test('dispose shuts the process down', () async {
    await client.dispose();
    expect(client.isClosed, isTrue);
  });

  test('live prompt streams into a transcript and settles', () async {
    final slash = liveModel!.indexOf('/');
    await client.setModel(liveModel.substring(0, slash), liveModel.substring(slash + 1));
    final transcript = Transcript();
    // Register the transcript first: firstWhere resumes this test synchronously
    // when it matches, before later listeners have seen the same event.
    client.events.listen(transcript.apply);
    final settled = client.events.firstWhere((e) => e is AgentSettledEvent);

    expect(await client.prompt('Reply with exactly the word: pong'), PromptDisposition.started);
    await settled.timeout(const Duration(minutes: 2));

    final reply = transcript.items.whereType<AssistantItem>().last;
    expect(reply.parts.whereType<TextPart>().map((p) => p.text).join().toLowerCase(), contains('pong'));
    expect(transcript.isRunning, isFalse);
    expect((await client.getSessionStats()).totalTokens, greaterThan(0));
  }, skip: liveModel == null ? 'set PI_RPC_LIVE_MODEL to run' : false, timeout: const Timeout(Duration(minutes: 3)));
}

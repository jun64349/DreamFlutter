@Tags(['core'])
library;

import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

/// Starts the real core (Node) on temp directories and drives a session
/// through [launchInCore], the path the desktop app uses.
void main() {
  late Directory temp;
  late CoreClient core;

  setUpAll(() async {
    temp = await Directory.systemTemp.createTemp('df-core-dart-');
    core = await CoreLocator.ensureRunning(
      searchRoots: [Directory.current.path],
      dataDir: p.join(temp.path, 'data'),
      extraArgs: ['--agent-dir', p.join(temp.path, 'agent'), '--session-dir', p.join(temp.path, 'sessions')],
    );
  });

  tearDownAll(() async {
    try {
      await core.call('core.shutdown');
    } catch (_) {}
    await core.closed.timeout(const Duration(seconds: 10), onTimeout: () {});
    await Future<void>.delayed(const Duration(milliseconds: 300));
    try {
      await temp.delete(recursive: true);
    } catch (_) {}
  });

  test('hello reports the core version and no slots', () async {
    final hello = asJsonForTest(await core.call('core.hello'));
    expect(hello['version'], '0.1.1');
    expect(hello['slots'], isEmpty);
  });

  test('a second ensureRunning connects to the same core', () async {
    final again = await CoreLocator.ensureRunning(searchRoots: [Directory.current.path], dataDir: p.join(temp.path, 'data'));
    final hello = asJsonForTest(await again.call('core.hello'));
    expect(hello['pid'], asJsonForTest(await core.call('core.hello'))['pid']);
    await again.close();
  });

  test('opens a session slot and speaks Pi RPC through it', () async {
    final workspace = await Directory(p.join(temp.path, 'ws')).create();
    final launched = launchInCore(core, SessionTarget(cwd: workspace.path));
    await launched.ready;
    final client = launched.client;
    final state = await client.getState();
    expect(state.sessionFile, isNotNull);
    expect(p.isWithin(p.join(temp.path, 'sessions'), state.sessionFile!), isTrue);
    expect(await client.getMessages(), isEmpty);
    expect(await client.getAvailableThinkingLevels(), isA<List<String>>());

    final slots = await core.call('slot.list') as List;
    expect(slots, hasLength(1));
    final slotId = launched.slotId!()!;

    // Detaching (closing the client) leaves the session running in the core.
    await client.dispose();
    expect(await core.call('slot.list') as List, hasLength(1));

    // Re-attach and see the same session.
    final attached = launchInCore(core, SessionTarget(cwd: workspace.path, attachSlotId: slotId));
    await attached.ready;
    expect((await attached.client.getState()).sessionFile, state.sessionFile);

    // Opening the same file again reuses the live slot instead of a second runtime.
    final reopened = launchInCore(core, SessionTarget(cwd: workspace.path, sessionPath: state.sessionFile));
    await reopened.ready;
    expect(reopened.slotId!(), slotId);

    await core.call('slot.close', {'slotId': slotId});
    expect(await core.call('slot.list') as List, isEmpty);
    expect(await attached.client.connection.done, 0);
  });
}

Map<String, dynamic> asJsonForTest(Object? value) => (value as Map).cast<String, dynamic>();

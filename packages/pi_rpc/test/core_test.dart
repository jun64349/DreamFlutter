@Tags(['core'])
library;

import 'dart:io';
import 'dart:convert';

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
    expect(hello['version'], '0.5.0');
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

  test('side creation passes quote and parent without incognito; private parent returns willPersist false', () async {
    final workspace = await Directory(p.join(temp.path, 'side-ws')).create();
    final path = p.join(temp.path, 'sessions', 'source.jsonl');
    await File(path).writeAsString(jsonEncode({'type': 'session', 'version': 3, 'id': 'source', 'timestamp': '2026-11-06T00:00:00.000Z', 'cwd': workspace.path}) + '\n');
    final launched = launchInCore(core, SessionTarget(cwd: workspace.path, forkOf: path, sideQuote: 'quoted', quoteEntryId: 'entry'));
    await launched.ready;
    final slotId = launched.slotId!()!;
    final info = (await core.call('slot.list') as List).cast<Map>().firstWhere((r) => r['slotId'] == slotId);
    expect(info['sessionType'], 'side'); expect(info['willPersist'], isTrue); expect(info['sessionFile'], isNull);
    final entries = await launched.client.send('get_entries') as Map;
    final marker = (entries['entries'] as List).cast<Map>().firstWhere((e) => e['customType'] == 'df.sideConversation');
    expect((marker['data'] as Map)['quote'], 'quoted'); expect((marker['data'] as Map)['quoteEntryId'], 'entry');
    await core.call('slot.close', {'slotId': slotId});
    await launched.client.dispose();
    final parent = launchInCore(core, SessionTarget(cwd: workspace.path, incognito: true));
    await parent.ready;
    final side = launchInCore(core, SessionTarget(cwd: workspace.path, parentSlotId: parent.slotId!()!, sideQuote: 'private'));
    await side.ready;
    final privateInfo = (await core.call('slot.list') as List).cast<Map>().firstWhere((r) => r['slotId'] == side.slotId!()!);
    expect(privateInfo['willPersist'], isFalse); expect(privateInfo['incognito'], isTrue);
    await core.call('slot.close', {'slotId': side.slotId!()!}); await side.client.dispose();
    await core.call('slot.close', {'slotId': parent.slotId!()!}); await parent.client.dispose();
  });

  // v0.4.0: the user's first start after the update took 22 s; the window gave up at 20 s with the core alive.
  group('starting the core', () {
    Future<Directory> emptyDir(String name) => Directory(p.join(temp.path, name)).create();

    test('waits for a core that is still starting, past the first checks', () async {
      final dir = await emptyDir('late');
      // The running core "comes up" in this data dir after 3 s.
      Future<void>.delayed(const Duration(seconds: 3), () => File(p.join(temp.path, 'data', 'core.json')).copySync(p.join(dir.path, 'core.json')));
      final client = await CoreLocator.waitForStart(dir.path, 1234, isAlive: (_) async => true, startTimeout: const Duration(seconds: 30));
      expect(asJsonForTest(await client.call('core.hello'))['version'], '0.5.0');
      await client.close();
    });

    test('a core that exited is reported at once, not after the whole wait', () async {
      final dir = await emptyDir('exited');
      final watch = Stopwatch()..start();
      await expectLater(
        CoreLocator.waitForStart(dir.path, 1234, isAlive: (_) async => false, startTimeout: const Duration(minutes: 1)),
        throwsA(isA<CoreException>().having((e) => e.code, 'code', 'start_failed').having((e) => e.message, 'message', contains('core.log'))),
      );
      expect(watch.elapsed, lessThan(const Duration(seconds: 10)));
    });

    test('ours stepping aside for another core that holds the lock keeps the wait going', () async {
      final dir = await emptyDir('aside');
      File(p.join(dir.path, 'core.lock')).writeAsStringSync('4242');
      await expectLater(
        CoreLocator.waitForStart(dir.path, 1234, isAlive: (pid) async => pid == 4242, startTimeout: const Duration(seconds: 5)),
        throwsA(isA<CoreException>().having((e) => e.code, 'code', 'start_timeout')),
      );
    });

    test('a live process is told apart from a gone one', () async {
      expect(await CoreLocator.processAlive(pid), isTrue);
      expect(await CoreLocator.processAlive(999999), isFalse);
    });
  });
}

Map<String, dynamic> asJsonForTest(Object? value) => (value as Map).cast<String, dynamic>();

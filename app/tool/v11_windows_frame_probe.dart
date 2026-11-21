// Run from app/ in a Windows profile build. See docs/testing/v1.1-windows-frames.md.
import 'dart:async';
import 'dart:convert';
import 'dart:developer';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/keys.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';

import '../test/fake_backend.dart';

Future<void> main() async {
  final output = Platform.environment['DF_WINDOWS_FRAME_PROBE_JSON'];
  final data = Platform.environment['DREAMFLUTTER_DATA'];
  if (!Platform.isWindows || !kProfileMode || output == null || data == null) {
    throw StateError('Use a Windows profile build and set both output and isolated data paths.');
  }
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    _write(output, {'error': details.exceptionAsString(), 'stack': details.stack.toString()});
    exit(1);
  };
  try {
    final root = Directory(data)..createSync(recursive: true);
    // FakePi reads the recorded RPC fixture relative to app/. It does not
    // launch a backend or use the installed program's data.
    final workspace = Directory(p.join(root.path, 'workspace'))..createSync();
    final sessions = Directory(p.join(root.path, 'sessions'))..createSync();
    WidgetsFlutterBinding.ensureInitialized();
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1400, 900));
    await windowManager.setTitle('DreamFlutter Windows frame probe');
    HeldKeys.askWindows = false;
    // The measurement uses the same isolated preferences as the UI tests.
    // ignore: invalid_use_of_visible_for_testing_member
    SharedPreferences.setMockInitialValues({
      'workspace': workspace.path,
      'onboarded': true,
      'migratedToCore': true,
      'themeMode': 'light',
    });
    final backend = FakeBackend();
    backend.onLaunch = (pi) => pi.sessionFile = p.join(sessions.path, 'profile-session.jsonl');
    final agent = AgentController(
      preferences: await Preferences.load(),
      backend: backend,
      sessionStore: SessionStore(sessionsDir: sessions.path),
    );
    runApp(DreamFlutterApp(controller: agent));
    await agent.init();
    final pi = backend.pis.single;
    await _pause(1600);

    final sampler = _Sampler();
    final home = await sampler.capture(() => _pause(3400));

    for (var turn = 0; turn < 80; turn++) {
      pi.startRun('第 ${turn + 1} 轮，请核对这段会话记录。');
      final message = _reply(turn + 2, _history);
      pi.emit({'type': 'message_start', 'message': message});
      pi.emit({'type': 'message_end', 'message': message});
      pi.finishRun();
    }
    await _pause(1800);
    if (agent.transcript.items.length != 160) {
      throw StateError('Expected 160 history items, got ${agent.transcript.items.length}.');
    }
    final sectionSwitches = await sampler.capture(() async {
      for (var i = 0; i < 5; i++) {
        agent.showSection(AppSection.settings);
        await _pause(450);
        agent.showSection(AppSection.chat);
        await _pause(450);
      }
    });

    pi.startRun('请边输出边检查输入响应。');
    final timestamp = 100;
    pi.emit({'type': 'message_start', 'message': _reply(timestamp, '')});
    pi.emit({'type': 'message_update', 'assistantMessageEvent': {'type': 'text_start', 'contentIndex': 0}});
    await _pause(600);
    final input = _editable();
    input.requestKeyboard();
    await _pause(350);
    final inputDelays = <int>[];
    final text = List.filled(7, _section).join('\n\n').replaceAll('§', '```');
    final streamed = await sampler.capture(() async {
      for (var offset = 0, chunk = 0; offset < text.length; offset += 26, chunk++) {
        pi.emit({
          'type': 'message_update',
          'assistantMessageEvent': {
            'type': 'text_delta',
            'contentIndex': 0,
            'delta': text.substring(offset, (offset + 26).clamp(0, text.length)),
          },
        });
        if (chunk % 12 == 0) {
          // Time from applying a keyboard editing value to the Dart frame
          // end. This does not measure OS input delivery or display scanout.
          final watch = Stopwatch()..start();
          final draft = '核对草稿 ${chunk ~/ 12 + 1}';
          input.userUpdateTextEditingValue(
            TextEditingValue(text: draft, selection: TextSelection.collapsed(offset: draft.length)),
            SelectionChangedCause.keyboard,
          );
          await SchedulerBinding.instance.endOfFrame;
          inputDelays.add(watch.elapsedMicroseconds);
        }
        await _pause(32);
      }
      pi.emit({'type': 'message_end', 'message': _reply(timestamp, text)});
      pi.finishRun();
      await _pause(350);
    });
    final last = agent.transcript.items.whereType<AssistantItem>().last;
    if (last.parts.whereType<TextPart>().map((part) => part.text).join() != text || agent.isRunning) {
      throw StateError('The expected stream did not finish on screen.');
    }
    final view = WidgetsBinding.instance.platformDispatcher.views.single;
    _write(output, {
      'mode': 'profile',
      'viewportPhysicalPx': [view.physicalSize.width, view.physicalSize.height],
      'devicePixelRatio': view.devicePixelRatio,
      'reportedRefreshRate': view.display.refreshRate,
      'zoom': agent.zoom,
      'historyItems': 160,
      'streamCharacters': text.length,
      'streamChunkCharacters': 26,
      'streamChunkDelayMs': 32,
      'externalModelCalls': 0,
      'home': home,
      'settingsSwitches': sectionSwitches,
      'conversationStream': streamed,
      'inputFrameUs': inputDelays,
      'inputFrameSummaryUs': _summary(inputDelays),
    });
    agent.dispose();
    await windowManager.destroy();
  } catch (error, stack) {
    _write(output, {'error': '$error', 'stack': '$stack'});
    exit(1);
  }
}

EditableTextState _editable() {
  EditableTextState? result;
  void visit(Element element, {bool inComposer = false}) {
    final composer = inComposer || element.widget.key == const ValueKey('composer-input');
    if (composer && element is StatefulElement && element.state is EditableTextState) {
      result = element.state as EditableTextState;
      return;
    }
    if (result == null) element.visitChildElements((child) => visit(child, inComposer: composer));
  }
  WidgetsBinding.instance.rootElement?.visitChildElements(visit);
  return result ?? (throw StateError('Workbench composer missing.'));
}

Future<void> _pause(int ms) => Future<void>.delayed(Duration(milliseconds: ms));

void _write(String output, Map<String, Object?> value) {
  File(output).writeAsStringSync('${const JsonEncoder.withIndent('  ').convert(value)}\n');
}

Json _reply(int timestamp, String text) => {
  'role': 'assistant',
  'content': [{'type': 'text', 'text': text}],
  'stopReason': 'stop',
  'timestamp': timestamp,
};

const _history = '### 验证记录\n\n结果已写入工作区。先复核抽样结果，再对照之前的说明。\n\n'
    '- 核对不同输入的处理情况\n- 保留原始日志\n- 记录边界结果';

const _section = '''
### Compare the recorded results

Use the same workload and record the time, repetition count, and outcome.
保留窗口内看到的结果，并检查记录是否与预期一致。

- Compare the pending and finished stages.
- Confirm the selection, spacing, and scrolling behavior.

§text
input: sample records
output: one row for each run
§

| Stage | Result |
| --- | --- |
| First pass | Ready |
| Recheck | Done |
''';

class _Sampler {
  Future<Map<String, Object>> capture(Future<void> Function() workload) async {
    final frames = <ui.FrameTiming>[];
    final scheduler = SchedulerBinding.instance;
    void record(List<ui.FrameTiming> batch) => frames.addAll(batch);
    // Engine callbacks batch measurements. Include the trailing batch before
    // detaching and exclude it from the elapsed workload time.
    scheduler.addTimingsCallback(record);
    final begin = Timeline.now;
    late int end;
    try {
      await workload();
    } finally {
      end = Timeline.now;
      await _pause(1200);
      scheduler.removeTimingsCallback(record);
    }
    int startUs(ui.FrameTiming frame) => frame.timestampInMicroseconds(ui.FramePhase.vsyncStart);
    frames.removeWhere((frame) => startUs(frame) < begin || startUs(frame) >= end);
    if (frames.isEmpty) throw StateError('No engine FrameTiming samples.');
    final build = [for (final frame in frames) frame.buildDuration.inMicroseconds];
    final raster = [for (final frame in frames) frame.rasterDuration.inMicroseconds];
    final span = [for (final frame in frames) frame.totalSpan.inMicroseconds];
    final start = [for (final frame in frames) startUs(frame)];
    final gaps = [for (var i = 1; i < start.length; i++) start[i] - start[i - 1]];
    return {
      'elapsedMs': (end - begin) ~/ 1000,
      'frames': frames.length,
      'buildUs': _summary(build),
      'rasterUs': _summary(raster),
      'totalSpanUs': _summary(span),
      'vsyncGapUs': _summary(gaps),
      'over16_7ms': {
        'build': build.where((us) => us > 16667).length,
        'raster': raster.where((us) => us > 16667).length,
        'totalSpan': span.where((us) => us > 16667).length,
      },
      'rawUs': [
        for (var i = 0; i < start.length; i++)
          [start[i] - start.first, build[i], raster[i], span[i]],
      ],
    };
  }
}

Map<String, int> _summary(List<int> values) {
  if (values.isEmpty) return const {};
  final sorted = [...values]..sort();
  int percentile(double p) => sorted[(p * sorted.length).ceil() - 1];
  return {'p50': percentile(.5), 'p95': percentile(.95), 'p99': percentile(.99), 'max': sorted.last};
}

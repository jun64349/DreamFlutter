import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/library_page.dart' show LibraryPage;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;

  var memories = <Json>[];
  var candidates = <Json>[];
  var proposals = <Json>[];

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 2400));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    sessions = Directory.systemTemp.createTempSync('df_library_');
    backend = FakeBackend();
    memories = [
      {'id': 'm1', 'scope': 'global', 'kind': 'preference', 'content': '回答用中文，先给结论', 'source': 'user', 'status': 'active', 'updatedAt': 1},
    ];
    candidates = [
      {'id': 'c1', 'scope': 'global', 'kind': 'background', 'content': '用户在杭州工作', 'source': 'agent', 'status': 'candidate', 'action': 'add', 'reason': '对话里提到', 'updatedAt': 2},
    ];
    proposals = [
      {
        'id': 'p1',
        'title': 'weekly-report',
        'createdAt': 3,
        'payload': {'name': 'weekly-report', 'description': '写周报', 'content': '---\nname: weekly-report\n---\n\n步骤', 'scope': 'user'},
      },
    ];
    backend.handlers.addAll({
      'memory.list': (p) => p['status'] == 'candidate' ? candidates : memories,
      'memory.blocks': (_) => [
        {'key': 'about_me', 'title': '关于我', 'content': '', 'locked': false},
        {'key': 'preferences', 'title': '偏好与习惯', 'content': '', 'locked': true},
        {'key': 'agreements', 'title': '当前约定', 'content': '', 'locked': false},
      ],
      'memory.acceptPending': (p) {
        candidates = [];
        return {'ok': true};
      },
      'proposals.list': (_) => proposals,
      'proposals.accept': (_) {
        proposals = [];
        return {'path': 'x'};
      },
      'skills.list': (_) => [
        {'name': 'pdf-tools', 'description': '处理 PDF', 'filePath': r'C:\skills\pdf-tools\SKILL.md', 'scope': 'user', 'enabled': true},
      ],
      'templates.list': (_) => [
        {
          'name': '周报',
          'description': '整理周报',
          'body': '把 {{文件}} 整理成周报',
          'params': [
            {'name': '文件'},
          ],
        },
      ],
      'templates.command': (p) => {'command': '/周报 "${(p['values'] as Map)['文件']}"'},
    });
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
  }

  tearDown(() {
    agent.dispose();
    sessions.deleteSync(recursive: true);
  });

  testWidgets('the rail shows pending counts and the memory page confirms candidates', (tester) async {
    await startApp(tester);
    await settle(tester);
    expect(agent.pendingMemories, 1);
    expect(agent.pendingProposals, 1);

    await tester.tap(find.byTooltip(RegExp('^记忆')));
    await settle(tester);
    // Candidates open first while there are any.
    expect(find.text('用户在杭州工作'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '同意').first);
    await settle(tester);
    expect(backend.callsTo('memory.acceptPending').single, {'id': 'c1'});
    expect(find.text('用户在杭州工作'), findsNothing);

    await tester.tap(find.text('记忆库'));
    await settle(tester);
    expect(find.text('回答用中文，先给结论'), findsOneWidget);

    // Add a memory through the dialog.
    await tester.tap(find.text('添加记忆'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, '周报每周五交');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存').last);
    await settle(tester);
    expect(backend.callsTo('memory.save').single, {'content': '周报每周五交', 'kind': 'preference', 'scope': 'global', 'cwd': null});

    // Editing a block enables its save button.
    await tester.tap(find.text('常驻记忆块'));
    await settle(tester);
    expect(find.text('偏好与习惯'), findsOneWidget);
    expect(find.text('已锁定'), findsOneWidget);
    final blockField = find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').startsWith('例如：我叫'));
    await tester.enterText(blockField, '我是产品经理');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存').first);
    await settle(tester);
    expect(backend.callsTo('memory.setBlock').single, {'key': 'about_me', 'content': '我是产品经理'});
  });

  testWidgets('skills, templates and proposals', (tester) async {
    await startApp(tester);
    await settle(tester);
    await tester.tap(find.byTooltip(RegExp('^技能')));
    await settle(tester);

    // Pending proposals open first.
    expect(find.text('等你确认的技能'), findsOneWidget);
    await tester.tap(find.text('保存技能'));
    await settle(tester);
    expect(backend.callsTo('proposals.accept').single, {'id': 'p1'});

    await tester.tap(find.descendant(of: find.byType(LibraryPage), matching: find.text('技能')));
    await settle(tester);
    expect(find.text('pdf-tools'), findsOneWidget);
    await tester.tap(find.byType(Switch).first);
    await settle(tester);
    expect(backend.callsTo('skills.setEnabled').single, {'filePath': r'C:\skills\pdf-tools\SKILL.md', 'enabled': false});

    await tester.tap(find.descendant(of: find.byType(LibraryPage), matching: find.text('任务模板')));
    await settle(tester);
    expect(find.text('/周报'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, '运行'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'a.md');
    await tester.tap(find.widgetWithText(FilledButton, '运行').last);
    await settle(tester);
    expect(backend.callsTo('templates.command').single, {
      'name': '周报',
      'values': {'文件': 'a.md'},
    });
    expect(agent.section, AppSection.chat, reason: 'running a template goes back to the chat');
    expect(backend.pis.single.sent('prompt').single, contains(r'/周报 \"a.md\"'));
  });

  testWidgets('a memory.changed event refreshes the badges', (tester) async {
    await startApp(tester);
    await settle(tester);
    candidates = [];
    backend.push({'event': 'memory.changed'});
    await settle(tester);
    expect(agent.pendingMemories, 0);
  });

  testWidgets('MCP section shows provenance, tests one service and grants butterfly separately', (tester) async {
    await startApp(tester);
    backend.handlers['mcp.list'] = (_) => {
      'servers': [
        {
          'name': 'docs',
          'scope': 'user',
          'source': r'C:\data\pi\mcp.json',
          'enabled': true,
          'trust': 'trusted',
          'sourceKind': 'community',
          'sourceUrl': 'https://example.invalid/docs',
          'usageCount': 7,
          'url': 'https://example.invalid/mcp',
          'butterflyAllowed': false,
        },
      ],
    };
    backend.handlers['mcp.test'] = (_) => {
      'ok': true,
      'durationMs': 34,
      'tools': ['search', 'read'],
      'errors': [],
    };
    await tester.tap(find.byTooltip(RegExp('^技能')));
    await settle(tester);
    await tester.tap(find.text('MCP 服务'));
    await settle(tester);
    expect(find.textContaining('社区安装 · 已信任 · 使用 7 次'), findsOneWidget);
    expect(find.textContaining('https://example.invalid/docs'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, '测试'));
    await settle(tester);
    expect(backend.callsTo('mcp.test').single, {'name': 'docs', 'source': r'C:\data\pi\mcp.json', 'cwd': agent.workspace});
    expect(find.text('测试通过'), findsOneWidget);
    expect(find.textContaining('search、read'), findsOneWidget);
    await tester.tap(find.text('关闭'));
    await settle(tester);
    await tester.tap(find.byType(Switch).first);
    await settle(tester);
    expect(backend.callsTo('mcp.setEnabled').single, {'name': 'docs', 'enabled': false});
    await tester.tap(find.byType(Switch).last);
    await settle(tester);
    expect(backend.callsTo('mcp.setButterflyAllowed').single['allowed'], true);
    expect(backend.callsTo('mcp.setButterflyAllowed').single['name'], 'docs');
  });

  testWidgets('MCP proposals are confirmed through the shared pending queue', (tester) async {
    await startApp(tester);
    proposals = [
      {
        'id': 'mcp1',
        'kind': 'mcp',
        'title': 'docs',
        'createdAt': 4,
        'payload': {'name': 'docs', 'content': '{"url":"https://example.invalid/mcp"}', 'sourceKind': 'agent'},
      },
    ];
    await tester.tap(find.byTooltip(RegExp('^技能')));
    await settle(tester);
    expect(find.text('等你确认的技能与 MCP'), findsOneWidget);
    expect(find.textContaining('Agent 建立 · 未信任'), findsOneWidget);
    expect(find.text('修改后保存'), findsNothing);
    await tester.tap(find.text('确认 MCP'));
    await settle(tester);
    expect(backend.callsTo('proposals.accept').single, {'id': 'mcp1'});
  });

  testWidgets('skill static check explains that scripts have not run', (tester) async {
    await startApp(tester);
    backend.handlers['skills.test'] = (_) => {
      'ok': true,
      'durationMs': 2,
      'errors': [],
      'scriptTrial': {'reason': '仅静态检查，脚本没有执行'},
    };
    await tester.tap(find.byTooltip(RegExp('^技能')));
    await settle(tester);
    await tester.tap(find.descendant(of: find.byType(LibraryPage), matching: find.text('技能')));
    await settle(tester);
    await tester.tap(find.text('检查'));
    await settle(tester);
    expect(backend.callsTo('skills.test').single, {'filePath': r'C:\skills\pdf-tools\SKILL.md'});
    expect(find.textContaining('脚本没有执行'), findsOneWidget);
  });

  testWidgets('builtin skills show read-only origin and copy into a user skill', (tester) async {
    await startApp(tester);
    backend.handlers['skills.list'] = (_) => [
      {
        'name': 'skill-builder',
        'description': '创建技能',
        'filePath': r'C:\app\core\assets\skills\skill-builder\SKILL.md',
        'scope': 'builtin',
        'sourceKind': 'builtin',
        'trust': 'trusted',
        'enabled': true,
        'readOnly': true,
        'usageCount': 1,
      },
    ];
    backend.handlers['skills.copyBuiltin'] = (_) => {'path': r'C:\data\pi\skills\custom-builder\SKILL.md'};
    await tester.tap(find.byTooltip(RegExp('^技能')));
    await settle(tester);
    await tester.tap(find.descendant(of: find.byType(LibraryPage), matching: find.text('技能')));
    await settle(tester);
    expect(find.text('随版本更新 · 修改请先复制为用户技能'), findsOneWidget);
    expect(find.textContaining('内置 · 已信任'), findsOneWidget);
    await tester.tap(find.byTooltip('操作').first);
    await tester.pumpAndSettle();
    expect(find.text('删除'), findsNothing);
    await tester.tap(find.text('复制为用户技能'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'custom-builder');
    await tester.tap(find.widgetWithText(FilledButton, '复制').last);
    await settle(tester);
    expect(backend.callsTo('skills.copyBuiltin').single, {'filePath': r'C:\app\core\assets\skills\skill-builder\SKILL.md', 'name': 'custom-builder'});
  });

  for (final brightness in Brightness.values) {
    testWidgets('MCP narrow surface at 150% in ${brightness.name}', (tester) async {
      await tester.binding.setSurfaceSize(const Size(820, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      sessions = Directory.systemTemp.createTempSync('df_t73_visual_');
      backend = FakeBackend();
      backend.handlers['skills.list'] = (_) => <Json>[];
      backend.handlers['templates.list'] = (_) => <Json>[];
      backend.handlers['proposals.list'] = (_) => <Json>[];
      backend.handlers['mcp.list'] = (_) => {
        'servers': [
          {
            'name': 'knowledge-library',
            'description': '查询资料库并读取相关文档',
            'scope': 'user',
            'source': r'C:\data\pi\mcp.json',
            'sourceKind': 'community',
            'sourceUrl': 'https://example.invalid/knowledge-library',
            'url': 'https://example.invalid/mcp',
            'trust': 'trusted',
            'enabled': true,
            'usageCount': 12,
            'lastUsedAt': 1794110400000,
            'butterflyAllowed': false,
          },
          {'name': 'workspace-notes', 'description': '尚未获得信任的条目', 'scope': 'user', 'sourceKind': 'agent', 'trust': 'untrusted', 'enabled': false, 'usageCount': 0},
        ],
      };
      agent = AgentController(
        preferences: await Preferences.load(),
        sessionStore: SessionStore(sessionsDir: sessions.path),
        backend: backend,
      )..workspace = sessions.path;
      const capture = bool.fromEnvironment('T73_CAPTURE');
      if (capture) {
        await tester.runAsync(() async {
          for (final entry in {
            'T73Capture': 'C:/Windows/Fonts/msyh.ttc',
            'SimSun': 'C:/Windows/Fonts/simsun.ttc',
            'Noto Serif SC': 'C:/Windows/Fonts/simsun.ttc',
            'MaterialIcons': 'E:/dev/flutter/bin/cache/artifacts/material_fonts/materialicons-regular.otf',
          }.entries) {
            final loader = FontLoader(entry.key)..addFont(Future.value(ByteData.sublistView(await File(entry.value).readAsBytes())));
            await loader.load();
          }
        });
      }
      final theme = buildTheme(brightness);
      await tester.pumpWidget(
        AgentScope(
          controller: agent,
          child: MaterialApp(
            theme: capture ? theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'T73Capture')) : theme,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
              child: child!,
            ),
            home: const Scaffold(body: LibraryPage()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('MCP 服务'));
      await tester.pumpAndSettle();
      expect(find.text('允许蝶君使用'), findsNWidgets(2));
      expect(tester.takeException(), isNull);
      if (capture) await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T73-mcp-${brightness.name}-150.png'));
    });
  }
}

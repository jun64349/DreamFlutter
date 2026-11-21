import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/ui/gateway_pages.dart';
import 'package:dreamflutter/ui/home_page.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 't88_fixture.dart';

void main() {
  testWidgets('ordinary startup reaches channel settings without a model or sandbox', (t) async {
    final f = (await t.runAsync(() => T88Fixture.create(fresh: true)))!;
    await t.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() async {
      await t.pumpWidget(const SizedBox());
      await t.runAsync(f.dispose);
      await t.binding.setSurfaceSize(null);
    });
    final visibility = <bool>[];
    await t.pumpWidget(DreamFlutterApp(
      controller: f.agent,
      home: SetupGate(dataRoot: f.root.path, initialStep: 2, onSetupVisible: visibility.add),
    ));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, '称呼'), '小周');
    await t.tap(find.text('下一步'));
    await t.pumpAndSettle();
    expect(find.text('常用的项目文件夹'), findsOneWidget);
    expect(find.text('连接一个模型'), findsNothing);
    await t.tap(find.text('跳过'));
    await t.pumpAndSettle();

    expect(find.byType(HomePage), findsOneWidget);
    expect(find.byType(SetupWizard), findsNothing);
    expect(f.agent.onboarded, isTrue);
    expect(f.agent.gatewayChannels, isEmpty);
    expect(f.agent.model, isNull);
    expect(visibility, [true, false]);
    expect(f.backend.callsTo('setup.complete').single, {
      'dataRoot': f.root.path, 'userName': '小周', 'defaultWorkspace': null,
    });
    for (final method in ['gateway.saveChannel', 'setup.testChannel', 'setup.recommendModels', 'persona.presets', 'sandbox.provision']) {
      expect(f.backend.callsTo(method), isEmpty, reason: method);
    }

    await t.tap(find.byTooltip('设置'));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const ValueKey('settings-nav-模型')));
    await t.pumpAndSettle();
    final add = find.text('添加渠道');
    await t.ensureVisible(add);
    await t.tap(add);
    await t.pumpAndSettle();
    expect(find.byType(ChannelEditorPage), findsOneWidget);
  });
}

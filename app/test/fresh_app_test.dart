import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:dreamflutter/ui/window_frame.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 0.13.1 step 3: a new installation's first screen uses the app's own frame (title strip, default
/// zoom and text size), so it looks like the wizard after it. It once painted grey: the title strip read
/// the controller, which does not exist yet on that screen.
void main() {
  testWidgets('the first-run screen renders inside the app frame without errors', (t) async {
    await t.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(FreshApp(home: FreshInstallation(initialRoot: r'C:\df-test\data', launch: (_) async {})));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.byType(AppTitleBar), findsOneWidget);
    expect(find.text('开始'), findsOneWidget);
    // The window buttons' tooltips need the overlay above the navigator.
    await t.longPress(find.byType(AppTitleBar).first, warnIfMissed: false);
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    await t.tap(find.text('开始'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
  });
}

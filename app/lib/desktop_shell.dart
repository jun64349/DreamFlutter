import 'dart:async';

import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'state/agent_controller.dart';
import 'state/desktop_notifications.dart';
import 'ui/attention_page.dart';

/// Window and tray behaviour: closing the window hides it to the tray while
/// the core keeps running sessions and schedules; the tray menu reopens the
/// window or quits (optionally stopping the core too).
class DesktopShell with WindowListener, TrayListener {
  DesktopShell(this.controller, {this.confirmExit, this.chooseCloseBehavior});

  final AgentController controller;
  final Future<bool> Function()? confirmExit;
  final Future<String?> Function()? chooseCloseBehavior;
  StreamSubscription<dynamic>? _events;
  bool _closing = false;
  bool _handlingClose = false;
  late final _notifications=DesktopNotifications((target,origin)async{await _show();await openAttentionTarget(controller,target,origin);});

  Future<void> init({bool startHidden = false}) async {
    await windowManager.ensureInitialized();
    // Our own title strip (ui/title_strip.dart) replaces the white system one;
    // the window keeps its resize edges and snapping.
    await windowManager.setTitleBarStyle(TitleBarStyle.hidden, windowButtonVisibility: false);
    await windowManager.setPreventClose(true);
    windowManager.addListener(this);
    await trayManager.setIcon('assets/tray_icon.ico');
    await trayManager.setToolTip('DreamFlutter（后台运行中）');
    await trayManager.setContextMenu(
      Menu(
        items: [
          MenuItem(key: 'show', label: '打开 DreamFlutter'),
          MenuItem.separator(),
          MenuItem(key: 'quit_all', label: '退出'),
        ],
      ),
    );
    trayManager.addListener(this);
    try { await _notifications.init(); } catch (_) { /* The window still runs if Windows disables notifications. */ }
    _events = controller.backend.events.listen((event) {
      if (event['event'] == 'updates.closeWindow') unawaited(_quit(stopCore: false, updating: true));
      if (event['event'] == 'notification' && event['title'] is String) {
        unawaited(_notifications.receive(event).catchError((Object _) {}));
      }
    });
    controller.setWindowFocused(!startHidden && await windowManager.isFocused());
    if (startHidden) unawaited(Future<void>.delayed(const Duration(milliseconds: 500), () => windowManager.hide()));
  }

  Future<void> _show() async {
    await windowManager.show();
    await windowManager.focus();
  }

  Future<void> _quit({required bool stopCore, bool updating = false}) async {
    if (_closing) return;
    _closing = true;
    if (stopCore && !updating) {
      var busy = false;
      try { final state = await controller.backend.call('core.activity'); busy = state is Map && (state['count'] as num? ?? 0)>0; final exit = await controller.backend.call('app.exitState'); busy = busy || exit is Map && exit['busy']==true; } catch (_) { busy = busy || [...controller.runtimes, ...?controller.butterfly?.runtimes].any((runtime) => runtime.isRunning); }
      if (busy && !(await confirmExit?.call() ?? false)) { _closing = false; return; }
    }
    await controller.flushGardenDeletes();
    if (stopCore) await controller.shutdownCore();
    await _events?.cancel();
    await _notifications.dispose();
    windowManager.removeListener(this);
    trayManager.removeListener(this);
    await trayManager.destroy();
    await windowManager.setPreventClose(false);
    // close(), not destroy(): destroy() posts WM_QUIT, so the engine was torn down after the
    // message loop had ended and crashed in flutter_windows.dll on every exit (E-01). close()
    // goes WM_CLOSE → WM_DESTROY → engine shutdown → PostQuitMessage, the template's own path.
    await windowManager.close();
  }

  @override
  void onWindowFocus() => controller.setWindowFocused(true);

  @override
  void onWindowBlur() => controller.setWindowFocused(false);

  @override
  void onWindowClose() {
    if (_handlingClose || _closing) return;
    _handlingClose = true;
    unawaited(() async {
      try {
        var choice = controller.preferences.closeBehaviorChoice;
        if (choice == null) {
          choice = await chooseCloseBehavior?.call();
          if (choice == null) return;
          await controller.preferences.setCloseBehaviorChoice(choice);
          try { await controller.updateCoreSettings({'closeBehavior': choice}); } catch (_) {}
        }
        if (choice == 'quit') {
          await _quit(stopCore: true);
        } else {
          controller.setWindowFocused(false);
          await windowManager.hide();
        }
      } finally {
        _handlingClose = false;
      }
    }());
  }

  @override
  void onTrayIconMouseDown() => unawaited(_show());

  @override
  void onTrayIconRightMouseDown() => unawaited(trayManager.popUpContextMenu());

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'show':
        unawaited(_show());
      case 'quit':
        unawaited(_quit(stopCore: false));
      case 'quit_all':
        unawaited(_quit(stopCore: true));
    }
  }
}

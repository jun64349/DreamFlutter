import 'dart:async';

import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'state/agent_controller.dart';

/// Window and tray behaviour: closing the window hides it to the tray while
/// the core keeps running sessions and schedules; the tray menu reopens the
/// window or quits (optionally stopping the core too).
class DesktopShell with WindowListener, TrayListener {
  DesktopShell(this.controller, {this.confirmExit});

  final AgentController controller;
  final Future<bool> Function()? confirmExit;
  StreamSubscription<dynamic>? _events;
  bool _closing = false;

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
          MenuItem(key: 'quit', label: '退出窗口（后台任务继续）'),
          MenuItem(key: 'quit_all', label: '退出并停止后台'),
        ],
      ),
    );
    trayManager.addListener(this);
    _events = controller.backend.events.listen((event) {
      if (event['event'] == 'updates.closeWindow') unawaited(_quit(stopCore: false, updating: true));
    });
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
      try { final state = await controller.backend.call('app.exitState'); busy = state is Map && state['busy'] == true; } catch (_) { busy = controller.runtimes.any((runtime) => runtime.isRunning); }
      if (busy && !(await confirmExit?.call() ?? false)) { _closing = false; return; }
    }
    if (stopCore) await controller.shutdownCore();
    await _events?.cancel();
    await trayManager.destroy();
    await windowManager.setPreventClose(false);
    await windowManager.destroy();
  }

  @override
  void onWindowClose() {
    if (controller.coreSettings['closeBehavior'] == 'quit') { unawaited(_quit(stopCore: true)); return; }
    unawaited(() async {
      await windowManager.hide();
      if (!controller.preferences.trayHintShown) {
        await controller.preferences.setTrayHintShown();
        try {
          await controller.backend.call('core.notify', {
            'title': 'DreamFlutter 仍在后台运行',
            'body': '正在进行的任务和定时任务会继续。点任务栏右下角的图标可以重新打开窗口或完全退出。',
          });
        } catch (_) {}
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

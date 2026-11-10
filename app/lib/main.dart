import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';

import 'desktop_shell.dart';
import 'state/agent_controller.dart';
import 'state/file_preferences_store.dart';
import 'state/preferences.dart';
import 'state/installation.dart';
import 'theme.dart';
import 'ui/agent_scope.dart';
import 'ui/home_page.dart';
import 'ui/web_surface.dart';
import 'ui/window_frame.dart';
import 'ui/zoom.dart';
import 'ui/close_window_dialog.dart';
import 'ui/setup_wizard.dart';
import 'update_bootstrap.dart';

/// Shown in the settings page.
const appVersion = String.fromEnvironment('DREAMFLUTTER_VERSION', defaultValue: '0.7.0');
const appBuild = String.fromEnvironment('DREAMFLUTTER_BUILD', defaultValue: '11');

Future<void> main([List<String> args = const []]) async {
  WidgetsFlutterBinding.ensureInitialized();
  if (await bootstrapUpdate(Installation.dataRoot(), appVersion, () => startApplication(args))) return;
  await startApplication(args);
}

Future<void> startApplication(List<String> args) async {
  LicenseRegistry.addLicense(() async* {
    yield LicenseEntryWithLineBreaks([
      'Ma Shan Zheng',
    ], await rootBundle.loadString('assets/fonts/OFL-MaShanZheng.txt'));
  });
  // Everything the window keeps goes to the app's data folder too (v0.3.2), next to the core's.
  final dataDir = Installation.dataRoot();
  if (!Installation.hasData(dataDir)) {
    runApp(MaterialApp(title:'DreamFlutter',debugShowCheckedModeBanner:false,theme:buildTheme(Brightness.light),darkTheme:buildTheme(Brightness.dark),home:FreshInstallation(initialRoot:dataDir,launch:(root)=>launchApplication(args,root,initialStep:2))));
    return;
  }
  await launchApplication(args,dataDir);
}

Future<void> launchApplication(List<String> args,String dataDir,{int initialStep=0}) async {
  final appData = Platform.environment['APPDATA'];
  SharedPreferencesStorePlatform.instance = await FilePreferencesStore.open(
    p.join(dataDir, 'window', 'prefs.json'),
    legacy: appData == null ? null : p.join(appData, 'com.dreamflutter', 'dreamflutter', 'shared_preferences.json'),
  );
  WebSurfaces.userDataFolder = p.join(dataDir, 'webview2');
  final controller = AgentController(preferences: await Preferences.load(),backend:CoreBackend(dataDir:dataDir),sessionStore:SessionStore(sessionsDir:SessionStore.defaultSessionsDir(dataDir)));
  final navigatorKey = GlobalKey<NavigatorState>();
  await DesktopShell(controller, confirmExit: () async {
    final context = navigatorKey.currentContext;
    if (context == null) return false;
    return await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: const Text('退出并停止后台？'), content: const Text('还有对话或记忆任务正在进行。退出会停止这些任务。'),
      actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('继续运行')), FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('退出程序'))],
    )) ?? false;
    },
    chooseCloseBehavior: () async {
      final context = navigatorKey.currentContext;
      if (context == null) return null;
      return chooseWindowCloseBehavior(context);
  }).init(startHidden: args.contains('--start-hidden'));
  final setupVisible=ValueNotifier(true);
  runApp(DreamFlutterApp(controller: controller,setupVisible:setupVisible, ownTitleBar: true, navigatorKey: navigatorKey,home:SetupGate(dataRoot:dataDir,initialStep:initialStep,onSetupVisible:(visible)=>setupVisible.value=visible)));
  // Connect after the first frame, so the UI can answer a trust prompt.
  WidgetsBinding.instance.addPostFrameCallback((_) => controller.init());
}

class DreamFlutterApp extends StatelessWidget {
  const DreamFlutterApp({super.key, required this.controller, this.ownTitleBar = false, this.navigatorKey,this.home,this.setupVisible});

  final Widget? home;
  final ValueListenable<bool>? setupVisible;

  final GlobalKey<NavigatorState>? navigatorKey;

  final AgentController controller;

  /// The system title bar is hidden: [AppTitleBar] drags the window and has its buttons (the real window; tests leave them off).
  final bool ownTitleBar;

  @override
  Widget build(BuildContext context) {
    return AgentScope(
      controller: controller,
      child: ValueListenableBuilder(
        valueListenable: controller.appearance,
        builder: (context, appearance, _) {
          return MaterialApp(
            navigatorKey: navigatorKey,
            title: 'DreamFlutter',
            debugShowCheckedModeBanner: false,
            theme: buildTheme(Brightness.light, painting: PaintingTheme.byId(appearance.lightTheme, Brightness.light)),
            darkTheme: buildTheme(Brightness.dark, painting: PaintingTheme.byId(appearance.darkTheme, Brightness.dark)),
            themeMode: appearance.themeMode,
            themeAnimationDuration: MediaQuery.maybeDisableAnimationsOf(context) == true ? Duration.zero : AppTokens.medium, themeAnimationCurve: AppTokens.curve,
            builder: (context, child) {
              final app = AppZoom(controller: controller, zoom: appearance.zoom, textScale: appearance.textScale, child: child!);
              // The title bar stays the same size when the interface is zoomed, and is on every page;
              // its own overlay holds its menus and tooltips (it is above the navigator).
              return Overlay.wrap(
                child: Column(
                  children: [
                    if(setupVisible!=null)ValueListenableBuilder<bool>(valueListenable:setupVisible!,builder:(context,visible,_)=>AppTitleBar(windowButtons:ownTitleBar,brandOnly:visible)) else AppTitleBar(windowButtons:ownTitleBar,brandOnly:home is SetupWizard || home is FreshInstallation),
                    Expanded(child: app),
                  ],
                ),
              );
            },
            home: home ?? const HomePage(),
          );
        },
      ),
    );
  }
}

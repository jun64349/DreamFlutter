import 'package:flutter/material.dart';

import 'desktop_shell.dart';
import 'state/agent_controller.dart';
import 'state/preferences.dart';
import 'theme.dart';
import 'ui/agent_scope.dart';
import 'ui/home_page.dart';
import 'ui/title_strip.dart';
import 'ui/zoom.dart';

/// Shown in the settings page.
const appVersion = '0.3.1';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AgentController(preferences: await Preferences.load());
  await DesktopShell(controller).init();
  runApp(DreamFlutterApp(controller: controller, ownTitleBar: true));
  // Connect after the first frame, so the UI can answer a trust prompt.
  WidgetsBinding.instance.addPostFrameCallback((_) => controller.init());
}

class DreamFlutterApp extends StatelessWidget {
  const DreamFlutterApp({super.key, required this.controller, this.ownTitleBar = false});

  final AgentController controller;

  /// The system title bar is hidden and [TitleStrip] takes its place (the real window; tests leave it off).
  final bool ownTitleBar;

  @override
  Widget build(BuildContext context) {
    return AgentScope(
      controller: controller,
      child: ValueListenableBuilder(
        valueListenable: controller.appearance,
        builder: (context, appearance, _) {
          return MaterialApp(
            title: 'DreamFlutter',
            debugShowCheckedModeBanner: false,
            theme: buildTheme(Brightness.light, painting: PaintingTheme.byId(appearance.lightTheme, Brightness.light)),
            darkTheme: buildTheme(Brightness.dark, painting: PaintingTheme.byId(appearance.darkTheme, Brightness.dark)),
            themeMode: appearance.themeMode,
            builder: (context, child) {
              final app = AppZoom(controller: controller, zoom: appearance.zoom, textScale: appearance.textScale, child: child!);
              if (!ownTitleBar) return app;
              // The strip stays the same size when the interface is zoomed.
              return Column(
                children: [
                  const TitleStrip(),
                  Expanded(child: app),
                ],
              );
            },
            home: const HomePage(),
          );
        },
      ),
    );
  }
}

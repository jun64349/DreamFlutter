import 'package:flutter/material.dart';

import 'desktop_shell.dart';
import 'state/agent_controller.dart';
import 'state/preferences.dart';
import 'theme.dart';
import 'ui/agent_scope.dart';
import 'ui/home_page.dart';

/// Shown in the settings page.
const appVersion = '0.1.1';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AgentController(preferences: await Preferences.load());
  await DesktopShell(controller).init();
  runApp(DreamFlutterApp(controller: controller));
  // Connect after the first frame, so the UI can answer a trust prompt.
  WidgetsBinding.instance.addPostFrameCallback((_) => controller.init());
}

class DreamFlutterApp extends StatelessWidget {
  const DreamFlutterApp({super.key, required this.controller});

  final AgentController controller;

  @override
  Widget build(BuildContext context) {
    return AgentScope(
      controller: controller,
      child: ValueListenableBuilder(
        valueListenable: controller.appearance,
        builder: (context, appearance, _) {
          final (themeMode, textScale) = appearance;
          return MaterialApp(
            title: 'DreamFlutter',
            debugShowCheckedModeBanner: false,
            theme: buildTheme(Brightness.light),
            darkTheme: buildTheme(Brightness.dark),
            themeMode: themeMode,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
              child: child!,
            ),
            home: const HomePage(),
          );
        },
      ),
    );
  }
}

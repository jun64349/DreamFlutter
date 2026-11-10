import 'dart:async';

import 'package:flutter/material.dart';

import '../state/agent_controller.dart';
import 'agent_scope.dart';
import 'butterfly_page.dart';
import 'chat_view.dart';
import 'extension_dialogs.dart';
import 'library_page.dart';
import 'memory_page.dart';
import 'rich_blocks.dart';
import 'sidebar.dart';
import 'attention_page.dart';
import 'dashboard_page.dart';
import 'settings_page.dart';
import 'shell_widgets.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  StreamSubscription<String>? _toasts;

  /// Pages opened at least once (kept alive afterwards).
  final _visited = <AppSection>{};

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    _toasts ??= agent.toasts.listen((message) {
      if (!mounted) return;
      // At the top, centred and only as wide as the message needs (v0.3.1 test 1).
      final size = MediaQuery.sizeOf(context);
      final width = (message.length * 13.0 + 48).clamp(200.0, 560.0);
      final side = ((size.width - width) / 2).clamp(16.0, double.infinity);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(message, textAlign: TextAlign.center),
          behavior: SnackBarBehavior.floating,
          dismissDirection: DismissDirection.up,
          margin: EdgeInsets.fromLTRB(side, 12, side, (size.height - 120).clamp(12.0, double.infinity)),
        ),
      );
    });
  }

  @override
  void dispose() {
    _toasts?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    _visited.add(agent.section);
    RichRenderer.configure((agent.coreInfo['port'] as num?)?.toInt());
    return ExtensionDialogHost(
      child: LayoutBuilder(builder: (context, constraints) {
        final narrow = constraints.maxWidth < 760;
        final pages = ShellPageMotion(
          page: agent.section,
          child: IndexedStack(index: agent.section.index, sizing: StackFit.expand, children: [
            TickerMode(enabled: agent.section == AppSection.chat, child: const ChatView()),
            _visited.contains(AppSection.butterfly) ? TickerMode(enabled: agent.section == AppSection.butterfly, child: const ButterflyPage()) : const SizedBox(),
            _visited.contains(AppSection.tasks) ? const AttentionPage() : const SizedBox(),
            _visited.contains(AppSection.memory) ? TickerMode(enabled: agent.section == AppSection.memory, child: const MemoryPage()) : const SizedBox(),
            _visited.contains(AppSection.library) ? TickerMode(enabled: agent.section == AppSection.library, child: const LibraryPage()) : const SizedBox(),
            _visited.contains(AppSection.spending) ? const DashboardPage() : const SizedBox(),
            _visited.contains(AppSection.settings) ? const SettingsPage() : const SizedBox(),
          ]),
        );
        return Scaffold(
          drawer: narrow ? Drawer(width: 254, backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest, child: const SafeArea(child: Sidebar())) : null,
          body: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (!narrow) const Sidebar(),
            Expanded(child: Column(children: [
              if (narrow) Align(alignment: Alignment.centerLeft, child: Builder(builder: (context) => IconButton(
                tooltip: '打开侧栏', onPressed: () => Scaffold.of(context).openDrawer(), icon: const Icon(Icons.menu, size: 20),
              ))),
              Expanded(child: pages),
            ])),
          ]),
        );
      }),
    );
  }
}

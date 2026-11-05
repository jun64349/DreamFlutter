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
import 'tasks_page.dart';

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
      child: Scaffold(
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // One sidebar for every page (0.4): the old icon rail's places are in it.
            const Sidebar(),
            Expanded(
              child: IndexedStack(
                index: agent.section.index,
                sizing: StackFit.expand,
                children: [
                  const ChatView(),
                  // Built on first visit, so their data loads when opened.
                  _visited.contains(AppSection.butterfly) ? const ButterflyPage() : const SizedBox(),
                  _visited.contains(AppSection.tasks) ? const TasksPage() : const SizedBox(),
                  _visited.contains(AppSection.memory) ? const MemoryPage() : const SizedBox(),
                  _visited.contains(AppSection.library) ? const LibraryPage() : const SizedBox(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}


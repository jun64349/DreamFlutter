import 'dart:async';

import 'package:flutter/material.dart';

import 'agent_scope.dart';
import 'chat_view.dart';
import 'extension_dialogs.dart';
import 'sidebar.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  StreamSubscription<String>? _toasts;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    _toasts ??= agent.toasts.listen((message) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message), behavior: SnackBarBehavior.floating, width: 520),
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
    return const ExtensionDialogHost(
      child: Scaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Sidebar(),
          VerticalDivider(width: 0.5),
          Expanded(child: ChatView()),
        ],
      ),
      ),
    );
  }
}

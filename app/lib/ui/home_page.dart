import 'dart:async';

import 'package:flutter/material.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'chat_view.dart';
import 'desk_page.dart';
import 'extension_dialogs.dart';
import 'library_page.dart';
import 'memory_page.dart';
import 'settings_page.dart';
import 'sidebar.dart';
import 'tasks_page.dart';
import 'zoom.dart';

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
    final agent = AgentScope.of(context);
    _visited.add(agent.section);
    return ExtensionDialogHost(
      child: Scaffold(
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _NavRail(),
            const VerticalDivider(width: 0.5),
            Expanded(
              child: IndexedStack(
                index: agent.section.index,
                sizing: StackFit.expand,
                children: [
                  const Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Sidebar(),
                      VerticalDivider(width: 0.5),
                      Expanded(child: ChatView()),
                    ],
                  ),
                  // Built on first visit, so their data loads when opened.
                  _visited.contains(AppSection.desk) ? const DeskPage() : const SizedBox(),
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

/// The far-left navigation: chat, memory, skills and templates, settings.
class _NavRail extends StatelessWidget {
  const _NavRail();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    Widget item(AppSection section, IconData icon, IconData selectedIcon, String label, {int badge = 0, bool dot = false}) {
      final selected = agent.section == section;
      return _NavButton(
        icon: selected ? selectedIcon : icon,
        label: label,
        selected: selected,
        badge: badge,
        dot: dot,
        onTap: () => agent.showSection(section),
      );
    }

    return Container(
      width: 64,
      color: colors.sidebar,
      padding: const EdgeInsets.symmetric(vertical: AppTokens.padLg),
      child: Column(
        children: [
          Icon(Icons.auto_awesome_outlined, size: 22, color: Theme.of(context).colorScheme.primary),
          const SizedBox(height: AppTokens.padLg),
          item(AppSection.chat, Icons.chat_bubble_outline, Icons.chat_bubble, '对话', dot: agent.backgroundRunning > 0 && agent.section != AppSection.chat),
          item(AppSection.desk, Icons.edit_note_outlined, Icons.edit_note, '书桌'),
          item(AppSection.tasks, Icons.task_alt_outlined, Icons.task_alt, '任务', badge: agent.pendingInbox),
          item(AppSection.memory, Icons.psychology_alt_outlined, Icons.psychology_alt, '记忆', badge: agent.pendingMemories),
          item(AppSection.library, Icons.auto_stories_outlined, Icons.auto_stories, '技能', badge: agent.pendingProposals),
          const Spacer(),
          _NavButton(
            icon: Icons.text_fields,
            label: '外观',
            selected: false,
            onTap: () => showAppearanceDialog(context),
          ),
          _NavButton(
            icon: Icons.settings_outlined,
            label: '设置',
            selected: false,
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SettingsPage())),
          ),
        ],
      ),
    );
  }
}

class _NavButton extends StatelessWidget {
  const _NavButton({required this.icon, required this.label, required this.selected, required this.onTap, this.badge = 0, this.dot = false});

  final IconData icon;
  final String label;
  final bool selected;
  final int badge;
  final bool dot;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = selected ? scheme.primary : context.colors.muted;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Semantics(
        button: true,
        selected: selected,
        label: label,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppTokens.radius),
          onTap: onTap,
          child: SizedBox(
            width: 52,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
                    decoration: BoxDecoration(
                      color: selected ? scheme.primary.withValues(alpha: 0.12) : null,
                      borderRadius: BorderRadius.circular(AppTokens.radiusLg),
                    ),
                    child: Badge(
                      isLabelVisible: badge > 0 || dot,
                      smallSize: 7,
                      label: badge > 0 ? Text('$badge') : null,
                      child: Icon(icon, size: 20, color: color),
                    ),
                  ),
                  const SizedBox(height: 2),
                  ExcludeSemantics(child: Text(label, style: context.text.labelSmall?.copyWith(color: color))),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

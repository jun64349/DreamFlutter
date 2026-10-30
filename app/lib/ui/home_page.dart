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
import 'usage_page.dart';
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
            Expanded(
              child: IndexedStack(
                index: agent.section.index,
                sizing: StackFit.expand,
                children: [
                  const Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Sidebar(),
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

/// The far-left navigation: the butterfly, the five places, and below them
/// the dashboard, appearance and settings.
class _NavRail extends StatelessWidget {
  const _NavRail();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
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

    void push(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

    return Container(
      width: AppTokens.railWidth,
      color: context.colors.rail,
      padding: const EdgeInsets.fromLTRB(0, 18, 0, 14),
      child: Column(
        children: [
          const Tooltip(message: 'DreamFlutter · 梦蝶', child: ButterflyMark(size: 36, semanticLabel: 'DreamFlutter')),
          const SizedBox(height: 18),
          item(AppSection.chat, Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, '对话', dot: agent.backgroundRunning > 0 && agent.section != AppSection.chat),
          item(AppSection.desk, Icons.edit_note_outlined, Icons.edit_note, '书桌'),
          item(AppSection.tasks, Icons.task_alt_outlined, Icons.task_alt, '任务', badge: agent.pendingInbox),
          item(AppSection.memory, Icons.lightbulb_outline, Icons.lightbulb, '记忆', badge: agent.pendingMemories),
          item(AppSection.library, Icons.auto_stories_outlined, Icons.auto_stories, '技能', badge: agent.pendingProposals),
          const Spacer(),
          _NavButton(icon: Icons.bar_chart_rounded, label: '仪表盘', selected: false, onTap: () => push(const UsagePage())),
          _NavButton(icon: Icons.text_fields, label: '外观', selected: false, onTap: () => showAppearanceDialog(context)),
          _NavButton(icon: Icons.settings_outlined, label: '设置', selected: false, onTap: () => push(const SettingsPage())),
        ],
      ),
    );
  }
}

class _NavButton extends StatefulWidget {
  const _NavButton({required this.icon, required this.label, required this.selected, required this.onTap, this.badge = 0, this.dot = false});

  final IconData icon;
  final String label;
  final bool selected;
  final int badge;
  final bool dot;
  final VoidCallback onTap;

  @override
  State<_NavButton> createState() => _NavButtonState();
}

class _NavButtonState extends State<_NavButton> {
  var _hovered = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final selected = widget.selected;
    final color = selected ? colors.accent : (_hovered ? colors.ink : colors.muted);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Semantics(
        button: true,
        selected: selected,
        label: widget.label,
        child: MouseRegion(
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() => _hovered = false),
          child: InkWell(
            borderRadius: BorderRadius.circular(AppTokens.radius),
            onTap: widget.onTap,
            child: AnimatedContainer(
              duration: AppTokens.fast,
              width: 56,
              padding: const EdgeInsets.fromLTRB(0, 8, 0, 6),
              decoration: BoxDecoration(
                color: selected ? colors.accentSoft : (_hovered ? colors.accentSoft.withValues(alpha: 0.4) : null),
                borderRadius: BorderRadius.circular(AppTokens.radius),
              ),
              child: Column(
                children: [
                  Badge(
                    isLabelVisible: widget.badge > 0 || widget.dot,
                    smallSize: 7,
                    backgroundColor: colors.ochre,
                    label: widget.badge > 0 ? Text('${widget.badge}') : null,
                    child: Icon(widget.icon, size: 20, color: color),
                  ),
                  const SizedBox(height: 3),
                  ExcludeSemantics(child: Text(widget.label, style: TextStyle(fontSize: 11, color: color))),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

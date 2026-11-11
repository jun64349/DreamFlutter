import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'motion.dart';
import 'conversation_actions.dart';
import 'artifact_widgets.dart';
import 'window_frame.dart';
import 'shell_widgets.dart';

/// The one sidebar of the window (0.4, design option 3): 工作台 / 蝶君 at the
/// top with new conversation, search and tasks; the conversations of the
/// current workspace (or 蝶君's on its page); memory, skills, dashboard,
/// appearance and settings at the bottom. Its width is dragged on its right edge.
class Sidebar extends StatefulWidget {
  const Sidebar({super.key});

  @override
  State<Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<Sidebar> {
  /// The width while it is being dragged (saved when the drag ends).
  double? _width;
  final _searching = true;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final section = agent.section;
    final onButterfly = agent.butterflySpace;
    // Whose conversations are listed: 蝶君's on its page, the workbench's everywhere else.
    final AgentController? lists = onButterfly ? agent.butterfly : agent;
    final usable = agent.status != ConnectionStatus.missingRuntime;
    final width = (_width ?? agent.sidebarWidth).clamp(
      180.0,
      MediaQuery.sizeOf(context).width * 0.36,
    );

    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          width: width,
          color: colors.sidebar,
          child: LayoutBuilder(
            builder: (context, constraints) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
                  child: _PlaceSwitch(
                    butterfly: onButterfly,
                    workbench: !onButterfly,
                    onWorkbench: () => agent.showSection(AppSection.chat),
                    onButterfly: () => agent.openButterfly(),
                    butterflyBusy: (agent.butterfly?.backgroundRunning ?? 0) + ((agent.butterfly?.isRunning ?? false) ? 1 : 0) > 0 && !onButterfly,
                    workbenchBusy: agent.backgroundRunning > 0 && section != AppSection.chat,
                  ),
                ),
                if (!onButterfly)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(8, 0, 8, 6),
                    child: SidebarWorkspaceButton(),
                  ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _NavRow(
                        icon: Icons.add,
                        label: '新对话',
                        onTap: usable && lists != null
                            ? () {
                                lists.newSession();
                                agent.showSection(onButterfly ? AppSection.butterfly : AppSection.chat);
                                if (onButterfly) agent.butterflyTab.value = ButterflyTab.talk;
                              }
                            : null,
                      ),
                      _NavRow(
                        icon: Icons.inbox_outlined,
                        label: '等你处理',
                        selected: section == AppSection.tasks,
                        badge: shellPendingCount(agent) == 0 ? null : '${shellPendingCount(agent)}',
                        onTap: () => agent.showSection(AppSection.tasks),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    // 0.8.3 (user test): 蝶君's side lists its conversations like the workbench — a click opens
                    // one from any page; what needs you is in 「等你处理」, not on the list.
                    child: lists == null
                        ? Padding(
                            padding: const EdgeInsets.all(10),
                            child: const SizedBox.shrink(),
                          )
                        : AgentScope(
                            controller: lists,
                            child: _SessionPane(
                              key: ValueKey(lists.sandbox),
                              searching: _searching,
                              onCloseSearch: () {},
                            ),
                            ),
                  )),
                Divider(height: 1, thickness: 0.5, color: colors.border),
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
                  child: Row(
                    children: [
                      _FootButton(
                        icon: Icons.lightbulb_outline,
                        label: '记忆',
                        selected: section == AppSection.memory,
                        badge: agent.pendingMemories,
                        onTap: () => agent.showSection(AppSection.memory),
                      ),
                      _FootButton(
                        icon: Icons.edit_outlined,
                        label: '技能',
                        selected: section == AppSection.library,
                        badge: agent.pendingProposals,
                        onTap: () => agent.showSection(AppSection.library),
                      ),
                      _FootButton(icon: Icons.monetization_on_outlined, label: '花费',
                        selected: section == AppSection.spending, onTap: () => agent.showSection(AppSection.spending),
                      ),
                      _FootButton(icon: Icons.settings_outlined, label: '设置',
                        selected: section == AppSection.settings,
                        onTap: () => agent.showSection(AppSection.settings)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        Container(width: 0.5, color: colors.border),
        // Dragged here: the sidebar's width (Preferences.sidebarWidths).
        Transform.translate(
          offset: const Offset(-3, 0),
          child: ResizeHandle(
            width: width,
            min: Preferences.sidebarWidths.min,
            max: Preferences.sidebarWidths.max,
            onChanged: (w) => setState(() => _width = w),
            onDone: (w) async {
              await agent.setSidebarWidth(w);
              if (mounted) setState(() => _width = null);
            },
          ),
        ),
      ],
    );
  }
}

/// 工作台 | 蝶君, the two places to work, with a dot when the other one is busy.
class _PlaceSwitch extends StatelessWidget {
  const _PlaceSwitch({
    required this.workbench,
    required this.butterfly,
    required this.onWorkbench,
    required this.onButterfly,
    required this.workbenchBusy,
    required this.butterflyBusy,
  });

  final bool workbench;
  final bool butterfly;
  final VoidCallback onWorkbench;
  final VoidCallback onButterfly;
  final bool workbenchBusy;
  final bool butterflyBusy;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    Widget half(String label, bool selected, bool busy, VoidCallback onTap) => Expanded(
      child: Semantics(
        button: true, selected: selected,
        child: AnimatedContainer(
          duration: AppTokens.motion(context, AppTokens.medium), curve: AppTokens.curve,
          decoration: BoxDecoration(color: selected ? colors.card : Colors.transparent, borderRadius: BorderRadius.circular(6)),
          child: Material(color: Colors.transparent, child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: () { onTap(); closeShellDrawer(context); },
            child: SizedBox(height: 30, child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text(label, style: context.text.bodyMedium?.copyWith(fontSize: 13, fontWeight: selected ? FontWeight.w600 : null, color: selected ? colors.ink : colors.muted)),
              if (busy) ...[const SizedBox(width: 6), const Tooltip(message: '有工作在后台进行', child: BreathingDot())],
            ])),
          )),
        ),
      ),
    );
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: colors.rail, borderRadius: BorderRadius.circular(8)),
      child: Row(children: [half('工作台', workbench, workbenchBusy, onWorkbench), const SizedBox(width: 4), half('蝶君', butterfly, butterflyBusy, onButterfly)]),
    );
  }
}

/// A row near the top of the sidebar (new conversation, search, tasks).
class _NavRow extends StatelessWidget {
  const _NavRow({required this.icon, required this.label, required this.onTap, this.selected = false, this.badge});

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool selected;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: selected ? colors.card : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(context.radius),
        onTap: onTap == null ? null : () { onTap!(); closeShellDrawer(context); },
        child: SizedBox(
          height: 36,
          child: Row(
            children: [
              const SizedBox(width: 10),
              Icon(icon, size: 18, color: colors.ink2),
              const SizedBox(width: 10),
              Expanded(child: Text(label, style: context.text.bodyMedium?.copyWith(fontSize: 14, color: onTap == null ? colors.muted : (selected ? colors.ink : colors.ink2)))),
                Padding(
                  padding: EdgeInsets.only(right: badge == null ? 0 : 8),
                  child: ShellCount(count: badge ?? ''),
                ),
              const SizedBox(width: 4),
            ],
          ),
        ),
      ),
    );
  }
}

/// An icon at the foot of the sidebar, with its name on hover and a count when something waits.
class _FootButton extends StatelessWidget {
  const _FootButton({required this.icon, required this.label, required this.onTap, this.selected = false, this.badge = 0});

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;
  final int badge;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Expanded(
      child: Tooltip(message: label, child: TextButton(
        onPressed: () { onTap(); closeShellDrawer(context); },
      style: TextButton.styleFrom(foregroundColor: selected ? colors.accent : colors.muted,
          padding: const EdgeInsets.symmetric(vertical: 9),
          minimumSize: Size.zero,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 18),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(fontSize: 11))]),
      )),
    );
  }
}

// ---------------------------------------------------------------------------
// Workspace switcher
// ---------------------------------------------------------------------------

/// The workspace, at the top of the workbench's sidebar (0.8.2, user test: it was in the title
/// bar, away from the conversations it lists). Ctrl O opens the same menu.
class SidebarWorkspaceButton extends StatelessWidget {
  const SidebarWorkspaceButton({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final current = agent.workspace;
    final others = agent.recentWorkspaces.where((w) => !SessionStore.samePath(w, current)).toList();
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    Widget row(String path, {required bool selected}) => Row(
      children: [
        Icon(Icons.folder_outlined, size: 18, color: colors.ochre),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(p.basename(path), overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontWeight: selected ? FontWeight.w600 : null)),
              Text(path, overflow: TextOverflow.ellipsis, style: muted?.copyWith(fontSize: 11)),
            ],
          ),
        ),
        if (selected) ...[const SizedBox(width: 8), Icon(Icons.check, size: 16, color: colors.accent)],
      ],
    );
    final itemStyle = MenuItemButton.styleFrom(minimumSize: const Size(320, 48), padding: const EdgeInsets.symmetric(horizontal: 10));
    return MenuAnchor(
      controller: workspaceMenu,
      alignmentOffset: const Offset(0, 6),
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(colors.card),
        side: WidgetStatePropertyAll(BorderSide(color: colors.border)),
        shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
        padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
      ),
      menuChildren: [
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 6),
          child: SizedBox(
            width: 320,
            child: Row(children: [Text('切换工作区', style: context.label), const Spacer(), Text('Ctrl O', style: muted?.copyWith(fontSize: 11))]),
          ),
        ),
        if (current.isNotEmpty) MenuItemButton(style: itemStyle, onPressed: () {}, child: SizedBox(width: 320, child: row(current, selected: true))),
        for (final w in others) MenuItemButton(style: itemStyle, onPressed: () => agent.setWorkspace(w), child: SizedBox(width: 320, child: row(w, selected: false))),
        const Divider(height: 9),
        MenuItemButton(leadingIcon: const Icon(Icons.create_new_folder_outlined, size: 18), onPressed: () => pickWorkspaceFolder(agent), child: const Text('打开文件夹作为工作区…')),
        if (current.isNotEmpty)
          MenuItemButton(leadingIcon: const Icon(Icons.open_in_new, size: 18), onPressed: () => agent.revealInExplorer(current), child: const Text('在资源管理器中显示')),
      ],
      builder: (context, controller, _) => Tooltip(
        message: current.isEmpty ? '选择工作区（Ctrl O）' : '$current（Ctrl O 切换）',
        waitDuration: const Duration(milliseconds: 600),
        child: Material(
          color: colors.card.withValues(alpha: 0.7),
          borderRadius: BorderRadius.circular(8),
          child: InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => controller.isOpen ? controller.close() : controller.open(),
            child: Container(
              height: 36,
              padding: const EdgeInsets.only(left: 10, right: 6),
              decoration: BoxDecoration(border: Border.all(color: colors.border, width: 0.8), borderRadius: BorderRadius.circular(8)),
              child: Row(
                children: [
                  Icon(Icons.folder_outlined, size: 18, color: colors.ochre),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      current.isEmpty ? '选择工作区' : p.basename(current),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.text.bodyMedium?.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: colors.ink),
                    ),
                  ),
                  Icon(Icons.unfold_more, size: 16, color: colors.muted),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Older workspace switcher (the empty state's folder picker)
// ---------------------------------------------------------------------------

/// Current workspace with a menu of recent ones; also used by the empty state.
class WorkspaceSwitcher extends StatelessWidget {
  const WorkspaceSwitcher({super.key, this.compact = false});

  final bool compact;

  static Future<void> pickFolder(BuildContext context) async {
    final agent = AgentScope.read(context);
    final directory = await getDirectoryPath(
      initialDirectory: agent.workspace.isEmpty ? null : agent.workspace,
      confirmButtonText: '设为工作区',
    );
    if (directory != null) await agent.setWorkspace(directory);
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final current = agent.workspace;
    final others = agent.recentWorkspaces.where((w) => !SessionStore.samePath(w, current)).toList();
    return PopupMenuButton<String>(
      tooltip: '工作区：Agent 在这个文件夹里读写文件、执行命令',
      position: PopupMenuPosition.under,
      constraints: const BoxConstraints(minWidth: 300, maxWidth: 420),
      onSelected: (value) async {
        switch (value) {
          case '__pick__':
            await pickFolder(context);
          case '__reveal__':
            await agent.revealInExplorer(current);
          default:
            await agent.setWorkspace(value);
        }
      },
      itemBuilder: (_) => [
        PopupMenuItem<String>(
          enabled: false,
          child: _WorkspaceRow(path: current, current: true),
        ),
        if (others.isNotEmpty) ...[
          const PopupMenuDivider(),
          PopupMenuItem<String>(
            enabled: false,
            height: 28,
            child: Text('最近使用', style: context.text.labelSmall?.copyWith(color: colors.muted)),
          ),
          for (final w in others) PopupMenuItem<String>(value: w, child: _WorkspaceRow(path: w)),
        ],
        const PopupMenuDivider(),
        const PopupMenuItem<String>(
          value: '__pick__',
          child: ListTile(dense: true, leading: Icon(Icons.create_new_folder_outlined), title: Text('打开其他文件夹…')),
        ),
        const PopupMenuItem<String>(
          value: '__reveal__',
          child: ListTile(dense: true, leading: Icon(Icons.open_in_new), title: Text('在资源管理器中显示')),
        ),
      ],
      child: compact
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    current.isEmpty ? '选择工作区' : '工作区 · ${p.basename(current)}',
                    overflow: TextOverflow.ellipsis,
                    style: context.label,
                  ),
                ),
                Icon(Icons.expand_more, size: 14, color: colors.muted),
              ],
            )
          : Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: colors.card,
                border: Border.all(color: colors.border),
                borderRadius: BorderRadius.circular(context.radius),
              ),
              child: Row(
                children: [
                  Icon(Icons.folder_outlined, size: 18, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(width: AppTokens.gap),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('工作区', style: context.text.labelSmall?.copyWith(color: colors.muted)),
                        Text(
                          current.isEmpty ? '选择工作区' : p.basename(current),
                          overflow: TextOverflow.ellipsis,
                          style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                  ),
                  Icon(Icons.unfold_more, size: 16, color: colors.muted),
                ],
              ),
            ),
    );
  }
}

class _WorkspaceRow extends StatelessWidget {
  const _WorkspaceRow({required this.path, this.current = false});

  final String path;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(
      children: [
        Icon(current ? Icons.check : Icons.folder_outlined, size: 16, color: current ? Theme.of(context).colorScheme.primary : colors.muted),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(p.basename(path), overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurface)),
              Text(path, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: colors.muted)),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

/// Search box above either the session list or the search results.
class _SessionPane extends StatefulWidget {
  const _SessionPane({super.key, required this.searching, required this.onCloseSearch});

  /// The search box is open (the sidebar's 「搜索」).
  final bool searching;
  final VoidCallback onCloseSearch;

  @override
  State<_SessionPane> createState() => _SessionPaneState();
}

class _SessionPaneState extends State<_SessionPane> {
  final _query = TextEditingController();
  Timer? _debounce;
  Json? _hits;
  String? _error;
  int _generation = 0;
  var _searching = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    super.dispose();
  }

  void _onChanged(String text) {
    _debounce?.cancel();
    final generation = ++_generation;
    setState(() { _searching = false; _error = null; _hits = null; });
    if (text.trim().isEmpty) {
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      setState(() => _searching = true);
      try {
        final agent = AgentScope.read(context);
        final hits = asJsonMap(await agent.backend.call('search.all', {'query': text.trim(), 'cwd': agent.workspace}));
        if (!mounted || generation != _generation) return;
        setState(() { _hits = hits; _searching = false; });
      } catch (error) {
        if (!mounted || generation != _generation) return;
        setState(() { _error = SessionRuntime.describeError(error); _searching = false; });
      }
    });
  }

  @override
  void didUpdateWidget(_SessionPane old) {
    super.didUpdateWidget(old);
    if (old.searching && !widget.searching) {
      _query.clear();
      _debounce?.cancel();
      ++_generation;
      _hits = null;
      _searching = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.searching) ...[
        SizedBox(
          height: 34,
          child: TextField(
            key: const ValueKey('sidebar-search'),
            controller: _query,
              onChanged: _onChanged,
            style: context.text.bodySmall,
            decoration: InputDecoration(
              hintText: '搜索',
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 16),
              prefixIconConstraints: const BoxConstraints(minWidth: 32),
              suffixIcon: _query.text.isEmpty ? null : IconButton(
                tooltip: '清除搜索',
                iconSize: 14,
                onPressed: () {
                    _query.clear();
                    _onChanged('');
                  },
                icon: const Icon(Icons.close),
              ),
              contentPadding: const EdgeInsets.symmetric(vertical: 8),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(context.radiusSm)),
            ),
          ),
        ),
        const SizedBox(height: AppTokens.gap),
        ],
        Expanded(
          child: _error != null ? Text(_error!, style: TextStyle(color: colors.danger)) : _hits != null || _searching
              ? _SearchResults(hits: _hits ?? const {}, searching: _searching)
              : _SessionList(entries: agent.sidebar),
        ),
      ],
    );
  }
}

class _SearchResults extends StatelessWidget {
  const _SearchResults({required this.hits, required this.searching});

  final Json hits;
  final bool searching;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final groups = {'conversations': '对话', 'files': '产物', 'memories': '记忆'};
    if (searching) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    if (groups.keys.every((key) => jsonRows(hits[key]).isEmpty)) return Text('没有找到', style: context.text.bodySmall?.copyWith(color: colors.muted));
    final agent = AgentScope.read(context);
    return ListView(
      children: [
        for (final group in groups.entries) if (jsonRows(hits[group.key]).isNotEmpty) ...[
        Padding(padding: const EdgeInsets.fromLTRB(6, 10, 6, 4), child: Text(group.value, style: context.label)),
        for (final hit in jsonRows(hits[group.key]))
          InkWell(
            borderRadius: BorderRadius.circular(context.radiusSm),
            onTap: () async {
              final target = asJsonMap(hit['target']);
              if (group.key == 'conversations') {
                await agent.openSearchHit(SearchHit.fromJson({...hit, 'path': target['sessionFile'] ?? hit['path']}));
                agent.entryTarget.value = target['entryId'] as String?;
                agent.main.showSection(agent.sandbox ? AppSection.butterfly : AppSection.chat);
                if (agent.sandbox) agent.main.butterflyTab.value = ButterflyTab.talk;
              } else if (group.key == 'files') {
                final path = target['path'] ?? hit['path'];
                if (path is String && context.mounted) await showFilePreview(context, path);
              } else {
                agent.main.openMemory(itemId: (target['itemId'] ?? hit['id']) as String?);
              }
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text((hit['title'] ?? hit['content'] ?? p.basename('${hit['path'] ?? ''}')).toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  if (hit['snippet'] is String) _Snippet(text: hit['snippet'] as String, prefix: ''),
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// Search snippet with the match (wrapped in 【】 by the core) highlighted.
class _Snippet extends StatelessWidget {
  const _Snippet({required this.text, required this.prefix});

  final String text;
  final String prefix;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final base = context.text.bodySmall?.copyWith(color: colors.muted);
    final spans = <TextSpan>[TextSpan(text: prefix)];
    final pattern = RegExp('【(.*?)】');
    var last = 0;
    for (final match in pattern.allMatches(text)) {
      spans.add(TextSpan(text: text.substring(last, match.start)));
      spans.add(TextSpan(text: match.group(1), style: TextStyle(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.w600)));
      last = match.end;
    }
    spans.add(TextSpan(text: text.substring(last)));
    return Text.rich(TextSpan(style: base, children: spans), maxLines: 2, overflow: TextOverflow.ellipsis);
  }
}

class _SessionList extends StatelessWidget {
  const _SessionList({required this.entries});

  final List<SidebarEntry> entries;

  static String _group(DateTime time) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(time.year, time.month, time.day);
    final diff = today.difference(day).inDays;
    if (diff <= 0) return '今天';
    if (diff == 1) return '昨天';
    if (!day.isBefore(today.subtract(Duration(days: today.weekday - 1)))) return '本周';
    return '更早';
  }

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: AppTokens.pad),
        child: Text(
          '还没有对话', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      );
    }
    final rows = <Widget>[];
    String? lastGroup;
    final ordered = orderSidebarEntries(entries);
    for (final entry in ordered) {
      final parent = entries
          .where(
            (e) =>
                entry.parentSession != null &&
                SessionStore.samePath(e.path, entry.parentSession!),
          )
          .firstOrNull;
      final group = (parent ?? entry).pinned ? '置顶' : _group((parent ?? entry).modifiedAt);
      if (group != lastGroup) {
        rows.add(
          Padding(
            key: ValueKey('group-$group'),
            padding: EdgeInsets.fromLTRB(6, lastGroup == null ? 4 : 14, 6, 4),
            child: Text(group, style: context.label),
          ),
        );
        lastGroup = group;
      }
      rows.add(
        Padding(
          key: ValueKey(entry.path),
          padding: EdgeInsets.only(left: parent == null ? 0 : 18),
          child: _SessionTile(key: ValueKey(entry.path), entry: entry),
        ));
    }
    return ShellAnimatedList(children: rows);
  }
}

class _SessionTile extends StatefulWidget {
  const _SessionTile({super.key, required this.entry});

  final SidebarEntry entry;

  @override
  State<_SessionTile> createState() => _SessionTileState();
}

class _SessionTileState extends State<_SessionTile> {
  var _hovered = false;

  Future<void> _showMenu(Offset position) async {
    final agent = AgentScope.read(context);
    final entry = widget.entry;
    final overlay = Overlay.of(context).context.findRenderObject()! as RenderBox;
    // [position] is on the screen; the menu is laid out in the overlay, which is scaled
    // with the interface zoom (AppZoom): convert, or it opens away from the button.
    final local = overlay.globalToLocal(position);
    final choice = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(local & const Size(1, 1), Offset.zero & overlay.size),
      items: [
        if (!entry.incognito) ...[
          PopupMenuItem(
            value: 'pin',
            child: ListTile(dense: true, leading: Icon(entry.pinned ? Icons.push_pin : Icons.push_pin_outlined), title: Text(entry.pinned ? '取消置顶' : '置顶')),
          ),
          const PopupMenuItem(value: 'rename', child: ListTile(dense: true, leading: Icon(Icons.edit_outlined), title: Text('重命名'))),
          const PopupMenuItem(value: 'clone', child: ListTile(dense: true, leading: Icon(Icons.copy_all_outlined), title: Text('复制为新对话'))),
          const PopupMenuItem(value: 'export_md', child: ListTile(dense: true, leading: Icon(Icons.description_outlined), title: Text('导出 Markdown'))),
          PopupMenuItem(
            value: 'archive',
            child: ListTile(dense: true, leading: const Icon(Icons.inventory_2_outlined), title: Text('归档')),
          ),
          const PopupMenuDivider(),
        ],
        PopupMenuItem(value: 'delete', child: ListTile(dense: true, leading: Icon(Icons.delete_outline, color: context.colors.danger), title: Text('删除', style: TextStyle(color: context.colors.danger)))),
      ],
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'rename':
        final name = await _askName(context, entry.title);
        if (name != null && name.trim().isNotEmpty) await agent.renameSession(entry.path, name);
      case 'clone':
        await agent.cloneSession(entry.path);
      case 'delete':
        await deleteConversation(context, agent, entry.path, title: entry.title);
      case 'pin':
        await agent.setPinned(entry.path, !entry.pinned);
      case 'archive':
        await agent.setArchived(entry.path, true);
      case 'export_md':
        await exportConversation(context, agent, entry.path, entry.title);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final entry = widget.entry;
    final selected = entry.isActive;
    final Widget? badge = entry.hasError
        ? Tooltip(message: '对话出错', child: Icon(Icons.error_outline, size: 14, color: colors.danger))
        : entry.needsAttention
        ? Tooltip(message: '在等你确认', child: Icon(Icons.front_hand_outlined, size: 14, color: colors.warning))
        : entry.isRunning
        ? const Tooltip(message: '正在运行', child: BreathingDot())
        : entry.hasUnseenResult
        ? Tooltip(
            message: '后台运行已完成，还没查看',
            child: Container(width: 7, height: 7, decoration: BoxDecoration(color: colors.ochre, shape: BoxShape.circle)),
          )
        : null;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onSecondaryTapUp: (details) => _showMenu(details.globalPosition),
        child: Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: Material(
            color: selected ? colors.accentSoft : (_hovered ? colors.accentSoft.withValues(alpha: 0.4) : Colors.transparent),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radius)),
            child: InkWell(
              borderRadius: BorderRadius.circular(context.radius),
              onTap: () {
                final agent = AgentScope.read(context);
                if (entry.isSideConversation) {
                  agent.openSavedSideChat({
                    'path': entry.path,
                    'parentSession': entry.parentSession,
                    'quote': entry.sideQuote,
                  });
                } else {
                  agent.openSession(entry.path);
                }
                // From the tasks or memory page too: show the conversation.
                agent.showSection(agent.sandbox ? AppSection.butterfly : AppSection.chat);
                if (agent.sandbox) agent.main.butterflyTab.value = ButterflyTab.talk;
              },
              child: Padding(
                padding: const EdgeInsets.fromLTRB(8, 7, 4, 7),
                child: Row(
                  children: [
                    if (entry.incognito) ...[
                      Tooltip(message: '无痕对话，不会保存', child: Icon(Icons.visibility_off_outlined, size: 14, color: colors.muted)),
                      const SizedBox(width: 4),
                    ],
                    if (entry.isFork) ...[
                      Tooltip(message: '从其他对话重来', child: Icon(Icons.call_split, size: 14, color: colors.muted)),
                      const SizedBox(width: 4),
                    ],
                    Expanded(
                      child: Text(
                        entry.title.isEmpty ? '新对话' : entry.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodyMedium?.copyWith(
                          fontSize: 13,
                          color: selected || entry.hasUnseenResult ? colors.ink : colors.ink2,
                          fontWeight: selected || entry.hasUnseenResult ? FontWeight.w600 : null,
                        ),
                      ),
                    ),
                    if (badge != null) ...[const SizedBox(width: 6), badge],
                    if (_hovered || selected)
                      Builder(
                        builder: (buttonContext) => InkWell(
                          borderRadius: BorderRadius.circular(4),
                          onTap: () {
                            final box = buttonContext.findRenderObject()! as RenderBox;
                            _showMenu(box.localToGlobal(box.size.bottomLeft(Offset.zero)));
                          },
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 2),
                            child: Icon(Icons.more_horiz, size: 16, color: colors.muted),
                          ),
                        ),
                      )
                    else
                      const SizedBox(width: 20),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

Future<String?> _askName(BuildContext context, String current) {
  final controller = TextEditingController(text: current);
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('重命名对话'),
      content: SizedBox(
        width: 360,
        child: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '对话名称'),
          onSubmitted: (value) => Navigator.pop(context, value),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('保存')),
      ],
    ),
  );
}

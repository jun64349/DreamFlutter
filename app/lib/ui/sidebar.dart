import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'dashboard_page.dart';
import 'motion.dart';
import 'settings_page.dart';
import 'session_dialogs.dart';
import 'window_frame.dart';
import 'zoom.dart';

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
  var _searching = false;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final section = agent.section;
    final onButterfly = section == AppSection.butterfly;
    // Whose conversations are listed: 蝶君's on its page, the workbench's everywhere else.
    final AgentController? lists = onButterfly ? agent.butterfly : agent;
    final usable = agent.status != ConnectionStatus.missingRuntime;
    final width = _width ?? agent.sidebarWidth;
    void push(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

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
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                  child: _PlaceSwitch(
                    butterfly: onButterfly,
                    workbench: section == AppSection.chat,
                    onWorkbench: () => agent.showSection(AppSection.chat),
                    onButterfly: () => agent.openButterfly(),
                    butterflyBusy: (agent.butterfly?.backgroundRunning ?? 0) + ((agent.butterfly?.isRunning ?? false) ? 1 : 0) > 0 && !onButterfly,
                    workbenchBusy: agent.backgroundRunning > 0 && section != AppSection.chat,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _NavRow(
                        icon: Icons.add,
                        label: '新建对话',
                        accent: true,
                        onTap: usable && lists != null
                            ? () {
                                lists.newSession();
                                agent.showSection(onButterfly ? AppSection.butterfly : AppSection.chat);
                                if (onButterfly) agent.butterflyTab.value = ButterflyTab.talk;
                              }
                            : null,
                        trailing: onButterfly
                            ? null
                            : IconButton(
                                tooltip: '无痕对话：极简模式，不保存记录，也不读写记忆',
                                visualDensity: VisualDensity.compact,
                                iconSize: 16,
                                onPressed: usable
                                    ? () {
                                        agent.newTemporarySession();
                                        agent.showSection(AppSection.chat);
                                      }
                                    : null,
                                icon: const Icon(Icons.visibility_off_outlined),
                              ),
                      ),
                      _NavRow(icon: Icons.search, label: '搜索', selected: _searching, onTap: () => setState(() => _searching = !_searching)),
                      _NavRow(
                        icon: Icons.task_alt_outlined,
                        label: '任务',
                        selected: section == AppSection.tasks,
                        badge: agent.pendingInbox > 0 ? '${agent.pendingInbox} 等你处理' : null,
                        onTap: () => agent.showSection(AppSection.tasks),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 14, 8, 4),
                  child: Row(
                    children: [
                      if (!onButterfly) ...[Icon(Icons.folder_outlined, size: 15, color: colors.ochre), const SizedBox(width: 6)],
                      Expanded(
                        child: Text(
                          onButterfly ? '和蝶君的对话' : (agent.workspace.isEmpty ? '对话' : '${p.basename(agent.workspace)} 的对话'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: context.text.bodySmall?.copyWith(fontWeight: FontWeight.w600, color: colors.ink2),
                        ),
                      ),
                      // 蝶君 has one home, no workspaces.
                      if (!onButterfly)
                        IconButton(
                          tooltip: '切换工作区（Ctrl O）',
                          visualDensity: VisualDensity.compact,
                          iconSize: 16,
                          onPressed: () => openWorkspaceMenu(agent),
                          icon: const Icon(Icons.unfold_more),
                        ),
                    ],
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: lists == null
                        ? Padding(
                            padding: const EdgeInsets.all(10),
                            child: Text('蝶君的沙箱建好后，和它的对话列在这里。', style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.6)),
                          )
                        : AgentScope(
                            controller: lists,
                            child: _SessionPane(
                              key: ValueKey(lists.sandbox),
                              searching: _searching,
                              onCloseSearch: () => setState(() => _searching = false),
                            ),
                          ),
                  ),
                ),
                // The inscription only where there is room for it.
                if (constraints.maxHeight > 720) const Padding(padding: EdgeInsets.symmetric(horizontal: 14), child: _Inscription()),
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
                        icon: Icons.auto_stories_outlined,
                        label: '技能',
                        selected: section == AppSection.library,
                        badge: agent.pendingProposals,
                        onTap: () => agent.showSection(AppSection.library),
                      ),
                      _FootButton(icon: Icons.bar_chart_rounded, label: '仪表盘', onTap: () => push(const DashboardPage())),
                      _FootButton(icon: Icons.text_fields, label: '外观', onTap: () => showAppearanceDialog(context)),
                      const Spacer(),
                      _FootButton(icon: Icons.settings_outlined, label: '设置', onTap: () => push(const SettingsPage())),
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
        button: true,
        selected: selected,
        child: Material(
          color: selected ? colors.card : Colors.transparent,
          elevation: selected ? 0.5 : 0,
          borderRadius: BorderRadius.circular(6),
          child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: onTap,
            child: SizedBox(
              height: 30,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(label, style: context.text.bodyMedium?.copyWith(fontSize: 13, fontWeight: selected ? FontWeight.w600 : null, color: selected ? colors.ink : colors.muted)),
                  if (busy) ...[const SizedBox(width: 6), const Tooltip(message: '有工作在后台进行', child: BreathingDot())],
                ],
              ),
            ),
          ),
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
  const _NavRow({required this.icon, required this.label, required this.onTap, this.selected = false, this.accent = false, this.badge, this.trailing});

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool selected;
  final bool accent;
  final String? badge;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: selected ? colors.accentSoft : Colors.transparent,
      borderRadius: BorderRadius.circular(context.radius),
      child: InkWell(
        borderRadius: BorderRadius.circular(context.radius),
        onTap: onTap,
        child: SizedBox(
          height: 36,
          child: Row(
            children: [
              const SizedBox(width: 10),
              Icon(icon, size: 17, color: accent ? colors.accent : colors.ink2),
              const SizedBox(width: 10),
              Expanded(child: Text(label, style: context.text.bodyMedium?.copyWith(fontSize: 13, color: onTap == null ? colors.muted : colors.ink))),
              if (badge != null)
                Container(
                  margin: const EdgeInsets.only(right: 8),
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                  decoration: BoxDecoration(color: colors.seal, borderRadius: BorderRadius.circular(9)),
                  child: Text(badge!, style: context.text.labelSmall?.copyWith(color: colors.onAccent, fontSize: 11)),
                ),
              ?trailing,
              if (trailing == null) const SizedBox(width: 4),
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
    final button = IconButton(
      tooltip: badge > 0 ? '$label（$badge 条待处理）' : label,
      visualDensity: VisualDensity.compact,
      isSelected: selected,
      onPressed: onTap,
      style: IconButton.styleFrom(foregroundColor: selected ? colors.accent : colors.muted, backgroundColor: selected ? colors.accentSoft : null),
      icon: Icon(icon, size: 19),
    );
    if (badge <= 0) return button;
    return Badge(label: Text('$badge'), offset: const Offset(-4, 4), backgroundColor: colors.seal, child: button);
  }
}

/// The theme's inscription beside its mark: 「栩栩然胡蝶也」 top to bottom
/// for the Song themes, a painting's title turned sideways for the others.
class _Inscription extends StatelessWidget {
  const _Inscription();

  @override
  Widget build(BuildContext context) {
    final theme = context.painting;
    final style = context.serif(context.text.bodySmall).copyWith(color: context.colors.muted, height: 1.45);
    final text = theme.verticalInscription
        ? Column(children: [for (final c in theme.inscription.characters) Text(c, style: style)])
        : RotatedBox(quarterTurns: 3, child: Text(theme.inscription, style: style.copyWith(fontStyle: FontStyle.italic, letterSpacing: 0.6)));
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, AppTokens.pad, 6, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Semantics(label: theme.inscription, child: ExcludeSemantics(child: text)),
          const ThemeMark(),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Workspace switcher
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
  List<SearchHit>? _hits;
  var _searching = false;
  var _showArchived = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    super.dispose();
  }

  void _onChanged(String text) {
    _debounce?.cancel();
    if (text.trim().isEmpty) {
      setState(() => _hits = null);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      setState(() => _searching = true);
      final hits = await AgentScope.read(context).searchSessions(text);
      if (!mounted || _query.text != text) return;
      setState(() {
        _hits = hits;
        _searching = false;
      });
    });
  }

  @override
  void didUpdateWidget(_SessionPane old) {
    super.didUpdateWidget(old);
    if (old.searching && !widget.searching) {
      _query.clear();
      _debounce?.cancel();
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
            controller: _query,
            autofocus: true,
            onChanged: _onChanged,
            style: context.text.bodySmall,
            decoration: InputDecoration(
              hintText: '搜索所有会话',
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 16),
              prefixIconConstraints: const BoxConstraints(minWidth: 32),
              suffixIcon: IconButton(
                tooltip: '关闭搜索',
                iconSize: 14,
                onPressed: widget.onCloseSearch,
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
          child: _hits != null || _searching
              ? _SearchResults(hits: _hits ?? const [], searching: _searching)
              : _SessionList(entries: agent.sidebar, archived: _showArchived ? agent.archivedSessions : null),
        ),
        if (_hits == null && agent.archivedSessions.isNotEmpty)
          TextButton.icon(
            style: TextButton.styleFrom(alignment: Alignment.centerLeft, foregroundColor: colors.muted),
            onPressed: () => setState(() => _showArchived = !_showArchived),
            icon: Icon(_showArchived ? Icons.expand_less : Icons.inventory_2_outlined, size: 16),
            label: Text(_showArchived ? '收起已归档' : '已归档（${agent.archivedSessions.length}）'),
          ),
      ],
    );
  }
}

class _SearchResults extends StatelessWidget {
  const _SearchResults({required this.hits, required this.searching});

  final List<SearchHit> hits;
  final bool searching;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    if (searching && hits.isEmpty) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    if (hits.isEmpty) return Text('没有找到', style: context.text.bodySmall?.copyWith(color: colors.muted));
    final agent = AgentScope.read(context);
    return ListView(
      children: [
        for (final hit in hits)
          InkWell(
            borderRadius: BorderRadius.circular(context.radiusSm),
            onTap: () {
              agent.openSearchHit(hit);
              agent.showSection(agent.sandbox ? AppSection.butterfly : AppSection.chat);
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(hit.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  _Snippet(text: hit.snippet, prefix: hit.role == 'user' ? '我：' : 'Agent：'),
                  if (hit.cwd != null && !SessionStore.samePath(hit.cwd!, agent.workspace))
                    Text('工作区：${p.basename(hit.cwd!)}', style: context.text.labelSmall?.copyWith(color: colors.muted)),
                ],
              ),
            ),
          ),
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
  const _SessionList({required this.entries, this.archived});

  final List<SidebarEntry> entries;

  /// Archived sessions to list below the others (null = hidden).
  final List<SessionSummary>? archived;

  static String _group(DateTime time) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(time.year, time.month, time.day);
    final diff = today.difference(day).inDays;
    if (diff <= 0) return '今天';
    if (diff == 1) return '昨天';
    if (diff < 7) return '本周';
    if (diff < 30) return '本月';
    return '更早';
  }

  @override
  Widget build(BuildContext context) {
    final archived = this.archived;
    if (entries.isEmpty && (archived?.isEmpty ?? true)) {
      return Padding(
        padding: const EdgeInsets.only(top: AppTokens.pad),
        child: Text('这个工作区还没有会话', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      );
    }
    final rows = <Widget>[];
    String? lastGroup;
    final ordered = [...entries.where((e) => e.pinned), ...entries.where((e) => !e.pinned)];
    for (final entry in ordered) {
      final group = entry.pinned ? '置顶' : _group(entry.modifiedAt);
      if (group != lastGroup) {
        rows.add(
          Padding(
            padding: EdgeInsets.fromLTRB(6, lastGroup == null ? 4 : 14, 6, 4),
            child: Text(group, style: context.label),
          ),
        );
        lastGroup = group;
      }
      rows.add(_SessionTile(entry: entry));
    }
    if (archived != null && archived.isNotEmpty) {
      rows.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 14, 6, 4),
          child: Text('已归档', style: context.label),
        ),
      );
      for (final s in archived) {
        rows.add(
          _SessionTile(
            entry: SidebarEntry(
              path: s.path,
              title: s.title,
              modifiedAt: s.modifiedAt,
              isActive: false,
              isRunning: false,
              hasUnseenResult: false,
              hasError: false,
            ),
            archived: true,
          ),
        );
      }
    }
    return ListView(children: rows);
  }
}

class _SessionTile extends StatefulWidget {
  const _SessionTile({required this.entry, this.archived = false});

  final SidebarEntry entry;
  final bool archived;

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
          const PopupMenuItem(value: 'clone', child: ListTile(dense: true, leading: Icon(Icons.copy_all_outlined), title: Text('复制为新会话'))),
          const PopupMenuItem(value: 'export_md', child: ListTile(dense: true, leading: Icon(Icons.description_outlined), title: Text('导出为 Markdown'))),
          const PopupMenuItem(value: 'export_html', child: ListTile(dense: true, leading: Icon(Icons.html_outlined), title: Text('导出为网页（HTML）'))),
          PopupMenuItem(
            value: 'archive',
            child: ListTile(dense: true, leading: const Icon(Icons.inventory_2_outlined), title: Text(widget.archived ? '取消归档' : '归档')),
          ),
          const PopupMenuDivider(),
        ],
        const PopupMenuItem(value: 'delete', child: ListTile(dense: true, leading: Icon(Icons.delete_outline), title: Text('删除（移到回收站）'))),
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
        if (await confirmSessionDelete(context, entry.path, entry.title)) await agent.deleteSession(entry.path);
      case 'pin':
        await agent.setPinned(entry.path, !entry.pinned);
      case 'archive':
        await agent.setArchived(entry.path, !widget.archived);
      case 'export_md' || 'export_html':
        final markdown = choice == 'export_md';
        final location = await getSaveLocation(
          suggestedName: '${entry.title.replaceAll(RegExp(r'[\\/:*?"<>|\s]+'), '_')}.${markdown ? 'md' : 'html'}',
          acceptedTypeGroups: [markdown ? const XTypeGroup(label: 'Markdown', extensions: ['md']) : const XTypeGroup(label: '网页', extensions: ['html'])],
        );
        if (location == null) return;
        final path = await agent.exportSession(entry.path, markdown ? 'markdown' : 'html', location.path);
        if (path != null && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('已导出：$path'),
              action: SnackBarAction(label: '打开所在文件夹', onPressed: () => agent.revealInExplorer(p.dirname(path))),
            ),
          );
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final entry = widget.entry;
    final selected = entry.isActive;
    final Widget? badge = entry.hasError
        ? Tooltip(message: 'Agent 进程出错', child: Icon(Icons.error_outline, size: 14, color: colors.danger))
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
                agent.openSession(entry.path);
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
                      Tooltip(message: '从其他会话分叉或复制而来', child: Icon(Icons.call_split, size: 14, color: colors.muted)),
                      const SizedBox(width: 4),
                    ],
                    Expanded(
                      child: Text(
                        entry.title.isEmpty ? '（空会话）' : entry.title,
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
      title: const Text('重命名会话'),
      content: SizedBox(
        width: 360,
        child: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '会话名称'),
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

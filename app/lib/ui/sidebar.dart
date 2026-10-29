import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'commands_dialog.dart';

class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    return Container(
      width: AppTokens.sidebarWidth,
      color: colors.sidebar,
      padding: const EdgeInsets.fromLTRB(AppTokens.pad, AppTokens.padLg, AppTokens.pad, AppTokens.gap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome_outlined, size: 20, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: AppTokens.gap),
              Text('DreamFlutter', style: context.text.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: AppTokens.padLg),
          const WorkspaceSwitcher(),
          const SizedBox(height: AppTokens.gap),
          Row(
            children: [
              Expanded(
                child: FilledButton.tonalIcon(
                  onPressed: agent.status == ConnectionStatus.missingRuntime ? null : agent.newSession,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('新会话'),
                ),
              ),
              const SizedBox(width: 4),
              IconButton.filledTonal(
                tooltip: '临时对话：不保存记录，也不读写记忆',
                onPressed: agent.status == ConnectionStatus.missingRuntime ? null : agent.newTemporarySession,
                icon: const Icon(Icons.visibility_off_outlined, size: 18),
              ),
            ],
          ),
          const SizedBox(height: AppTokens.gap),
          const Expanded(child: _SessionPane()),
          const Divider(),
          const SizedBox(height: 4),
          _FooterButton(
            icon: Icons.bolt_outlined,
            label: 'Skills 与命令',
            onTap: () => showCommandsDialog(context),
          ),
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
                Icon(Icons.folder_outlined, size: 16, color: colors.muted),
                const SizedBox(width: 4),
                Text('切换工作区', style: context.text.bodySmall?.copyWith(color: Theme.of(context).colorScheme.primary)),
              ],
            )
          : Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: colors.card,
                border: Border.all(color: colors.border),
                borderRadius: BorderRadius.circular(AppTokens.radius),
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
  const _SessionPane();

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
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 34,
          child: TextField(
            controller: _query,
            onChanged: _onChanged,
            style: context.text.bodySmall,
            decoration: InputDecoration(
              hintText: '搜索所有会话',
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 16),
              prefixIconConstraints: const BoxConstraints(minWidth: 32),
              suffixIcon: _query.text.isEmpty
                  ? null
                  : IconButton(
                      tooltip: '清除',
                      iconSize: 14,
                      onPressed: () {
                        _query.clear();
                        _onChanged('');
                      },
                      icon: const Icon(Icons.close),
                    ),
              contentPadding: const EdgeInsets.symmetric(vertical: 8),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
            ),
          ),
        ),
        const SizedBox(height: AppTokens.gap),
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
            borderRadius: BorderRadius.circular(AppTokens.radiusSm),
            onTap: () => agent.openSearchHit(hit),
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
            padding: EdgeInsets.fromLTRB(6, lastGroup == null ? 0 : 14, 6, 4),
            child: Text(group, style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
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
          child: Text('已归档', style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
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
    final choice = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(position & const Size(1, 1), Offset.zero & overlay.size),
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
        if (await _confirmDelete(context, entry.title)) await agent.deleteSession(entry.path);
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
        ? const Tooltip(
            message: '正在运行',
            child: SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6)),
          )
        : entry.hasUnseenResult
        ? Tooltip(
            message: '后台运行已完成，还没查看',
            child: Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: Theme.of(context).colorScheme.primary, shape: BoxShape.circle),
            ),
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
            color: selected ? colors.card : (_hovered ? colors.border.withValues(alpha: 0.06) : Colors.transparent),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppTokens.radiusSm),
              side: BorderSide(color: selected ? colors.border : Colors.transparent),
            ),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppTokens.radiusSm),
              onTap: () => AgentScope.read(context).openSession(entry.path),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(8, 7, 4, 7),
                child: Row(
                  children: [
                    if (entry.incognito) ...[
                      Tooltip(message: '临时对话，不会保存', child: Icon(Icons.visibility_off_outlined, size: 14, color: colors.muted)),
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
                          color: selected || entry.hasUnseenResult ? null : colors.muted,
                          fontWeight: entry.hasUnseenResult ? FontWeight.w600 : null,
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

Future<bool> _confirmDelete(BuildContext context, String title) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除会话？'),
        content: Text('「$title」会被移到回收站，需要时可以从回收站恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: context.colors.danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    ) ??
    false;

class _FooterButton extends StatelessWidget {
  const _FooterButton({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(AppTokens.radiusSm),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        child: Row(
          children: [
            Icon(icon, size: 18, color: colors.muted),
            const SizedBox(width: 10),
            Text(label, style: context.text.bodyMedium?.copyWith(color: colors.muted)),
          ],
        ),
      ),
    );
  }
}

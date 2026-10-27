import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'commands_dialog.dart';
import 'settings_page.dart';

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
          FilledButton.tonalIcon(
            onPressed: agent.status == ConnectionStatus.missingRuntime ? null : agent.newSession,
            icon: const Icon(Icons.add, size: 18),
            label: const Text('新会话'),
          ),
          const SizedBox(height: AppTokens.pad),
          Expanded(child: _SessionList(entries: agent.sidebar)),
          const Divider(),
          const SizedBox(height: 4),
          _FooterButton(
            icon: Icons.bolt_outlined,
            label: 'Skills 与命令',
            onTap: () => showCommandsDialog(context),
          ),
          _FooterButton(
            icon: Icons.settings_outlined,
            label: '设置',
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SettingsPage())),
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
    if (diff < 7) return '本周';
    if (diff < 30) return '本月';
    return '更早';
  }

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: AppTokens.pad),
        child: Text('这个工作区还没有会话', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      );
    }
    final rows = <Widget>[];
    String? lastGroup;
    for (final entry in entries) {
      final group = _group(entry.modifiedAt);
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
    return ListView(children: rows);
  }
}

class _SessionTile extends StatefulWidget {
  const _SessionTile({required this.entry});

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
    final choice = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(position & const Size(1, 1), Offset.zero & overlay.size),
      items: const [
        PopupMenuItem(value: 'rename', child: ListTile(dense: true, leading: Icon(Icons.edit_outlined), title: Text('重命名'))),
        PopupMenuItem(value: 'clone', child: ListTile(dense: true, leading: Icon(Icons.copy_all_outlined), title: Text('复制为新会话'))),
        PopupMenuDivider(),
        PopupMenuItem(value: 'delete', child: ListTile(dense: true, leading: Icon(Icons.delete_outline), title: Text('删除（移到回收站）'))),
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

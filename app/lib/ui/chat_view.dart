import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'composer.dart';
import 'common.dart';
import 'context_dialog.dart';
import 'library_page.dart' show showTemplateEditor;
import 'run_summary.dart';
import 'sidebar.dart' show WorkspaceSwitcher;
import 'message_widgets.dart';

class ChatView extends StatelessWidget {
  const ChatView({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _TopBar(),
        const Divider(),
        if (agent.backendProblem != null && agent.status != ConnectionStatus.missingRuntime)
          _ProblemBanner(status: ConnectionStatus.crashed, detail: agent.backendProblem!, reconnecting: true)
        else if (agent.status == ConnectionStatus.crashed || agent.status == ConnectionStatus.missingRuntime)
          _ProblemBanner(status: agent.status, detail: agent.statusDetail),
        for (final run in agent.interruptedRuns.take(3)) _InterruptedRunCard(run: run),
        if (agent.currentSessionPath != null && !(agent.active?.incognito ?? false))
          TaskBanner(key: ValueKey('task-${agent.currentSessionPath}'), sessionFile: agent.currentSessionPath!),
        if (agent.active?.incognito ?? false)
          Container(
            margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
            padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 6),
            decoration: BoxDecoration(color: context.colors.border.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(AppTokens.radius)),
            child: Row(
              children: [
                Icon(Icons.visibility_off_outlined, size: 16, color: context.colors.muted),
                const SizedBox(width: AppTokens.gap),
                Text('临时对话：不会保存记录，也不会读写长期记忆。关掉后内容就没了。', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
              ],
            ),
          ),
        Expanded(
          child: agent.status == ConnectionStatus.starting && agent.transcript.items.isEmpty
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : agent.transcript.items.isEmpty
              ? _EmptyState(workspace: agent.workspace)
              : const _MessageList(),
        ),
        if (agent.isReady && agent.stats.contextKnown && agent.stats.contextPercent >= 85 && !agent.isCompacting)
          _ContextWarning(percent: agent.stats.contextPercent),
        const Composer(),
        const Divider(),
        const _StatusBar(),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Top bar: title, model and thinking level
// ---------------------------------------------------------------------------

class _TopBar extends StatelessWidget {
  const _TopBar();

  static const _levelNames = {
    'off': '关闭',
    'minimal': '极低',
    'low': '低',
    'medium': '中',
    'high': '高',
    'xhigh': '很高',
    'max': '最高',
  };

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final model = agent.model;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              agent.sessionTitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.titleSmall?.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: AppTokens.pad),
          _MenuChip<PiModel>(
            icon: Icons.memory_outlined,
            label: model?.name ?? '选择模型',
            tooltip: model == null ? '模型' : '模型：${model.key}',
            enabled: agent.isReady && agent.models.isNotEmpty,
            items: [
              for (final m in agent.models)
                PopupMenuItem(
                  value: m,
                  child: _MenuRow(title: m.name, subtitle: m.provider, selected: m == model),
                ),
            ],
            onSelected: agent.selectModel,
          ),
          const SizedBox(width: AppTokens.gap),
          _MenuChip<String>(
            icon: Icons.psychology_outlined,
            label: '思考：${_levelNames[agent.thinkingLevel] ?? agent.thinkingLevel}',
            tooltip: model != null && !model.reasoning ? '当前模型不支持思考' : '思考级别：越高越慢，但更仔细',
            enabled: agent.isReady && (model?.reasoning ?? false),
            items: [
              for (final level in agent.thinkingLevels)
                PopupMenuItem(
                  value: level,
                  child: _MenuRow(title: _levelNames[level] ?? level, selected: level == agent.thinkingLevel),
                ),
            ],
            onSelected: agent.selectThinkingLevel,
          ),
          const SizedBox(width: 4),
          const _SessionMenu(),
        ],
      ),
    );
  }
}

/// Top-bar menu: turn the conversation into a skill or template, and see or
/// refresh the memory snapshot it was given.
class _SessionMenu extends StatelessWidget {
  const _SessionMenu();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final hasContent = agent.isReady && !(agent.active?.isPristine ?? true);
    final remembers = !(agent.active?.incognito ?? false) && agent.coreSettings['memoryEnabled'] != false;
    return PopupMenuButton<String>(
      tooltip: '更多操作',
      icon: const Icon(Icons.more_horiz, size: 20),
      position: PopupMenuPosition.under,
      onSelected: (action) => _run(context, action),
      itemBuilder: (_) => [
        PopupMenuItem(
          value: 'skill',
          enabled: hasContent && !agent.isRunning,
          child: const ListTile(dense: true, leading: Icon(Icons.auto_fix_high_outlined), title: Text('存成技能'), subtitle: Text('把这次的做法整理成可复用的技能')),
        ),
        PopupMenuItem(
          value: 'template',
          enabled: hasContent,
          child: const ListTile(dense: true, leading: Icon(Icons.post_add_outlined), title: Text('存为模板'), subtitle: Text('把最后一条请求存成任务模板')),
        ),
        const PopupMenuDivider(),
        PopupMenuItem(
          value: 'snapshots',
          enabled: remembers && agent.activeSessionId != null,
          child: const ListTile(dense: true, leading: Icon(Icons.psychology_alt_outlined), title: Text('查看用到的记忆')),
        ),
        PopupMenuItem(
          value: 'refresh',
          enabled: remembers && hasContent,
          child: const ListTile(dense: true, leading: Icon(Icons.refresh), title: Text('刷新记忆快照'), subtitle: Text('下一条消息带上最新的记忆')),
        ),
      ],
    );
  }

  Future<void> _run(BuildContext context, String action) async {
    final agent = AgentScope.read(context);
    switch (action) {
      case 'skill':
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('正在用辅助模型整理这次的做法，大约需要几十秒…'), behavior: SnackBarBehavior.floating, width: 520),
        );
        await agent.draftSkillFromSession();
      case 'template':
        final draft = await agent.draftTemplateFromSession();
        if (draft == null || !context.mounted) return;
        final saved = await showTemplateEditor(
          context,
          name: draft['name'] as String? ?? '',
          description: draft['description'] as String? ?? '',
          body: draft['body'] as String? ?? '',
        );
        if (saved && context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('模板已保存，可以在「技能」页运行，或在输入框里输入 /模板名。'), behavior: SnackBarBehavior.floating, width: 520),
          );
        }
      case 'refresh':
        await agent.refreshMemorySnapshot();
      case 'snapshots':
        final snapshots = await agent.memorySnapshots();
        if (!context.mounted) return;
        await showTextDialog(
          context,
          title: '这个会话用到的记忆',
          text: snapshots.isEmpty
              ? '这个会话还没有带上记忆快照（可能是记忆为空，或者还没发出第一条消息）。'
              : [for (final s in snapshots) s['content'] as String? ?? ''].join('\n\n────────\n\n'),
        );
    }
  }
}

class _MenuChip<T> extends StatelessWidget {
  const _MenuChip({
    required this.icon,
    required this.label,
    required this.tooltip,
    required this.enabled,
    required this.items,
    required this.onSelected,
  });

  final IconData icon;
  final String label;
  final String tooltip;
  final bool enabled;
  final List<PopupMenuEntry<T>> items;
  final ValueChanged<T> onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return PopupMenuButton<T>(
      enabled: enabled,
      tooltip: tooltip,
      onSelected: onSelected,
      itemBuilder: (_) => items,
      position: PopupMenuPosition.under,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          border: Border.all(color: colors.border),
          borderRadius: BorderRadius.circular(AppTokens.radius),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: colors.muted),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 200),
              child: Text(label, overflow: TextOverflow.ellipsis, style: context.text.bodySmall),
            ),
            Icon(Icons.expand_more, size: 16, color: colors.muted),
          ],
        ),
      ),
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.title, this.subtitle, required this.selected});

  final String title;
  final String? subtitle;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        SizedBox(width: 22, child: selected ? const Icon(Icons.check, size: 16) : null),
        Expanded(child: Text(title)),
        if (subtitle != null) ...[
          const SizedBox(width: 16),
          Text(subtitle!, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Banners and empty state
// ---------------------------------------------------------------------------

class _ProblemBanner extends StatelessWidget {
  const _ProblemBanner({required this.status, required this.detail, this.reconnecting = false});

  final ConnectionStatus status;
  final String detail;

  /// The core connection dropped and the controller is reconnecting by itself.
  final bool reconnecting;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final crashed = status == ConnectionStatus.crashed;
    return Container(
      margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
      padding: const EdgeInsets.all(AppTokens.pad),
      decoration: BoxDecoration(
        color: colors.danger.withValues(alpha: 0.08),
        border: Border.all(color: colors.danger.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(AppTokens.radius),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, color: colors.danger, size: 20),
          const SizedBox(width: AppTokens.pad),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(reconnecting ? '后台连接中断' : crashed ? '会话已断开' : '后台服务没有启动', style: context.text.titleSmall),
                const SizedBox(height: 4),
                SelectableText(
                  detail,
                  style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback),
                ),
              ],
            ),
          ),
          if (crashed && !reconnecting) ...[
            const SizedBox(width: AppTokens.pad),
            OutlinedButton.icon(
              onPressed: AgentScope.read(context).restart,
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('重新打开'),
            ),
          ],
        ],
      ),
    );
  }
}

/// A run the core was doing when it last stopped (crash, reboot): offer to
/// pick it up again or dismiss it.
class _InterruptedRunCard extends StatelessWidget {
  const _InterruptedRunCard({required this.run});

  final InterruptedRun run;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final agent = AgentScope.read(context);
    final what = (run.prompt ?? '').replaceAll(RegExp(r's+'), ' ').trim();
    return Container(
      margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: AppTokens.gap),
      decoration: BoxDecoration(
        color: colors.warning.withValues(alpha: 0.08),
        border: Border.all(color: colors.warning.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(AppTokens.radius),
      ),
      child: Row(
        children: [
          Icon(Icons.history_toggle_off, color: colors.warning, size: 20),
          const SizedBox(width: AppTokens.pad),
          Expanded(
            child: Text(
              what.isEmpty ? '有一个任务在后台停止时被中断了' : '任务被中断：$what',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          TextButton(onPressed: () => agent.dismissInterrupted(run), child: const Text('忽略')),
          const SizedBox(width: AppTokens.gap),
          FilledButton.tonal(onPressed: () => agent.resumeInterrupted(run), child: const Text('继续')),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.workspace});

  final String workspace;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.auto_awesome_outlined, size: 36, color: Theme.of(context).colorScheme.primary),
          const SizedBox(height: AppTokens.pad),
          Text('有什么可以帮你？', style: context.text.headlineSmall),
          const SizedBox(height: AppTokens.gap),
          Text('工作区：$workspace', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          const SizedBox(height: 6),
          const WorkspaceSwitcher(compact: true),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Message list with stick-to-bottom scrolling
// ---------------------------------------------------------------------------

class _MessageList extends StatefulWidget {
  const _MessageList();

  @override
  State<_MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<_MessageList> {
  final _scroll = ScrollController();
  var _stickToBottom = true;
  int _lastRevision = -1;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      final position = _scroll.position;
      _stickToBottom = position.maxScrollExtent - position.pixels < 80;
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _followIfNeeded(int revision) {
    if (revision == _lastRevision) return;
    _lastRevision = revision;
    if (!_stickToBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final transcript = agent.transcript;
    final items = transcript.items;
    _followIfNeeded(transcript.revision);
    final sessionFile = agent.currentSessionPath;
    // The last run's summary (trace, cost, files) under the last reply.
    final showSummary = sessionFile != null && !transcript.isRunning && !(agent.active?.incognito ?? false);
    final replies = ReplyInfo.collect(items);
    return SelectionArea(
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.symmetric(vertical: AppTokens.padLg),
        itemCount: items.length + (transcript.queuedSteering.isEmpty ? 0 : 1) + (showSummary ? 1 : 0),
        itemBuilder: (context, index) {
          final child = index < items.length
              ? TranscriptItemView(key: ValueKey(items[index].key), item: items[index], transcript: transcript, reply: replies[index])
              : index == items.length && transcript.queuedSteering.isNotEmpty
              ? QueuedMessages(messages: transcript.queuedSteering)
              : RunSummaryCard(key: ValueKey(sessionFile), sessionFile: sessionFile!);
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg + 8, vertical: 6),
                child: child,
              ),
            ),
          );
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

class _StatusBar extends StatelessWidget {
  const _StatusBar();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final (dotColor, label) = switch (agent.status) {
      ConnectionStatus.starting => (colors.warning, '启动中…'),
      ConnectionStatus.crashed => (colors.danger, '已断开'),
      ConnectionStatus.missingRuntime => (colors.danger, '缺少运行环境'),
      ConnectionStatus.ready when agent.isCompacting => (colors.warning, '正在压缩上下文…'),
      ConnectionStatus.ready when agent.isRunning => (colors.warning, '运行中'),
      ConnectionStatus.ready => (colors.success, '就绪'),
    };
    final stats = agent.stats;
    final style = context.text.bodySmall?.copyWith(color: colors.muted);
    final percent = stats.contextPercent;
    final barColor = percent >= 85 ? colors.danger : (percent >= 60 ? colors.warning : Theme.of(context).colorScheme.primary);
    return Container(
      color: colors.sidebar,
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: 3),
      child: Row(
        children: [
          Container(width: 7, height: 7, decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Text('Pi · $label', style: style),
          if (agent.backgroundRunning > 0) ...[
            const SizedBox(width: AppTokens.pad),
            Tooltip(
              message: '切走的会话仍在后台运行，左侧会话栏里转圈的就是',
              child: Text('后台运行 ${agent.backgroundRunning} 个', style: style?.copyWith(color: colors.warning)),
            ),
          ],
          for (final status in agent.extensionStatuses.values) ...[
            const SizedBox(width: AppTokens.pad),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 220),
              child: Text(status, overflow: TextOverflow.ellipsis, style: style),
            ),
          ],
          const Spacer(),
          Tooltip(
            message: '查看上下文占用、手动压缩',
            child: InkWell(
              borderRadius: BorderRadius.circular(AppTokens.radiusSm),
              onTap: agent.isReady ? () => showContextDialog(context) : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                child: Row(
                  children: [
                    Text('上下文', style: style),
                    const SizedBox(width: 6),
                    SizedBox(
                      width: 64,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(2),
                        child: LinearProgressIndicator(
                          value: stats.contextKnown ? (percent / 100).clamp(0, 1) : 0,
                          minHeight: 4,
                          color: barColor,
                          backgroundColor: colors.border,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      stats.contextWindow == 0 || !stats.contextKnown ? '—' : '${percent.toStringAsFixed(percent < 10 ? 1 : 0)}%',
                      style: style,
                    ),
                    const SizedBox(width: AppTokens.pad),
                    Text('${formatTokens(stats.totalTokens)} tokens', style: style),
                    if (stats.cost > 0) ...[
                      const SizedBox(width: AppTokens.pad),
                      Text('\$${stats.cost.toStringAsFixed(4)}', style: style),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ContextWarning extends StatelessWidget {
  const _ContextWarning({required this.percent});

  final double percent;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(AppTokens.padLg + 8, 4, AppTokens.padLg + 8, 0),
          child: Row(
            children: [
              Icon(Icons.warning_amber_rounded, size: 16, color: colors.warning),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '上下文已用 ${percent.toStringAsFixed(0)}%，快满了。可以压缩较早的对话，或者开一个新会话。',
                  style: context.text.bodySmall?.copyWith(color: colors.warning),
                ),
              ),
              TextButton(onPressed: () => showContextDialog(context), child: const Text('管理上下文')),
            ],
          ),
        ),
      ),
    );
  }
}

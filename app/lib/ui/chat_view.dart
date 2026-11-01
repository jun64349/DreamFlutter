import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'composer.dart';
import 'common.dart';
import 'context_dialog.dart';
import 'library_page.dart' show showTemplateEditor;
import 'message_widgets.dart';
import 'motion.dart';
import 'providers_page.dart' show ProvidersPage;
import 'run_summary.dart';
import 'schedules.dart' show showScheduleEditor;
import 'sidebar.dart' show WorkspaceSwitcher;

/// Takes files dropped anywhere on the conversation (not just on the input
/// box) and hands them to the input box.
class _FileDropArea extends StatefulWidget {
  const _FileDropArea({required this.enabled, required this.onDrop, required this.builder});

  final bool enabled;
  final ValueChanged<List<String>> onDrop;
  final Widget Function(bool dragging) builder;

  @override
  State<_FileDropArea> createState() => _FileDropAreaState();
}

class _FileDropAreaState extends State<_FileDropArea> {
  var _dragging = false;

  @override
  Widget build(BuildContext context) => DropTarget(
    enable: widget.enabled,
    onDragEntered: (_) => setState(() => _dragging = true),
    onDragExited: (_) => setState(() => _dragging = false),
    onDragDone: (details) {
      setState(() => _dragging = false);
      widget.onDrop([for (final f in details.files) f.path]);
    },
    child: widget.builder(_dragging),
  );
}

/// The conversation: title bar, messages and the input box, with the run
/// panel on the right when there is room.
class ChatView extends StatelessWidget {
  const ChatView({super.key});

  /// Below this width the run panel stays closed.
  static const _panelMinWidth = 940.0;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final incognito = agent.active?.incognito ?? false;
    // The latest card of the conversation on screen runs live.
    agent.cardStage.setLatest(latestCardId(agent.transcript));
    return LayoutBuilder(
      builder: (context, constraints) {
        final roomForPanel = constraints.maxWidth >= _panelMinWidth && !incognito;
        final showPanel = roomForPanel && agent.runPanelOpen;
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: _FileDropArea(
                enabled: agent.isReady,
                onDrop: agent.dropFiles,
                builder: (dragging) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _TopBar(panelToggle: roomForPanel, panelOpen: showPanel),
                    if (agent.backendProblem != null && agent.status != ConnectionStatus.missingRuntime)
                      _ProblemBanner(status: ConnectionStatus.crashed, detail: agent.backendProblem!, reconnecting: true)
                    else if (agent.status == ConnectionStatus.crashed || agent.status == ConnectionStatus.missingRuntime)
                      _ProblemBanner(status: agent.status, detail: agent.statusDetail),
                    for (final run in agent.interruptedRuns.take(3)) _InterruptedRunCard(run: run),
                    if (incognito)
                      Container(
                        margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
                        padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 6),
                        decoration: BoxDecoration(color: context.colors.accentSoft, borderRadius: BorderRadius.circular(context.radius)),
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
                          ? const _EmptyState()
                          : const _MessageList(),
                    ),
                    if (agent.isReady && agent.stats.contextKnown && agent.stats.contextPercent >= 85 && !agent.isCompacting)
                      _ContextWarning(percent: agent.stats.contextPercent),
                    Composer(dragging: dragging),
                  ],
                ),
              ),
            ),
            if (showPanel)
              RunPanel(
                key: ValueKey('panel-${agent.currentSessionPath}'),
                sessionFile: agent.currentSessionPath,
                onClose: () => agent.setRunPanelOpen(false),
              ),
          ],
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Title bar
// ---------------------------------------------------------------------------

class _TopBar extends StatelessWidget {
  const _TopBar({required this.panelToggle, required this.panelOpen});

  /// There is room for the run panel, so offer to open or close it.
  final bool panelToggle;
  final bool panelOpen;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    return Container(
      height: 56,
      padding: const EdgeInsets.only(left: 24, right: 12),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: colors.border, width: 0.5))),
      child: Row(
        children: [
          Expanded(
            child: Text(
              agent.sessionTitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.titleMedium?.copyWith(fontSize: 18),
            ),
          ),
          if (panelToggle)
            IconButton(
              tooltip: panelOpen ? '收起右栏' : '展开右栏：本次运行的步骤、文件和花费',
              isSelected: panelOpen,
              onPressed: () => agent.setRunPanelOpen(!panelOpen),
              style: IconButton.styleFrom(backgroundColor: panelOpen ? colors.accentSoft : null, foregroundColor: panelOpen ? colors.accent : colors.muted),
              icon: const Icon(Icons.view_sidebar_outlined, size: 19),
            ),
          const SizedBox(width: 2),
          const _SessionMenu(),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// The first screen of a new conversation
// ---------------------------------------------------------------------------

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  static const _ideas = [
    (Icons.summarize_outlined, '整理一份周报', '把工作区里本周的资料整理成周报，列出要点和待办。', '把工作区里本周的资料整理成一份周报，列出要点和待办。'),
    (Icons.folder_open_outlined, '看看这个文件夹', '读一读工作区里的文件，说说各自是做什么的。', '读一读当前工作区里的文件，告诉我里面都有什么、各自是做什么的。'),
    (Icons.route_outlined, '规划一件事', '先问清目标和时间，再给出分步计划。', '帮我规划一件事：先问我目标和时间，再给出分步计划。'),
  ];

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final agent = AgentScope.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: FadeSlideIn(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const ButterflyMark(size: 120, veins: true),
              const SizedBox(height: 20),
              Text('今天想做点什么？', style: context.text.headlineSmall?.copyWith(fontSize: 26)),
              const SizedBox(height: 10),
              Text('Agent 会在工作区里读写文件、运行命令，做好的东西会放到书桌上。', style: context.text.bodyMedium?.copyWith(color: colors.muted)),
              const SizedBox(height: 28),
              if (!agent.onboarded) ...[const _FirstRunGuide(), const SizedBox(height: 20)],
              Wrap(
                spacing: 12,
                runSpacing: 12,
                alignment: WrapAlignment.center,
                children: [
                  for (final (icon, title, subtitle, prompt) in _ideas)
                    SizedBox(
                      width: 210,
                      child: Material(
                        color: colors.card,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radiusLg), side: BorderSide(color: colors.border)),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(context.radiusLg),
                          onTap: () => agent.insertIntoComposer(prompt),
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(icon, size: 18, color: colors.accent),
                                const SizedBox(height: 8),
                                Text(title, style: context.serif(context.text.bodyMedium).copyWith(fontWeight: FontWeight.w600)),
                                const SizedBox(height: 4),
                                Text(subtitle, style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.6)),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 24),
              const WorkspaceSwitcher(compact: true),
            ],
          ),
        ),
      ),
    );
  }
}

/// 「开始之前」: three things to check on first use (a model, the
/// workspace, a first task). Shown on the empty conversation until
/// dismissed; it never blocks anything.
class _FirstRunGuide extends StatelessWidget {
  const _FirstRunGuide();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final model = agent.model;
    final hasModel = model != null && agent.models.isNotEmpty;
    final folder = agent.workspace.isEmpty ? '未选择' : p.basename(agent.workspace);
    Widget step(int n, bool done, String title, String detail, Widget? action) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, color: done ? colors.accent : null, border: Border.all(color: done ? colors.accent : colors.muted)),
            child: done
                ? Icon(Icons.check, size: 13, color: colors.onAccent)
                : Text('$n', style: context.text.labelSmall?.copyWith(color: colors.muted)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                Text(detail, style: context.text.bodySmall?.copyWith(color: colors.muted)),
              ],
            ),
          ),
          ?action,
        ],
      ),
    );
    return Container(
      width: 520,
      padding: const EdgeInsets.fromLTRB(18, 14, 12, 10),
      decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(context.radiusLg)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('开始之前', style: context.serif(context.text.titleMedium).copyWith(fontSize: 16)),
          const SizedBox(height: 6),
          step(
            1,
            hasModel,
            hasModel ? '已连接模型：${model.name}' : '连接一个模型',
            hasModel ? '换模型在输入框右下角；服务商和 Key 在设置里。' : '在设置里添加服务商和 API Key，Agent 才能开始工作。',
            TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ProvidersPage())),
              child: Text(hasModel ? '管理' : '去添加'),
            ),
          ),
          step(
            2,
            agent.workspace.isNotEmpty,
            '工作区：$folder',
            'Agent 在这个文件夹里读写文件、运行命令。',
            TextButton(onPressed: () => WorkspaceSwitcher.pickFolder(context), child: const Text('换一个文件夹')),
          ),
          step(3, false, '试一个任务', '点下面任意一张卡片，或者直接在输入框里说。', null),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(onPressed: agent.finishOnboarding, child: const Text('知道了')),
          ),
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
    _followIfNeeded(transcript.revision);
    final rows = ChatRow.fromItems(transcript.items);
    final queued = transcript.queuedSteering;
    return SelectionArea(
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.symmetric(vertical: 24),
        itemCount: rows.length + (queued.isEmpty ? 0 : 1),
        itemBuilder: (context, index) {
          final child = index < rows.length
              ? FadeSlideIn(
                  key: ValueKey(rows[index].key),
                  animate: transcript.isRunning,
                  child: ChatRowView(row: rows[index], transcript: transcript),
                )
              : QueuedMessages(messages: queued);
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth + 56),
              child: Padding(padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 6), child: child),
            ),
          );
        },
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
        PopupMenuItem(
          value: 'schedule',
          enabled: hasContent && agent.active?.sessionPath != null && !(agent.active?.incognito ?? false),
          child: const ListTile(dense: true, leading: Icon(Icons.schedule), title: Text('定时接着做'), subtitle: Text('按时间在这个会话里继续，比如每天汇报进度')),
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
      case 'schedule':
        final path = agent.active?.sessionPath;
        if (path == null) return;
        if (await showScheduleEditor(context, session: path) && context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('定时任务已保存，可以在「任务 › 定时」里查看和修改。'), behavior: SnackBarBehavior.floating, width: 520),
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
        borderRadius: BorderRadius.circular(context.radius),
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
        borderRadius: BorderRadius.circular(context.radius),
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

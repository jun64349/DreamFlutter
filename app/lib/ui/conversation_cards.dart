import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'butterfly_motion.dart';
import 'message_widgets.dart' show DiffView, editDiff;
import 'workspace_path.dart';

bool isConversationApproval(ExtensionUiRequest request) => request.method == 'select' && request.title.startsWith('Agent 请求执行操作');

class ConversationPresence extends StatelessWidget {
  const ConversationPresence({super.key, this.detail});
  final String? detail;
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    if (agent.active?.pendingDialogs.any(isConversationApproval) == true) return const SizedBox.shrink();
    final activity = butterflyActivity(agent);
    final title = switch (activity) {
      ButterflyActivity.received => '接住你的念头', ButterflyActivity.thinking => '让思绪慢慢成形',
      ButterflyActivity.searching => '循着线索探寻', ButterflyActivity.reading => '翻阅字里行间',
      ButterflyActivity.working => '让想法落地', ButterflyActivity.waiting => '这一笔等你点头',
      ButterflyActivity.writing => '将思绪写给你', ButterflyActivity.complete => '这一页写好了',
      ButterflyActivity.paused => '在这里停一停', ButterflyActivity.idle => '接住你的念头',
    };
    final active = agent.transcript.tools.values.where((r) => r.isActive).lastOrNull;
    final rawPath = active?.args['file_path'] ?? active?.args['path'];
    final argument = rawPath is String ? relativeWorkspacePath(agent.workspace, rawPath) : active?.args['description'] ?? active?.args['command'] ?? '';
    final actual = detail ?? (agent.active?.pendingDialogs.isNotEmpty == true ? '等待你决定这次操作'
      : active != null ? '${active.name == 'read' ? '正在读取' : active.name == 'edit' ? '正在修改' : active.name == 'write' ? '正在写入' : '正在执行操作'} $argument'.trim()
      : activity == ButterflyActivity.writing ? '正在生成回复' : activity == ButterflyActivity.thinking ? '正在思考你的问题' : '正在等待模型回应');
    return Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
      ButterflyAvatar(activity: activity, size: 42), const SizedBox(width: 14),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: context.handwriting(context.text.titleLarge).copyWith(fontSize: 24, color: context.colors.ink)),
        const SizedBox(height: 3), Tooltip(message: rawPath is String ? fullWorkspacePath(agent.workspace, rawPath) : '', child: Text(actual, maxLines: 2, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: context.colors.muted))),
      ])),
    ]));
  }
}

class ConversationApprovalLane extends StatefulWidget {
  const ConversationApprovalLane({super.key, required this.runtime});
  final SessionRuntime? runtime;
  @override
  State<ConversationApprovalLane> createState() => _ConversationApprovalLaneState();
}

class _ConversationApprovalLaneState extends State<ConversationApprovalLane> {
  final _seen = <String, ExtensionUiRequest>{};
  final _answers = <String, String>{};
  @override
  void didUpdateWidget(ConversationApprovalLane old) {
    super.didUpdateWidget(old);
    if (!identical(old.runtime, widget.runtime)) { _seen.clear(); _answers.clear(); }
  }
  @override
  Widget build(BuildContext context) {
    final runtime = widget.runtime;
    if (runtime == null) return const SizedBox.shrink();
    return ListenableBuilder(listenable: runtime, builder: (context, _) {
      for (final request in runtime.pendingDialogs.where(isConversationApproval)) { _seen[request.id] = request; }
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final request in _seen.values)
          if (runtime.pendingDialogs.contains(request) || _answers.containsKey(request.id))
            Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: ConversationApprovalCard(
              request: request, runtime: runtime, answer: _answers[request.id],
              onAnswer: (value) {
                runtime.answerDialog(request, value: value);
                setState(() => _answers[request.id] = value == '拒绝' ? '已拒绝' : '已允许');
              },
            )),
      ]);
    });
  }
}

class ConversationApprovalCard extends StatelessWidget {
  const ConversationApprovalCard({super.key, required this.request, required this.runtime, required this.onAnswer, this.answer});
  final ExtensionUiRequest request;
  final SessionRuntime runtime;
  final ValueChanged<String> onAnswer;
  final String? answer;
  @override
  Widget build(BuildContext context) {
    final body = request.title.replaceFirst('Agent 请求执行操作', '').trim();
    final lines = body.split('\n');
    final fileTitle = RegExp(r'^(修改文件|写入文件)：\s*(.*)$').firstMatch(lines.first);
    final cwd = workspaceOf(context);
    final title = fileTitle == null ? lines.first : '${fileTitle.group(1)}：${relativeWorkspacePath(cwd, fileTitle.group(2)!)}';
    final toolName = request.options.map((o) => RegExp('本会话内总是允许「([^」]+)」').firstMatch(o)?.group(1)).whereType<String>().firstOrNull;
    final run = runtime.transcript.tools.values.where((r) => r.isActive && (toolName == null || r.name == toolName)).lastOrNull;
    final diff = run == null ? const [] : editDiff(run);
    final reason = run?.args['description'];
    final always = request.options.where((o) => o.startsWith('本会话内总是允许')).firstOrNull;
    return Container(
      key: ValueKey('approval-${request.id}'), padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: context.colors.card, border: Border.all(color: context.colors.border), borderRadius: BorderRadius.circular(context.radiusLg)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(Icons.verified_user_outlined, size: 19, color: context.colors.accent), const SizedBox(width: 8), Expanded(child: Tooltip(message: fileTitle == null ? '' : fullWorkspacePath(cwd, fileTitle.group(2)!), child: Text(title, style: context.text.titleSmall)))]),
        if (reason is String && reason.isNotEmpty && !lines.first.contains(reason)) Padding(padding: const EdgeInsets.only(top: 8), child: Text(reason, style: context.text.bodySmall?.copyWith(color: context.colors.muted))),
        if (lines.length > 1) Padding(padding: const EdgeInsets.only(top: 8), child: SelectableText(lines.skip(1).join('\n'), style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily))),
        if (diff.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: DiffView(lines: diff.cast())),
        const SizedBox(height: 12),
        if (answer != null) Text(answer!, style: context.text.bodySmall?.copyWith(color: answer == '已拒绝' ? context.colors.muted : context.colors.accent))
        else Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
          FilledButton(onPressed: request.options.contains('允许') ? () => onAnswer('允许') : null, child: const Text('允许')),
          OutlinedButton(onPressed: request.options.contains('拒绝') ? () => onAnswer('拒绝') : null, child: const Text('拒绝')),
          if (always != null) TextButton(onPressed: () => onAnswer(always), child: const Text('这个对话里都允许这类操作')),
        ]),
      ]),
    );
  }
}

class ConversationErrorCard extends StatefulWidget {
  const ConversationErrorCard({super.key, required this.reason, this.question});
  final String reason;
  final UserItem? question;
  @override
  State<ConversationErrorCard> createState() => _ConversationErrorCardState();
}

class _ConversationErrorCardState extends State<ConversationErrorCard> {
  var _busy = false;
  String? _error;
  Future<void> _retry([PiModel? model]) async {
    final agent = AgentScope.read(context);
    final question = widget.question ?? agent.transcript.items.whereType<UserItem>().lastOrNull;
    if (question == null) return;
    setState(() { _busy = true; _error = null; });
    try {
      if (!agent.isReady) await agent.restart();
      if (agent.active?.branchFor(question) != null) { await agent.regenerate(question, model: model); }
      else { if (model != null) await agent.selectModel(model); await agent.send(question.text, images: question.images); }
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return Container(padding: const EdgeInsets.all(16), decoration: BoxDecoration(color: context.colors.card, border: Border.all(color: context.colors.danger.withValues(alpha: .45)), borderRadius: BorderRadius.circular(context.radiusLg)), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('这次没能完成', style: context.text.titleSmall), const SizedBox(height: 6), Text(widget.reason, style: context.text.bodyMedium),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: TextStyle(color: context.colors.danger))),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        FilledButton(onPressed: _busy || agent.isRunning ? null : _retry, child: Text(_busy ? '正在重试…' : '重试')),
        PopupMenuButton<PiModel>(tooltip: '换个模型', enabled: !_busy && !agent.isRunning && agent.models.isNotEmpty, onSelected: _retry, itemBuilder: (_) => [for (final model in agent.models) PopupMenuItem(value: model, child: Text(model.name))], child: const Padding(padding: EdgeInsets.symmetric(horizontal: 12, vertical: 10), child: Text('换个模型'))),
        TextButton(onPressed: () => agent.main.showSection(AppSection.settings), child: const Text('去设置')),
      ]),
    ]));
  }
}

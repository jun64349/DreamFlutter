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

/// A plain-words headline for a model error; the original text stays below it (0.8.1 C.2).
String explainModelError(String raw) {
  final t = raw.toLowerCase();
  if (t.contains('timed out') || t.contains('timeout') || t.contains('etimedout')) return '模型太久没有回应，这次请求超时了';
  if (t.contains('401') || (t.contains('invalid') && t.contains('key')) || t.contains('authentication') || t.contains('unauthorized')) return '密钥不对或已失效';
  if (t.contains('402') || t.contains('insufficient') || t.contains('balance') || t.contains('quota') || t.contains('余额')) return '余额或额度不够了';
  if (t.contains('429') || t.contains('rate limit') || t.contains('too many requests')) return '请求太频繁，被模型服务限流了';
  if (t.contains('context') && (t.contains('length') || t.contains('too long') || t.contains('exceed'))) return '这次的内容超过了模型能读的长度';
  if (t.contains('econnrefused') || t.contains('enotfound') || t.contains('fetch failed') || t.contains('network') || t.contains('socket')) return '连不上模型服务，检查一下网络或代理';
  if (RegExp(r'\b5\d\d\b').hasMatch(t) || t.contains('overloaded') || t.contains('unavailable')) return '模型服务暂时出了问题';
  return raw;
}

class ConversationErrorCard extends StatefulWidget {
  const ConversationErrorCard({super.key, required this.reason, this.question, this.model, this.attempts = 0});
  final String reason;
  final UserItem? question;

  /// The model id that failed, when known.
  final String? model;

  /// How many automatic retries ran before giving up.
  final int attempts;
  @override
  State<ConversationErrorCard> createState() => _ConversationErrorCardState();
}

class _ConversationErrorCardState extends State<ConversationErrorCard> {
  var _busy = false;
  var _expanded = false;
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
    final colors = context.colors;
    final headline = explainModelError(widget.reason);
    final explained = headline != widget.reason;
    final id = widget.model;
    final modelName = id == null || id.isEmpty ? null : agent.models.where((m) => m.id == id).firstOrNull?.name ?? id;
    final meta = [?modelName, if (widget.attempts > 0) '自动重试了 ${widget.attempts} 次'].join(' · ');
    final long = widget.reason.length > 160 || '\n'.allMatches(widget.reason).length > 2;
    final enabled = !_busy && !agent.isRunning;
    // Three buttons of one height and shape; the first is the main one.
    final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radius));
    const size = Size(0, 36);
    const pad = EdgeInsets.symmetric(horizontal: 16);
    return Container(padding: const EdgeInsets.all(16), decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.danger.withValues(alpha: .45)), borderRadius: BorderRadius.circular(context.radiusLg)), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('这次没能完成', style: context.text.titleSmall), const SizedBox(height: 6),
      Text(headline, style: context.text.bodyMedium),
      if (meta.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(meta, style: context.text.bodySmall?.copyWith(color: colors.muted))),
      if (explained) Padding(padding: const EdgeInsets.only(top: 6), child: AnimatedSize(
        duration: AppTokens.motion(context, AppTokens.medium), curve: AppTokens.curve, alignment: Alignment.topLeft,
        child: SelectableText(widget.reason, maxLines: long && !_expanded ? 3 : null, style: context.text.bodySmall?.copyWith(color: colors.muted, fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback)),
      )),
      if (explained && long) Align(alignment: Alignment.centerLeft, child: TextButton(style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: EdgeInsets.zero), onPressed: () => setState(() => _expanded = !_expanded), child: Text(_expanded ? '收起' : '展开原始信息'))),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: TextStyle(color: colors.danger))),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        FilledButton(style: FilledButton.styleFrom(minimumSize: size, padding: pad, shape: shape), onPressed: enabled ? _retry : null, child: Text(_busy ? '正在重试…' : '重试')),
        MenuAnchor(
          menuChildren: [for (final model in agent.pickableModels()) MenuItemButton(onPressed: () => _retry(model), child: Text(model.name))],
          builder: (context, menu, _) => OutlinedButton(style: OutlinedButton.styleFrom(minimumSize: size, padding: pad, shape: shape), onPressed: enabled && agent.models.isNotEmpty ? () => menu.isOpen ? menu.close() : menu.open() : null, child: const Text('换个模型')),
        ),
        OutlinedButton(style: OutlinedButton.styleFrom(minimumSize: size, padding: pad, shape: shape), onPressed: () => agent.main.openSettings('模型'), child: const Text('去设置')),
      ]),
    ]));
  }
}

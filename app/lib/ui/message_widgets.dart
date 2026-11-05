import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/mentions.dart';
import '../state/agent_controller.dart' show asJsonMap;
import '../state/session_runtime.dart' show MessageBranch;
import '../theme.dart';
import 'agent_scope.dart';
import 'card_view.dart';
import 'common.dart' show ImageThumb;
import 'composer.dart' show MentionChip;
import 'markdown_view.dart';
import 'motion.dart';
import 'dashboard_page.dart' show formatCost, formatTokens;

// ---------------------------------------------------------------------------
// Rows: a question, or the whole reply to it
// ---------------------------------------------------------------------------

/// What the conversation shows: each question, then everything the agent
/// did and said in reply (several assistant messages, tool calls, notices)
/// as one row.
sealed class ChatRow {
  const ChatRow();

  /// Stable identity for list rendering.
  String get key;

  static List<ChatRow> fromItems(List<TranscriptItem> items) {
    final rows = <ChatRow>[];
    UserItem? question;
    var pending = <TranscriptItem>[];
    void close(UserItem? next) {
      if (pending.isNotEmpty) {
        rows.add(ReplyRow(pending, ReplyInfo.of(pending, question: question, nextQuestion: next)));
      }
      pending = [];
    }

    for (final item in items) {
      switch (item) {
        case UserItem():
          close(item);
          question = item;
          rows.add(QuestionRow(item));
        case AssistantItem() || NoticeItem():
          pending.add(item);
      }
    }
    close(null);
    return rows;
  }
}

class QuestionRow extends ChatRow {
  const QuestionRow(this.item);
  final UserItem item;

  @override
  String get key => item.key;
}

class ReplyRow extends ChatRow {
  const ReplyRow(this.items, this.info);

  /// Assistant messages and notices, in order.
  final List<TranscriptItem> items;
  final ReplyInfo info;

  @override
  String get key => items.first.key;

  List<AssistantItem> get assistants => items.whereType<AssistantItem>().toList();
}

/// One answer to a question, for its actions.
class ReplyInfo {
  const ReplyInfo({required this.question, required this.nextQuestion, required this.text});

  factory ReplyInfo.of(List<TranscriptItem> items, {UserItem? question, UserItem? nextQuestion}) => ReplyInfo(
    question: question,
    nextQuestion: nextQuestion,
    text: [
      for (final item in items.whereType<AssistantItem>())
        for (final part in item.parts.whereType<TextPart>())
          if (part.text.trim().isNotEmpty) part.text.trim(),
    ].join('\n\n'),
  );

  /// The message this replies to (null when history was compacted away).
  final UserItem? question;

  /// The message after this reply; null for the last reply.
  final UserItem? nextQuestion;

  /// The reply's text parts as Markdown.
  final String text;

  bool get isLatest => nextQuestion == null;
}

class ChatRowView extends StatelessWidget {
  const ChatRowView({super.key, required this.row, required this.transcript});

  final ChatRow row;
  final Transcript transcript;

  @override
  Widget build(BuildContext context) => switch (row) {
    QuestionRow(:final item) => _UserBubble(item: item),
    final ReplyRow reply => _ReplyView(row: reply, transcript: transcript, live: transcript.isRunning && reply.info.isLatest),
  };
}

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

class _UserBubble extends StatefulWidget {
  const _UserBubble({required this.item});

  final UserItem item;

  @override
  State<_UserBubble> createState() => _UserBubbleState();
}

class _UserBubbleState extends State<_UserBubble> {
  var _hovered = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final agent = AgentScope.of(context);
    final item = widget.item;
    final branch = agent.active?.branchFor(item);
    final busy = agent.isRunning;
    // Desk notes, materials and files sent along show as chips.
    final (question, attached) = splitMentions(item.text);
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (item.images.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                alignment: WrapAlignment.end,
                children: [
                  for (final image in item.images) ImageThumb(base64: image.data, height: 140),
                ],
              ),
            ),
          if (item.images.isNotEmpty) VisionNote(images: item.images),
          if (attached.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Wrap(spacing: 6, runSpacing: 6, alignment: WrapAlignment.end, children: [for (final m in attached) MentionChip(mention: m)]),
            ),
          if (question.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                decoration: BoxDecoration(color: colors.userBubble, borderRadius: BorderRadius.circular(context.radiusLg)),
                child: Text(question, style: context.text.bodyMedium?.copyWith(color: colors.onUserBubble, height: 1.7)),
              ),
            ),
          SizedBox(
            height: 26,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AnimatedOpacity(
                  opacity: _hovered ? 1 : 0,
                  duration: AppTokens.fast,
                  child: Row(
                    children: [
                      _ActionButton(
                        icon: Icons.copy_outlined,
                        tooltip: '复制',
                        onTap: () {
                          Clipboard.setData(ClipboardData(text: question));
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制'), duration: Duration(seconds: 1)));
                        },
                      ),
                      if (branch != null) ...[
                        _ActionButton(
                          icon: Icons.edit_outlined,
                          tooltip: busy ? '回复结束后才能编辑' : '编辑后重新发送（原来的版本会保留，可以切换回去）',
                          onTap: busy ? null : () => AgentScope.read(context).editMessage(item),
                        ),
                        _ActionButton(
                          icon: Icons.refresh,
                          tooltip: busy ? '回复结束后才能重新生成' : '重新生成回复（原来的回复会保留）',
                          onTap: busy ? null : () => AgentScope.read(context).regenerate(item),
                        ),
                      ],
                      _ActionButton(
                        icon: Icons.call_split,
                        tooltip: busy ? '回复结束后才能分叉' : '分叉为新会话：保留这条消息之前的内容，并把这条消息放回输入框供你修改',
                        onTap: busy ? null : () => AgentScope.read(context).forkFrom(item),
                      ),
                    ],
                  ),
                ),
                if (branch != null && branch.total > 1) _VersionSwitcher(item: item, branch: branch, enabled: !busy),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// "‹ 2/3 ›": switches between versions of an edited message in place.
class _VersionSwitcher extends StatelessWidget {
  const _VersionSwitcher({required this.item, required this.branch, required this.enabled});

  final UserItem item;
  final MessageBranch branch;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.read(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _ActionButton(
          icon: Icons.chevron_left,
          tooltip: '上一个版本',
          onTap: enabled && branch.index > 0 ? () => agent.switchVersion(item, branch.index - 1) : null,
        ),
        Text('${branch.index + 1}/${branch.total}', style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
        _ActionButton(
          icon: Icons.chevron_right,
          tooltip: '下一个版本',
          onTap: enabled && branch.index < branch.total - 1 ? () => agent.switchVersion(item, branch.index + 1) : null,
        ),
      ],
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({required this.icon, required this.tooltip, required this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    onPressed: onTap,
    iconSize: 18,
    padding: EdgeInsets.zero,
    constraints: const BoxConstraints(minWidth: 36, minHeight: 34),
    icon: Icon(icon, color: context.colors.muted),
  );
}

class QueuedMessages extends StatelessWidget {
  const QueuedMessages({super.key, required this.messages});

  final List<String> messages;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (final message in messages)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                border: Border.all(color: colors.border),
                borderRadius: BorderRadius.circular(context.radiusLg),
              ),
              child: Text('等这一步做完就插进去：$message', style: context.text.bodySmall?.copyWith(color: colors.muted)),
            ),
          ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

/// A piece of a reply: text, a run of work (thinking and tool calls), a
/// notice, or an inline note (failed, stopped, truncated).
sealed class _Segment {}

class _TextSegment extends _Segment {
  _TextSegment(this.text);
  final String text;
}

class _WorkSegment extends _Segment {
  final steps = <Object>[]; // ThinkingPart or ToolRun
  var waiting = false; // a message has started but shown nothing yet
}

class _NoticeSegment extends _Segment {
  _NoticeSegment(this.notice);
  final NoticeItem notice;
}

class _CardSegment extends _Segment {
  _CardSegment(this.run);
  final ToolRun run;
}

class _NoteSegment extends _Segment {
  _NoteSegment(this.icon, this.color, this.text);
  final IconData icon;
  final Color color;
  final String text;
}

List<_Segment> _segments(ReplyRow row, Transcript transcript, AppColors colors) {
  final segments = <_Segment>[];
  _WorkSegment work() {
    final last = segments.isEmpty ? null : segments.last;
    if (last is _WorkSegment) return last;
    return _WorkSegment().also(segments.add);
  }

  for (final item in row.items) {
    switch (item) {
      case NoticeItem():
        segments.add(_NoticeSegment(item));
      case AssistantItem():
        if (item.streaming && item.parts.isEmpty) work().waiting = true;
        for (final part in item.parts) {
          switch (part) {
            case TextPart(:final text):
              if (text.trim().isNotEmpty) segments.add(_TextSegment(text));
            case ThinkingPart():
              if (part.text.trim().isNotEmpty || part.redacted) work().steps.add(part);
            case ToolCallPart(:final toolCallId):
              final run = transcript.tool(toolCallId);
              // A card the agent shows is content, not work.
              if (run != null && run.name == 'show_card') {
                segments.add(_CardSegment(run));
              } else if (run != null) {
                work().steps.add(run);
              }
          }
        }
        if (item.failed) {
          segments.add(_NoteSegment(Icons.error_outline, colors.danger, '模型请求失败：${item.errorMessage ?? '未知错误'}'));
        } else if (item.aborted) {
          segments.add(_NoteSegment(Icons.stop_circle_outlined, colors.muted, '已停止'));
        } else if (item.truncated) {
          segments.add(_NoteSegment(Icons.warning_amber_rounded, colors.warning, '回复达到长度上限，被截断了'));
        }
      case UserItem():
        break;
    }
  }
  return segments;
}

extension<T> on T {
  T also(void Function(T) action) {
    action(this);
    return this;
  }
}

class _ReplyView extends StatelessWidget {
  const _ReplyView({required this.row, required this.transcript, required this.live});

  final ReplyRow row;
  final Transcript transcript;

  /// The reply is still being written.
  final bool live;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final segments = _segments(row, transcript, colors);
    final lastText = segments.lastIndexWhere((s) => s is _TextSegment);
    final streaming = row.assistants.any((a) => a.streaming);
    final children = <Widget>[];
    for (final (index, segment) in segments.indexed) {
      final isLast = index == segments.length - 1;
      children.add(switch (segment) {
        _TextSegment(:final text) => index == lastText && live && streaming && isLast
            ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [ReplyMarkdown(text: text), const StreamingCaret()])
            : ReplyMarkdown(text: text),
        _WorkSegment() => WorkBlock(steps: segment.steps, active: live && isLast, waiting: segment.waiting),
        _NoticeSegment(:final notice) => _NoticeView(notice: notice),
        _CardSegment(:final run) => CardBlock(key: ValueKey('card-${run.id}'), run: run),
        _NoteSegment(:final icon, :final color, :final text) => _InlineNote(icon: icon, color: color, text: text),
      });
    }
    if (live && segments.isEmpty) children.add(const WorkBlock(steps: [], active: true, waiting: true));
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [for (final child in children) Padding(padding: const EdgeInsets.symmetric(vertical: 5), child: child)],
    );
    if (live) return content;
    return _ReplyFrame(row: row, child: content);
  }
}

/// A finished reply with its numbers and actions. The latest reply always
/// shows the actions; older ones on hover or keyboard focus.
class _ReplyFrame extends StatefulWidget {
  const _ReplyFrame({required this.row, required this.child});

  final ReplyRow row;
  final Widget child;

  @override
  State<_ReplyFrame> createState() => _ReplyFrameState();
}

class _ReplyFrameState extends State<_ReplyFrame> {
  var _hovered = false;
  var _focused = false;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final info = widget.row.info;
    final busy = agent.isRunning;
    final question = info.question;
    final branch = question == null ? null : agent.active?.branchFor(question);
    final canRegenerate = branch != null && !busy;
    final others = agent.models.where((m) => m != agent.model).toList();
    // 0.4 (test 21): the numbers and the buttons show together, only under the mouse or with keyboard focus.
    final visible = _hovered || _focused;
    String modelName(String id) => agent.models.where((m) => m.id == id).firstOrNull?.name ?? id;
    final facts = replyFacts(widget.row.assistants, modelName: modelName);
    final short = replyFactsShort(widget.row.assistants, modelName: modelName);
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          widget.child,
          const SizedBox(height: 4),
          Focus(
            skipTraversal: true,
            onFocusChange: (focused) => setState(() => _focused = focused),
            child: SizedBox(
              height: 36,
              child: Row(
                children: [
                  AnimatedOpacity(
                    opacity: visible ? 1 : 0,
                    duration: AppTokens.fast,
                    child: Row(
                      children: [
                        _ActionButton(
                          icon: Icons.copy_outlined,
                          tooltip: '复制回复（Markdown 原文）',
                          onTap: info.text.isEmpty
                              ? null
                              : () {
                                  Clipboard.setData(ClipboardData(text: info.text));
                                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制'), duration: Duration(seconds: 1)));
                                },
                        ),
                        _ActionButton(
                          icon: Icons.refresh,
                          tooltip: busy
                              ? '回复结束后才能重新生成'
                              : branch == null
                              ? '这条回复对应的问题已被压缩，无法重新生成'
                              : '重新生成（原来的回复会保留，可以切换回去）',
                          onTap: canRegenerate ? () => AgentScope.read(context).regenerate(question!) : null,
                        ),
                        if (others.isNotEmpty)
                          PopupMenuButton<PiModel>(
                            tooltip: '换一个模型重新生成',
                            enabled: canRegenerate,
                            padding: EdgeInsets.zero,
                            iconSize: 18,
                            icon: Icon(Icons.expand_more, color: colors.muted),
                            style: IconButton.styleFrom(minimumSize: const Size(24, 34), padding: EdgeInsets.zero, visualDensity: VisualDensity.compact),
                            itemBuilder: (_) => [
                              for (final m in others) PopupMenuItem(value: m, child: Text('用 ${m.name} 重新生成')),
                            ],
                            onSelected: (m) => AgentScope.read(context).regenerate(question!, model: m),
                          ),
                        _ActionButton(
                          icon: Icons.call_split,
                          tooltip: busy ? '回复结束后才能分叉' : '从这里分叉：新开一个会话，保留到这条回复为止的内容',
                          onTap: busy ? null : () => AgentScope.read(context).forkAfterReply(info.nextQuestion),
                        ),
                      ],
                    ),
                  ),
                  if (question != null && branch != null && branch.total > 1)
                    _VersionSwitcher(item: question, branch: branch, enabled: !busy),
                  if (short.isNotEmpty)
                    Expanded(
                      child: AnimatedOpacity(
                        opacity: visible ? 1 : 0,
                        duration: AppTokens.fast,
                        child: Padding(
                          padding: const EdgeInsets.only(left: 8),
                          child: Tooltip(
                            message: facts,
                            child: Text(short, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.labelSmall?.copyWith(color: colors.muted, fontSize: 12)),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The reply's numbers kept under it (0.4): model · how long · cost; the rest is in [replyFacts], on hover.
String replyFactsShort(List<AssistantItem> replies, {required String Function(String id) modelName}) {
  if (replies.isEmpty) return '';
  final first = replies.first;
  final last = replies.last;
  final cost = replies.fold<double>(0, (sum, r) => sum + (r.usage?.costTotal ?? 0));
  final took = first.requestedAt != null && last.endedAt != null ? last.endedAt!.difference(first.requestedAt!) : null;
  return [
    if (last.model.isNotEmpty) modelName(last.model),
    if (took != null) took.inMilliseconds < 10000 ? '${(took.inMilliseconds / 1000).toStringAsFixed(1)} 秒' : '${took.inSeconds} 秒',
    if (cost > 0) formatCost(cost),
  ].join(' · ');
}

/// The reply's numbers in one line: model · input / output / cache tokens ·
/// time to first token · speed · duration · cost · time of day. Live timing
/// is only known for replies the window watched.
String replyFacts(List<AssistantItem> replies, {required String Function(String id) modelName, DateTime? now}) {
  if (replies.isEmpty) return '';
  var input = 0, output = 0, cache = 0;
  var cost = 0.0;
  var generatingMs = 0, generated = 0;
  for (final r in replies) {
    final u = r.usage;
    if (u != null) {
      input += u.input;
      output += u.output;
      cache += u.cacheRead;
      cost += u.costTotal;
    }
    if (r.firstTokenAt != null && r.endedAt != null && (u?.output ?? 0) > 0) {
      generatingMs += r.endedAt!.difference(r.firstTokenAt!).inMilliseconds;
      generated += u!.output;
    }
  }
  final first = replies.first;
  final last = replies.last;
  final ttft = first.timeToFirstToken;
  final took = first.requestedAt != null && last.endedAt != null ? last.endedAt!.difference(first.requestedAt!) : null;
  String seconds(Duration d) => d.inMilliseconds < 10000 ? '${(d.inMilliseconds / 1000).toStringAsFixed(1)} 秒' : '${d.inSeconds} 秒';
  String clock() {
    if (first.timestamp <= 0) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(first.timestamp);
    final today = now ?? DateTime.now();
    final hm = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    return t.year == today.year && t.month == today.month && t.day == today.day ? hm : '${t.month}月${t.day}日 $hm';
  }

  return [
    if (last.model.isNotEmpty) modelName(last.model),
    if (input > 0) '输入 ${formatTokens(input)}',
    if (output > 0) '输出 ${formatTokens(output)}',
    if (cache > 0) '缓存 ${formatTokens(cache)}',
    if (ttft != null) '首字 ${seconds(ttft)}',
    if (generatingMs > 0) '${(generated * 1000 / generatingMs).round()} token/秒',
    if (took != null) '耗时 ${seconds(took)}',
    if (cost > 0) formatCost(cost),
    clock(),
  ].where((s) => s.isNotEmpty).join(' · ');
}

// ---------------------------------------------------------------------------
// Work: thinking and tool calls between the words
// ---------------------------------------------------------------------------

/// A run of thinking and tool calls, summed up in one line
/// (「思考了 12 秒 · 读取 2 个文件 · 运行 1 条命令」). Folded by default (0.4,
/// tests 32 and extra 7): while it runs the header says what it is doing and
/// the latest three steps show one line each; opened, every step in full.
class WorkBlock extends StatefulWidget {
  const WorkBlock({super.key, required this.steps, required this.active, this.waiting = false});

  final List<Object> steps;
  final bool active;

  /// The model has been asked but has not produced anything yet.
  final bool waiting;

  @override
  State<WorkBlock> createState() => _WorkBlockState();
}

class _WorkBlockState extends State<WorkBlock> {
  bool? _expanded;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final steps = widget.steps;
    final expanded = _expanded ?? false;
    const previewSteps = 3;
    final tools = steps.whereType<ToolRun>().toList();
    final errors = tools.where((t) => t.status == ToolStatus.error).length;
    final toolMs = tools.fold<int>(0, (sum, t) => sum + (t.durationMs ?? 0));
    final summary = workSummary(steps);
    final current = widget.active ? _currentStep(steps) : null;
    final headerText = widget.active ? (current ?? (summary.isEmpty ? '正在思考…' : summary)) : (summary.isEmpty ? '思考过' : summary);
    final canExpand = steps.isNotEmpty;
    return Container(
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: errors > 0 ? colors.danger.withValues(alpha: 0.4) : colors.border),
        borderRadius: BorderRadius.circular(context.radiusLg),
      ),
      clipBehavior: Clip.antiAlias,
      child: AnimatedSize(
        duration: AppTokens.medium,
        curve: Curves.easeOutCubic,
        alignment: Alignment.topCenter,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InkWell(
              onTap: canExpand ? () => setState(() => _expanded = !expanded) : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                child: Row(
                  children: [
                    if (widget.active)
                      const Padding(padding: EdgeInsets.all(4), child: BreathingDot())
                    else
                      Icon(errors > 0 ? Icons.error_outline : Icons.check, size: 15, color: errors > 0 ? colors.danger : colors.accent),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        headerText,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall?.copyWith(fontSize: 13, color: colors.ink2),
                      ),
                    ),
                    if (errors > 0) ...[
                      Text('$errors 个出错', style: context.text.bodySmall?.copyWith(color: colors.danger)),
                      const SizedBox(width: 8),
                    ],
                    if (toolMs > 0 && !widget.active) ...[
                      Text(_seconds(toolMs), style: context.text.bodySmall?.copyWith(color: colors.muted)),
                      const SizedBox(width: 6),
                    ],
                    if (canExpand) Icon(expanded ? Icons.expand_less : Icons.expand_more, size: 16, color: colors.muted),
                  ],
                ),
              ),
            ),
            if (expanded && canExpand) ...[
              Divider(height: 0.5, color: colors.border),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final step in steps)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3),
                        child: step is ThinkingPart ? _ThinkingStep(part: step) : ToolStep(run: step as ToolRun),
                      ),
                  ],
                ),
              ),
            ] else if (widget.active && canExpand) ...[
              Divider(height: 0.5, color: colors.border),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 6, 14, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (steps.length > previewSteps)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 2),
                        child: Text('前面还有 ${steps.length - previewSteps} 步', style: context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted)),
                      ),
                    for (final step in steps.skip((steps.length - previewSteps).clamp(0, steps.length))) _OneLineStep(step: step),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// What is happening right now, for the header of a running block.
  static String? _currentStep(List<Object> steps) {
    if (steps.isEmpty) return null;
    final last = steps.last;
    if (last is ThinkingPart) return '正在思考…';
    if (last is ToolRun && last.isActive) return '正在${_verb(last.name)}：${toolSubject(last)}';
    return null;
  }

  static String _verb(String tool) => switch (tool) {
    'read' => '读取',
    'grep' || 'find' || 'glob' => '搜索',
    'ls' => '查看目录',
    'bash' || 'powershell' || 'pwsh' => '运行',
    'edit' => '修改',
    'write' => '写入',
    'web_fetch' => '读取网页',
    'read_image' => '看图',
    'working_directory' => '切换目录',
    'job_output' || 'job_list' || 'job_kill' => '查看后台任务',
    'skill' => '载入技能',
    'todo_write' => '更新待办',
    'ask_user_question' => '等你回答',
    'exit_plan_mode' => '等你审阅计划',
    'agent' => '让子 Agent 干活',
    _ => '调用 $tool',
  };
}

/// A step as one line, for a running block that is folded: what it is and how it is going.
class _OneLineStep extends StatelessWidget {
  const _OneLineStep({required this.step});

  final Object step;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final step = this.step;
    if (step is ThinkingPart) {
      final first = step.text.trim().split('\n').firstWhere((l) => l.trim().isNotEmpty, orElse: () => '');
      return _StepLine(icon: Icons.psychology_outlined, verb: '思考', subject: step.redacted ? null : first);
    }
    final run = step as ToolRun;
    final (icon, verb) = toolIconVerb(run.name);
    final trailing = switch (run.status) {
      ToolStatus.running || ToolStatus.pending || ToolStatus.drafting => const SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.3)),
      ToolStatus.error => Text('出错', style: context.text.bodySmall?.copyWith(color: colors.danger)),
      _ => null,
    };
    return _StepLine(icon: icon, verb: verb, subject: toolSubject(run), trailing: trailing);
  }
}

/// The icon and verb a tool call is shown with. MCP tools (`mcp__server__tool`) say which server and tool.
(IconData, String) toolIconVerb(String name) => switch (name) {
  'read' => (Icons.description_outlined, '读取'),
  'read_image' => (Icons.image_outlined, '看图'),
  'grep' => (Icons.search, '搜索'),
  'find' || 'glob' => (Icons.manage_search, '查找文件'),
  'ls' => (Icons.folder_open_outlined, '查看目录'),
  'web_fetch' => (Icons.language, '读取网页'),
  'web_search' => (Icons.travel_explore, '搜索网页'),
  'bash' || 'powershell' || 'pwsh' => (Icons.terminal, '运行'),
  'edit' => (Icons.edit_outlined, '修改'),
  'write' => (Icons.note_add_outlined, '写入'),
  'agent' => (Icons.hub_outlined, '子 Agent'),
  'todo_write' => (Icons.checklist_rounded, '更新待办'),
  'exit_plan_mode' => (Icons.map_outlined, '计划'),
  'working_directory' => (Icons.drive_file_move_outlined, '工作目录'),
  'job_output' || 'job_list' => (Icons.pending_outlined, '后台任务'),
  'job_kill' => (Icons.stop_circle_outlined, '停止后台任务'),
  'skill' => (Icons.auto_awesome_outlined, '载入技能'),
  'ask_user_question' => (Icons.help_outline, '向你提问'),
  _ when name.startsWith('mcp__') => (Icons.extension_outlined, 'MCP · ${name.substring(5).split('__').join(' · ')}'),
  _ => (Icons.extension_outlined, name),
};

/// Tools that only keep the agent's own bookkeeping (not counted as work).
const _bookkeepingTools = {'read_card', 'todo_write', 'working_directory', 'job_list', 'job_output', 'ask_user_question', 'exit_plan_mode', 'skill'};

String _seconds(int ms) => ms < 1000 ? '$ms 毫秒' : ms < 10000 ? '${(ms / 1000).toStringAsFixed(1)} 秒' : '${(ms / 1000).round()} 秒';

/// 「思考了 12 秒 · 读取 2 个文件 · 运行 1 条命令 · 修改 1 个文件」.
String workSummary(List<Object> steps) {
  final thinking = steps.whereType<ThinkingPart>().toList();
  final tools = steps.whereType<ToolRun>().toList();
  final thoughtMs = thinking.fold<int>(0, (sum, t) => sum + (t.durationMs ?? 0));
  int count(bool Function(ToolRun) test) => tools.where(test).length;
  int files(String name) => tools.where((t) => t.name == name).map((t) => t.args['path'] ?? t.args['file_path'] ?? t.id).toSet().length;
  const known = {'read', 'read_image', 'grep', 'find', 'glob', 'ls', 'bash', 'powershell', 'pwsh', 'edit', 'write', 'web_fetch', 'job_kill', 'agent', ..._bookkeepingTools};
  final searches = count((t) => t.name == 'grep' || t.name == 'find' || t.name == 'glob' || t.name == 'ls');
  final commands = count((t) => t.name == 'bash' || t.name == 'powershell' || t.name == 'pwsh');
  final pages = count((t) => t.name == 'web_fetch');
  final subagents = count((t) => t.name == 'agent');
  final images = files('read_image');
  final others = count((t) => !known.contains(t.name));
  return [
    if (thinking.isNotEmpty) thoughtMs >= 1000 ? '思考了 ${(thoughtMs / 1000).round()} 秒' : (thoughtMs > 0 ? '思考了片刻' : '思考过'),
    if (files('read') > 0) '读取 ${files('read')} 个文件',
    if (images > 0) '看了 $images 张图',
    if (searches > 0) '搜索 $searches 次',
    if (commands > 0) '运行 $commands 条命令',
    if (files('edit') > 0) '修改 ${files('edit')} 个文件',
    if (files('write') > 0) '写入 ${files('write')} 个文件',
    if (pages > 0) '读取 $pages 个网页',
    if (subagents > 0) '派出 $subagents 个子 Agent',
    if (others > 0) '调用 $others 次工具',
  ].join(' · ');
}

/// The most telling argument of a tool call, on one line.
String toolSubject(ToolRun run) {
  final args = run.args;
  switch (run.name) {
    case 'todo_write':
      final todos = args['todos'];
      if (todos is List) return '${todos.length} 项';
    case 'ask_user_question':
      final questions = args['questions'];
      if (questions is List && questions.isNotEmpty && questions.first is Map) return '${(questions.first as Map)['question'] ?? ''}'.replaceAll('\n', ' ');
    case 'exit_plan_mode':
      final plan = args['plan'];
      if (plan is String) return plan.trimLeft().split('\n').first.replaceFirst(RegExp(r'^#+\s*'), '');
    case 'agent':
      if (args['description'] is String) return args['description'] as String;
    case 'working_directory':
      return args['cd'] is String ? args['cd'] as String : '查看当前目录';
  }
  for (final key in ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name', 'job_id']) {
    final value = args[key];
    if (value is String && value.isNotEmpty) return value.replaceAll('\n', ' ');
  }
  if (args.isEmpty && run.argsDraft.isNotEmpty) return run.argsDraft.replaceAll('\n', ' ');
  return args.isEmpty ? '' : formatArguments(args).replaceAll('\n', ' ');
}

class _ThinkingStep extends StatefulWidget {
  const _ThinkingStep({required this.part});

  final ThinkingPart part;

  @override
  State<_ThinkingStep> createState() => _ThinkingStepState();
}

class _ThinkingStepState extends State<_ThinkingStep> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final part = widget.part;
    final ms = part.durationMs;
    final label = part.redacted ? '思考内容已加密' : (ms != null && ms >= 1000 ? '思考 · ${(ms / 1000).round()} 秒' : '思考');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _StepLine(
          icon: Icons.psychology_outlined,
          verb: label,
          onTap: part.redacted ? null : () => setState(() => _open = !_open),
          open: _open,
        ),
        if (!part.redacted)
          Padding(
            padding: const EdgeInsets.only(left: 22, top: 2),
            child: Text(
              part.text.trim(),
              maxLines: _open ? null : 3,
              overflow: _open ? null : TextOverflow.ellipsis,
              style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.65),
            ),
          ),
      ],
    );
  }
}

/// One step's line: icon, verb, subject, and its state at the end.
class _StepLine extends StatelessWidget {
  const _StepLine({required this.icon, required this.verb, this.subject, this.trailing, this.onTap, this.open});

  final IconData icon;
  final String verb;
  final String? subject;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool? open;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12, color: colors.muted);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(context.radiusSm),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          children: [
            Icon(icon, size: 14, color: colors.muted),
            const SizedBox(width: 8),
            Text(verb, style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.ink2)),
            if (subject != null && subject!.isNotEmpty) ...[
              const SizedBox(width: 8),
              Expanded(child: Text(subject!, maxLines: 1, overflow: TextOverflow.ellipsis, style: mono)),
            ] else
              const Spacer(),
            if (trailing != null) ...[const SizedBox(width: 8), trailing!],
            if (open != null) Icon(open! ? Icons.expand_less : Icons.expand_more, size: 14, color: colors.muted),
          ],
        ),
      ),
    );
  }
}

/// A tool call shown by kind: commands as a terminal, edits as a diff,
/// reads and searches as one line that opens to the output.
class ToolStep extends StatefulWidget {
  const ToolStep({super.key, required this.run});

  final ToolRun run;

  @override
  State<ToolStep> createState() => _ToolStepState();
}

class _ToolStepState extends State<ToolStep> {
  bool? _open;

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    final colors = context.colors;
    final trailing = switch (run.status) {
      ToolStatus.running || ToolStatus.pending || ToolStatus.drafting => const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.4)),
      ToolStatus.error => Text('出错', style: context.text.bodySmall?.copyWith(color: colors.danger)),
      ToolStatus.interrupted => Text('已中断', style: context.text.bodySmall?.copyWith(color: colors.muted)),
      ToolStatus.done => Text(run.durationMs == null ? '' : _seconds(run.durationMs!), style: context.text.bodySmall?.copyWith(color: colors.muted)),
    };
    switch (run.name) {
      case 'bash' || 'powershell' || 'pwsh':
        return _TerminalStep(run: run, trailing: trailing);
      case 'todo_write':
        return _TodoStep(run: run, trailing: trailing);
      case 'agent':
        return _SubagentStep(run: run, trailing: trailing);
      case 'exit_plan_mode':
        return _PlanStep(run: run, trailing: trailing);
      case 'edit' || 'write' when run.name == 'edit' || run.details['patch'] is String:
        final open = _open ?? true;
        final diff = editDiff(run);
        final added = diff.where((l) => l.kind == DiffKind.added).length;
        final removed = diff.where((l) => l.kind == DiffKind.removed).length;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _StepLine(
              icon: run.name == 'edit' ? Icons.edit_outlined : Icons.note_add_outlined,
              verb: run.name == 'edit' ? '修改' : '写入',
              subject: toolSubject(run),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (added > 0) Text('+$added ', style: context.text.bodySmall?.copyWith(color: colors.accent)),
                  if (removed > 0) Text('−$removed ', style: context.text.bodySmall?.copyWith(color: colors.danger)),
                  if (added > 0 || removed > 0) const SizedBox(width: 6),
                  trailing,
                ],
              ),
              onTap: diff.isEmpty ? null : () => setState(() => _open = !open),
              open: diff.isEmpty ? null : open,
            ),
            if (open && diff.isNotEmpty) Padding(padding: const EdgeInsets.only(left: 22, top: 4), child: DiffView(lines: diff)),
            if (run.status == ToolStatus.error) _OutputBox(text: run.outputText, error: true),
          ],
        );
      case 'write':
        final content = run.args['content'] is String ? run.args['content'] as String : '';
        final lines = content.isEmpty ? 0 : '\n'.allMatches(content).length + 1;
        return _Expandable(
          line: (open, toggle) => _StepLine(
            icon: Icons.note_add_outlined,
            verb: '写入',
            subject: toolSubject(run),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [if (lines > 0) Text('+$lines 行 ', style: context.text.bodySmall?.copyWith(color: colors.accent)), trailing],
            ),
            onTap: toggle,
            open: open,
          ),
          body: _OutputBox(text: run.status == ToolStatus.error ? run.outputText : content, error: run.status == ToolStatus.error),
          startOpen: run.status == ToolStatus.error,
        );
      default:
        final (icon, verb) = toolIconVerb(run.name);
        final known = const {
          'read', 'read_image', 'grep', 'find', 'glob', 'ls', 'web_fetch', 'working_directory', 'job_output', 'job_list', 'job_kill', 'skill', 'ask_user_question',
        }.contains(run.name);
        // Pictures the tool returned (看图, screenshots from MCP tools): small, and open in full on a click.
        final images = run.output.whereType<ImageBlock>().toList();
        final line = _Expandable(
          line: (open, toggle) => _StepLine(icon: icon, verb: verb, subject: toolSubject(run), trailing: trailing, onTap: toggle, open: open),
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (!known && run.args.isNotEmpty) _OutputBox(text: formatArguments(run.args)),
              if (run.outputText.isNotEmpty || images.isEmpty) _OutputBox(text: run.outputText.isEmpty ? '（无输出）' : run.outputText, error: run.status == ToolStatus.error),
            ],
          ),
          startOpen: run.status == ToolStatus.error,
        );
        if (images.isEmpty) return line;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            line,
            Padding(
              padding: const EdgeInsets.only(left: 22, top: 4, bottom: 2),
              child: Wrap(spacing: 6, runSpacing: 6, children: [for (final image in images) ImageThumb(base64: image.data)]),
            ),
          ],
        );
    }
  }
}

/// A subagent sent off by the `agent` tool: its role and task on one line,
/// what it is doing while it runs, and its reply and numbers when opened.
class _SubagentStep extends StatelessWidget {
  const _SubagentStep({required this.run, required this.trailing});

  final ToolRun run;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final d = run.details;
    final role = d['roleName'] as String? ?? '子 Agent';
    final title = (d['description'] as String?) ?? (run.args['description'] as String?) ?? '';
    final activity = run.isActive ? (d['status'] == 'waiting' ? '排队中' : d['activity'] as String?) : null;
    final turns = (d['turns'] as num?)?.toInt() ?? 0;
    final calls = (d['toolCalls'] as num?)?.toInt() ?? 0;
    final cost = (d['cost'] as num?)?.toDouble() ?? 0;
    final stats = [
      if (d['model'] is String) (d['model'] as String).split('/').last,
      if (turns > 0) '$turns 轮',
      if (calls > 0) '$calls 次工具',
      if ((d['inputTokens'] as num? ?? 0) > 0) '输入 ${formatTokens((d['inputTokens'] as num).toInt())} / 输出 ${formatTokens((d['outputTokens'] as num? ?? 0).toInt())}',
      if (cost > 0) formatCost(cost),
      if (d['stoppedBy'] == 'maxTurns') '到了轮数上限',
      if (d['stoppedBy'] == 'aborted') '已停止',
    ].join(' · ');
    return _Expandable(
      line: (open, toggle) => _StepLine(
        icon: Icons.hub_outlined,
        verb: '子 Agent · $role',
        subject: activity == null || activity.isEmpty ? title : '$title · $activity',
        trailing: trailing,
        onTap: run.isActive ? null : toggle,
        open: run.isActive ? null : open,
      ),
      body: Padding(
        padding: const EdgeInsets.only(left: 22, top: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (run.status == ToolStatus.error)
              _OutputBox(text: run.outputText, error: true)
            else
              ReplyMarkdown(text: run.outputText.isEmpty ? '（没有回复）' : run.outputText),
            if (stats.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(stats, style: context.text.bodySmall?.copyWith(color: colors.muted))),
          ],
        ),
      ),
      startOpen: run.status == ToolStatus.error,
    );
  }
}

/// A step line that opens to show [body].
class _Expandable extends StatefulWidget {
  const _Expandable({required this.line, required this.body, this.startOpen = false});

  final Widget Function(bool open, VoidCallback toggle) line;
  final Widget body;
  final bool startOpen;

  @override
  State<_Expandable> createState() => _ExpandableState();
}

class _ExpandableState extends State<_Expandable> {
  late var _open = widget.startOpen;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      widget.line(_open, () => setState(() => _open = !_open)),
      if (_open) Padding(padding: const EdgeInsets.only(left: 22, top: 4), child: widget.body),
    ],
  );
}

/// The agent's todo list (todo_write) as a small checklist.
class _TodoStep extends StatelessWidget {
  const _TodoStep({required this.run, required this.trailing});

  final ToolRun run;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    final todos = todoItems(run.args['todos']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _StepLine(icon: Icons.checklist, verb: '待办', subject: toolSubject(run), trailing: trailing),
        if (todos.isNotEmpty) Padding(padding: const EdgeInsets.only(left: 22, top: 2, bottom: 2), child: TodoList(todos: todos)),
        if (run.status == ToolStatus.error) _OutputBox(text: run.outputText, error: true),
      ],
    );
  }
}

/// One item of the agent's todo list.
typedef TodoItem = ({String content, String status});

List<TodoItem> todoItems(Object? raw) => raw is List
    ? [
        for (final item in raw.whereType<Map>())
          if (item['content'] is String) (content: item['content'] as String, status: item['status'] is String ? item['status'] as String : 'pending'),
      ]
    : const [];

/// A checklist: done items struck through, the current one in the accent colour.
class TodoList extends StatelessWidget {
  const TodoList({super.key, required this.todos});

  final List<TodoItem> todos;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final todo in todos)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Icon(
                    switch (todo.status) {
                      'completed' => Icons.check_circle,
                      'in_progress' => Icons.radio_button_checked,
                      _ => Icons.radio_button_unchecked,
                    },
                    size: 14,
                    color: todo.status == 'pending' ? colors.muted : colors.accent,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    todo.content,
                    style: context.text.bodySmall?.copyWith(
                      color: todo.status == 'completed' ? colors.muted : colors.ink2,
                      decoration: todo.status == 'completed' ? TextDecoration.lineThrough : null,
                      fontWeight: todo.status == 'in_progress' ? FontWeight.w600 : null,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// A plan the agent presented for review (exit_plan_mode), shown as Markdown.
class _PlanStep extends StatefulWidget {
  const _PlanStep({required this.run, required this.trailing});

  final ToolRun run;
  final Widget trailing;

  @override
  State<_PlanStep> createState() => _PlanStepState();
}

class _PlanStepState extends State<_PlanStep> {
  bool? _open;

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    final colors = context.colors;
    final plan = run.args['plan'] is String ? run.args['plan'] as String : '';
    final approved = run.details['approved'] == true;
    final open = _open ?? !approved;
    final status = switch (run.status) {
      ToolStatus.done when approved => Text('已批准', style: context.text.bodySmall?.copyWith(color: colors.accent)),
      ToolStatus.error => Text('继续修改', style: context.text.bodySmall?.copyWith(color: colors.muted)),
      _ => widget.trailing,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _StepLine(icon: Icons.map_outlined, verb: '计划', subject: toolSubject(run), trailing: status, onTap: () => setState(() => _open = !open), open: open),
        if (open && plan.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(left: 22, top: 4, bottom: 4),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: colors.accent, width: 2)),
              color: colors.codeBackground,
              borderRadius: BorderRadius.circular(context.radius),
            ),
            child: ReplyMarkdown(text: plan),
          ),
        if (run.status == ToolStatus.error && run.outputText.isNotEmpty) _OutputBox(text: run.outputText),
      ],
    );
  }
}

/// Tool output in a quiet monospaced box; long output keeps its end.
class _OutputBox extends StatelessWidget {
  const _OutputBox({required this.text, this.error = false});

  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    const limit = 20000;
    final shown = text.length <= limit ? text : '…（前面省略 ${text.length - limit} 个字符）\n${text.substring(text.length - limit)}';
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      constraints: const BoxConstraints(maxHeight: 300),
      decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(context.radius)),
      padding: const EdgeInsets.all(10),
      child: SingleChildScrollView(
        child: Text(
          shown,
          style: TextStyle(
            fontFamily: AppTokens.monoFamily,
            fontFamilyFallback: AppTokens.monoFallback,
            fontSize: 12,
            height: 1.5,
            color: error ? colors.danger : colors.ink2,
          ),
        ),
      ),
    );
  }
}

/// A command and its output, like a terminal. Long output shows its last
/// lines until opened.
class _TerminalStep extends StatefulWidget {
  const _TerminalStep({required this.run, required this.trailing});

  final ToolRun run;
  final Widget trailing;

  @override
  State<_TerminalStep> createState() => _TerminalStepState();
}

class _TerminalStepState extends State<_TerminalStep> {
  var _all = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final run = widget.run;
    final command = run.args['command'] is String ? run.args['command'] as String : run.argsDraft;
    final purpose = run.args['description'] is String ? (run.args['description'] as String).trim() : '';
    final output = run.outputText.trimRight();
    final lines = output.isEmpty ? <String>[] : output.split('\n');
    const tail = 12;
    final hidden = _all ? 0 : (lines.length - tail).clamp(0, lines.length);
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12, height: 1.6);
    // The terminal follows the theme (0.4, test 32: a black block on the paper-coloured page stood out):
    // the code colours by day, the terminal's own at night.
    final night = Theme.of(context).brightness == Brightness.dark;
    final ground = night ? colors.terminal : colors.codeBackground;
    final ink = night ? colors.onTerminal : colors.ink;
    final quiet = night ? colors.terminalMuted : colors.muted;
    final failed = night ? colors.terminalError : colors.danger;
    final terminal = Container(
      decoration: BoxDecoration(color: ground, borderRadius: BorderRadius.circular(context.radius)),
      padding: const EdgeInsets.fromLTRB(12, 8, 10, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (purpose.isNotEmpty) Text('# $purpose', style: mono.copyWith(color: quiet, fontStyle: FontStyle.italic)),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: '\$ ', style: TextStyle(color: quiet)),
              TextSpan(text: command, style: TextStyle(color: ink)),
            ]),
            style: mono,
          ),
          if (hidden > 0)
            InkWell(
              onTap: () => setState(() => _all = true),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Text('… 还有 $hidden 行，点开查看全部', style: mono.copyWith(color: quiet, fontStyle: FontStyle.italic)),
              ),
            ),
          if (lines.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 360),
              child: SingleChildScrollView(
                reverse: true,
                child: Text(
                  lines.skip(hidden).join('\n'),
                  style: mono.copyWith(color: run.status == ToolStatus.error ? failed : quiet),
                ),
              ),
            ),
        ],
      ),
    );
    // One line like the other tools; the terminal opens below it (open from the start when it failed).
    final firstLine = command.split('\n').first;
    return _Expandable(
      line: (open, toggle) => _StepLine(
        icon: Icons.terminal,
        verb: '运行',
        subject: purpose.isNotEmpty ? purpose : firstLine,
        trailing: widget.trailing,
        onTap: toggle,
        open: open,
      ),
      body: terminal,
      startOpen: run.status == ToolStatus.error,
    );
  }
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

enum DiffKind { context, added, removed, gap }

class DiffLine {
  const DiffLine(this.kind, this.text);
  final DiffKind kind;
  final String text;
}

/// The lines an edit changed: from the unified patch Pi returns when the
/// edit is done, else from the requested replacements.
List<DiffLine> editDiff(ToolRun run) {
  final patch = run.details['patch'];
  if (patch is String && patch.isNotEmpty) {
    final lines = <DiffLine>[];
    for (final line in patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('===')) continue;
      if (line.startsWith('@@')) {
        if (lines.isNotEmpty) lines.add(const DiffLine(DiffKind.gap, '⋯'));
      } else if (line.startsWith('+')) {
        lines.add(DiffLine(DiffKind.added, line.substring(1)));
      } else if (line.startsWith('-')) {
        lines.add(DiffLine(DiffKind.removed, line.substring(1)));
      } else if (line.startsWith(' ')) {
        lines.add(DiffLine(DiffKind.context, line.substring(1)));
      }
    }
    return lines;
  }
  final edits = run.args['edits'];
  final pairs = edits is List
      ? edits.whereType<Map>().map((e) => (e['oldText'], e['newText']))
      : [(run.args['oldText'] ?? run.args['old_string'], run.args['newText'] ?? run.args['new_string'])];
  final lines = <DiffLine>[];
  for (final (old, now) in pairs) {
    if (old is! String && now is! String) continue;
    if (lines.isNotEmpty) lines.add(const DiffLine(DiffKind.gap, '⋯'));
    if (old is String && old.isNotEmpty) lines.addAll(old.split('\n').map((l) => DiffLine(DiffKind.removed, l)));
    if (now is String && now.isNotEmpty) lines.addAll(now.split('\n').map((l) => DiffLine(DiffKind.added, l)));
  }
  return lines;
}

class DiffView extends StatefulWidget {
  const DiffView({super.key, required this.lines});

  final List<DiffLine> lines;

  @override
  State<DiffView> createState() => _DiffViewState();
}

class _DiffViewState extends State<DiffView> {
  var _all = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    const limit = 16;
    final lines = _all ? widget.lines : widget.lines.take(limit).toList();
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12, height: 1.55, color: colors.ink2);
    return Container(
      decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(context.radius)),
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final line in lines)
            Container(
              color: switch (line.kind) {
                DiffKind.added => colors.diffAdded,
                DiffKind.removed => colors.diffRemoved,
                _ => null,
              },
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Text(
                '${switch (line.kind) {
                  DiffKind.added => '+ ',
                  DiffKind.removed => '− ',
                  DiffKind.context => '  ',
                  DiffKind.gap => '',
                }}${line.text}',
                style: mono.copyWith(color: line.kind == DiffKind.gap ? colors.muted : null),
              ),
            ),
          if (!_all && widget.lines.length > limit)
            InkWell(
              onTap: () => setState(() => _all = true),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 4, 10, 0),
                child: Text('还有 ${widget.lines.length - limit} 行，点开查看全部', style: mono.copyWith(color: colors.muted, fontStyle: FontStyle.italic)),
              ),
            ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Notices and notes
// ---------------------------------------------------------------------------

class _NoticeView extends StatelessWidget {
  const _NoticeView({required this.notice});

  final NoticeItem notice;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (icon, color, text) = switch (notice.kind) {
      NoticeKind.retry => (Icons.replay, colors.warning, '模型请求出错，正在重试（${_attempt(notice.detail)}）：${notice.message}'),
      NoticeKind.retryFailed => (Icons.error_outline, colors.danger, '重试失败：${notice.message}'),
      NoticeKind.compaction => (Icons.compress, colors.muted, '已压缩较早的对话，以节省上下文空间'),
      NoticeKind.compactionFailed => (Icons.error_outline, colors.danger, '上下文压缩失败：${notice.message}'),
      NoticeKind.shell => (Icons.terminal, colors.muted, '\$ ${notice.message}'),
      NoticeKind.info => (Icons.info_outline, colors.muted, notice.message),
      NoticeKind.extensionError => (Icons.extension_off_outlined, colors.danger, '扩展出错：${notice.message}'),
    };
    return _InlineNote(icon: icon, color: color, text: text);
  }

  static String _attempt(String detail) {
    final parts = detail.split('/');
    return parts.length >= 2 ? '第 ${parts[0]}/${parts[1]} 次' : detail;
  }
}

class _InlineNote extends StatelessWidget {
  const _InlineNote({required this.icon, required this.color, required this.text});

  final IconData icon;
  final Color color;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(padding: const EdgeInsets.only(top: 2), child: Icon(icon, size: 15, color: color)),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: context.text.bodySmall?.copyWith(color: color))),
      ],
    );
  }
}

/// Descriptions the core made of images for models that cannot see (hash → description).
final _visionCache = <String, ({String model, String text})?>{};

/// 「图片由 X 转述」 under a question whose images went to the model as text.
class VisionNote extends StatefulWidget {
  const VisionNote({super.key, required this.images});

  final List<ImageBlock> images;

  @override
  State<VisionNote> createState() => _VisionNoteState();
}

class _VisionNoteState extends State<VisionNote> {
  late final List<String> _hashes = [for (final i in widget.images) sha256.convert(utf8.encode(i.data)).toString()];
  ValueNotifier<int>? _revision;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final revision = AgentScope.read(context).visionRevision;
    if (revision != _revision) {
      _revision?.removeListener(_lookup);
      _revision = revision..addListener(_lookup);
      _lookup();
    }
  }

  @override
  void dispose() {
    _revision?.removeListener(_lookup);
    super.dispose();
  }

  Future<void> _lookup() async {
    final missing = _hashes.where((h) => _visionCache[h] == null).toList();
    if (missing.isEmpty) return;
    try {
      final found = asJsonMap(await AgentScope.read(context).backend.call('vision.lookup', {'hashes': missing}));
      for (final h in missing) {
        final d = found[h];
        if (d is Map) _visionCache[h] = (model: d['model'] as String? ?? '看图模型', text: d['text'] as String? ?? '');
      }
      if (mounted) setState(() {});
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final described = [for (final h in _hashes) ?_visionCache[h]];
    if (described.isEmpty) return const SizedBox.shrink();
    final models = described.map((d) => d.model).toSet().join('、');
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: InkWell(
        borderRadius: BorderRadius.circular(context.radiusSm),
        onTap: () => showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('图片由 $models 转述'),
            content: SizedBox(
              width: 560,
              child: SingleChildScrollView(
                child: SelectableText(
                  [for (final (i, d) in described.indexed) '${described.length > 1 ? '图片 ${i + 1}：\n' : ''}${d.text}'].join('\n\n'),
                  style: context.text.bodyMedium?.copyWith(height: 1.7),
                ),
              ),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.visibility_outlined, size: 13, color: context.colors.muted),
              const SizedBox(width: 4),
              Text('当前模型看不到图片，图片由 $models 转述 ›', style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
            ],
          ),
        ),
      ),
    );
  }
}

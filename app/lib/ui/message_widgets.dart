import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme.dart';
import 'agent_scope.dart';

class TranscriptItemView extends StatelessWidget {
  const TranscriptItemView({super.key, required this.item, required this.transcript});

  final TranscriptItem item;
  final Transcript transcript;

  @override
  Widget build(BuildContext context) => switch (item) {
    UserItem() => _UserBubble(item: item as UserItem),
    AssistantItem() => _AssistantView(item: item as AssistantItem, transcript: transcript),
    NoticeItem() => _NoticeView(notice: item as NoticeItem),
  };
}

// ---------------------------------------------------------------------------
// User
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
                  for (final image in item.images)
                    ClipRRect(
                      borderRadius: BorderRadius.circular(AppTokens.radius),
                      child: Image.memory(
                        base64Decode(image.data),
                        height: 140,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined),
                      ),
                    ),
                ],
              ),
            ),
          if (item.text.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 620),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(color: colors.userBubble, borderRadius: BorderRadius.circular(AppTokens.radiusLg)),
                child: Text(item.text, style: context.text.bodyMedium?.copyWith(color: colors.onUserBubble, height: 1.5)),
              ),
            ),
          SizedBox(
            height: 26,
            child: AnimatedOpacity(
              opacity: _hovered ? 1 : 0,
              duration: const Duration(milliseconds: 120),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  _BubbleAction(
                    icon: Icons.copy_outlined,
                    tooltip: '复制',
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: item.text));
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制'), duration: Duration(seconds: 1)));
                    },
                  ),
                  _BubbleAction(
                    icon: Icons.call_split,
                    tooltip: agent.isRunning ? '回复结束后才能分叉' : '从这里分叉：新建一个会话，保留这条消息之前的内容，并把这条消息放回输入框供你修改',
                    onTap: agent.isRunning ? null : () => AgentScope.read(context).forkFrom(item),
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

class _BubbleAction extends StatelessWidget {
  const _BubbleAction({required this.icon, required this.tooltip, required this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    onPressed: onTap,
    iconSize: 15,
    visualDensity: VisualDensity.compact,
    padding: EdgeInsets.zero,
    constraints: const BoxConstraints(minWidth: 28, minHeight: 26),
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
                borderRadius: BorderRadius.circular(AppTokens.radiusLg),
              ),
              child: Text('等待插入：$message', style: context.text.bodySmall?.copyWith(color: colors.muted)),
            ),
          ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

class _AssistantView extends StatelessWidget {
  const _AssistantView({required this.item, required this.transcript});

  final AssistantItem item;
  final Transcript transcript;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final children = <Widget>[];
    for (final (index, part) in item.parts.indexed) {
      final isLast = index == item.parts.length - 1;
      children.add(switch (part) {
        TextPart(:final text) => _MarkdownText(text: text),
        ThinkingPart(:final text, :final redacted) => _ThinkingView(
          text: text,
          redacted: redacted,
          active: item.streaming && isLast,
        ),
        ToolCallPart(:final toolCallId) => _ToolCard(run: transcript.tool(toolCallId)),
      });
    }
    if (item.streaming && item.parts.isEmpty) {
      children.add(_Pending(label: '正在思考…', color: colors.muted));
    }
    if (item.failed) {
      children.add(_InlineNote(icon: Icons.error_outline, color: colors.danger, text: '模型请求失败：${item.errorMessage ?? '未知错误'}'));
    } else if (item.aborted) {
      children.add(_InlineNote(icon: Icons.stop_circle_outlined, color: colors.muted, text: '已停止'));
    } else if (item.truncated) {
      children.add(_InlineNote(icon: Icons.warning_amber_rounded, color: colors.warning, text: '回复达到长度上限，被截断了'));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [for (final child in children) Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: child)],
    );
  }
}

class _MarkdownText extends StatelessWidget {
  const _MarkdownText({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13);
    return MarkdownBody(
      data: text,
      styleSheet: MarkdownStyleSheet.fromTheme(theme).copyWith(
        p: theme.textTheme.bodyMedium?.copyWith(height: 1.65),
        code: mono.copyWith(backgroundColor: colors.codeBackground),
        codeblockDecoration: BoxDecoration(
          color: colors.codeBackground,
          borderRadius: BorderRadius.circular(AppTokens.radius),
          border: Border.all(color: colors.border),
        ),
        codeblockPadding: const EdgeInsets.all(AppTokens.pad),
        blockquoteDecoration: BoxDecoration(border: Border(left: BorderSide(color: colors.border, width: 3))),
      ),
      onTapLink: (text, href, title) {
        final uri = href == null ? null : Uri.tryParse(href);
        if (uri != null && (uri.scheme == 'http' || uri.scheme == 'https')) launchUrl(uri);
      },
    );
  }
}

class _ThinkingView extends StatefulWidget {
  const _ThinkingView({required this.text, required this.redacted, required this.active});

  final String text;
  final bool redacted;
  final bool active;

  @override
  State<_ThinkingView> createState() => _ThinkingViewState();
}

class _ThinkingViewState extends State<_ThinkingView> {
  var _expanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final label = widget.active ? '思考中…' : (widget.redacted ? '思考内容已加密' : '思考过程');
    return _Collapsible(
      expanded: _expanded,
      onToggle: widget.redacted ? null : () => setState(() => _expanded = !_expanded),
      header: Row(
        children: [
          Icon(Icons.psychology_outlined, size: 16, color: colors.muted),
          const SizedBox(width: 6),
          Text(label, style: context.text.bodySmall?.copyWith(color: colors.muted)),
          if (widget.active) ...[const SizedBox(width: 8), const _Spinner()],
        ],
      ),
      body: Text(widget.text, style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.6)),
    );
  }
}

// ---------------------------------------------------------------------------
// Tool card
// ---------------------------------------------------------------------------

class _ToolCard extends StatefulWidget {
  const _ToolCard({required this.run});

  final ToolRun? run;

  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  var _expanded = false;

  static IconData _icon(String name) => switch (name) {
    'read' => Icons.description_outlined,
    'bash' || 'powershell' => Icons.terminal,
    'edit' || 'write' => Icons.edit_note,
    'grep' || 'find' => Icons.search,
    'ls' => Icons.folder_open_outlined,
    _ => Icons.extension_outlined,
  };

  /// One-line summary of the most telling argument.
  static String _summary(ToolRun run) {
    final args = run.args;
    for (final key in ['command', 'path', 'pattern', 'file_path', 'query', 'url']) {
      final value = args[key];
      if (value is String && value.isNotEmpty) return value.replaceAll('\n', ' ');
    }
    if (args.isEmpty && run.argsDraft.isNotEmpty) return run.argsDraft.replaceAll('\n', ' ');
    return args.isEmpty ? '' : formatArguments(args).replaceAll('\n', ' ');
  }

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    if (run == null) return const SizedBox.shrink();
    final colors = context.colors;
    final (statusColor, statusText) = switch (run.status) {
      ToolStatus.drafting => (colors.muted, '准备中'),
      ToolStatus.pending => (colors.muted, '等待执行'),
      ToolStatus.running => (colors.warning, '运行中'),
      ToolStatus.done => (colors.success, run.durationMs == null ? '完成' : '完成 · ${_duration(run.durationMs!)}'),
      ToolStatus.error => (colors.danger, '出错'),
      ToolStatus.interrupted => (colors.muted, '已中断'),
    };
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12.5);
    final output = run.outputText;
    return Container(
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: run.status == ToolStatus.error ? colors.danger.withValues(alpha: 0.5) : colors.border),
        borderRadius: BorderRadius.circular(AppTokens.radius),
      ),
      child: _Collapsible(
        expanded: _expanded,
        onToggle: () => setState(() => _expanded = !_expanded),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        header: Row(
          children: [
            Icon(_icon(run.name), size: 16, color: colors.muted),
            const SizedBox(width: 8),
            Text(run.name, style: context.text.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                _summary(run),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: mono.copyWith(color: colors.muted),
              ),
            ),
            const SizedBox(width: 8),
            if (run.isActive && run.status == ToolStatus.running) ...[const _Spinner(), const SizedBox(width: 6)],
            Text(statusText, style: context.text.bodySmall?.copyWith(color: statusColor)),
          ],
        ),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (run.args.isNotEmpty) ...[
              Text('参数', style: context.text.labelSmall?.copyWith(color: colors.muted)),
              const SizedBox(height: 4),
              _CodeBox(text: formatArguments(run.args), style: mono),
              const SizedBox(height: 8),
            ],
            Text('输出', style: context.text.labelSmall?.copyWith(color: colors.muted)),
            const SizedBox(height: 4),
            _CodeBox(text: output.isEmpty ? '（无输出）' : _tail(output), style: mono),
          ],
        ),
      ),
    );
  }

  static String _duration(int ms) => ms < 1000 ? '${ms}ms' : '${(ms / 1000).toStringAsFixed(1)}s';

  /// Very long outputs are trimmed to keep the UI responsive.
  static String _tail(String text) {
    const limit = 20000;
    return text.length <= limit ? text : '…（前面省略 ${text.length - limit} 个字符）\n${text.substring(text.length - limit)}';
  }
}

class _CodeBox extends StatelessWidget {
  const _CodeBox({required this.text, required this.style});

  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      constraints: const BoxConstraints(maxHeight: 320),
      decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
      padding: const EdgeInsets.all(10),
      child: SingleChildScrollView(child: Text(text, style: style)),
    );
  }
}

// ---------------------------------------------------------------------------
// Notices and small pieces
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

class _Collapsible extends StatelessWidget {
  const _Collapsible({
    required this.expanded,
    required this.onToggle,
    required this.header,
    required this.body,
    this.padding = const EdgeInsets.symmetric(vertical: 4),
  });

  final bool expanded;
  final VoidCallback? onToggle;
  final Widget header;
  final Widget body;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          onTap: onToggle,
          borderRadius: BorderRadius.circular(AppTokens.radius),
          child: Padding(
            padding: padding,
            child: Row(
              children: [
                Expanded(child: header),
                if (onToggle != null)
                  Icon(expanded ? Icons.expand_less : Icons.expand_more, size: 18, color: context.colors.muted),
              ],
            ),
          ),
        ),
        if (expanded) Padding(padding: EdgeInsets.fromLTRB(padding.left, 0, padding.right, padding.bottom + 2), child: body),
      ],
    );
  }
}

class _Pending extends StatelessWidget {
  const _Pending({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      const _Spinner(),
      const SizedBox(width: 8),
      Text(label, style: context.text.bodySmall?.copyWith(color: color)),
    ],
  );
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) =>
      const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6));
}

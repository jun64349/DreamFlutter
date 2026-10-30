import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../theme.dart';
import 'agent_scope.dart';
import 'commands_dialog.dart' show commandSourceLabels, showCommandsDialog;
import 'context_dialog.dart' show showContextDialog;
import 'motion.dart';
import 'usage_page.dart' show formatCost, formatTokens;

/// Message input. Enter sends, Shift+Enter inserts a newline; while an IME
/// composition is active Enter is left to the IME. During a run, sending
/// steers the agent and the button doubles as Stop when the input is empty.
/// Typing `/` at the start suggests skills, prompt templates and commands.
class Composer extends StatefulWidget {
  const Composer({super.key});

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  late final _focus = FocusNode(onKeyEvent: _onKey);
  final List<_Attachment> _images = [];
  Object? _editorRuntime;
  int _editorRevision = 0;
  int _highlighted = 0;

  static const _maxImageBytes = 8 * 1024 * 1024;
  static const _imageTypes = XTypeGroup(label: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp']);

  @override
  void initState() {
    super.initState();
    _controller.addListener(() => setState(() => _highlighted = 0));
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Commands matching a leading `/word` while no space has been typed yet.
  List<SlashCommand> _suggestions(List<SlashCommand> commands) {
    final text = _controller.text;
    if (!text.startsWith('/') || text.contains(' ') || text.contains('\n')) return const [];
    final query = text.substring(1).toLowerCase();
    return commands.where((c) => c.name.toLowerCase().contains(query)).take(8).toList();
  }

  void _applySuggestion(SlashCommand command) {
    final text = '/${command.name} ';
    _controller.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
    _focus.requestFocus();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) return KeyEventResult.ignored;
    final suggestions = _suggestions(AgentScope.read(context).commands);
    final key = event.logicalKey;
    if (suggestions.isNotEmpty) {
      if (key == LogicalKeyboardKey.arrowDown) {
        setState(() => _highlighted = (_highlighted + 1) % suggestions.length);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.arrowUp) {
        setState(() => _highlighted = (_highlighted - 1 + suggestions.length) % suggestions.length);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.tab || (key == LogicalKeyboardKey.enter && !_controller.value.composing.isValid)) {
        _applySuggestion(suggestions[_highlighted.clamp(0, suggestions.length - 1)]);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.escape) {
        _controller.clear();
        return KeyEventResult.handled;
      }
    }
    if (event is! KeyDownEvent || key != LogicalKeyboardKey.enter) return KeyEventResult.ignored;
    if (HardwareKeyboard.instance.isShiftPressed || _controller.value.composing.isValid) {
      return KeyEventResult.ignored;
    }
    _send();
    return KeyEventResult.handled;
  }

  void _send() {
    final text = _controller.text;
    if (text.trim().isEmpty && _images.isEmpty) return;
    final agent = AgentScope.read(context);
    if (!agent.isReady) return;
    final images = _images.map((a) => a.block).toList();
    _controller.clear();
    setState(_images.clear);
    agent.send(text, images: images);
  }

  Future<void> _pickImages() async {
    final files = await openFiles(acceptedTypeGroups: const [_imageTypes], confirmButtonText: '添加');
    final rejected = <String>[];
    for (final file in files) {
      final bytes = await file.readAsBytes();
      if (bytes.length > _maxImageBytes) {
        rejected.add(file.name);
        continue;
      }
      final ext = p.extension(file.name).toLowerCase().replaceFirst('.', '');
      final mime = switch (ext) {
        'jpg' || 'jpeg' => 'image/jpeg',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        _ => 'image/png',
      };
      _images.add(_Attachment(file.name, bytes, ImageBlock(data: base64Encode(bytes), mimeType: mime)));
    }
    if (!mounted) return;
    setState(() {});
    if (rejected.isNotEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('图片超过 8MB，未添加：${rejected.join('、')}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;

    // Text pushed by an extension (set_editor_text) or a fork.
    final runtime = agent.active;
    if (runtime != null && !identical(runtime, _editorRuntime)) {
      // Switched sessions: adopt its revision without replacing the input.
      _editorRuntime = runtime;
      _editorRevision = runtime.editorTextRevision;
    } else if (runtime != null && runtime.editorTextRevision != _editorRevision) {
      _editorRevision = runtime.editorTextRevision;
      {
        final text = runtime.editorText;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _controller.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
          _focus.requestFocus();
        });
      }
    }

    final hasContent = _controller.text.trim().isNotEmpty || _images.isNotEmpty;
    final running = agent.isRunning;
    final showStop = running && !hasContent;
    final suggestions = _suggestions(agent.commands);
    final supportsImages = agent.model?.supportsImages ?? true;
    final widgets = agent.extensionWidgets.values.expand((lines) => lines).toList();
    final statuses = agent.extensionStatuses.values.toList();
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth + 56),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(28, 4, 28, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (widgets.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(widgets.join('\n'), style: muted)),
              if (agent.isCompacting || statuses.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6, left: 4),
                  child: Row(
                    children: [
                      if (agent.isCompacting) ...[const BreathingDot(), const SizedBox(width: 8), Text('正在压缩较早的对话…', style: muted)],
                      for (final status in statuses) ...[
                        const SizedBox(width: AppTokens.pad),
                        Flexible(child: Text(status, overflow: TextOverflow.ellipsis, style: muted)),
                      ],
                    ],
                  ),
                ),
              if (suggestions.isNotEmpty) _SuggestionList(suggestions: suggestions, highlighted: _highlighted, onPick: _applySuggestion),
              AnimatedContainer(
                duration: AppTokens.fast,
                decoration: BoxDecoration(
                  color: colors.card,
                  border: Border.all(color: _focus.hasFocus ? colors.accent.withValues(alpha: 0.6) : colors.border),
                  borderRadius: BorderRadius.circular(AppTokens.radiusLg),
                ),
                padding: const EdgeInsets.fromLTRB(14, 8, 10, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_images.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6, top: 2),
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (final image in _images)
                              _AttachmentChip(attachment: image, onRemove: () => setState(() => _images.remove(image))),
                          ],
                        ),
                      ),
                    Focus(
                      onFocusChange: (_) => setState(() {}),
                      child: TextField(
                        controller: _controller,
                        focusNode: _focus,
                        autofocus: true,
                        minLines: 1,
                        maxLines: 8,
                        enabled: agent.isReady,
                        style: context.text.bodyMedium?.copyWith(height: 1.6),
                        decoration: InputDecoration(
                          hintText: running ? 'Agent 正在工作，现在输入会插进对话里…' : '说点什么…  Enter 发送，Shift+Enter 换行，/ 调用技能',
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          filled: false,
                          contentPadding: const EdgeInsets.symmetric(vertical: 6),
                        ),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        _ToolbarButton(
                          icon: Icons.image_outlined,
                          tooltip: supportsImages ? '添加图片' : '当前模型不支持图片',
                          onTap: agent.isReady && supportsImages ? _pickImages : null,
                        ),
                        _ToolbarButton(icon: Icons.bolt_outlined, tooltip: 'Skills 与命令', onTap: () => showCommandsDialog(context)),
                        const Spacer(),
                        const _ModelChip(),
                        const SizedBox(width: 4),
                        const _ThinkingChip(),
                        const SizedBox(width: 6),
                        const _ContextRing(),
                        const SizedBox(width: 8),
                        SizedBox.square(
                          dimension: 34,
                          child: IconButton.filled(
                            tooltip: showStop ? '停止' : (running ? '插话' : '发送'),
                            onPressed: showStop ? agent.abort : (hasContent && agent.isReady ? _send : null),
                            padding: EdgeInsets.zero,
                            style: IconButton.styleFrom(
                              backgroundColor: showStop ? colors.ink : colors.accent,
                              foregroundColor: colors.onAccent,
                              disabledBackgroundColor: colors.accentSoft,
                              disabledForegroundColor: colors.muted,
                            ),
                            icon: Icon(showStop ? Icons.stop_rounded : Icons.arrow_upward_rounded, size: 18),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ToolbarButton extends StatelessWidget {
  const _ToolbarButton({required this.icon, required this.tooltip, required this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    onPressed: onTap,
    iconSize: 18,
    visualDensity: VisualDensity.compact,
    icon: Icon(icon),
  );
}

const _levelNames = {
  'off': '关闭',
  'minimal': '极低',
  'low': '低',
  'medium': '中',
  'high': '高',
  'xhigh': '很高',
  'max': '最高',
};

/// A quiet chip in the input box's toolbar that opens a menu.
class _Chip<T> extends StatelessWidget {
  const _Chip({required this.label, required this.tooltip, required this.enabled, required this.items, required this.onSelected, this.filled = false});

  final String label;
  final String tooltip;
  final bool enabled;
  final List<PopupMenuEntry<T>> items;
  final ValueChanged<T> onSelected;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return PopupMenuButton<T>(
      enabled: enabled,
      tooltip: tooltip,
      onSelected: onSelected,
      itemBuilder: (_) => items,
      position: PopupMenuPosition.over,
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(color: filled ? colors.accentSoft : null, borderRadius: BorderRadius.circular(AppTokens.radius)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Text(label, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: enabled ? colors.ink : colors.muted)),
            ),
            const SizedBox(width: 2),
            Icon(Icons.expand_more, size: 15, color: colors.muted),
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

class _ModelChip extends StatelessWidget {
  const _ModelChip();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final model = agent.model;
    return _Chip<PiModel>(
      label: model?.name ?? '选择模型',
      tooltip: model == null ? '模型' : '模型：${model.key}',
      enabled: agent.isReady && agent.models.isNotEmpty,
      filled: true,
      items: [
        for (final m in agent.models)
          PopupMenuItem(value: m, child: _MenuRow(title: m.name, subtitle: m.provider, selected: m == model)),
      ],
      onSelected: agent.selectModel,
    );
  }
}

class _ThinkingChip extends StatelessWidget {
  const _ThinkingChip();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final model = agent.model;
    return _Chip<String>(
      label: '思考 · ${_levelNames[agent.thinkingLevel] ?? agent.thinkingLevel}',
      tooltip: model != null && !model.reasoning ? '当前模型不支持思考' : '思考级别：越高越慢，但更仔细',
      enabled: agent.isReady && (model?.reasoning ?? false),
      items: [
        for (final level in agent.thinkingLevels)
          PopupMenuItem(value: level, child: _MenuRow(title: _levelNames[level] ?? level, selected: level == agent.thinkingLevel)),
      ],
      onSelected: agent.selectThinkingLevel,
    );
  }
}

/// How full the context window is, as a small ring; opens the context panel.
class _ContextRing extends StatelessWidget {
  const _ContextRing();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final stats = agent.stats;
    final percent = stats.contextKnown ? stats.contextPercent : 0.0;
    final color = percent >= 85 ? colors.danger : (percent >= 60 ? colors.warning : colors.accent);
    final known = stats.contextKnown && stats.contextWindow > 0;
    final tip = [
      known ? '上下文已用 ${percent.toStringAsFixed(percent < 10 ? 1 : 0)}%' : '上下文用量未知',
      '本会话 ${formatTokens(stats.totalTokens)} tokens',
      if (stats.cost > 0) '花费 ${formatCost(stats.cost)}',
      '点击查看或压缩',
    ].join(' · ');
    return Tooltip(
      message: tip,
      child: Semantics(
        button: true,
        label: '上下文',
        child: InkWell(
          key: const ValueKey('context-ring'),
          customBorder: const CircleBorder(),
          onTap: agent.isReady ? () => showContextDialog(context) : null,
          child: Padding(
            padding: const EdgeInsets.all(4),
            child: SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(
                value: known ? (percent / 100).clamp(0.02, 1.0) : 0,
                strokeWidth: 3,
                color: color,
                backgroundColor: colors.border,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Attachment {
  _Attachment(this.name, this.bytes, this.block);
  final String name;
  final List<int> bytes;
  final ImageBlock block;
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({required this.attachment, required this.onRemove});

  final _Attachment attachment;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: Image.memory(base64Decode(attachment.block.data), width: 36, height: 36, fit: BoxFit.cover),
          ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 140),
            child: Text(attachment.name, overflow: TextOverflow.ellipsis, style: context.text.bodySmall),
          ),
          IconButton(
            tooltip: '移除',
            visualDensity: VisualDensity.compact,
            iconSize: 16,
            onPressed: onRemove,
            icon: const Icon(Icons.close),
          ),
        ],
      ),
    );
  }
}

class _SuggestionList extends StatelessWidget {
  const _SuggestionList({required this.suggestions, required this.highlighted, required this.onPick});

  final List<SlashCommand> suggestions;
  final int highlighted;
  final ValueChanged<SlashCommand> onPick;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(AppTokens.radius),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (index, command) in suggestions.indexed)
            InkWell(
              onTap: () => onPick(command),
              child: Container(
                color: index == highlighted ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.08) : null,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: Row(
                  children: [
                    Text('/${command.name}', style: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13)),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        command.description,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall?.copyWith(color: colors.muted),
                      ),
                    ),
                    Text(commandSourceLabels[command.source] ?? command.source, style: context.text.labelSmall?.copyWith(color: colors.muted)),
                  ],
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 2),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('↑↓ 选择 · Tab / Enter 确认 · Esc 取消', style: context.text.labelSmall?.copyWith(color: colors.muted)),
            ),
          ),
        ],
      ),
    );
  }
}

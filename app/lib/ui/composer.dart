import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../theme.dart';
import 'agent_scope.dart';
import 'commands_dialog.dart' show commandSourceLabels;

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

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 860),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(AppTokens.padLg + 8, 4, AppTokens.padLg + 8, AppTokens.pad),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (widgets.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(widgets.join('\n'), style: context.text.bodySmall?.copyWith(color: colors.muted)),
                ),
              if (suggestions.isNotEmpty) _SuggestionList(suggestions: suggestions, highlighted: _highlighted, onPick: _applySuggestion),
              Container(
                decoration: BoxDecoration(
                  color: colors.card,
                  border: Border.all(color: _focus.hasFocus ? Theme.of(context).colorScheme.primary : colors.border),
                  borderRadius: BorderRadius.circular(AppTokens.radiusLg),
                ),
                padding: const EdgeInsets.fromLTRB(AppTokens.pad, 6, 6, 6),
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
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        IconButton(
                          tooltip: supportsImages ? '添加图片' : '当前模型不支持图片',
                          onPressed: agent.isReady && supportsImages ? _pickImages : null,
                          icon: const Icon(Icons.image_outlined, size: 20),
                        ),
                        Expanded(
                          child: Focus(
                            onFocusChange: (_) => setState(() {}),
                            child: TextField(
                              controller: _controller,
                              focusNode: _focus,
                              autofocus: true,
                              minLines: 1,
                              maxLines: 8,
                              enabled: agent.isReady,
                              decoration: InputDecoration(
                                hintText: running ? 'Agent 运行中，输入内容可以插话…' : '输入消息，/ 调用技能，Enter 发送，Shift+Enter 换行',
                                border: InputBorder.none,
                                enabledBorder: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                disabledBorder: InputBorder.none,
                                contentPadding: const EdgeInsets.symmetric(vertical: 10),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: AppTokens.gap),
                        showStop
                            ? FilledButton.tonalIcon(
                                onPressed: agent.abort,
                                icon: const Icon(Icons.stop_rounded, size: 18),
                                label: const Text('停止'),
                              )
                            : FilledButton.icon(
                                onPressed: hasContent && agent.isReady ? _send : null,
                                icon: const Icon(Icons.arrow_upward_rounded, size: 18),
                                label: Text(running ? '插话' : '发送'),
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

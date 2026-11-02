import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pasteboard/pasteboard.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/mentions.dart';
import '../state/agent_controller.dart' show asJsonMap, groupProvider, jsonRows, MaterialInfo, NoteInfo, SessionRuntime;
import '../theme.dart';
import 'agent_scope.dart';
import 'commands_dialog.dart' show commandSourceLabels, showCommandsDialog;
import 'context_dialog.dart' show showContextDialog;
import 'motion.dart';
import 'run_summary.dart' show mentionOf;
import 'dashboard_page.dart' show formatCost, formatTokens;

/// Message input. Enter sends, Shift+Enter inserts a newline; while an IME
/// composition is active Enter is left to the IME. During a run, sending
/// steers the agent and the button doubles as Stop when the input is empty.
/// Typing `/` at the start suggests skills, prompt templates and commands;
/// `@` suggests the desk's notes and materials. Files can be dropped or
/// pasted in: images are attached, other files and folders go along by path.
class Composer extends StatefulWidget {
  const Composer({super.key, this.dragging = false});

  /// Files are being dragged over the conversation (the chat view takes the drop).
  final bool dragging;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  late final _focus = FocusNode(onKeyEvent: _onKey);
  final List<_Attachment> _images = [];
  final List<Mention> _mentions = [];
  Object? _editorRuntime;
  int _editorRevision = 0;
  int _highlighted = 0;
  bool get _dragging => widget.dragging;

  /// Documents being turned into text (sending waits for them).
  var _converting = 0;
  StreamSubscription<Mention>? _mentionRequests;
  StreamSubscription<List<String>>? _fileDrops;

  /// The desk's notes and materials for `@`, loaded on first use per workspace.
  List<(Mention, String?)>? _deskItems;
  String? _deskFor;

  static const _maxImageBytes = 8 * 1024 * 1024;
  static const _imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  static const _imageTypes = XTypeGroup(label: '图片', extensions: _imageExtensions);

  @override
  void initState() {
    super.initState();
    _controller.addListener(() => setState(() => _highlighted = 0));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _mentionRequests ??= AgentScope.read(context).mentionRequests.listen((mention) {
      if (!mounted) return;
      _addMention(mention);
      _focus.requestFocus();
    });
    _fileDrops ??= AgentScope.read(context).fileDrops.listen((paths) {
      if (!mounted) return;
      _addPaths(paths);
      _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _mentionRequests?.cancel();
    _fileDrops?.cancel();
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _addMention(Mention mention) {
    if (_mentions.contains(mention)) return;
    setState(() => _mentions.add(mention));
  }

  // --- Suggestions ------------------------------------------------------------

  /// Commands matching a leading `/word` while no space has been typed yet.
  List<SlashCommand> _commandSuggestions(List<SlashCommand> commands) {
    final text = _controller.text;
    if (!text.startsWith('/') || text.contains(' ') || text.contains('\n')) return const [];
    final query = text.substring(1).toLowerCase();
    return commands.where((c) => c.name.toLowerCase().contains(query)).take(8).toList();
  }

  static final _atQuery = RegExp(r'(?:^|\s)@([^\s@]*)$');

  /// The `@word` being typed at the cursor, if any.
  RegExpMatch? _atMatch() {
    final value = _controller.value;
    final cursor = value.selection.baseOffset;
    if (cursor < 0 || cursor > value.text.length) return null;
    return _atQuery.firstMatch(value.text.substring(0, cursor));
  }

  List<(Mention, String?)> _deskSuggestions(String workspace) {
    final match = _atMatch();
    if (match == null) return const [];
    if (_deskFor != workspace) {
      _deskFor = workspace;
      _deskItems = null;
      _loadDesk(workspace);
    }
    final query = match.group(1)!.toLowerCase();
    return (_deskItems ?? const []).where((d) => d.$1.title.toLowerCase().contains(query) && !_mentions.contains(d.$1)).take(8).toList();
  }

  Future<void> _loadDesk(String workspace) async {
    final agent = AgentScope.read(context);
    try {
      final desk = asJsonMap(await agent.backend.call('desk.get', {'cwd': workspace}));
      final items = [
        for (final n in jsonRows(desk['notes']).map(NoteInfo.fromJson)) (Mention(kind: MentionKind.note, title: n.title, content: n.content), '写笺'),
        // 蝶君 cannot open this machine's paths: only pasted text goes along (files reach it through the inbox).
        for (final m in jsonRows(desk['materials']).map(MaterialInfo.fromJson))
          if (!agent.sandbox || m.kind == 'text') (mentionOf(m), m.path ?? '资料'),
      ];
      if (mounted && _deskFor == workspace) setState(() => _deskItems = items);
    } catch (_) {
      if (mounted && _deskFor == workspace) setState(() => _deskItems = const []);
    }
  }

  /// What the suggestion list shows now: commands after `/`, desk items after `@`.
  List<_Option> _options(BuildContext context) {
    final agent = AgentScope.read(context);
    final commands = _commandSuggestions(agent.commands);
    if (commands.isNotEmpty) {
      return [
        for (final c in commands)
          _Option(label: '/${c.name}', description: c.description, tag: commandSourceLabels[c.source] ?? c.source, mono: true, pick: () => _applyCommand(c)),
      ];
    }
    return [
      for (final (mention, detail) in _deskSuggestions(agent.workspace))
        _Option(
          label: mention.title,
          description: detail ?? '',
          tag: mention.kind == MentionKind.note ? '写笺' : '资料',
          icon: mentionIcon(mention.kind),
          pick: () => _applyMention(mention),
        ),
    ];
  }

  void _applyCommand(SlashCommand command) {
    final text = '/${command.name} ';
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _focus.requestFocus();
  }

  /// Replaces the `@word` being typed with a chip for [mention].
  void _applyMention(Mention mention) {
    final match = _atMatch();
    if (match != null) {
      final value = _controller.value;
      final start = match.start + match.group(0)!.indexOf('@');
      final end = value.selection.baseOffset;
      final text = value.text.replaceRange(start, end, '');
      _controller.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: start),
      );
    }
    _addMention(mention);
    _focus.requestFocus();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    if (event is KeyDownEvent && key == LogicalKeyboardKey.keyV && HardwareKeyboard.instance.isControlPressed) {
      // Text pastes as usual; images and files on the clipboard are attached.
      unawaited(_pasteAttachments());
      return KeyEventResult.ignored;
    }
    final suggestions = _options(context);
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
        suggestions[_highlighted.clamp(0, suggestions.length - 1)].pick();
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.escape) {
        if (_atMatch() != null) {
          _applyMentionCancel();
        } else {
          _controller.clear();
        }
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

  /// Esc after `@`: drop the half-typed `@word`.
  void _applyMentionCancel() {
    final match = _atMatch();
    if (match == null) return;
    final value = _controller.value;
    final start = match.start + match.group(0)!.indexOf('@');
    _controller.value = TextEditingValue(
      text: value.text.replaceRange(start, value.selection.baseOffset, ''),
      selection: TextSelection.collapsed(offset: start),
    );
  }

  bool get _hasContent => _controller.text.trim().isNotEmpty || _images.isNotEmpty || _mentions.isNotEmpty;

  void _send() {
    if (!_hasContent || _converting > 0) return;
    final agent = AgentScope.read(context);
    if (!agent.isReady) return;
    final text = composeWithMentions(_controller.text, _mentions);
    final images = _images.map((a) => a.block).toList();
    _controller.clear();
    setState(() {
      _images.clear();
      _mentions.clear();
    });
    agent.send(text, images: images);
  }

  // --- Attachments --------------------------------------------------------------

  static String _mimeOf(String name) => switch (p.extension(name).toLowerCase().replaceFirst('.', '')) {
    'jpg' || 'jpeg' => 'image/jpeg',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    _ => 'image/png',
  };

  /// Adds an image; false if it is too large.
  bool _addImage(String name, List<int> bytes, String mime) {
    if (bytes.length > _maxImageBytes) return false;
    _images.add(_Attachment(name, bytes, ImageBlock(data: base64Encode(bytes), mimeType: mime)));
    return true;
  }

  void _tooLarge(List<String> names) {
    if (names.isEmpty || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('图片超过 8MB，未添加：${names.join('、')}')));
  }

  Future<void> _pickImages() async {
    final files = await openFiles(acceptedTypeGroups: const [_imageTypes], confirmButtonText: '添加');
    final rejected = <String>[];
    for (final file in files) {
      if (!_addImage(file.name, await file.readAsBytes(), _mimeOf(file.name))) rejected.add(file.name);
    }
    if (!mounted) return;
    setState(() {});
    _tooLarge(rejected);
  }

  /// Dropped or pasted paths: images are attached (a model that cannot see
  /// gets them described by the vision model); documents become text (large
  /// ones go by path for read_document); anything else goes by path.
  Future<void> _addPaths(List<String> paths) async {
    final agent = AgentScope.read(context);
    final rejected = <String>[];
    final failed = <String>[];
    // 蝶君 gets copies in its inbox (images still go along as images).
    final toInbox = <String>[];
    for (final path in paths) {
      if (agent.sandbox) {
        final ext = p.extension(path).toLowerCase().replaceFirst('.', '');
        if (!_imageExtensions.contains(ext) || Directory(path).existsSync()) {
          toInbox.add(path);
          continue;
        }
      }
      if (Directory(path).existsSync()) {
        _addMention(Mention.file(path, folder: true));
        continue;
      }
      final ext = p.extension(path).toLowerCase().replaceFirst('.', '');
      if (_imageExtensions.contains(ext)) {
        try {
          if (!_addImage(p.basename(path), await File(path).readAsBytes(), _mimeOf(path))) rejected.add(p.basename(path));
          continue;
        } catch (_) {
          // Unreadable: send the path instead.
        }
      }
      if (documentExtensions.contains(ext)) {
        setState(() => _converting++);
        try {
          final doc = asJsonMap(await agent.backend.call('files.convert', {'path': path}, const Duration(minutes: 3)));
          final large = doc['large'] == true;
          _addMention(Mention(kind: MentionKind.document, title: p.basename(path), path: path, content: large ? null : doc['text'] as String?));
          continue;
        } catch (_) {
          failed.add(p.basename(path));
        } finally {
          if (mounted) setState(() => _converting--);
        }
      }
      _addMention(Mention.file(path));
    }
    if (toInbox.isNotEmpty) {
      try {
        final copied = asJsonMap(await agent.backend.call('butterfly.import', {'paths': toInbox}, const Duration(minutes: 5)));
        for (final path in (copied['paths'] as List? ?? const []).whereType<String>()) {
          final local = toInbox.firstWhere((l) => p.basename(l) == p.posix.basename(path), orElse: () => '');
          _addMention(Mention(kind: Directory(local).existsSync() ? MentionKind.folder : MentionKind.file, title: p.posix.basename(path), path: path));
        }
      } catch (e) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('没能复制给蝶君：${SessionRuntime.describeError(e)}')));
      }
    }
    if (failed.isNotEmpty && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('没能转成文字，改为把路径交给 Agent：${failed.join('、')}')));
    }
    if (!mounted) return;
    setState(() {});
    _tooLarge(rejected);
  }

  Future<void> _pasteAttachments() async {
    try {
      final files = await Pasteboard.files();
      if (files.isNotEmpty) {
        await _addPaths(files);
        return;
      }
      final image = await Pasteboard.image;
      if (image == null || !mounted) return;
      if (!(AgentScope.read(context).model?.supportsImages ?? true)) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('当前模型不支持图片，没有附上剪贴板里的图片。')));
        return;
      }
      final added = _addImage('粘贴的图片.png', image, 'image/png');
      setState(() {});
      if (!added) _tooLarge(['粘贴的图片']);
    } catch (_) {
      // No clipboard plugin (tests) or an unreadable clipboard: text paste still works.
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
        // A question put back for editing: its attachments become chips again.
        final (text, attached) = splitMentions(runtime.editorText);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _controller.value = TextEditingValue(
            text: text,
            selection: TextSelection.collapsed(offset: text.length),
          );
          setState(() => _mentions
            ..clear()
            ..addAll(attached));
          _focus.requestFocus();
        });
      }
    }

    final hasContent = _hasContent;
    final running = agent.isRunning;
    final showStop = running && !hasContent;
    final suggestions = _options(context);
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
              if (widgets.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(widgets.join('\n'), style: muted),
                ),
              if (agent.isCompacting || statuses.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6, left: 4),
                  child: Row(
                    children: [
                      if (agent.isCompacting) ...[const BreathingDot(), const SizedBox(width: 8), Text('正在压缩较早的对话…', style: muted)],
                      for (final status in statuses) ...[
                        const SizedBox(width: AppTokens.pad),
                        Flexible(
                          child: Text(status, overflow: TextOverflow.ellipsis, style: muted),
                        ),
                      ],
                    ],
                  ),
                ),
              if (suggestions.isNotEmpty) _SuggestionList(options: suggestions, highlighted: _highlighted),
              AnimatedContainer(
                duration: AppTokens.fast,
                decoration: BoxDecoration(
                  color: _dragging ? colors.accentSoft : colors.card,
                  border: Border.all(
                    color: _dragging ? colors.accent : (_focus.hasFocus ? colors.accent.withValues(alpha: 0.6) : colors.border),
                    width: _dragging ? 1.5 : 1,
                  ),
                  borderRadius: BorderRadius.circular(context.radiusLg),
                ),
                padding: const EdgeInsets.fromLTRB(14, 8, 10, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_dragging)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text('松开即可附上：图片直接给模型看，其他文件和文件夹交给 Agent 读取', style: muted?.copyWith(color: colors.accent)),
                      ),
                    if (_converting > 0)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4, top: 2),
                        child: Row(
                          children: [
                            const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5)),
                            const SizedBox(width: 8),
                            Text('正在把文档转成文字…', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
                          ],
                        ),
                      ),
                    if (_images.isNotEmpty || _mentions.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6, top: 2),
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (final image in _images) _AttachmentChip(attachment: image, onRemove: () => setState(() => _images.remove(image))),
                            for (final mention in _mentions) MentionChip(mention: mention, onRemove: () => setState(() => _mentions.remove(mention))),
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
                        if (agent.agentMode == 'standard') const _PlanToggle(),
                        const Spacer(),
                        // 蝶君 always works in the standard mode.
                        if (!agent.sandbox) const _ModeChip(),
                        const SizedBox(width: 4),
                        const Flexible(child: _ModelChip()),
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
  Widget build(BuildContext context) => IconButton(tooltip: tooltip, onPressed: onTap, iconSize: 18, visualDensity: VisualDensity.compact, icon: Icon(icon));
}

const _levelNames = {'off': '关闭', 'minimal': '极低', 'low': '低', 'medium': '中', 'high': '高', 'xhigh': '很高', 'max': '最高'};

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
        decoration: BoxDecoration(color: filled ? colors.accentSoft : null, borderRadius: BorderRadius.circular(context.radius)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 180),
                child: Text(
                  label,
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                  style: context.text.bodySmall?.copyWith(color: enabled ? colors.ink : colors.muted),
                ),
              ),
            ),
            const SizedBox(width: 2),
            Icon(Icons.expand_more, size: 15, color: colors.muted),
          ],
        ),
      ),
    );
  }
}

/// A non-selectable section label inside a popup menu.
class _MenuHeader extends PopupMenuEntry<Never> {
  const _MenuHeader(this.label);

  final String label;

  @override
  double get height => 28;

  @override
  bool represents(Object? value) => false;

  @override
  State<_MenuHeader> createState() => _MenuHeaderState();
}

class _MenuHeaderState extends State<_MenuHeader> {
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
    child: Text(widget.label, style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
  );
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.title, required this.selected});

  final String title;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        SizedBox(width: 22, child: selected ? const Icon(Icons.check, size: 16) : null),
        Expanded(child: Text(title)),
      ],
    );
  }
}

/// Names and one-line explanations of the agent modes.
const agentModeNames = {'standard': '标准', 'minimal': '极简'};
const agentModeHints = {
  'standard': '完整的工具和上下文：文件、搜索、命令、待办、计划、记忆和技能',
  'minimal': 'DeepSeek 训练时的环境：一句话提示词，只有一个 PowerShell、看图和工作目录',
};

/// The agent mode of the session. A session keeps its mode, so picking the
/// other one starts a new session in it.
class _ModeChip extends StatelessWidget {
  const _ModeChip();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final current = agent.agentMode;
    final blank = agent.active?.isPristine ?? true;
    return _Chip<String>(
      label: agentModeNames[current] ?? current,
      tooltip: 'Agent 模式：${agentModeHints[current] ?? ''}${blank ? '' : '\n切换模式会新开一个会话'}',
      enabled: agent.isReady && !agent.isRunning,
      items: [
        for (final mode in agentModeNames.keys)
          PopupMenuItem(
            value: mode,
            child: SizedBox(
              width: 300,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: 22, child: mode == current ? const Icon(Icons.check, size: 16) : null),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${agentModeNames[mode]}模式${mode != current && !blank ? '（新会话）' : ''}'),
                        Text(agentModeHints[mode]!, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
      onSelected: agent.selectAgentMode,
    );
  }
}

/// Plan mode (standard mode): the agent explores and presents a plan for
/// approval before changing anything.
class _PlanToggle extends StatelessWidget {
  const _PlanToggle();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final on = agent.planMode;
    return IconButton(
      tooltip: on ? '计划模式已开启：Agent 先查看和规划，你批准后才动手。点击关闭' : '计划模式：先让 Agent 给出计划，你批准后再动手',
      onPressed: agent.isReady ? () => agent.setPlanMode(!on) : null,
      iconSize: 18,
      visualDensity: VisualDensity.compact,
      style: on ? IconButton.styleFrom(backgroundColor: colors.accentSoft, foregroundColor: colors.accent) : null,
      icon: Icon(on ? Icons.map : Icons.map_outlined),
    );
  }
}

class _ModelChip extends StatelessWidget {
  const _ModelChip();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final model = agent.model;
    // Model groups first, then each channel's models under its name.
    final byProvider = <String, List<PiModel>>{};
    for (final m in agent.models) {
      byProvider.putIfAbsent(m.provider, () => []).add(m);
    }
    final providers = byProvider.keys.toList()..sort((a, b) => (a == groupProvider ? 0 : 1).compareTo(b == groupProvider ? 0 : 1));
    return _Chip<PiModel>(
      label: model?.name ?? '选择模型',
      tooltip: model == null ? '模型' : '模型：${model.name} · ${agent.providerLabel(model.provider)}',
      enabled: agent.isReady && agent.models.isNotEmpty,
      filled: true,
      items: [
        for (final provider in providers) ...[
          if (providers.length > 1) _MenuHeader(agent.providerLabel(provider)),
          for (final m in byProvider[provider]!)
            PopupMenuItem(
              value: m,
              child: _MenuRow(title: m.name, selected: m == model),
            ),
        ],
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
          PopupMenuItem(
            value: level,
            child: _MenuRow(title: _levelNames[level] ?? level, selected: level == agent.thinkingLevel),
          ),
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
      decoration: BoxDecoration(
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(context.radiusSm),
      ),
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
          IconButton(tooltip: '移除', visualDensity: VisualDensity.compact, iconSize: 16, onPressed: onRemove, icon: const Icon(Icons.close)),
        ],
      ),
    );
  }
}

/// One entry in the suggestion list above the input box.
class _Option {
  const _Option({required this.label, required this.description, required this.tag, required this.pick, this.icon, this.mono = false});

  final String label;
  final String description;
  final String tag;
  final VoidCallback pick;
  final IconData? icon;
  final bool mono;
}

class _SuggestionList extends StatelessWidget {
  const _SuggestionList({required this.options, required this.highlighted});

  final List<_Option> options;
  final int highlighted;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(context.radius),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (index, option) in options.indexed)
            InkWell(
              onTap: option.pick,
              child: Container(
                color: index == highlighted ? colors.accentSoft : null,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: Row(
                  children: [
                    if (option.icon != null) ...[Icon(option.icon, size: 15, color: colors.muted), const SizedBox(width: 8)],
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 260),
                      child: Text(
                        option.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: option.mono
                            ? const TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13)
                            : context.text.bodyMedium?.copyWith(fontSize: 13),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        option.description,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall?.copyWith(color: colors.muted),
                      ),
                    ),
                    Text(option.tag, style: context.text.labelSmall?.copyWith(color: colors.muted)),
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

IconData mentionIcon(MentionKind kind) => switch (kind) {
  MentionKind.note => Icons.sticky_note_2_outlined,
  MentionKind.text => Icons.notes,
  MentionKind.folder => Icons.folder_outlined,
  MentionKind.file => Icons.description_outlined,
  MentionKind.document => Icons.article_outlined,
};

/// A note, material, file or folder going along with a message; removable
/// in the input box, read-only in a sent question.
class MentionChip extends StatelessWidget {
  const MentionChip({super.key, required this.mention, this.onRemove});

  final Mention mention;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tip = mention.path ?? (mention.kind == MentionKind.note ? '写笺' : '资料');
    return Tooltip(
      message: tip,
      child: Container(
        height: 30,
        padding: EdgeInsets.only(left: 8, right: onRemove == null ? 10 : 0),
        decoration: BoxDecoration(color: colors.accentSoft, borderRadius: BorderRadius.circular(context.radius)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(mentionIcon(mention.kind), size: 14, color: colors.accent),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Text(
                mention.title,
                overflow: TextOverflow.ellipsis,
                style: context.text.bodySmall?.copyWith(color: colors.ink),
              ),
            ),
            if (onRemove != null)
              IconButton(tooltip: '移除', visualDensity: VisualDensity.compact, iconSize: 14, onPressed: onRemove, icon: const Icon(Icons.close)),
          ],
        ),
      ),
    );
  }
}

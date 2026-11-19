import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'proto_icon.dart';
import 'package:flutter/services.dart';
import 'package:pasteboard/pasteboard.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../craft_style.dart';
import 'craft_surface.dart';
import 'context_usage_ring.dart';
import '../state/mentions.dart';
import '../state/beta_edition.dart';
import '../state/agent_controller.dart' show AgentController, asJsonMap, jsonRows, MaterialInfo, NoteInfo, SessionRuntime;
import '../state/side_chat.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'commands_dialog.dart' show commandSourceLabels;
import 'common.dart' show memoryImageOf, showsOnScreen;
import 'conversation_controls.dart';
import 'keys.dart';
import 'model_group_pages.dart' show showModelSearch;
import 'motion.dart';
import 'shell_widgets.dart' show homeContentMaxWidth;
import 'run_summary.dart' show mentionOf;
import 'dashboard_page.dart' show formatCost;
import '../state/voice_input.dart';
import 'voice_controls.dart';
import 'notes.dart';
import 'onboarding_tour.dart';

/// Message input. Enter sends, Shift+Enter inserts a newline; while an IME
/// composition is active Enter is left to the IME. During a run, sending
/// steers the agent and the button doubles as Stop when the input is empty.
/// Typing `/` at the start suggests skills, prompt templates and commands;
/// `@` suggests the desk's notes and materials. Files can be dropped or
/// pasted in: images are attached, other files and folders go along by path.
class Composer extends StatefulWidget {
  const Composer({super.key, this.dragging = false, this.home = false, this.contained = false});

  /// Files are being dragged over the conversation (the chat view takes the drop).
  final bool dragging;
  final bool home;
  final bool contained;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  VoiceInput? _voice;
  void _voiceChanged(){if(!mounted)return;if(_voice?.recording==true&&!showsOnScreen(context)){unawaited(_voice!.cancel());return;}setState((){});}
  final _controller = TextEditingController();
  late final _focus = FocusNode(onKeyEvent: _onKey);
  final List<_Attachment> _images = [];
  final List<Mention> _mentions = [];
  Object? _editorRuntime;
  int _editorRevision = 0;
  int _highlighted = 0;
  static const _hints = ['说点什么…', '试试把一个表格文件拖进来', '输入 / 用技能', '想让蝶君替你盯着一件事？切到蝶君说', 'Shift + Enter 换行'];
  var _hintIndex = 0;
  Timer? _hintTimer;
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
    _hintTimer = Timer.periodic(const Duration(milliseconds: 4500), (_) {
      if (!mounted || _controller.text.isNotEmpty || _focus.hasFocus || !showsOnScreen(context)) return;
      if (AgentScope.read(context).sandbox) return;
      setState(() => _hintIndex++);
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _voice ??= VoiceInput(AgentScope.read(context).backend,onText:(text){if(mounted)_controller.value=TextEditingValue(text:text,selection:TextSelection.collapsed(offset:text.length));})..addListener(_voiceChanged);
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
    _hintTimer?.cancel();
    _voice?.removeListener(_voiceChanged);_voice?.dispose();
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
        for (final n in jsonRows(desk['notes']).map(NoteInfo.fromJson)) (Mention(kind: MentionKind.note, title: n.title, content: n.content), '任务'),
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
          tag: mention.kind == MentionKind.note ? '任务' : '资料',
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
    if (event is KeyDownEvent && key == LogicalKeyboardKey.keyV && HeldKeys.control) {
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
    if (HeldKeys.shift || _controller.value.composing.isValid) {
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

  bool get _hasContent => _controller.text.trim().isNotEmpty || _images.isNotEmpty || _mentions.isNotEmpty || AgentScope.read(context).active?.composerQuote != null;

  void _send() {
    if(_voice?.active==true)return;
    if (!_hasContent || _converting > 0) return;
    final agent = AgentScope.read(context);
    if (!agent.isReady) return;
    final quote = agent.active?.composerQuote;
    final text = composeWithMentions('${quote == null ? '' : '${SideChat.quoteLines(quote)}\n\n'}${_controller.text}', _mentions);
    final images = _images.map((a) => a.block).toList();
    _controller.clear();
    agent.clearComposerQuote();
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
    showNote('图片超过 8MB，未添加：${names.join('、')}', kind: NoteKind.fail);
  }

  Future<void> _pickImages() async {
    final files = await openFiles(acceptedTypeGroups: const [_imageTypes], confirmButtonText: '添加');
    final rejected = <String>[];
    for (final file in files) {
      // The size first: a huge file is never read into memory.
      if (await file.length() > _maxImageBytes || !_addImage(file.name, await file.readAsBytes(), _mimeOf(file.name))) rejected.add(file.name);
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
          final file = File(path);
          if (await file.length() > _maxImageBytes || !_addImage(p.basename(path), await file.readAsBytes(), _mimeOf(path))) rejected.add(p.basename(path));
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
        if (mounted) showNote('没能复制给蝶君：${SessionRuntime.describeError(e)}', kind: NoteKind.fail);
      }
    }
    if (failed.isNotEmpty && mounted) {
      showNote('没能转成文字，已添加文件路径：${failed.join('、')}', kind: NoteKind.info);
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
        showNote('当前模型不支持图片，没有附上剪贴板里的图片。', kind: NoteKind.fail);
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
      if(_voice?.active==true)unawaited(_voice!.cancel());
      // Switched sessions: adopt its revision without replacing the input.
      _editorRuntime = runtime;
      _editorRevision = runtime.editorTextRevision;
    } else if (runtime != null && runtime.editorTextRevision != _editorRevision && runtime.editorAppend) {
      // A quote (「回复」 on selected text, a side conversation's answer): after what is typed, cursor at the end.
      _editorRevision = runtime.editorTextRevision;
      runtime.editorAppend = false;
      final quote = runtime.editorText;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final typed = _controller.text.trimRight();
        final text = typed.isEmpty ? quote : '$typed\n\n$quote';
        _controller.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
        _focus.requestFocus();
      });
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
    final focusRingOpacity = switch (context.painting.id) {
      'jiadie' || 'caodie' => .11,
      'liuguang' => .15,
      _ => context.painting.isDark ? .14 : .10,
    };

    return TourAnchor('composer', child: Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: widget.home ? homeContentMaxWidth : AppTokens.contentMaxWidth + 48),
        child: Padding(
          padding: widget.home || widget.contained ? EdgeInsets.zero : const EdgeInsets.fromLTRB(24, 4, 24, 18),
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
                      if (agent.isCompacting) ...[const BreathingDot(), const SizedBox(width: 8), Text('正在整理上下文…', style: muted)],
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
              // The quote is a bar above the box (prototype 5.4), not part of it.
              if (runtime?.composerQuote case final quote?) ComposerQuote(text: quote, onRemove: agent.clearComposerQuote),
              AnimatedContainer(
                key: const ValueKey('composer-body'),
                duration: AppTokens.motion(context, AppTokens.fast),
                curve: AppTokens.curve,
                decoration: craftSurfaceDecoration(context,
                  color: _dragging ? colors.accentSoft : colors.card,
                  borderColor: _voice?.active == true
                        ? colors.seal
                        : _dragging
                            ? colors.accent
                            : _focus.hasFocus
                                ? Color.lerp(colors.border, colors.accent, .5)!
                                : colors.border,
                  borderWidth: _dragging ? 1.5 : 1,
                  radius: 18,
                  // Recording: a soft seal ring around the box (prototype .composer.rec).
                  shadows: _voice?.active == true
                      ? [BoxShadow(color: colors.seal.withValues(alpha: 0.18), spreadRadius: 3)]
                      : _focus.hasFocus
                          ? [BoxShadow(color: colors.accent.withValues(alpha: focusRingOpacity), spreadRadius: 3)]
                          : const [BoxShadow(color: Color(0x0D392F2A), blurRadius: 10, offset: Offset(0, 2))],
                ),
                // The edit rectangle follows the narrow bottom edge (18px
                // shoulders), leaving the wider top as deliberate whitespace.
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_dragging)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text('松开以添加文件', style: muted?.copyWith(color: colors.accent)),
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
                        key: const ValueKey('composer-input'),
                        controller: _controller,
                        focusNode: _focus,
                        autofocus: true,
                        minLines: widget.home ? 3 : 1,
                        maxLines: 8,
                        enabled: agent.isReady,
                        style: context.text.bodyMedium?.copyWith(height: 1.6, fontFamily: AppTokens.kaiFamily, fontFamilyFallback: AppTokens.kaiFallback, fontStyle: FontStyle.normal),
                        decoration: InputDecoration(
                          hintText: agent.sandbox ? '交代一件事，或者只是聊聊' : _hints[_hintIndex % _hints.length],
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
                    LayoutBuilder(builder: (context, constraints) {
                      if(_voice?.active==true)return VoiceRecordingBar(voice:_voice!);
                      final mic=_ToolbarButton(icon:'mic',tooltip:'语音输入（Ctrl + Shift + M）',onTap:agent.isReady?()=>_voice!.start(_controller.text):null);
                      final controls = <Widget>[
                        _ToolbarButton(
                          icon: 'attach',
                          tooltip: supportsImages ? '添加图片' : '当前模型不支持图片',
                          onTap: agent.isReady && supportsImages ? _pickImages : null,
                        ),
                        // Skills come up by typing 「/」 (1.0 prototype has no separate button).
                        // 蝶君 works in its sandbox without approvals, so both are 工作台-only (1.0 prototype).
                        if (!agent.sandbox) const IncognitoToggle(),
                        if (!agent.sandbox) const AskBeforeActingToggle(),
                      ];
                      final geometry = context.painting.craftGeometry;
                      final canSend = hasContent && agent.isReady;
                      final sendButton = IconButton(
                        tooltip: showStop ? '停止' : (running ? '插话' : '发送'),
                        onPressed: showStop ? agent.abort : (canSend ? _send : null),
                        padding: EdgeInsets.zero,
                        style: craftControlStyle(
                          context,
                          IconButton.styleFrom(
                            backgroundColor: showStop ? Colors.transparent : colors.accent,
                            foregroundColor: showStop ? colors.seal : colors.onAccent,
                            disabledBackgroundColor: colors.sunk,
                            disabledForegroundColor: colors.muted,
                            shape: craftButtonShape(geometry),
                          ),
                          focusColor: showStop ? colors.seal : colors.onAccent,
                        ),
                        icon: ProtoIcon(showStop ? 'stop' : 'send', size: showStop ? 14 : 16, color: showStop ? colors.seal : (canSend ? colors.onAccent : colors.muted)),
                      );
                      final send = TourAnchor('send', child: PressFeedback(
                        enabled: showStop || canSend,
                        child: SizedBox.square(
                          dimension: 34,
                          child: CraftControlMark(
                            geometry: geometry,
                            color: canSend && !showStop ? colors.onAccent.withValues(alpha: .22) : Colors.transparent,
                            child: sendButton,
                          ),
                        ),
                      ));
                      // Keep unusually long model/provider names readable on
                      // the home page after the user narrowed it to 900px.
                      final labelMeasure = TextPainter(
                        text: TextSpan(text: composerModelLabel(agent), style: _chipTextStyle(context)),
                        textDirection: Directionality.of(context), textScaler: MediaQuery.textScalerOf(context),
                      )..layout();
                      final separateHomeTools = widget.home && constraints.maxWidth >= 640 &&
                          labelMeasure.width + (agent.sandbox ? 220 : 360) > constraints.maxWidth;
                      labelMeasure.dispose();
                      if (separateHomeTools) {
                        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          Row(children: [...controls, const Spacer()]),
                          const SizedBox(height: 4),
                          Row(children: [
                            const Expanded(child: Align(alignment: Alignment.centerRight, child: _ModelThinkingChips())),
                            const _ContextRing(), mic, const SizedBox(width: 4), send,
                          ]),
                        ]);
                      }
                      if (constraints.maxWidth < 440) {
                        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          Row(children: [const Expanded(child: Align(alignment: Alignment.centerRight, child: _ModelThinkingChips())), const SizedBox(width: 8), const _ContextRing(), mic]),
                          const SizedBox(height: 4),
                          Row(children: [...controls, const Spacer(), send]),
                        ]);
                      }
                      // 2026-11-16: models, thinking and voice stay together beside send.
                      // 上下文圆环（0.8.1 定的「留」，原型没画）：淡色细环，放在麦克风旁边，不夹在开关中间。
                      return Row(children: [
                        ...controls,
                        const Expanded(child: Align(alignment: Alignment.centerRight, child: _ModelThinkingChips())),
                        const _ContextRing(),
                        mic,
                        const SizedBox(width: 4),
                        send,
                      ]);
                    }),
                  ],
                ),
              ),
              if(_voice?.error!=null)Padding(padding:const EdgeInsets.only(top:4),child:Text(_voice!.error!,style:context.text.bodySmall?.copyWith(color:colors.seal))),
            ],
          ),
        ),
      ),
    ));
  }
}

/// 原型 .ib：30 方、圆角 8 的细线图标钮（回形针、麦克风）。
class _ToolbarButton extends StatelessWidget {
  const _ToolbarButton({required this.icon, required this.tooltip, required this.onTap});

  final String icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => PressFeedback(enabled: onTap != null, child: IconButton(
    tooltip: tooltip, onPressed: onTap,
    style: craftControlStyle(context, IconButton.styleFrom(
      fixedSize: const Size(30, 30), minimumSize: const Size(30, 30), padding: EdgeInsets.zero,
      shape: craftButtonShape(context.painting.craftGeometry),
      foregroundColor: context.colors.ink2, disabledForegroundColor: context.colors.muted,
    )),
    icon: ProtoIcon(icon, color: onTap == null ? context.colors.muted : context.colors.ink2),
  ));
}

const _levelNames = {'off': '关闭', 'minimal': '极低', 'low': '低', 'medium': '中', 'high': '高', 'xhigh': '很高', 'max': '最高'};

/// The chips' label text, also what their widths are measured with (0.8.3: measuring with a smaller
/// font cut short labels that had room, e.g. 「Fau…」).
TextStyle _chipTextStyle(BuildContext context) => (context.text.bodySmall ?? const TextStyle()).copyWith(fontSize: 12.5);
const _chipLabelWidth = 180.0;
const _modelLabelWidth = double.infinity;

/// The model chip's label (0.8.3, user: "名称显示要完整，信息都要完整不然选错了"): the model and
/// where it comes from — 「GPT-6.1 Sol · 中转 A」, a group as 「主力 · 模型组」.
String composerModelLabel(AgentController agent) {
  final model = agent.model;
  if (model == null) return '选择模型';
  return agent.modelWithProvider(model.name, model.provider);
}

/// A quiet chip in the input box's toolbar that opens a menu.
class _Chip<T> extends StatelessWidget {
  const _Chip({super.key, required this.label, required this.tooltip, required this.enabled, required this.items, required this.onSelected, this.filled = false, this.icon, this.tightLabel = false, this.maxLabelWidth = _chipLabelWidth, this.leading, this.chevron = true});

  final String label;
  final String tooltip;
  final bool enabled;
  final List<PopupMenuEntry<T>> items;
  final ValueChanged<T> onSelected;
  final bool filled;
  final IconData? icon;
  final bool tightLabel;
  final double maxLabelWidth;
  /// Before the label (the thinking pill's bulb, prototype .pill).
  final Widget? leading;
  /// The small menu arrow (prototype: only the model pill has one).
  final bool chevron;

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
        height: 26,
        padding: EdgeInsets.symmetric(horizontal: tightLabel ? 4 : 9),
        // Only the model pill carries a sunk fill.
        decoration: ShapeDecoration(color: filled ? colors.sunk : null, shape: craftButtonShape(context.painting.craftGeometry)),
        child: icon != null ? Icon(icon, size: 18, color: enabled ? colors.ink : colors.muted) : Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (leading != null) ...[IconTheme(data: IconThemeData(color: enabled ? colors.ink2 : colors.muted), child: leading!), if (label.isNotEmpty) const SizedBox(width: 5)],
            Flexible(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: maxLabelWidth),
                child: Text(
                  label,
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                  style: _chipTextStyle(context).copyWith(color: enabled ? colors.ink2 : colors.muted),
                ),
              ),
            ),
            if (!tightLabel && chevron) ...[
              const SizedBox(width: 3),
              ProtoIcon('chev', size: 12, color: colors.muted),
            ],
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
  const _MenuRow({required this.title, required this.selected, this.note});

  final String title;
  /// 内测版在模型后面标用途（用户 2026-11-19）。
  final String? note;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        SizedBox(width: 22, child: selected ? const Icon(Icons.check, size: 16) : null),
        Expanded(child: note == null ? Text(title) : Text.rich(TextSpan(text: title, children: [TextSpan(text: '　$note', style: TextStyle(color: context.colors.muted, fontSize: 12.5))]))),
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

/// The input box's choices (0.4, roadmap 4.6): the two modes and 无痕, which is the old temporary chat
/// (minimal tools and prompt, no memory read or written, nothing saved). Settings only pick between the two modes.
const composerModeNames = {...agentModeNames, 'incognito': '无痕'};
const composerModeHints = {...agentModeHints, 'incognito': '极简的工具和提示词，不读写记忆、不保存记录，关掉就没了'};

/// Only this pair yields width: first the model label, then the thinking text.
/// Measure the current labels with the actual font/scale; no window breakpoint
/// or translated label length can steal space from the fixed toolbar buttons.
class _ModelThinkingChips extends StatelessWidget {
  const _ModelThinkingChips();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    double textWidth(String text) {
      final painter = TextPainter(text: TextSpan(text: text, style: _chipTextStyle(context)), textDirection: Directionality.of(context), textScaler: MediaQuery.textScalerOf(context))..layout();
      // A pixel of slack: the chip's Text and this painter may round differently.
      final width = painter.width.ceilToDouble() + 1;
      painter.dispose();
      return width;
    }
    // _Chip: 20px horizontal padding + 2px gap + 15px menu chevron.
    // _Chip: 18px padding + 14px bulb + 5px gap + the level.
    final thinkingWidth = textWidth(_levelNames[agent.thinkingLevel] ?? agent.thinkingLevel).clamp(0.0, _chipLabelWidth) + 37;
    final minimumModelWidth = textWidth('…') + 37;
    return LayoutBuilder(builder: (context, constraints) {
      final iconOnly = constraints.maxWidth < minimumModelWidth + 4 + thinkingWidth;
      // 0.8.3: the model chip takes the room that is really left (it read 「Fau…」 with room to spare);
      // it only shortens when the toolbar is narrower than the whole label.
      return Row(mainAxisSize: MainAxisSize.min, children: [
        Flexible(child: _ModelChip(tightLabel: constraints.maxWidth - 4 - (iconOnly ? 32 : thinkingWidth) < minimumModelWidth)),
        const SizedBox(width: 4),
        _ThinkingChip(iconOnly: iconOnly),
      ]);
    });
  }
}

class _ModelChip extends StatelessWidget {
  const _ModelChip({this.tightLabel = false});
  final bool tightLabel;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final model = agent.model;
    // 0.8.3: model groups first, then each channel's common models under its name; 「更多模型…」 for the rest.
    final sections = agent.modelSections();
    final member = agent.currentGroupMember;
    return _Chip<PiModel>(
      key: const ValueKey('composer-model'),
      tightLabel: tightLabel,
      label: composerModelLabel(agent),
      maxLabelWidth: _modelLabelWidth,
      tooltip: model == null ? '模型' : member != null ? '模型组「${model.name}」：现在用 $member' : '模型：${agent.modelWithProvider(model.name, model.provider)}',
      enabled: agent.isReady && agent.models.isNotEmpty,
      filled: true,
      items: [
        for (final section in sections) ...[
          if (sections.length > 1) _MenuHeader(section.title),
          for (final m in section.models)
            PopupMenuItem(
              value: m,
              child: _MenuRow(title: m.name, note: betaModelNote(m.id), selected: m == model),
            ),
        ],
        if (agent.hasMoreModels)
          PopupMenuItem(
            key: const ValueKey('composer-more-models'),
            // The menu closes first; then the search opens over the conversation.
            onTap: () => WidgetsBinding.instance.addPostFrameCallback((_) async {
              final picked = await showModelSearch(context);
              if (picked != null) await agent.selectModel(picked);
            }),
            child: const _MenuRow(title: '更多模型…', selected: false),
          ),
      ],
      onSelected: agent.selectModel,
    );
  }
}

class _ThinkingChip extends StatelessWidget {
  const _ThinkingChip({this.iconOnly = false});
  final bool iconOnly;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final model = agent.model;
    return _Chip<String>(
      key: const ValueKey('composer-thinking'),
      // 原型 .pill：「💡 中」——灯泡图标加档位，没有下拉箭头；很窄时只剩灯泡。
      leading: const ProtoIcon('think', size: 14),
      chevron: false,
      label: iconOnly ? '' : (_levelNames[agent.thinkingLevel] ?? agent.thinkingLevel),
      tooltip: model != null && !model.reasoning ? '当前模型不支持思考' : '思考深度',
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
    final stats = agent.stats;
    final percent = stats.contextKnown ? stats.contextPercent : 0.0;
    final known = stats.contextKnown && stats.contextWindow > 0;
    final tip = [
      known ? '上下文已用 ${percent.toStringAsFixed(percent < 10 ? 1 : 0)}%' : '上下文用量未知',
      if (stats.cost > 0) '花费 ${formatCost(stats.cost)}',
    ].join(' · ');
    return Tooltip(
      message: tip,
      child: Semantics(
        button: true,
        label: '上下文',
        value: known ? '${percent.toStringAsFixed(1)}%' : '用量未知',
        child: InkWell(
          key: const ValueKey('context-ring'),
          customBorder: const CircleBorder(),
          onTap: agent.isReady ? agent.showContextPanel : null,
          child: Padding(
            padding: const EdgeInsets.all(6),
            child: ContextUsageRing(value: known ? percent / 100 : null),
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
            child: Image(image: memoryImageOf(attachment.block.data), gaplessPlayback: true, width: 36, height: 36, fit: BoxFit.cover),
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
      decoration: craftSurfaceDecoration(context,
        color: colors.card,
        radius: context.radius,
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
    final tip = mention.path ?? (mention.kind == MentionKind.note ? '任务' : '资料');
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

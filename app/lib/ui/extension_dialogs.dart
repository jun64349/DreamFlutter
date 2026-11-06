import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../theme.dart';
import '../state/session_runtime.dart';
import 'agent_scope.dart';
import 'markdown_view.dart';

/// Shows extension dialogs (select / confirm / input / editor) of the active
/// session one at a time. Tool approval from dreamflutter-approval arrives as
/// a `select` and gets a dedicated layout.
class ExtensionDialogHost extends StatefulWidget {
  const ExtensionDialogHost({super.key, required this.child});

  final Widget child;

  @override
  State<ExtensionDialogHost> createState() => _ExtensionDialogHostState();
}

class _ExtensionDialogHostState extends State<ExtensionDialogHost> {
  ExtensionUiRequest? _showing;

  @override
  Widget build(BuildContext context) {
    final request = AgentScope.of(context).pendingDialog;
    if (request != null && !identical(request, _showing)) {
      _showing = request;
      WidgetsBinding.instance.addPostFrameCallback((_) => _present(request));
    }
    return widget.child;
  }

  Future<void> _present(ExtensionUiRequest request) async {
    if (!mounted) return;
    final agent = AgentScope.read(context);
    final answer = await showDialog<_Answer>(
      context: context,
      barrierDismissible: false,
      // The route sits above this page's scope (蝶君 has its own controller): hand it the one that asked.
      builder: (_) => AgentScope(controller: agent, child: _ExtensionDialog(request: request)),
    );
    // The run may have ended (and the request vanished) while it was open.
    if (answer != null) {
      agent.answerDialog(request, value: answer.value, confirmed: answer.confirmed, cancelled: answer.cancelled);
    } else {
      agent.answerDialog(request, cancelled: true);
    }
    if (mounted) setState(() => _showing = null);
  }
}

class _Answer {
  const _Answer({this.value, this.confirmed, this.cancelled = false});
  final String? value;
  final bool? confirmed;
  final bool cancelled;
}

/// The same confirmation card as the main conversation, answered through the
/// owning runtime's slot connection rather than the active main conversation.
class SideExtensionDialog extends StatelessWidget {
  const SideExtensionDialog({super.key, required this.runtime});
  final SessionRuntime runtime;

  @override
  Widget build(BuildContext context) {
    final request = runtime.pendingDialogs.firstOrNull;
    if (request == null) return const SizedBox.shrink();
    return SingleChildScrollView(child: _ExtensionDialog(
      key: ObjectKey(request),
      request: request,
      onAnswer: (answer) => runtime.answerDialog(request, value: answer.value, confirmed: answer.confirmed, cancelled: answer.cancelled),
    ));
  }
}

class _ExtensionDialog extends StatefulWidget {
  const _ExtensionDialog({super.key, required this.request, this.onAnswer});

  final ExtensionUiRequest request;
  final void Function(_Answer)? onAnswer;

  @override
  State<_ExtensionDialog> createState() => _ExtensionDialogState();
}

class _ExtensionDialogState extends State<_ExtensionDialog> {
  late final _text = TextEditingController(text: widget.request.prefill ?? '');
  var _closing = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  /// Closes with [answer]; marks the dialog as closing first.
  void _answer(BuildContext context, _Answer answer) {
    if (_closing) return;
    _closing = true;
    if (widget.onAnswer != null) {
      widget.onAnswer!(answer);
    } else {
      Navigator.pop(context, answer);
    }
  }

  // Title prefixes the core uses (core/src/pi/dialogs.ts).
  static const approvalTitle = 'Agent 请求执行操作';
  static const trustTitle = '信任此工作区？';
  static const planTitle = '请审阅 Agent 的计划';
  static const questionTitle = 'Agent 需要你补充信息：';

  bool get _isApproval => widget.request.method == 'select' && widget.request.title.startsWith(approvalTitle);
  bool get _isTrust => widget.request.method == 'select' && widget.request.title.startsWith(trustTitle);
  bool get _isPlan => widget.request.method == 'select' && widget.request.title.startsWith(planTitle);
  bool get _isQuestion => widget.request.title.startsWith(questionTitle);

  @override
  Widget build(BuildContext context) {
    // Close if the request disappeared on Pi's side (run aborted, settled).
    // Never pop twice: after the user answers, this dialog keeps rebuilding
    // during its exit animation, and a second pop would close the page below.
    final agent = AgentScope.of(context);
    final stillPending = agent.active?.pendingDialogs.contains(widget.request) ?? false;
    if (widget.onAnswer == null && !stillPending && !_closing) {
      _closing = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && (ModalRoute.of(context)?.isCurrent ?? false)) Navigator.of(context).pop();
      });
    }
    final request = widget.request;
    return switch (request.method) {
      'select' when _isApproval => _approval(context),
      'select' when _isTrust => _trust(context),
      'select' when _isPlan => _plan(context),
      'select' when _isQuestion => _question(context),
      'select' => _select(context),
      'confirm' => _confirm(context),
      _ => _input(context, multiline: request.method == 'editor'),
    };
  }

  Widget _card({Widget? icon, required Widget title, required Widget content, List<Widget>? actions, double? actionsOverflowButtonSpacing}) => AlertDialog(
    icon: icon,
    title: title,
    content: content,
    actions: actions,
    actionsOverflowButtonSpacing: actionsOverflowButtonSpacing,
    insetPadding: widget.onAnswer == null ? null : EdgeInsets.zero,
  );

  Widget _approval(BuildContext context) {
    final colors = context.colors;
    final request = widget.request;
    final body = request.title.substring(approvalTitle.length).trimLeft();
    final newline = body.indexOf('\n');
    final heading = newline == -1 ? body : body.substring(0, newline);
    final detail = newline == -1 ? '' : body.substring(newline + 1);
    final options = request.options;
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13);
    return _card(
      icon: Icon(Icons.shield_outlined, color: colors.warning),
      title: const Text('Agent 请求执行操作'),
      content: SizedBox(
        width: 520,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(heading, style: context.text.bodyLarge),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: AppTokens.gap),
              Container(
                constraints: const BoxConstraints(maxHeight: 260),
                padding: const EdgeInsets.all(AppTokens.pad),
                decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(context.radiusSm)),
                child: SingleChildScrollView(child: SelectableText(detail, style: mono)),
              ),
            ],
            const SizedBox(height: AppTokens.pad),
            Text('可以在「设置 → 安全」里调整什么时候需要确认。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          ],
        ),
      ),
      actionsOverflowButtonSpacing: AppTokens.gap,
      actions: [
        // Options: allow, ..."always allow" variants..., deny.
        for (final option in options.length >= 3 ? options.sublist(1, options.length - 1) : const <String>[])
          TextButton(onPressed: () => _answer(context, _Answer(value: option)), child: Text(option)),
        OutlinedButton(
          onPressed: () => _answer(context, options.isEmpty ? const _Answer(cancelled: true) : _Answer(value: options.last)),
          child: Text(options.isEmpty ? '拒绝' : options.last),
        ),
        FilledButton(
          autofocus: true,
          onPressed: () => _answer(context, _Answer(value: options.isEmpty ? '允许' : options.first)),
          child: Text(options.isEmpty ? '允许' : options.first),
        ),
      ],
    );
  }

  /// Workspace trust prompt from the core. Options, in order: trust once,
  /// trust and remember, distrust once, distrust and remember.
  Widget _trust(BuildContext context) {
    final colors = context.colors;
    final lines = widget.request.title.substring(trustTitle.length).trim().split('\n');
    final cwd = lines.first.trim();
    final options = widget.request.options;
    String option(int i, String fallback) => i < options.length ? options[i] : fallback;
    return _card(
      icon: Icon(Icons.verified_user_outlined, color: colors.warning),
      title: const Text('信任这个工作区的配置吗？'),
      content: SizedBox(
        width: 520,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SelectableText(cwd, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: AppTokens.pad),
            const Text(
              '这个文件夹里有 Pi 的项目配置，比如 .pi 目录里的设置、技能、扩展。信任后会加载它们，其中的扩展会以你的权限运行代码。'
              '只信任你自己或可靠来源的项目。不信任的话，Agent 照常工作，只是不加载这些项目配置。',
            ),
          ],
        ),
      ),
      actionsOverflowButtonSpacing: AppTokens.gap,
      actions: [
        TextButton(onPressed: () => _answer(context, _Answer(value: option(3, '不信任并记住'))), child: Text(option(3, '不信任并记住'))),
        OutlinedButton(onPressed: () => _answer(context, _Answer(value: option(2, '这次不信任'))), child: Text(option(2, '这次不信任'))),
        OutlinedButton(onPressed: () => _answer(context, _Answer(value: option(0, '仅这次信任'))), child: Text(option(0, '仅这次信任'))),
        FilledButton(onPressed: () => _answer(context, _Answer(value: option(1, '信任并记住'))), child: Text(option(1, '信任并记住'))),
      ],
    );
  }

  /// A plan the agent presents for approval (exit_plan_mode), as Markdown.
  Widget _plan(BuildContext context) {
    final colors = context.colors;
    final plan = widget.request.title.substring(planTitle.length).trim();
    final options = widget.request.options;
    return _card(
      icon: Icon(Icons.map_outlined, color: colors.accent),
      title: const Text(planTitle),
      content: SizedBox(
        width: 640,
        child: Container(
          constraints: const BoxConstraints(maxHeight: 460),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(context.radiusSm)),
          child: SingleChildScrollView(child: ReplyMarkdown(text: plan)),
        ),
      ),
      actions: [
        if (options.length > 1) TextButton(onPressed: () => _answer(context, _Answer(value: options[1])), child: Text(options[1])),
        if (options.isNotEmpty) FilledButton(autofocus: true, onPressed: () => _answer(context, _Answer(value: options[0])), child: Text(options[0])),
      ],
    );
  }

  /// A question the agent asks (ask_user_question): its choices as cards,
  /// "label — description" split into a title and a quiet line.
  Widget _question(BuildContext context) {
    final colors = context.colors;
    final body = widget.request.title.substring(questionTitle.length).trim();
    final timeout = widget.request.timeout;
    final recommended = widget.request.options.firstWhere((o) => RegExp(r'\(recommended\)|（推荐）|\(推荐\)', caseSensitive: false).hasMatch(o), orElse: () => widget.request.options.first);
    return _card(
      icon: Icon(Icons.help_outline, color: colors.accent),
      title: const Text('Agent 想问你'),
      content: SizedBox(
        width: 520,
        child: ListView(
          shrinkWrap: true,
          children: [
            Text(body, style: context.text.bodyLarge?.copyWith(height: 1.6)),
            if (timeout != null) _Countdown(total: timeout, recommended: recommended.split(' — ').first),
            const SizedBox(height: AppTokens.gap),
            for (final option in widget.request.options)
              Builder(
                builder: (context) {
                  final split = option.indexOf(' — ');
                  return ListTile(
                    title: Text(split < 0 ? option : option.substring(0, split)),
                    subtitle: split < 0 ? null : Text(option.substring(split + 3)),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radiusSm)),
                    onTap: () => _answer(context, _Answer(value: option)),
                  );
                },
              ),
          ],
        ),
      ),
    );
  }

  Widget _select(BuildContext context) => _card(
    title: Text(widget.request.title),
    content: SizedBox(
      width: 460,
      child: ListView(
        shrinkWrap: true,
        children: [
          for (final option in widget.request.options)
            ListTile(
              title: Text(option),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radiusSm)),
              onTap: () => _answer(context, _Answer(value: option)),
            ),
        ],
      ),
    ),
    actions: [TextButton(onPressed: () => _answer(context, const _Answer(cancelled: true)), child: const Text('取消'))],
  );

  Widget _confirm(BuildContext context) => _card(
    title: Text(widget.request.title),
    content: SizedBox(width: 460, child: Text(widget.request.message)),
    actions: [
      TextButton(onPressed: () => _answer(context, const _Answer(confirmed: false)), child: const Text('否')),
      FilledButton(autofocus: true, onPressed: () => _answer(context, const _Answer(confirmed: true)), child: const Text('是')),
    ],
  );

  Widget _input(BuildContext context, {required bool multiline}) => _card(
    title: Text(_isQuestion ? 'Agent 想问你' : widget.request.title),
    content: SizedBox(
      width: 520,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_isQuestion) ...[
            Text(widget.request.title.substring(questionTitle.length).trim(), style: context.text.bodyLarge?.copyWith(height: 1.6)),
            const SizedBox(height: AppTokens.gap),
          ],
          TextField(
            controller: _text,
            autofocus: true,
            minLines: multiline ? 6 : 1,
            maxLines: multiline ? 16 : 1,
            decoration: InputDecoration(hintText: widget.request.placeholder),
            onSubmitted: multiline ? null : (v) => _answer(context, _Answer(value: v)),
          ),
        ],
      ),
    ),
    actions: [
      TextButton(onPressed: () => _answer(context, const _Answer(cancelled: true)), child: const Text('取消')),
      FilledButton(onPressed: () => _answer(context, _Answer(value: _text.text)), child: const Text('确定')),
    ],
  );
}

/// 「52 秒后自动选择 X」 under a question that times out (extra test 12).
class _Countdown extends StatefulWidget {
  const _Countdown({required this.total, required this.recommended});

  final Duration total;
  final String recommended;

  @override
  State<_Countdown> createState() => _CountdownState();
}

class _CountdownState extends State<_Countdown> {
  final _started = DateTime.now();
  late final Timer _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final left = widget.total - DateTime.now().difference(_started);
    final seconds = left.isNegative ? 0 : (left.inMilliseconds / 1000).ceil();
    return Padding(
      padding: const EdgeInsets.only(top: AppTokens.gap),
      child: Text(
        '$seconds 秒后没有回答，会自动选择「${widget.recommended}」',
        style: context.text.bodySmall?.copyWith(color: context.colors.muted),
      ),
    );
  }
}

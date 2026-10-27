import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../theme.dart';
import 'agent_scope.dart';

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
      builder: (_) => _ExtensionDialog(request: request),
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

class _ExtensionDialog extends StatefulWidget {
  const _ExtensionDialog({required this.request});

  final ExtensionUiRequest request;

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
    Navigator.pop(context, answer);
  }

  // Title prefixes the core uses (core/src/pi/dialogs.ts).
  static const approvalTitle = 'Agent 请求执行操作';
  static const trustTitle = '信任此工作区？';

  bool get _isApproval => widget.request.method == 'select' && widget.request.title.startsWith(approvalTitle);
  bool get _isTrust => widget.request.method == 'select' && widget.request.title.startsWith(trustTitle);

  @override
  Widget build(BuildContext context) {
    // Close if the request disappeared on Pi's side (run aborted, settled).
    // Never pop twice: after the user answers, this dialog keeps rebuilding
    // during its exit animation, and a second pop would close the page below.
    final agent = AgentScope.of(context);
    final stillPending = agent.active?.pendingDialogs.contains(widget.request) ?? false;
    if (!stillPending && !_closing) {
      _closing = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && (ModalRoute.of(context)?.isCurrent ?? false)) Navigator.of(context).pop();
      });
    }
    final request = widget.request;
    return switch (request.method) {
      'select' when _isApproval => _approval(context),
      'select' when _isTrust => _trust(context),
      'select' => _select(context),
      'confirm' => _confirm(context),
      _ => _input(context, multiline: request.method == 'editor'),
    };
  }

  Widget _approval(BuildContext context) {
    final colors = context.colors;
    final request = widget.request;
    final body = request.title.substring(approvalTitle.length).trimLeft();
    final newline = body.indexOf('\n');
    final heading = newline == -1 ? body : body.substring(0, newline);
    final detail = newline == -1 ? '' : body.substring(newline + 1);
    final options = request.options;
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13);
    return AlertDialog(
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
                decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
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
          onPressed: () => _answer(context, _Answer(value: options.last)),
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
    return AlertDialog(
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

  Widget _select(BuildContext context) => AlertDialog(
    title: Text(widget.request.title),
    content: SizedBox(
      width: 460,
      child: ListView(
        shrinkWrap: true,
        children: [
          for (final option in widget.request.options)
            ListTile(
              title: Text(option),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
              onTap: () => _answer(context, _Answer(value: option)),
            ),
        ],
      ),
    ),
    actions: [TextButton(onPressed: () => _answer(context, const _Answer(cancelled: true)), child: const Text('取消'))],
  );

  Widget _confirm(BuildContext context) => AlertDialog(
    title: Text(widget.request.title),
    content: SizedBox(width: 460, child: Text(widget.request.message)),
    actions: [
      TextButton(onPressed: () => _answer(context, const _Answer(confirmed: false)), child: const Text('否')),
      FilledButton(autofocus: true, onPressed: () => _answer(context, const _Answer(confirmed: true)), child: const Text('是')),
    ],
  );

  Widget _input(BuildContext context, {required bool multiline}) => AlertDialog(
    title: Text(widget.request.title),
    content: SizedBox(
      width: 520,
      child: TextField(
        controller: _text,
        autofocus: true,
        minLines: multiline ? 6 : 1,
        maxLines: multiline ? 16 : 1,
        decoration: InputDecoration(hintText: widget.request.placeholder),
        onSubmitted: multiline ? null : (v) => _answer(context, _Answer(value: v)),
      ),
    ),
    actions: [
      TextButton(onPressed: () => _answer(context, const _Answer(cancelled: true)), child: const Text('取消')),
      FilledButton(onPressed: () => _answer(context, _Answer(value: _text.text)), child: const Text('确定')),
    ],
  );
}

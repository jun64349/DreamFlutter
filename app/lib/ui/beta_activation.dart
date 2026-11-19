import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/beta_edition.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'proto_icon.dart';
import 'setup_wizard.dart';

/// 内测版的第一次启动：只有输入激活码一张卡片，激活成功点「进入」直接到首页（用户 2026-11-19 定）。
/// 激活码就是随想上给每人建的 API Key；其余首次设置都用默认值。
class BetaActivation extends StatefulWidget {
  const BetaActivation({super.key, required this.status, required this.onComplete});
  final Json status;
  final VoidCallback onComplete;
  @override State<BetaActivation> createState() => _BetaActivationState();
}

class _BetaActivationState extends State<BetaActivation> {
  final _key = TextEditingController();
  Timer? _debounce;
  String? _channel, _provider, _tested, _error;
  bool _busy = false, _entering = false;
  AgentController get a => AgentScope.read(context);
  bool get _ok => _tested != null && _tested == _key.text.trim();

  @override void dispose() { _debounce?.cancel(); _key.dispose(); super.dispose(); }

  void _changed(String value) {
    _debounce?.cancel();
    setState(() { _tested = null; _error = null; });
    if (value.trim().isNotEmpty) _debounce = Timer(const Duration(milliseconds: 350), () => unawaited(_activate()));
  }

  Future<void> _activate() async {
    final key = _key.text.trim();
    if (_busy || key.isEmpty || _tested == key) return;
    setState(() { _busy = true; _error = null; });
    try {
      final saved = await a.backend.call('gateway.saveChannel', betaChannel(key, id: _channel));
      _channel = saved is String ? saved : asJsonMap(saved)['id'] as String?;
      if (_channel == null) throw StateError('save');
      await a.refreshGateway();
      _provider = a.gatewayChannels.where((c) => c.id == _channel).firstOrNull?.provider;
      final tested = asJsonMap(await a.backend.call('setup.testChannel', {'channel': _channel, 'model': betaTerra}, const Duration(seconds: 60)));
      if (tested['ok'] != true) throw StateError('${tested['error'] ?? tested['message'] ?? ''}');
      if (mounted && _key.text.trim() == key) setState(() => _tested = key);
    } catch (e) {
      if (mounted && _key.text.trim() == key) setState(() => _error = betaActivationError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _enter() async {
    if (!_ok || _entering) return;
    setState(() { _entering = true; _error = null; });
    try {
      Future<Object?> complete(String sandbox) => a.backend.call('setup.complete', {
        'dataRoot': widget.status['dataRoot'], 'userName': '', 'channelId': _channel,
        'models': betaUses(_provider ?? _channel!), 'defaultWorkspace': null, 'sandbox': sandbox,
      }, const Duration(minutes: 5));
      try { await complete('now'); } on CoreException catch (e) { if (e.code != 'unavailable') rethrow; await complete('later'); }
      await a.updateCoreSettings({});
      await a.finishOnboarding();
      if (mounted) widget.onComplete();
    } catch (e) {
      if (mounted) setState(() => _error = '还没完成：${SessionRuntime.describeError(e)}');
    } finally {
      if (mounted) setState(() => _entering = false);
    }
  }

  @override Widget build(BuildContext context) {
    final colors = context.colors;
    final border = OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none);
    final small = context.text.bodySmall?.copyWith(fontSize: 13);
    return WizardFrame(step: 0, busy: _entering, error: _error, next: _ok ? _enter : null, nextLabel: '进入', child: Padding(padding: const EdgeInsets.only(top: 20), child: Column(children: [
      const SizedBox.square(dimension: 96, child: Center(child: ButterflyMark(size: 60))),
      const SizedBox(height: 16),
      Text('输入激活码', textAlign: TextAlign.center, style: context.handwriting(context.text.headlineMedium).copyWith(fontSize: 30, height: 1.6, fontWeight: FontWeight.w400)),
      const SizedBox(height: 18),
      Semantics(label: '激活码', child: TextField(
        key: const ValueKey('beta-activation-key'), controller: _key, autofocus: true, obscureText: true, enableSuggestions: false, autocorrect: false, textAlign: TextAlign.center,
        decoration: InputDecoration(hintText: '粘贴激活码', isDense: true, filled: true, fillColor: colors.sunk, border: border, enabledBorder: border,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10)),
        onChanged: _changed, onSubmitted: (_) => _ok ? _enter() : _activate(),
      )),
      SizedBox(height: 34, child: Center(child: _busy
        ? Row(mainAxisSize: MainAxisSize.min, children: [const SizedBox.square(dimension: 12, child: CircularProgressIndicator(strokeWidth: 1.5)), const SizedBox(width: 8), Text('正在激活…', style: small?.copyWith(color: colors.muted))])
        : _ok ? Row(mainAxisSize: MainAxisSize.min, children: [ProtoIcon('check', size: 14, color: colors.success), const SizedBox(width: 6), Text('激活成功', style: small?.copyWith(color: colors.success))])
        : const SizedBox.shrink())),
    ])));
  }
}

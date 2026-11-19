import 'package:flutter/material.dart';
import '../state/agent_controller.dart';
import '../state/beta_edition.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'dashboard_page.dart' show formatCost;
import 'settings_controls.dart' show SettingRow;
import 'shell_widgets.dart' show ShellButton, ShellButtonKind;

/// The beta's channel (the only one it ever saves).
GatewayChannel? betaChannelOf(AgentController a) => a.gatewayChannels.where((c) => c.baseUrl == betaBaseUrl).firstOrNull;

/// 设置 › 模型 › 模型池（内测版，原型 v1-settings.js「托管版」）：激活码和这台电脑上已花的钱。
class BetaPoolRows extends StatefulWidget {
  const BetaPoolRows({super.key});
  @override State<BetaPoolRows> createState() => _BetaPoolRowsState();
}

class _BetaPoolRowsState extends State<BetaPoolRows> {
  double? _spent;
  @override void initState() { super.initState(); WidgetsBinding.instance.addPostFrameCallback((_) => _load()); }
  Future<void> _load() async {
    try {
      final rows = jsonRows(asJsonMap(await AgentScope.read(context).backend.call('ledger.summary', {'since': 0, 'until': DateTime.now().add(const Duration(days: 1)).millisecondsSinceEpoch, 'period': 'month', 'groupBy': 'all'}))['rows']);
      var total = 0.0;
      for (final row in rows) { for (final v in asJsonMap(row['amounts']).values) { if (v is num) total += v.toDouble(); } }
      if (mounted) setState(() => _spent = total);
    } catch (_) {}
  }
  @override Widget build(BuildContext context) {
    final a = AgentScope.of(context);
    final colors = context.colors;
    final channel = betaChannelOf(a);
    final hint = channel?.keys.firstOrNull?.hint ?? '';
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12.5, color: colors.ink2);
    Widget link(String text, VoidCallback onTap) => TextButton(onPressed: onTap,
      style: TextButton.styleFrom(foregroundColor: colors.accent, padding: const EdgeInsets.symmetric(horizontal: 6), minimumSize: const Size(0, 30), tapTargetSize: MaterialTapTargetSize.shrinkWrap, textStyle: const TextStyle(fontSize: 13)),
      child: Text(text));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SettingRow('激活码', child: Row(mainAxisSize: MainAxisSize.min, children: [Text('sk-••••$hint', style: mono), link('换一个', () => _replace(context, channel))])),
      SettingRow('这台电脑上已花', child: Row(mainAxisSize: MainAxisSize.min, children: [Text(_spent == null ? '—' : formatCost(_spent!), style: mono), link('明细', () => a.showSection(AppSection.spending))])),
    ]);
  }

  Future<void> _replace(BuildContext context, GatewayChannel? channel) async {
    final changed = await showDialog<bool>(context: context, builder: (_) => _ReplaceKeyDialog(channel: channel));
    if (changed == true && mounted) setState(() {});
  }
}

class _ReplaceKeyDialog extends StatefulWidget {
  const _ReplaceKeyDialog({required this.channel});
  final GatewayChannel? channel;
  @override State<_ReplaceKeyDialog> createState() => _ReplaceKeyDialogState();
}

class _ReplaceKeyDialogState extends State<_ReplaceKeyDialog> {
  final _key = TextEditingController();
  bool _busy = false;
  String? _error;
  @override void dispose() { _key.dispose(); super.dispose(); }
  Future<void> _save() async {
    final key = _key.text.trim();
    if (key.isEmpty || _busy) return;
    final a = AgentScope.read(context);
    setState(() { _busy = true; _error = null; });
    try {
      await a.backend.call('gateway.saveChannel', betaChannel(key, id: widget.channel?.id));
      await a.refreshGateway();
      final id = betaChannelOf(a)?.id;
      final tested = asJsonMap(await a.backend.call('setup.testChannel', {'channel': id, 'model': betaTerra}, const Duration(seconds: 60)));
      if (tested['ok'] != true) throw StateError('${tested['error'] ?? tested['message'] ?? ''}');
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = betaActivationError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
  @override Widget build(BuildContext context) => AlertDialog(
    title: const Text('换一个激活码'),
    content: SizedBox(width: 360, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(controller: _key, autofocus: true, obscureText: true, enableSuggestions: false, autocorrect: false, decoration: const InputDecoration(hintText: '粘贴激活码'), onSubmitted: (_) => _save()),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: TextStyle(color: context.colors.danger))),
    ])),
    actions: [
      ShellButton('取消', kind: ShellButtonKind.ghost, onPressed: _busy ? null : () => Navigator.pop(context, false)),
      ShellButton(_busy ? '正在激活…' : '换上', kind: ShellButtonKind.primary, onPressed: _busy ? null : _save),
    ],
  );
}

/// 四个用途写死，只显示（用户 2026-11-19 定）。
class BetaFixedModel extends StatelessWidget {
  const BetaFixedModel(this.label, this.model, {super.key, this.desc});
  final String label, model;
  final String? desc;
  @override Widget build(BuildContext context) => SettingRow(label, desc: desc, child: Text(model, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: context.colors.ink2)));
}

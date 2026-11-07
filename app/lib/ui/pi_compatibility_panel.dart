import 'dart:async';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import 'agent_scope.dart';
import 'providers_page.dart';

/// Migration state and the same app-owned configuration used by the Pi CLI.
class PiCompatibilityPanel extends StatefulWidget {
  const PiCompatibilityPanel({super.key, this.pickFolder});
  final Future<String?> Function(String?)? pickFolder;
  @override
  State<PiCompatibilityPanel> createState() => _PiCompatibilityPanelState();
}

class _PiCompatibilityPanelState extends State<PiCompatibilityPanel> {
  AgentController? _agent;
  StreamSubscription<Json>? _events;
  Json? _data;
  String? _error;
  String? _receipt;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (agent == _agent) return;
    _agent = agent;
    unawaited(_events?.cancel());
    _events = agent.backend.events.listen((event) {
      if (event['event'] == 'piMigration.changed' && mounted) setState(() => _data = asJsonMap(event['status']));
    });
    unawaited(_run(() async => _load()));
  }
  @override
  void dispose() { unawaited(_events?.cancel()); super.dispose(); }
  Future<void> _load() async {
    final data = asJsonMap(await _agent!.backend.call('piMigration.status'));
    if (mounted) setState(() => _data = data);
  }
  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; _receipt = null; });
    try { await action(); }
    catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  Future<void> _call(String method, [Json params = const {}]) async => _run(() async {
    final result = asJsonMap(await _agent!.backend.call(method, params, const Duration(minutes: 5)));
    if (mounted) setState(() { _data = result; _receipt = result['status'] == 'done' ? '渠道与 Pi 兼容配置已更新' : null; });
  });
  Future<void> _import() async {
    final initial = _data?['defaultImportFolder'] as String?;
    final folder = await (widget.pickFolder?.call(initial) ?? getDirectoryPath(initialDirectory: initial, confirmButtonText: '只读导入 Pi 配置'));
    if (folder == null || !mounted) return;
    await _call('piMigration.import', {'folder': folder});
  }
  @override
  Widget build(BuildContext context) {
    final data = _data, done = data?['status'] == 'done';
    final busy = _busy || data?['busy'] == true;
    final unresolved = data?['unresolved'] as List? ?? const [];
    return Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Pi 兼容配置', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 8),
      Text(data == null ? '正在读取迁移状态…' : done ? '已迁入渠道 · 兼容配置由渠道生成' : data['status'] == 'failed' ? '迁移失败 · 原 Pi 配置页仍可用' : '尚未完成 Pi 服务商迁移'),
      if (data != null) ...[
        const SizedBox(height: 12),
        SelectableText('配置路径：${data['path'] ?? ''}'),
        if (data['generatedAt'] is num) Text('上次生成：${DateTime.fromMillisecondsSinceEpoch((data['generatedAt'] as num).toInt()).toLocal()}'),
        Text(data['externalModified'] == true ? '检测到外部修改；重新生成前会先备份。' : '外部修改：未检测到'),
        if (data['externalBackup'] != null) SelectableText('检测到外部修改，已备份到 ${data['externalBackup']}；需要的话可以点“从 Pi 配置导入”。'),
        if (data['backup'] != null) SelectableText('迁移备份：${data['backup']}'),
      ],
      const SizedBox(height: 12),
      const Text('渠道是配置来源。Pi 命令行使用以下命令进入同一份兼容配置；密钥通过 !command 解密，只能在同一台电脑、同一个 Windows 用户下使用。'),
      if (done) ...[
        const SizedBox(height: 8),
        SelectableText(data?['command'] as String? ?? ''),
        Wrap(spacing: 8, runSpacing: 8, children: [
          TextButton(onPressed: busy ? null : () async { await Clipboard.setData(ClipboardData(text: data?['command'] as String? ?? '')); if (mounted) setState(() => _receipt = 'Pi 启动命令已复制'); }, child: const Text('复制命令')),
          OutlinedButton(onPressed: busy ? null : _import, child: const Text('从 Pi 配置导入')),
          TextButton(onPressed: busy ? null : () => _call('piMigration.generate'), child: const Text('重新生成')),
        ]),
        const Text('手动导入只读所选文件夹，只添加新服务商；已有映射和渠道不会覆盖。cc-switch 的后续修改不会自动导入。'),
      ] else ...[
        Wrap(spacing: 8, runSpacing: 8, children: [
          OutlinedButton(onPressed: busy || data == null ? null : () => _call('piMigration.retry'), child: const Text('重试迁移')),
          TextButton(onPressed: busy ? null : () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const ProvidersPage(legacyOnly: true))), child: const Text('打开原 Pi 配置页')),
        ]),
      ],
      if (unresolved.isNotEmpty) ...[const SizedBox(height: 8), const Text('以下模型引用未映射，已保留原值：'), for (final ref in unresolved) SelectableText('$ref')],
      for (final row in jsonRows(data?['results'])) Text('${row['provider']}：${row['status']}'),
      if (_receipt != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_receipt!)),
      if (_error != null || data?['error'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error ?? '${data?['error']}', style: TextStyle(color: Theme.of(context).colorScheme.error))),
      if (busy) const LinearProgressIndicator(semanticsLabel: '正在更新 Pi 渠道配置'),
      TextButton(onPressed: busy ? null : () => _run(_load), child: const Text('刷新迁移状态')),
    ]));
  }
}

const chatGptPiProviderId = 'openai';
const _channelOAuthLoginProviders = {chatGptPiProviderId};
bool canLoginPiOAuth(String provider) => _channelOAuthLoginProviders.contains(provider);

class PiOAuthDialog extends StatefulWidget {
  const PiOAuthDialog({super.key, required this.provider, this.configured = true});
  final String provider;
  final bool configured;
  @override
  State<PiOAuthDialog> createState() => _PiOAuthDialogState();
}
class _PiOAuthDialogState extends State<PiOAuthDialog> {
  final _answer = TextEditingController();
  StreamSubscription<Json>? _events;
  Json? _state;
  String? _error;
  AgentController? _agent;
  bool _busy = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (_agent == agent) return;
    _agent = agent;
    _events = agent.backend.events.listen((event) {
      final login = asJsonMap(event['login']);
      if (event['event'] == 'piMigration.oauth' && login['provider'] == widget.provider && mounted) setState(() => _state = login);
    });
  }
  @override
  void dispose() {
    unawaited(_events?.cancel()); _answer.clear(); _answer.dispose();
    if (_state?['status'] == 'running') unawaited(_agent?.backend.call('piMigration.oauthCancel', {'id': _state?['id']}));
    super.dispose();
  }
  Future<void> _call(String method, Json params) async {
    if (method.endsWith('oauthStart') && !canLoginPiOAuth(widget.provider)) return;
    setState(() { _busy = true; _error = null; });
    try {
      final result = asJsonMap(await _agent!.backend.call(method, params));
      _answer.clear();
      if (mounted && method.endsWith('oauthStart')) {
        final state = asJsonMap(await _agent!.backend.call('piMigration.oauthStatus', {'id': result['id']}));
        if (mounted) setState(() => _state = state);
      }
      if (mounted && method.endsWith('oauthLogout')) setState(() => _state = {'status': 'logged_out'});
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) {
    final state = _state, prompt = asJsonMap(state?['prompt']), event = asJsonMap(state?['event']);
    final running = state?['status'] == 'running';
    final canLogin = canLoginPiOAuth(widget.provider);
    final configured = state?['status'] == 'logged_out' ? false : state?['status'] == 'done' || widget.configured;
    return AlertDialog(title: Text(canLogin ? 'ChatGPT 登录' : '已保留登录 · ${widget.provider}'), content: SizedBox(width: 560, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text(canLogin ? '使用 ChatGPT 订阅登录，登录状态和自动续期由 Pi 管理。' : configured ? '已保留现有登录，可继续使用或退出；此服务商不再支持重新登录。' : '已退出登录；此服务商不再支持重新登录。'),
      if (state != null) Text('状态：${state['status']}'),
      if (event['message'] != null) Text('${event['message']}'),
      for (final key in ['url', 'instructions', 'userCode', 'verificationUri']) if (event[key] != null) SelectableText('${event[key]}'),
      if (canLogin && prompt.isNotEmpty) ...[
        Text('${prompt['message'] ?? '完成登录步骤'}'),
        if (prompt['type'] == 'select') Wrap(children: [for (final option in jsonRows(prompt['options'])) TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthAnswer', {'id': state?['id'], 'value': option['id']}), child: Text('${option['label']}'))])
        else TextField(controller: _answer, obscureText: prompt['type'] != 'text' || prompt['secret'] == true, enableSuggestions: false, autocorrect: false, decoration: const InputDecoration(labelText: '登录信息或验证码')),
        if (prompt['type'] != 'select') TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthAnswer', {'id': state?['id'], 'value': _answer.text}), child: const Text('继续登录')),
      ],
      if (_error != null || state?['error'] != null) Text(_error ?? '${state?['error']}', style: TextStyle(color: Theme.of(context).colorScheme.error)),
      if (_busy) const LinearProgressIndicator(),
    ]))), actions: [
      if (canLogin && running) TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthCancel', {'id': state?['id']}), child: const Text('取消登录')),
      if (!running && configured) TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthLogout', {'provider': widget.provider}), child: const Text('退出登录')),
      if (canLogin && !running) FilledButton(onPressed: _busy ? null : () => _call('piMigration.oauthStart', {'provider': widget.provider}), child: Text(configured ? '重新登录' : '登录 ChatGPT')),
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
    ]);
  }
}

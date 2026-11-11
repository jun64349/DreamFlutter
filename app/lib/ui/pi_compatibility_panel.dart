import 'dart:async';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:url_launcher/url_launcher.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
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
    if (mounted) setState(() { _data = result; _receipt = result['status'] == 'done' ? '渠道与 原有连接配置已更新' : null; });
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
      Text('原有连接配置', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 8),
      Text(data == null ? '正在读取迁移状态…' : done ? '已迁入渠道 · 兼容配置由渠道生成' : data['status'] == 'failed' ? '迁移失败 · 原有配置页仍可用' : '尚未完成 原有服务商迁移'),
      if (data != null) ...[
        const SizedBox(height: 12),
        SelectableText('配置路径：${data['path'] ?? ''}'),
        if (data['generatedAt'] is num) Text('上次生成：${DateTime.fromMillisecondsSinceEpoch((data['generatedAt'] as num).toInt()).toLocal()}'),
        Text(data['externalModified'] == true ? '检测到外部修改；重新生成前会先备份。' : '外部修改：未检测到'),
        if (data['externalBackup'] != null) SelectableText('检测到外部修改，已备份到 ${data['externalBackup']}；需要的话可以点“从原配置导入”。'),
        if (data['backup'] != null) SelectableText('迁移备份：${data['backup']}'),
      ],
      const SizedBox(height: 12),
      const Text('密钥只在这台电脑的当前账户下可用。'),
      if (done) ...[
        const SizedBox(height: 8),
        SelectableText(data?['command'] as String? ?? ''),
        Wrap(spacing: 8, runSpacing: 8, children: [
          TextButton(onPressed: busy ? null : () async { await Clipboard.setData(ClipboardData(text: data?['command'] as String? ?? '')); if (mounted) setState(() => _receipt = '启动命令已复制'); }, child: const Text('复制命令')),
          OutlinedButton(onPressed: busy ? null : _import, child: const Text('从原配置导入')),
          TextButton(onPressed: busy ? null : () => _call('piMigration.generate'), child: const Text('重新生成')),
        ]),
        const Text('手动导入只读所选文件夹，只添加新服务商；已有映射和渠道不会覆盖。cc-switch 的后续修改不会自动导入。'),
      ] else ...[
        Wrap(spacing: 8, runSpacing: 8, children: [
          OutlinedButton(onPressed: busy || data == null ? null : () => _call('piMigration.retry'), child: const Text('重试迁移')),
          TextButton(onPressed: busy ? null : () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const ProvidersPage(legacyOnly: true))), child: const Text('打开原有配置页')),
        ]),
      ],
      if (unresolved.isNotEmpty) ...[const SizedBox(height: 8), const Text('以下模型引用未映射，已保留原值：'), for (final ref in unresolved) SelectableText('$ref')],
      for (final row in jsonRows(data?['results'])) Text('${row['provider']}：${row['status']}'),
      if (_receipt != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_receipt!)),
      if (_error != null || data?['error'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error ?? '${data?['error']}', style: TextStyle(color: Theme.of(context).colorScheme.error))),
      if (busy) const LinearProgressIndicator(semanticsLabel: '正在更新连接配置'),
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

  /// How the login page is opened (tests replace it).
  static Future<bool> Function(Uri url) openBrowser = (url) => launchUrl(url, mode: LaunchMode.externalApplication);

  @override
  State<PiOAuthDialog> createState() => _PiOAuthDialogState();
}

/// ChatGPT sign-in (0.8.2, user test: "不应该是直接弹出登录界面，完成以后回来不就登录好了吗"):
/// the login page opens in the browser by itself; the core listens for the browser coming back
/// on this computer and the dialog turns to 「已登录」. Pasting the address by hand is only the
/// fallback, folded away; the raw link and Pi's English steps are not shown.
class _PiOAuthDialogState extends State<PiOAuthDialog> {
  final _answer = TextEditingController();
  StreamSubscription<Json>? _events;
  Json? _state;
  String? _error;
  AgentController? _agent;
  bool _busy = false;
  bool _manual = false;
  String? _opened;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (_agent == agent) return;
    _agent = agent;
    _events = agent.backend.events.listen((event) {
      final login = asJsonMap(event['login']);
      if (event['event'] == 'piMigration.oauth' && login['provider'] == widget.provider && mounted) _update(login);
    });
  }
  @override
  void dispose() {
    unawaited(_events?.cancel()); _answer.clear(); _answer.dispose();
    if (_state?['status'] == 'running') unawaited(_agent?.backend.call('piMigration.oauthCancel', {'id': _state?['id']}));
    super.dispose();
  }

  String? get _url {
    final event = asJsonMap(_state?['event']);
    return (event['url'] ?? event['verificationUri']) as String?;
  }

  void _update(Json login) {
    setState(() => _state = login);
    final url = _url;
    // Open the login page once, as soon as the core has it.
    if (login['status'] == 'running' && url != null && url != _opened) { _opened = url; unawaited(_open(url)); }
  }

  Future<void> _open(String url) async {
    var ok = false;
    try { ok = await PiOAuthDialog.openBrowser(Uri.parse(url)); } catch (_) {}
    if (!ok && mounted) setState(() => _error = '没能自动打开浏览器：点「重新打开登录页」，或复制链接到浏览器里打开');
  }

  Future<void> _call(String method, Json params) async {
    if (method.endsWith('oauthStart') && !canLoginPiOAuth(widget.provider)) return;
    setState(() { _busy = true; _error = null; if (method.endsWith('oauthStart')) { _manual = false; _opened = null; } });
    try {
      final result = asJsonMap(await _agent!.backend.call(method, params));
      _answer.clear();
      if (mounted && method.endsWith('oauthStart')) {
        final state = asJsonMap(await _agent!.backend.call('piMigration.oauthStatus', {'id': result['id']}));
        if (mounted) _update(state);
      }
      if (mounted && method.endsWith('oauthLogout')) setState(() => _state = {'status': 'logged_out'});
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final state = _state, prompt = asJsonMap(state?['prompt']), event = asJsonMap(state?['event']);
    final status = state?['status'] as String?;
    final running = status == 'running';
    final canLogin = canLoginPiOAuth(widget.provider);
    final configured = status == 'logged_out' ? false : status == 'done' || widget.configured;
    final url = _url;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    Widget line(IconData icon, Color color, String text) => Row(children: [Icon(icon, size: 20, color: color), const SizedBox(width: 10), Expanded(child: Text(text, style: context.text.bodyLarge))]);
    final Widget headline = switch (status) {
      'running' => Row(children: [const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)), const SizedBox(width: 12), Expanded(child: Text(url == null ? '正在准备登录…' : '已在浏览器里打开 ChatGPT 登录页。登录完会自动回到这里。', style: context.text.bodyLarge))]),
      'done' => line(Icons.check_circle, colors.success, '已登录 ChatGPT'),
      'logged_out' => line(Icons.logout, colors.muted, canLogin ? '已退出登录' : '已退出登录；此服务商不再支持重新登录。'),
      'cancelled' => line(Icons.cancel_outlined, colors.muted, '登录已取消'),
      'failed' => line(Icons.error_outline, colors.danger, '登录没有完成'),
      _ => Text(canLogin ? (configured ? '已登录 ChatGPT。可以重新登录或退出。' : '用你的 ChatGPT 订阅登录：会在浏览器里打开登录页，登录完自动回来。') : configured ? '已保留现有登录，可继续使用或退出；此服务商不再支持重新登录。' : '已退出登录；此服务商不再支持重新登录。'),
    };
    final manualPrompt = canLogin && prompt.isNotEmpty && prompt['type'] != 'select';
    return AlertDialog(
      title: Text(canLogin ? 'ChatGPT 登录' : '已保留登录 · ${widget.provider}'),
      content: SizedBox(width: 480, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        headline,
        if (running && event['userCode'] != null) Padding(padding: const EdgeInsets.only(top: 12), child: SelectableText('验证码：${event['userCode']}', style: context.text.titleMedium)),
        if (running && url != null) Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Wrap(spacing: 4, children: [
            TextButton.icon(onPressed: () => _open(url), icon: const Icon(Icons.open_in_new, size: 16), label: const Text('重新打开登录页')),
            TextButton.icon(onPressed: () async { await Clipboard.setData(ClipboardData(text: url)); if (context.mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('已复制登录链接'))); }, icon: const Icon(Icons.copy, size: 16), label: const Text('复制链接')),
          ]),
        ),
        if (canLogin && running && prompt['type'] == 'select') Wrap(children: [for (final option in jsonRows(prompt['options'])) TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthAnswer', {'id': state?['id'], 'value': option['id']}), child: Text('${option['label']}'))]),
        // Only when the browser cannot come back here (another program holds the port, a remote desktop…).
        if (manualPrompt && running) ...[
          const SizedBox(height: 6),
          InkWell(
            onTap: () => setState(() => _manual = !_manual),
            child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [
              Icon(_manual ? Icons.expand_less : Icons.expand_more, size: 18, color: colors.muted),
              const SizedBox(width: 4),
              Text('登录完没有自动回来？', style: muted),
            ])),
          ),
          if (_manual) ...[
            Text('把浏览器最后停住的那个页面的地址整个复制过来，粘贴到这里。', style: muted),
            const SizedBox(height: 6),
            TextField(controller: _answer, obscureText: prompt['secret'] == true, enableSuggestions: false, autocorrect: false, decoration: const InputDecoration(labelText: '浏览器地址栏里的地址', isDense: true)),
            Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthAnswer', {'id': state?['id'], 'value': _answer.text}), child: const Text('继续登录'))),
          ],
        ],
        if (_error != null || state?['error'] != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error ?? '${state?['error']}', style: TextStyle(color: colors.danger))),
        if (_busy) const Padding(padding: EdgeInsets.only(top: 10), child: LinearProgressIndicator()),
      ]))),
      actions: [
        if (canLogin && running) TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthCancel', {'id': state?['id']}), child: const Text('取消登录')),
        if (!running && configured) TextButton(onPressed: _busy ? null : () => _call('piMigration.oauthLogout', {'provider': widget.provider}), child: const Text('退出登录')),
        if (canLogin && !running && status != 'done') FilledButton(onPressed: _busy ? null : () => _call('piMigration.oauthStart', {'provider': widget.provider}), child: Text(configured ? '重新登录' : '登录 ChatGPT')),
        if (status == 'done') FilledButton(onPressed: () => Navigator.pop(context), child: const Text('完成'))
        else TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
      ],
    );
  }
}

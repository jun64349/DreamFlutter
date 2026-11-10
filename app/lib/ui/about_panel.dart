import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:url_launcher/url_launcher.dart';
import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../state/session_runtime.dart' show SessionRuntime;
import 'agent_scope.dart';
import 'settings_controls.dart' show SettingRow;

class AboutPanel extends StatefulWidget {
  const AboutPanel({super.key, this.details = false});

  /// The build details (build number, core and Pi versions, platform, signing) for 高级, instead of the main rows.
  final bool details;
  @override
  State<AboutPanel> createState() => _AboutPanelState();
}
class _AboutPanelState extends State<AboutPanel> {
  AgentController? _agent;
  StreamSubscription<Json>? _events;
  Json _status = {};
  String? _error, _diagnostics;
  bool _working = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies(); final agent = AgentScope.read(context);
    if (_agent == agent) return;
    _agent = agent; unawaited(_events?.cancel());
    _events = agent.backend.events.listen((event) {
      if (event['event'] == 'updates.changed' && mounted) setState(() => _status = asJsonMap(event['status']));
      if (event['event'] == 'settings.changed') unawaited(_load());
    });
    unawaited(_load());
  }
  @override
  void dispose() { unawaited(_events?.cancel()); super.dispose(); }
  Future<void> _load() async {
    try { final status = asJsonMap(await _agent!.backend.call('updates.status')); if (mounted) setState(() { _status = status; _error = null; }); }
    catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
  }
  Future<void> _action(Future<void> Function() action) async {
    setState(() { _working = true; _error = null; });
    try { await action(); }
    catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _working = false); }
  }
  Future<void> _method(String method) async { final status = asJsonMap(await _agent!.backend.call(method, const {}, const Duration(minutes: 12))); if (mounted) setState(() => _status = status); }
  Future<void> _install() async {
    final release = asJsonMap(_status['available']);
    final approved = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: Text('安装 ${release['version'] ?? '新版本'} 并重启？'),
      content: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        const Text('测试版更新包未获受信任的正式签名。请确认版本和校验信息；安装前将等待现有任务结束并备份数据，随后关闭窗口、安装并重启。'),
        const SizedBox(height: 12), SelectableText('SHA-256：${release['sha256'] ?? ''}'),
        const SizedBox(height: 8), const Text('启动验证失败会恢复旧版本和更新前备份；新版本开始接受写入后，不会自动恢复旧备份。'),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('确认安装并重启'))],
    ));
    if (approved != true) return;
    final status = asJsonMap(await _agent!.backend.call('updates.install', {'windowPid': pid, 'approveUnsigned': true, 'prefs': _agent!.preferences.exportAll()}));
    if (mounted) setState(() => _status = status);
  }
  Future<void> _licenses() async {
    final result = asJsonMap(await _agent!.backend.call('updates.licenses'));
    if (!mounted) return;
    final entries = result['entries'] is List ? result['entries'] as List : const [];
    await showDialog<void>(context: context, builder: (context) => AlertDialog(
      title: const Text('许可证与第三方声明'),
      content: SizedBox(width: 650, height: 500, child: result['generated'] != true
        ? const Text('开发运行尚未生成清单。打包时会从实际依赖和许可证文件收集。')
        : ListView.builder(itemCount: entries.length, itemBuilder: (context, index) {
          final item = asJsonMap(entries[index]);
          return ListTile(title: Text('${item['name']} ${item['version'] ?? ''}'), subtitle: Text('${item['license'] ?? '见随包声明'}'), trailing: const Icon(Icons.chevron_right), onTap: () async {
            try {
              final text = asJsonMap(await _agent!.backend.call('updates.licenseText', {'id': item['id']}));
              if (!context.mounted) return;
              await showDialog<void>(context: context, builder: (context) => AlertDialog(title: Text('${item['name']}'), content: SizedBox(width: 650, height: 500, child: SingleChildScrollView(child: SelectableText('${text['text'] ?? ''}'))), actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))]));
            } catch (error) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(error)))); }
          });
        })),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    ));
  }
  // 0.8.1 S.4: plain setting rows, one thing per row; build details live under 高级 (AboutPanel(details: true)).
  // "关闭窗口时" is in 通用 only, and backups in 数据与安全 only.
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context), build = asJsonMap(_status['application']), release = asJsonMap(_status['available']), recovery = asJsonMap(_status['recovery']);
    final muted = Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant);
    if (widget.details) {
      Widget row(String title, String value) => SettingRow(title, child: SelectableText(value));
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        row('构建号', '${build['build'] ?? '未知'}'),
        row('后台版本', '${_status['coreVersion'] ?? agent.coreInfo['version'] ?? '未知'}'),
        row('Pi 版本', '${_status['piVersion'] ?? '未知'}'),
        row('平台', '${_status['platform'] ?? Platform.operatingSystem} / ${_status['arch'] ?? '未知'}'),
        row('签名', build['signed'] == true ? '已签名' : '测试版未签名'),
        if (recovery['backup'] is String && (recovery['backup'] as String).isNotEmpty) row('更新备份', '${recovery['backup']}'),
      ]);
    }
    final active = {'checking', 'downloading', 'preparing', 'installing'}.contains(_status['state']);
    final enabled = !_working && !active;
    final message = _status['message'] as String?;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SettingRow('DreamFlutter ${build['version'] ?? ''}'.trim(), child: Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.end, crossAxisAlignment: WrapCrossAlignment.center, children: [
        if (message != null && message.isNotEmpty) Text(message, style: muted),
        if (release.isNotEmpty && _status['downloaded'] != true) FilledButton(onPressed: enabled ? () => _action(() => _method('updates.download')) : null, child: Text('下载 ${release['version'] ?? '新版本'}')),
        if (_status['downloaded'] == true) FilledButton(onPressed: enabled && _status['canInstall'] == true ? () => _action(_install) : null, child: const Text('安装并重启')),
        if (active && _status['state'] != 'installing') TextButton(onPressed: () async { try { await _agent!.backend.call('updates.cancel'); } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); } }, child: const Text('取消更新')),
        OutlinedButton(onPressed: enabled ? () => _action(() => _method('updates.check')) : null, child: Text(_status['state'] == 'checking' ? '正在检查…' : '检查更新')),
      ])),
      if (_status['state'] == 'downloading') LinearProgressIndicator(value: (_status['progress'] as num?)?.toDouble()),
      if (release.isNotEmpty) ExpansionTile(tilePadding: EdgeInsets.zero, title: Text('${release['version']} 更新了什么'), children: [Align(alignment: Alignment.centerLeft, child: SelectableText('${release['notes'] ?? '这个版本没有写更新日志。'}'))]),
      SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('自动检查更新'), value: agent.coreSettings['autoCheckUpdates'] != false, onChanged: _working ? null : (value) => _action(() => agent.updateCoreSettings({'autoCheckUpdates': value}))),
      SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('开机启动'), subtitle: _status['canStartup'] == true ? null : const Text('免安装版不能开机启动'), value: _status['startOnLogin'] == true, onChanged: _working || _status['canStartup'] != true ? null : (value) => _action(() async { final status = asJsonMap(await agent.backend.call('app.setStartup', {'enabled': value})); if (mounted) setState(() => _status = status); })),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        OutlinedButton(onPressed: _working ? null : () => _action(() async { final result = asJsonMap(await agent.backend.call('updates.diagnostics')); if (mounted) setState(() => _diagnostics = result['path'] as String?); }), child: const Text('导出诊断信息')),
        OutlinedButton(onPressed: () => _action(() async { final body = Uri.encodeComponent('版本：${build['version'] ?? ''}（${build['build'] ?? ''}）\n平台：${_status['platform'] ?? Platform.operatingSystem} / ${_status['arch'] ?? ''}\n\n问题描述：\n'); await launchUrl(Uri.parse('https://github.com/jun64349/DreamFlutter/issues/new?body=$body'), mode: LaunchMode.externalApplication); }), child: const Text('问题反馈')),
        TextButton(onPressed: () => _action(_licenses), child: const Text('许可证与第三方声明')),
      ]),
      if (_diagnostics != null) Padding(padding: const EdgeInsets.only(top: 8), child: SelectableText('诊断包已保存：$_diagnostics（不会自动上传）', style: muted)),
      if (recovery['error'] != null) Text('${recovery['error']}'),
      if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
    ]);
  }

}

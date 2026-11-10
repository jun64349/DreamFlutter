import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:url_launcher/url_launcher.dart';
import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../state/session_runtime.dart' show SessionRuntime;
import 'agent_scope.dart';

class AboutPanel extends StatefulWidget {
  const AboutPanel({super.key, this.openData});
  final VoidCallback? openData;
  @override
  State<AboutPanel> createState() => _AboutPanelState();
}
class _AboutPanelState extends State<AboutPanel> {
  AgentController? _agent;
  StreamSubscription<Json>? _events;
  Json _status = {};
  String? _error, _diagnostics;
  bool _working = false;
  int _revision = 0;
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
    finally { if (mounted) setState(() { _working = false; _revision++; }); }
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
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context), build = asJsonMap(_status['application']), release = asJsonMap(_status['available']), recovery = asJsonMap(_status['recovery']);
    final active = {'checking', 'downloading', 'preparing', 'installing'}.contains(_status['state']);
    final enabled = !_working && !active;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('版本与更新', style: Theme.of(context).textTheme.titleMedium),
      Text('应用版本：${build['version'] ?? '未知'}'),
      Text('构建号：${build['build'] ?? '未知'} · 后台：${_status['coreVersion'] ?? '未知'} · Pi：${_status['piVersion'] ?? '未知'}'),
      Text('平台：${_status['platform'] ?? Platform.operatingSystem} / ${_status['arch'] ?? '未知'}'),
      Text(build['signed'] == true ? '已签名构建' : '测试版未签名'),
      const SizedBox(height: 8), Text('${_status['message'] ?? '正在读取更新状态…'}'),
      if (_status['state'] == 'downloading') LinearProgressIndicator(value: (_status['progress'] as num?)?.toDouble()),
      Wrap(spacing: 8, runSpacing: 8, children: [
        OutlinedButton(onPressed: enabled ? () => _action(() => _method('updates.check')) : null, child: const Text('检查更新')),
        if (release.isNotEmpty && _status['downloaded'] != true) FilledButton(onPressed: enabled ? () => _action(() => _method('updates.download')) : null, child: const Text('下载更新')),
        if (_status['downloaded'] == true) FilledButton(onPressed: enabled && _status['canInstall'] == true ? () => _action(_install) : null, child: const Text('安装并重启')),
        if (active && _status['state'] != 'installing') TextButton(onPressed: () async { try { await _agent!.backend.call('updates.cancel'); } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); } }, child: const Text('取消更新')),
      ]),
      if (release.isNotEmpty) ...[
        const SizedBox(height: 8), Text('新版本：${release['version']} · ${((release['size'] as num? ?? 0) / 1024 / 1024).toStringAsFixed(1)} MiB'),
        ExpansionTile(tilePadding: EdgeInsets.zero, title: const Text('更新日志'), children: [Align(alignment: Alignment.centerLeft, child: SelectableText('${release['notes'] ?? '此版本未提供更新日志。'}'))]),
      ],
      SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('自动检查更新'), subtitle: const Text('每天最多自动检查一次；不发送使用数据。'), value: agent.coreSettings['autoCheckUpdates'] != false, onChanged: _working ? null : (value) => _action(() => agent.updateCoreSettings({'autoCheckUpdates': value}))),
      SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('开机启动'), subtitle: Text(_status['canStartup'] == true ? '仅设置当前 Windows 用户的启动项。' : '使用可更新的打包版本后可开启。'), value: _status['startOnLogin'] == true, onChanged: _working || _status['canStartup'] != true ? null : (value) => _action(() async { final status = asJsonMap(await agent.backend.call('app.setStartup', {'enabled': value})); if (mounted) setState(() => _status = status); })),
      DropdownButtonFormField<String>(
        key: ValueKey('close-${agent.coreSettings['closeBehavior']}-$_revision'), initialValue: agent.coreSettings['closeBehavior'] as String? ?? 'tray', isExpanded: true,
        decoration: const InputDecoration(labelText: '关闭窗口时'),
        items: const [DropdownMenuItem(value: 'tray', child: Text('隐藏到托盘（默认）')), DropdownMenuItem(value: 'quit', child: Text('退出程序'))],
        onChanged: _working ? null : (value) { if (value != null) _action(() async { await agent.preferences.setCloseBehaviorChoice(value); await agent.updateCoreSettings({'closeBehavior': value}); }); },
      ),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        OutlinedButton(onPressed: _working ? null : () => _action(() async { final result = asJsonMap(await agent.backend.call('updates.diagnostics')); if (mounted) setState(() => _diagnostics = result['path'] as String?); }), child: const Text('导出诊断信息')),
        OutlinedButton(onPressed: () => _action(() async { final body = Uri.encodeComponent('版本：${build['version'] ?? ''}（${build['build'] ?? ''}）\n平台：${_status['platform'] ?? Platform.operatingSystem} / ${_status['arch'] ?? ''}\n\n问题描述：\n'); await launchUrl(Uri.parse('https://github.com/jun64349/DreamFlutter/issues/new?body=$body'), mode: LaunchMode.externalApplication); }), child: const Text('问题反馈')),
        TextButton(onPressed: () => _action(_licenses), child: const Text('许可证与第三方声明')),
        TextButton(onPressed: widget.openData, child: const Text('数据备份与恢复')),
      ]),
      if (_diagnostics != null) SelectableText('诊断包已保存：$_diagnostics\n不会自动上传，请自行决定是否分享。'),
      if (recovery['backup'] is String && (recovery['backup'] as String).isNotEmpty) SelectableText('更新备份：${recovery['backup']}'),
      if (recovery['error'] != null) Text('${recovery['error']}'),
      if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
    ]);
  }
}

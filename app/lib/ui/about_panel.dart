import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:url_launcher/url_launcher.dart';
import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../state/session_runtime.dart' show SessionRuntime;
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart' show SettingRow, V1Toggle;
import 'settings_layout.dart' show SettingsCard;
import 'shell_widgets.dart' show ShellButton, ShellButtonKind;
import 'notes.dart';

class AboutPanel extends StatefulWidget {
  const AboutPanel({super.key, this.details = false, this.startupOnly = false});

  /// The build details (build number, core and Pi versions, platform, signing) for 高级, instead of the main rows.
  final bool details;
  final bool startupOnly;
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
            } catch (error) { if (context.mounted) showNote(SessionRuntime.describeError(error), kind: NoteKind.fail); }
          });
        })),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    ));
  }
  // 原型「关于与更新」：居中的蝴蝶、名字、版本和状态、按钮；下面一张卡片，一行一件事。
  // 构建细节在开发者选项（AboutPanel(details: true)）；开机启动在窗口与通知（startupOnly）。
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context), build = asJsonMap(_status['application']), release = asJsonMap(_status['available']), recovery = asJsonMap(_status['recovery']);
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted);
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12.5, color: colors.ink2);
    Widget toggle(String title, bool value, ValueChanged<bool>? onChanged, {String? desc}) => SettingRow(title, desc: desc, child: V1Toggle(value: value, onChanged: onChanged));
    if (widget.startupOnly) {
      return toggle('开机启动', _status['startOnLogin'] == true, _working || _status['canStartup'] != true ? null : (value) => _action(() async { final status = asJsonMap(await agent.backend.call('app.setStartup', {'enabled': value})); if (mounted) { setState(() => _status = status); } }), desc: _status['canStartup'] == true ? null : '免安装版不能开机启动');
    }
    if (widget.details) {
      Widget row(String title, String value) => SettingRow(title, child: SelectableText(value, style: mono));
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
    final version = build['version'] as String?;
    Widget link(String text, VoidCallback? onTap) => TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(foregroundColor: colors.accent, padding: const EdgeInsets.symmetric(horizontal: 6), minimumSize: const Size(0, 30), tapTargetSize: MaterialTapTargetSize.shrinkWrap, textStyle: const TextStyle(fontSize: 13.5)),
      child: Text(text),
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.fromLTRB(0, 16, 0, 6), child: Column(children: [
        // 原型 72px 的 SVG 四周有留白，蝴蝶占画框宽度的 625/1024。
        const SizedBox.square(dimension: 72, child: Center(child: ButterflyMark(size: 72 * 625.38 / 1024))),
        const SizedBox(height: 8),
        Text('DreamFlutter', style: context.serif(context.text.titleLarge).copyWith(fontSize: 22, fontWeight: FontWeight.w700, color: colors.accent)),
        const SizedBox(height: 2),
        Text('住在你电脑里的助手，一只认真的蝴蝶。', textAlign: TextAlign.center, style: context.text.bodySmall?.copyWith(fontSize: 13, color: colors.ink2)),
        if (version != null && version.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: Text('v$version', style: mono.copyWith(fontSize: 12, color: colors.muted))),
        if (message != null && message.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(message, style: muted, textAlign: TextAlign.center)),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
          if (release.isNotEmpty && _status['downloaded'] != true) ShellButton('下载 ${release['version'] ?? '新版本'}', kind: ShellButtonKind.primary, small: true, onPressed: enabled ? () => _action(() => _method('updates.download')) : null),
          if (_status['downloaded'] == true) ShellButton('安装并重启', kind: ShellButtonKind.primary, small: true, onPressed: enabled && _status['canInstall'] == true ? () => _action(_install) : null),
          if (active && _status['state'] != 'installing') ShellButton('取消更新', kind: ShellButtonKind.ghost, small: true, onPressed: () async { try { await _agent!.backend.call('updates.cancel'); } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); } }),
          ShellButton(_status['state'] == 'checking' ? '正在检查…' : '检查更新', small: true, onPressed: enabled ? () => _action(() => _method('updates.check')) : null),
        ]),
        if (_status['state'] == 'downloading') Padding(padding: const EdgeInsets.only(top: 12), child: SizedBox(width: 240, child: LinearProgressIndicator(value: (_status['progress'] as num?)?.toDouble(), color: colors.accent, backgroundColor: colors.sunk))),
      ])),
      SettingsCard(children: [
        if (release.isNotEmpty) Theme(data: Theme.of(context).copyWith(dividerColor: Colors.transparent), child: ExpansionTile(tilePadding: EdgeInsets.zero, title: Text('${release['version']} 更新了什么', style: context.text.bodyMedium?.copyWith(fontSize: 14)), children: [Align(alignment: Alignment.centerLeft, child: Padding(padding: const EdgeInsets.only(bottom: 12), child: SelectableText('${release['notes'] ?? '这个版本没有写更新日志。'}')))])),
        toggle('自动检查更新', agent.coreSettings['autoCheckUpdates'] != false, _working ? null : (value) => _action(() => agent.updateCoreSettings({'autoCheckUpdates': value}))),
        SettingRow('导出诊断', desc: _diagnostics != null ? '已保存：$_diagnostics（不会自动上传）' : '不含对话内容，导出前可以先看一遍', child: ShellButton('导出…', small: true, onPressed: _working ? null : () => _action(() async { final result = asJsonMap(await agent.backend.call('updates.diagnostics')); if (mounted) setState(() => _diagnostics = result['path'] as String?); }))),
        SettingRow('反馈问题', child: link('写给我们', () => _action(() async { final body = Uri.encodeComponent('版本：${build['version'] ?? ''}（${build['build'] ?? ''}）\n平台：${_status['platform'] ?? Platform.operatingSystem} / ${_status['arch'] ?? ''}\n\n问题描述：\n'); await launchUrl(Uri.parse('https://github.com/jun64349/DreamFlutter/issues/new?body=$body'), mode: LaunchMode.externalApplication); }))),
        SettingRow('许可证', child: link('开源许可 · 查看', () => _action(_licenses))),
      ]),
      if (recovery['error'] != null) Text('${recovery['error']}', style: TextStyle(color: colors.danger)),
      if (_error != null) Text(_error!, style: TextStyle(color: colors.danger)),
    ]);
  }
}

import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../theme.dart';
import 'agent_scope.dart';

/// Tables as people read them, for the counts in a preview.
const _countNames = {
  'session_meta': '对话',
  'memories': '记忆',
  'tasks': '任务',
  'schedules': '定时任务',
  'cards': '卡片',
  'notes': '任务',
  'materials': '资料',
  'gateway_channels': '模型渠道',
};

const _typeGroup = XTypeGroup(label: 'DreamFlutter 备份', extensions: ['dfbackup']);

/// Where to save a backup (a Save dialog); tests swap it.
@visibleForTesting
Future<String?> Function(String suggestedName) chooseBackupDestination = (name) async =>
    (await getSaveLocation(suggestedName: name, acceptedTypeGroups: const [_typeGroup], confirmButtonText: '保存'))?.path;

/// Which backup to import (an Open dialog); tests swap it.
@visibleForTesting
Future<String?> Function() chooseBackupFile = () async => (await openFile(acceptedTypeGroups: const [_typeGroup], confirmButtonText: '选择'))?.path;

String formatBytes(num bytes) {
  if (bytes < 1024 * 1024) return '${(bytes / 1024).ceil()} KB';
  if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
}

String _date(num? ms) {
  if (ms == null) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
  String two(int n) => n.toString().padLeft(2, '0');
  return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}';
}

/// Settings › 数据与迁移 (docs/v0.3.1-backup-design.md §八): export a backup,
/// import one (check → preview → stage → replace on restart), undo the last
/// restore, and the backups made so far.
class BackupPanel extends StatefulWidget {
  const BackupPanel({super.key});

  @override
  State<BackupPanel> createState() => _BackupPanelState();
}

class _BackupPanelState extends State<BackupPanel> {
  AgentController? _agent;
  Json? _overview;
  String? _error;

  // Export.
  var _includeKeys = false;
  var _includeMaterials = true;
  var _includeSandbox = true;
  final _password = TextEditingController();
  final _password2 = TextEditingController();

  // Import.
  String? _importPath;
  Json? _preview;
  Json? _staged;
  final _importPassword = TextEditingController();
  final Map<String, TextEditingController> _paths = {};

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (_agent == agent) return;
    _agent?.backupJob.removeListener(_onJob);
    _agent = agent..backupJob.addListener(_onJob);
    unawaited(_load());
  }

  @override
  void dispose() {
    _agent?.backupJob.removeListener(_onJob);
    for (final c in [_password, _password2, _importPassword, ..._paths.values]) {
      c.dispose();
    }
    super.dispose();
  }

  Json? get _job => _agent?.backupJob.value ?? asNullableMap(_overview?['job']);
  bool get _running => _job?['status'] == 'running';

  void _onJob() {
    final job = _agent?.backupJob.value;
    if (!mounted || job == null) return;
    if (job['status'] == 'done' && job['kind'] == 'stage') _staged = asNullableMap(job['result']);
    setState(() {});
    if (job['status'] != 'running') unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final overview = asJsonMap(await _agent!.backend.call('backup.overview', const {}, const Duration(seconds: 60)));
      if (mounted) setState(() => _overview = overview);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _call(String method, [Json params = const {}]) async {
    setState(() => _error = null);
    try {
      await _agent!.backend.call(method, params, const Duration(minutes: 2));
    } catch (e) {
      if (mounted) setState(() => _error = e is CoreException ? e.message : '$e');
    }
  }

  // ---- export ----------------------------------------------------------------------

  Future<void> _export() async {
    if (_includeKeys) {
      if (_password.text.length < 6) return setState(() => _error = '迁移密码至少 6 位');
      if (_password.text != _password2.text) return setState(() => _error = '两次输入的迁移密码不一样');
    }
    final now = DateTime.now();
    final stamp = '${now.year}${now.month.toString().padLeft(2, '0')}${now.day.toString().padLeft(2, '0')}';
    final location = await chooseBackupDestination('DreamFlutter-备份-$stamp.dfbackup');
    if (location == null || !mounted) return;
    await _call('backup.export', {
      'path': location,
      'includeKeys': _includeKeys,
      if (_includeKeys) 'password': _password.text,
      'includeMaterials': _includeMaterials,
      'includeSandbox': _includeSandbox,
      'prefs': _agent!.preferences.exportAll(),
    });
  }

  // ---- import ----------------------------------------------------------------------

  Future<void> _pick() async {
    final file = await chooseBackupFile();
    if (file == null || !mounted) return;
    setState(() {
      _importPath = file;
      _preview = null;
      _staged = null;
      _error = null;
    });
    try {
      final preview = asJsonMap(await _agent!.backend.call('backup.inspect', {'path': file}, const Duration(minutes: 2)));
      for (final c in _paths.values) {
        c.dispose();
      }
      _paths.clear();
      for (final row in _rows(preview)) {
        if (row['kind'] == 'workspace') _paths[row['from'] as String] = TextEditingController(text: row['to'] as String);
      }
      if (mounted) setState(() => _preview = preview);
    } catch (e) {
      if (mounted) setState(() => _error = e is CoreException ? e.message : '$e');
    }
  }

  List<Json> _rows(Json preview) => [for (final r in preview['paths'] as List? ?? const []) asJsonMap(r)];

  Future<void> _stage() async {
    setState(() => _staged = null);
    await _call('backup.stage', {
      'path': _importPath,
      if (_preview?['needsPassword'] == true) 'password': _importPassword.text,
      'workspaces': [
        for (final MapEntry(:key, :value) in _paths.entries) {'from': key, 'to': value.text.trim().isEmpty ? key : value.text.trim()},
      ],
    });
  }

  Future<void> _apply() async {
    final ok = await _confirm(
      '用备份替换当前数据？',
      '替换前会先自动备份现在的数据（可以在「上次恢复」里撤销）。后台会重启，正在打开的对话会重新连接。',
      '替换并重启后台',
    );
    // The current preferences go into the automatic backup, so an undo brings them back too.
    if (ok) await _call('backup.apply', {'prefs': _agent!.preferences.exportAll()});
  }

  Future<void> _undo() async {
    final ok = await _confirm('撤销上次恢复？', '会回到恢复之前的数据（用恢复前自动做的备份）。后台会重启。', '撤销');
    if (ok) await _call('backup.undo', {'prefs': _agent!.preferences.exportAll()});
  }

  Future<bool> _confirm(String title, String body, String action) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(action)),
          ],
        ),
      ) ==
      true;

  // ---- build -----------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    final overview = _overview;
    if (overview == null) return Text(_error ?? '正在读取…', style: muted);
    final busy = [for (final b in overview['busy'] as List? ?? const []) '$b'];
    final history = overview['history'] as List? ?? const [];
    // One line and two buttons; the options and the record fold away (v0.3.1 test 8: the page was too much at once).
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_error != null) ...[Text(_error!, style: context.text.bodyMedium?.copyWith(color: context.colors.danger)), const SizedBox(height: AppTokens.gap)],
        if (_job != null) _JobView(job: _job!, onCancel: () => _call('backup.cancel'), onReveal: (p) => _agent!.revealInExplorer(p)),
        Padding(padding: const EdgeInsets.only(top: 16), child: Text('备份', style: context.label)),
        const SizedBox(height: AppTokens.gap),
        Row(
          children: [
            FilledButton.icon(onPressed: _running || busy.isNotEmpty ? null : _export, icon: const Icon(Icons.upload_file_outlined, size: 18), label: const Text('导出备份…')),
            const SizedBox(width: AppTokens.gap),
            OutlinedButton.icon(onPressed: _running ? null : _pick, icon: const Icon(Icons.download_outlined, size: 18), label: const Text('导入备份…')),
          ],
        ),
        if (busy.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('有任务正在运行（${busy.join('、')}），等它结束或先停止再导出。', style: muted)),
        _importSection(muted),
        if (_agent!.restoreResult.value case final result?) ...[
          const SizedBox(height: AppTokens.gap * 2),
          _heading('上次恢复'),
          _restoreSection(result, muted),
        ],
        const SizedBox(height: AppTokens.gap),
        _Fold(title: '导出选项', summary: _includeKeys ? '包含 API Key' : '不含 API Key', child: _exportOptions(overview, muted)),
        _Fold(title: '备份记录', summary: history.isEmpty ? '还没有' : '${history.length} 份', child: _historySection(overview, muted)),
      ],
    );
  }

  Widget _heading(String text) => Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(text, style: context.text.titleSmall));

  Widget _exportOptions(Json overview, TextStyle? muted) {
    final materials = (overview['estimate'] as Map?)?['materials'] as num? ?? 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('包括记忆、对话、任务、模型连接、偏好和蝶君的文件；工作区只记位置。预计大小：${overview['estimateText']}', style: muted),
        CheckboxListTile(
          value: _includeKeys,
          onChanged: _running ? null : (v) => setState(() => _includeKeys = v ?? false),
          title: const Text('包含 API Key'),
          subtitle: const Text('Key 用你设的迁移密码加密后放进备份；导入时要输入这个密码。不勾选时，导入后要重新填 Key。'),
          dense: true,
          contentPadding: EdgeInsets.zero,
        ),
        if (_includeKeys)
          Row(
            children: [
              Expanded(child: TextField(controller: _password, obscureText: true, decoration: const InputDecoration(labelText: '迁移密码（至少 6 位）', isDense: true))),
              const SizedBox(width: AppTokens.gap),
              Expanded(child: TextField(controller: _password2, obscureText: true, decoration: const InputDecoration(labelText: '再输一次', isDense: true))),
            ],
          ),
        CheckboxListTile(
          value: _includeMaterials,
          onChanged: _running ? null : (v) => setState(() => _includeMaterials = v ?? true),
          title: Text('蝶君的资料随包（${overview['materialsCount']} 份，${formatBytes(materials)}）'),
          subtitle: overview['materialsWarning'] == true ? const Text('资料超过 200 MB，备份会比较大。不随包时只记位置。') : null,
          dense: true,
          contentPadding: EdgeInsets.zero,
        ),
        if (overview['sandbox'] == true)
          CheckboxListTile(
            value: _includeSandbox,
            onChanged: _running ? null : (v) => setState(() => _includeSandbox = v ?? true),
            title: const Text('蝶君沙箱里的文件（/workspace 和家目录）'),
            subtitle: const Text('不带整个沙箱：导入后用应用自带的镜像重建，再放回这些文件。'),
            dense: true,
            contentPadding: EdgeInsets.zero,
          ),
      ],
    );
  }

  /// What a picked backup holds and what importing it replaces (nothing until one is picked).
  Widget _importSection(TextStyle? muted) {
    final preview = _preview;
    final staged = _staged;
    final children = <Widget>[];
    if (preview != null) {
      final counts = asJsonMap(preview['counts']);
      final includes = asJsonMap(preview['includes']);
      children.addAll([
        const SizedBox(height: AppTokens.gap * 2),
        _heading('导入这份备份'),
        Text('来自 v${preview['appVersion']}，${_date(preview['createdAt'] as num?)}，${preview['host']}（${preview['user']}）${preview['kind'] == 'manual' ? '' : '，自动备份'}', style: context.text.bodyMedium),
        const SizedBox(height: 4),
        Text(
          [
            for (final MapEntry(:key, :value) in _countNames.entries)
              if ((counts[key] as num? ?? 0) > 0) '$value ${counts[key]}',
            if (includes['sandbox'] == true) '蝶君沙箱里的文件',
            if ((includes['materials'] as num? ?? 0) > 0) '资料副本 ${includes['materials']}',
          ].join(' · '),
          style: muted,
        ),
        const SizedBox(height: 6),
        Text('会被替换：', style: context.text.bodySmall),
        for (final r in preview['replaces'] as List? ?? const []) Text('· $r', style: muted),
        for (final w in preview['warnings'] as List? ?? const []) Padding(padding: const EdgeInsets.only(top: 4), child: Text('注意：$w', style: muted)),
        if (_paths.isNotEmpty) ...[
          const SizedBox(height: AppTokens.gap),
          Text('工作区的位置（在这台电脑上不同就改一下；没有的可以不管）：', style: context.text.bodySmall),
          for (final row in _rows(preview).where((r) => r['kind'] == 'workspace'))
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  Expanded(child: Text(row['from'] as String, style: muted, overflow: TextOverflow.ellipsis)),
                  const Padding(padding: EdgeInsets.symmetric(horizontal: 6), child: Text('→')),
                  Expanded(child: TextField(controller: _paths[row['from']], decoration: const InputDecoration(isDense: true))),
                  const SizedBox(width: 6),
                  Tooltip(
                    message: row['exists'] == true ? '这台电脑上有这个文件夹' : '这台电脑上没有这个文件夹',
                    child: Icon(row['exists'] == true ? Icons.check_circle_outline : Icons.help_outline, size: 18, color: context.colors.muted),
                  ),
                ],
              ),
            ),
        ],
        if (preview['needsPassword'] == true) ...[
          const SizedBox(height: AppTokens.gap),
          SizedBox(width: 320, child: TextField(controller: _importPassword, obscureText: true, decoration: const InputDecoration(labelText: '迁移密码', isDense: true))),
        ],
        const SizedBox(height: AppTokens.gap),
        FilledButton.tonal(onPressed: _running ? null : _stage, child: const Text('检查并准备')),
      ]);
    }
    if (staged != null) {
      final missing = [for (final m in staged['missingKeys'] as List? ?? const []) '$m'];
      children.addAll([
        const SizedBox(height: AppTokens.gap),
        Text('已准备好：${staged['sessions']} 个对话${(staged['materialsRestored'] as num? ?? 0) > 0 ? '，${staged['materialsRestored']} 份资料放进蝶君的家' : ''}。恢复后定时任务都会先暂停，检查后再打开。', style: context.text.bodyMedium),
        if (missing.isNotEmpty) Text('恢复后要重新填写 Key：${missing.join('、')}', style: muted),
        const SizedBox(height: 6),
        Row(
          children: [
            FilledButton(onPressed: _running ? null : _apply, child: const Text('替换当前数据…')),
            const SizedBox(width: AppTokens.gap),
            TextButton(
              onPressed: _running
                  ? null
                  : () async {
                      await _call('backup.discardStaged');
                      if (mounted) setState(() => _staged = null);
                    },
              child: const Text('不恢复了'),
            ),
          ],
        ),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  }

  Widget _restoreSection(Json result, TextStyle? muted) {
    final from = asNullableMap(result['from']);
    final ok = result['ok'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          !ok
              ? '${_date(result['at'] as num?)} 的恢复没有完成，数据保持原样：${result['error']}'
              : result['undo'] == true
              ? '${_date(result['at'] as num?)} 撤销了上一次恢复。'
              : '${_date(result['at'] as num?)} 恢复了 ${from?['host'] ?? ''} 在 ${_date(from?['createdAt'] as num?)} 做的备份（v${from?['appVersion'] ?? '?'}）。',
          style: context.text.bodyMedium,
        ),
        if (ok) ...[
          for (final n in result['notRestored'] as List? ?? const []) Text('· 没有恢复：$n', style: muted),
          for (final k in result['missingKeys'] as List? ?? const []) Text('· 要重新填写 Key：$k', style: muted),
          if (result['schedulesPaused'] == true) Text('· 定时任务都已暂停，到「任务 › 定时任务」检查后再打开。', style: muted),
          if (result['undoBackup'] != null && result['undo'] != true) ...[
            const SizedBox(height: 6),
            OutlinedButton(onPressed: _running ? null : _undo, child: const Text('撤销这次恢复…')),
          ],
        ],
      ],
    );
  }

  Widget _historySection(Json overview, TextStyle? muted) {
    final history = [for (final h in overview['history'] as List? ?? const []) asJsonMap(h)];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('升级前、导入前会各自动备份一次，各留最近 3 份（自动备份共 ${formatBytes(overview['autoBytes'] as num? ?? 0)}）。删除旧备份不会动其他数据。', style: muted),
        if (history.isEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('还没有备份。', style: muted)),
        for (final h in history)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(h['auto'] == true ? Icons.history : Icons.archive_outlined, size: 20),
            title: Text('${switch (h['kind']) {
              'upgrade' => '升级前自动备份',
              'import' => '导入前自动备份',
              _ => '手动导出',
            }} · ${_date(h['createdAt'] as num?)} · ${formatBytes(h['size'] as num? ?? 0)}'),
            subtitle: Text(h['exists'] == true ? h['path'] as String : '${h['path']}（文件已不在）', overflow: TextOverflow.ellipsis),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (h['exists'] == true) IconButton(tooltip: '在文件夹中显示', icon: const Icon(Icons.folder_open_outlined, size: 18), onPressed: () => _agent!.revealInExplorer(h['path'] as String)),
                IconButton(
                  tooltip: h['auto'] == true ? '删除这个备份' : '从记录里移除',
                  icon: const Icon(Icons.delete_outline, size: 18),
                  onPressed: _running
                      ? null
                      : () async {
                          await _call('backup.delete', {'path': h['path']});
                          await _load();
                        },
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// A folded group: its title and a short summary; open it for the rest.
class _Fold extends StatelessWidget {
  const _Fold({required this.title, required this.summary, required this.child});

  final String title;
  final String summary;
  final Widget child;

  @override
  Widget build(BuildContext context) => Theme(
    // No divider lines around the fold.
    data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
    child: ExpansionTile(
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(bottom: AppTokens.gap),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      dense: true,
      title: Text(title, style: context.text.titleSmall),
      subtitle: Text(summary, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      children: [child],
    ),
  );
}

/// The running or last job: its step, a cancel button, how it ended.
class _JobView extends StatelessWidget {
  const _JobView({required this.job, required this.onCancel, required this.onReveal});

  final Json job;
  final VoidCallback onCancel;
  final void Function(String path) onReveal;

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    final kind = switch (job['kind']) {
      'export' => '导出',
      'stage' => '检查备份',
      _ => '恢复',
    };
    final Widget body = switch (job['status']) {
      'running' => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('正在$kind：${job['step'] ?? '准备中'}…', style: context.text.bodyMedium),
          const SizedBox(height: 6),
          const LinearProgressIndicator(),
          if (job['kind'] != 'apply') Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: onCancel, child: const Text('取消'))),
        ],
      ),
      'failed' => Text('$kind没有完成：${job['error']}', style: context.text.bodyMedium?.copyWith(color: context.colors.danger)),
      'cancelled' => Text('已取消$kind，没有留下半成品。', style: muted),
      _ when job['kind'] == 'export' => Row(
        children: [
          Expanded(
            child: Text(
              '已导出到 ${asNullableMap(job['result'])?['path']}（${formatBytes(asNullableMap(job['result'])?['size'] as num? ?? 0)}）',
              style: context.text.bodyMedium,
            ),
          ),
          TextButton(onPressed: () => onReveal(asNullableMap(job['result'])?['path'] as String), child: const Text('在文件夹中显示')),
        ],
      ),
      _ => const SizedBox.shrink(),
    };
    return Padding(padding: const EdgeInsets.only(bottom: AppTokens.gap * 2), child: body);
  }
}

Json? asNullableMap(Object? value) => value is Map ? asJsonMap(value) : null;

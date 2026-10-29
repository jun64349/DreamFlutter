import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';

class McpServer {
  McpServer.fromJson(Json json)
    : name = json['name'] as String? ?? '',
      scope = json['scope'] as String? ?? 'user',
      transport = json['transport'] as String? ?? 'stdio',
      command = json['command'] as String? ?? '',
      args = [for (final a in (json['args'] as List? ?? const [])) '$a'],
      cwd = json['cwd'] as String? ?? '',
      url = json['url'] as String? ?? '',
      env = _values(json['env']),
      headers = _values(json['headers']),
      description = json['description'] as String? ?? '',
      exposure = json['exposure'] as String?,
      enabled = json['enabled'] != false,
      timeout = (json['timeout'] as num?)?.toInt();

  static List<(String, String, bool)> _values(Object? v) => [
    for (final e in ((v as Map?) ?? const {}).entries) (e.key as String, (e.value as Map)['value'] as String? ?? '', (e.value as Map)['secret'] == true),
  ];

  final String name;
  final String scope;
  final String transport;
  final String command;
  final List<String> args;
  final String cwd;
  final String url;
  final List<(String, String, bool)> env;
  final List<(String, String, bool)> headers;
  final String description;
  final String? exposure;
  final bool enabled;
  final int? timeout;

  String get target => transport == 'http' ? url : [command, ...args].join(' ');
}

const _exposures = {
  'codemode': ('脚本调用（默认）', 'Agent 写小脚本调用这些工具，适合工具多的服务'),
  'deferred': ('按需加载', 'Agent 先搜索，再加载需要的工具'),
  'direct': ('直接可见', '工具像内置工具一样直接给 Agent，适合工具少、常用的服务'),
  'hidden': ('隐藏', '连接但不让 Agent 使用'),
};

/// MCP servers: Pi's own `mcp.json`, edited with a form; connection check
/// shows each server's state and tools.
class McpPage extends StatefulWidget {
  const McpPage({super.key});

  @override
  State<McpPage> createState() => _McpPageState();
}

class _McpPageState extends State<McpPage> {
  late final AgentController _agent = AgentScope.read(context);
  List<McpServer> _servers = const [];
  String _file = '';
  Map<String, Json> _status = const {};
  var _checking = false;
  var _changed = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = asJsonMap(await _agent.backend.call('mcp.list', {'cwd': _agent.workspace}));
      _file = result['file'] as String? ?? '';
      _servers = jsonRows(result['servers']).map(McpServer.fromJson).toList();
      _error = null;
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    if (mounted) setState(() {});
  }

  Future<void> _check() async {
    setState(() => _checking = true);
    try {
      final result = asJsonMap(await _agent.backend.call('mcp.status', {'cwd': _agent.workspace}, const Duration(seconds: 150)));
      _status = {for (final s in jsonRows(result['servers'])) s['name'] as String: s};
    } catch (e) {
      _snack('检查失败：${SessionRuntime.describeError(e)}');
    }
    if (mounted) setState(() => _checking = false);
  }

  void _snack(String text) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating, width: 520));

  Future<void> _call(String method, Json params) async {
    try {
      await _agent.backend.call(method, params);
      setState(() {
        _changed = true;
        _status = const {};
      });
    } catch (e) {
      _snack('操作失败：${SessionRuntime.describeError(e)}');
    }
    await _load();
  }

  Future<void> _edit(McpServer? existing) async {
    final saved = await showDialog<bool>(context: context, builder: (_) => _McpEditor(existing: existing));
    if (saved == true) {
      setState(() {
        _changed = true;
        _status = const {};
      });
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    return Scaffold(
      appBar: AppBar(
        title: const Text('MCP 服务'),
        scrolledUnderElevation: 0,
        actions: [
          TextButton.icon(
            onPressed: _checking || _servers.isEmpty ? null : _check,
            icon: _checking ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.wifi_tethering, size: 18),
            label: Text(_checking ? '正在连接…' : '检查连接'),
          ),
          const SizedBox(width: AppTokens.gap),
          FilledButton.tonalIcon(onPressed: () => _edit(null), icon: const Icon(Icons.add, size: 18), label: const Text('添加服务')),
          const SizedBox(width: AppTokens.padLg),
        ],
      ),
      body: _error != null
          ? Center(child: Text(_error!, style: TextStyle(color: context.colors.danger)))
          : PageBody(
              children: [
                Text(
                  'MCP 服务给 Agent 增加新工具（例如读写某个软件、查资料库）。配置保存在 Pi 的 $_file，在终端里用 Pi 也能用。'
                  '标为「加密」的环境变量和请求头用你的 Windows 账户加密保存。',
                  style: muted,
                ),
                if (_changed)
                  Padding(
                    padding: const EdgeInsets.only(top: AppTokens.pad),
                    child: OutlinedCard(
                      highlight: context.colors.warning,
                      child: Row(
                        children: [
                          const Expanded(child: Text('修改会在会话重新加载后生效（运行中的会话不受影响）。')),
                          FilledButton.tonal(
                            onPressed: () async {
                              await _agent.reloadIdleSessions();
                              if (mounted) setState(() => _changed = false);
                            },
                            child: const Text('现在重新加载'),
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: AppTokens.pad),
                if (_servers.isEmpty) const EmptyNote('还没有 MCP 服务。点「添加服务」，例如文件系统：命令 npx，参数 -y、@modelcontextprotocol/server-filesystem、要开放的文件夹。'),
                for (final s in _servers) _ServerCard(server: s, status: _status[s.name], onEdit: () => _edit(s), onAction: _call),
              ],
            ),
    );
  }
}

class _ServerCard extends StatelessWidget {
  const _ServerCard({required this.server, required this.status, required this.onEdit, required this.onAction});

  final McpServer server;
  final Json? status;
  final VoidCallback onEdit;
  final Future<void> Function(String method, Json params) onAction;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final state = status?['state'] as String?;
    final tools = [for (final t in (status?['tools'] as List? ?? const [])) t is Map ? '${t['name']}' : '$t'];
    final error = status?['error'] as String?;
    final (stateLabel, stateColor) = switch (state) {
      'connected' => ('已连接 · ${tools.length} 个工具', colors.success),
      'failed' => ('连接失败', colors.danger),
      'needs-auth' || 'needs_auth' => ('需要登录', colors.warning),
      'disabled' => ('已停用', colors.muted),
      null => ('', colors.muted),
      _ => (state, colors.muted),
    };
    final editable = server.scope == 'user';
    return OutlinedCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(server.transport == 'http' ? Icons.cloud_outlined : Icons.terminal, size: 18, color: server.enabled ? Theme.of(context).colorScheme.primary : colors.muted),
              const SizedBox(width: AppTokens.gap),
              Text(server.name, style: context.text.titleSmall),
              const SizedBox(width: AppTokens.gap),
              if (!editable) const TagChip('项目配置'),
              if (stateLabel.isNotEmpty) ...[const SizedBox(width: 6), TagChip(stateLabel, color: stateColor)],
              const Spacer(),
              if (editable) ...[
                Switch(value: server.enabled, onChanged: (v) => onAction('mcp.setEnabled', {'name': server.name, 'enabled': v})),
                IconButton(tooltip: '修改', icon: const Icon(Icons.edit_outlined, size: 18), onPressed: onEdit),
                IconButton(
                  tooltip: '删除',
                  icon: const Icon(Icons.delete_outline, size: 18),
                  onPressed: () async {
                    if (await confirmAction(context, title: '删除 MCP 服务「${server.name}」？', message: '会从 mcp.json 里删除，加密保存的值也会删除。', confirm: '删除', danger: true)) {
                      await onAction('mcp.remove', {'name': server.name});
                    }
                  },
                ),
              ],
            ],
          ),
          const SizedBox(height: 4),
          Text(server.target, style: muted?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback), maxLines: 2, overflow: TextOverflow.ellipsis),
          if (server.description.isNotEmpty) ...[const SizedBox(height: 2), Text(server.description, style: muted)],
          if (error != null && error.isNotEmpty) ...[
            const SizedBox(height: 6),
            SelectableText(error.length > 600 ? '${error.substring(0, 600)}…' : error, style: context.text.bodySmall?.copyWith(color: colors.danger)),
          ],
          if (tools.isNotEmpty) ...[
            const SizedBox(height: 6),
            Wrap(spacing: 6, runSpacing: 4, children: [for (final t in tools.take(40)) TagChip(t)]),
          ],
        ],
      ),
    );
  }
}

/// One editable key/value row (env var or header) with an "encrypt" toggle.
class _KeyValue {
  _KeyValue(String key, String value, this.secret, {this.stored = false}) : key = TextEditingController(text: key), value = TextEditingController(text: value);

  final TextEditingController key;
  final TextEditingController value;
  bool secret;

  /// An encrypted value already saved (left blank = keep it).
  final bool stored;

  void dispose() {
    key.dispose();
    value.dispose();
  }
}

class _McpEditor extends StatefulWidget {
  const _McpEditor({this.existing});

  final McpServer? existing;

  @override
  State<_McpEditor> createState() => _McpEditorState();
}

class _McpEditorState extends State<_McpEditor> {
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _command = TextEditingController(text: widget.existing?.command ?? '');
  late final _args = TextEditingController(text: widget.existing?.args.join('\n') ?? '');
  late final _cwd = TextEditingController(text: widget.existing?.cwd ?? '');
  late final _url = TextEditingController(text: widget.existing?.url ?? '');
  late final _description = TextEditingController(text: widget.existing?.description ?? '');
  late var _transport = widget.existing?.transport ?? 'stdio';
  late var _exposure = widget.existing?.exposure ?? 'codemode';
  late final _env = [for (final (k, v, s) in widget.existing?.env ?? const <(String, String, bool)>[]) _KeyValue(k, v, s, stored: s)];
  late final _headers = [for (final (k, v, s) in widget.existing?.headers ?? const <(String, String, bool)>[]) _KeyValue(k, v, s, stored: s)];
  String? _error;
  var _saving = false;

  @override
  void dispose() {
    for (final c in [_name, _command, _args, _cwd, _url, _description]) {
      c.dispose();
    }
    for (final kv in [..._env, ..._headers]) {
      kv.dispose();
    }
    super.dispose();
  }

  Json _values(List<_KeyValue> rows) => {
    for (final r in rows)
      if (r.key.text.trim().isNotEmpty) r.key.text.trim(): {'value': r.value.text, 'secret': r.secret},
  };

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final agent = AgentScope.read(context);
    try {
      await agent.backend.call('mcp.save', {
        'previousName': ?widget.existing?.name,
        'server': {
          'name': _name.text.trim(),
          'transport': _transport,
          'command': _command.text.trim(),
          'args': _args.text.split('\n').map((a) => a.trim()).where((a) => a.isNotEmpty).toList(),
          'cwd': _cwd.text.trim(),
          'env': _values(_env),
          'url': _url.text.trim(),
          'headers': _values(_headers),
          'description': _description.text.trim(),
          'exposure': _exposure,
          'enabled': widget.existing?.enabled ?? true,
          'timeout': ?widget.existing?.timeout,
        },
      }, const Duration(seconds: 60));
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() {
        _saving = false;
        _error = SessionRuntime.describeError(e);
      });
    }
  }

  Widget _rows(String title, List<_KeyValue> rows, String keyHint) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(title, style: context.text.labelMedium),
            const Spacer(),
            TextButton.icon(onPressed: () => setState(() => rows.add(_KeyValue('', '', false))), icon: const Icon(Icons.add, size: 16), label: const Text('添加')),
          ],
        ),
        for (final r in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                SizedBox(width: 180, child: TextField(controller: r.key, decoration: InputDecoration(hintText: keyHint))),
                const SizedBox(width: AppTokens.gap),
                Expanded(
                  child: TextField(
                    controller: r.value,
                    obscureText: r.secret,
                    decoration: InputDecoration(hintText: r.stored ? '已加密保存，留空表示不改' : '值，可写 \${环境变量}'),
                  ),
                ),
                const SizedBox(width: 4),
                Tooltip(
                  message: '加密保存（用于密钥、令牌）',
                  child: FilterChip(label: const Text('加密'), selected: r.secret, onSelected: (v) => setState(() => r.secret = v)),
                ),
                IconButton(
                  tooltip: '删除这一行',
                  icon: const Icon(Icons.close, size: 16),
                  onPressed: () => setState(() {
                    rows.remove(r);
                    r.dispose();
                  }),
                ),
              ],
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    final valid = _name.text.trim().isNotEmpty && (_transport == 'http' ? _url.text.trim().isNotEmpty : _command.text.trim().isNotEmpty);
    return AlertDialog(
      title: Text(widget.existing == null ? '添加 MCP 服务' : '修改 MCP 服务'),
      content: SizedBox(
        width: 680,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: '名称（字母、数字、横线、下划线）'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppTokens.pad),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'stdio', label: Text('本地程序'), icon: Icon(Icons.terminal)),
                  ButtonSegment(value: 'http', label: Text('网络地址'), icon: Icon(Icons.cloud_outlined)),
                ],
                selected: {_transport},
                onSelectionChanged: (s) => setState(() => _transport = s.first),
              ),
              const SizedBox(height: AppTokens.pad),
              if (_transport == 'stdio') ...[
                TextField(controller: _command, decoration: const InputDecoration(labelText: '命令（只写程序名，例如 npx、uvx）'), onChanged: (_) => setState(() {})),
                const SizedBox(height: AppTokens.gap),
                TextField(controller: _args, minLines: 2, maxLines: 6, decoration: const InputDecoration(labelText: '参数（每行一个）', alignLabelWithHint: true)),
                const SizedBox(height: AppTokens.gap),
                TextField(controller: _cwd, decoration: const InputDecoration(labelText: '工作目录（可不填）')),
                const SizedBox(height: AppTokens.pad),
                _rows('环境变量', _env, '名称，例如 API_KEY'),
              ] else ...[
                TextField(controller: _url, decoration: const InputDecoration(labelText: '地址（https://…/mcp）'), onChanged: (_) => setState(() {})),
                const SizedBox(height: 4),
                Text('需要 OAuth 登录的服务（如 Sentry）不用填凭证，保存后在终端运行 pi mcp login <名称> 登录。', style: muted),
                const SizedBox(height: AppTokens.pad),
                _rows('请求头', _headers, '例如 Authorization'),
              ],
              const SizedBox(height: AppTokens.pad),
              TextField(controller: _description, decoration: const InputDecoration(labelText: '一句话说明（帮助 Agent 判断什么时候用）')),
              const SizedBox(height: AppTokens.pad),
              Text('Agent 怎么使用这些工具', style: context.text.labelMedium),
              RadioGroup<String>(
                groupValue: _exposure,
                onChanged: (v) => setState(() => _exposure = v!),
                child: Column(
                  children: [
                    for (final e in _exposures.entries) RadioListTile<String>(value: e.key, title: Text(e.value.$1), subtitle: Text(e.value.$2), dense: true),
                  ],
                ),
              ),
              if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(onPressed: _saving || !valid ? null : _save, child: const Text('保存')),
      ],
    );
  }
}

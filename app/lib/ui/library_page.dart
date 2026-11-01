import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';

class SkillInfo {
  SkillInfo.fromJson(Json json)
    : name = json['name'] as String? ?? '',
      description = json['description'] as String? ?? '',
      filePath = json['filePath'] as String? ?? '',
      scope = json['scope'] as String? ?? 'user',
      enabled = json['enabled'] != false;

  final String name;
  final String description;
  final String filePath;
  final String scope;
  final bool enabled;

  String get scopeLabel => switch (scope) {
    'user' => '个人',
    'project' => '本工作区',
    'temporary' => '临时',
    _ => scope,
  };
}

class TemplateParam {
  const TemplateParam(this.name, [this.defaultValue]);

  TemplateParam.fromJson(Json json) : name = json['name'] as String? ?? '', defaultValue = json['default'] as String?;

  final String name;
  final String? defaultValue;

  Json toJson() => {'name': name, if ((defaultValue ?? '').isNotEmpty) 'default': defaultValue};
}

class TemplateInfo {
  TemplateInfo.fromJson(Json json)
    : name = json['name'] as String? ?? '',
      description = json['description'] as String? ?? '',
      body = json['body'] as String? ?? '',
      params = [
        for (final p in (json['params'] as List? ?? const []))
          if (p is Map) TemplateParam.fromJson(p.cast<String, dynamic>()),
      ];

  final String name;
  final String description;
  final String body;
  final List<TemplateParam> params;
}

class SkillProposal {
  SkillProposal.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      title = json['title'] as String? ?? '',
      createdAt = (json['createdAt'] as num?)?.toInt() ?? 0,
      payload = (json['payload'] as Map?)?.cast<String, dynamic>() ?? const {};

  final String id;
  final String title;
  final int createdAt;
  final Json payload;

  String get name => payload['name'] as String? ?? title;
  String get description => payload['description'] as String? ?? '';
  String get content => payload['content'] as String? ?? '';
  String? get previous => payload['previous'] as String?;
  String get scope => payload['scope'] as String? ?? 'user';
  String? get reason => payload['reason'] as String?;
}

/// `{{name}}` placeholders in template text, in order of first use.
List<String> templatePlaceholders(String body) {
  final seen = <String>[];
  for (final m in RegExp(r'\{\{\s*([^}]+?)\s*\}\}').allMatches(body)) {
    final name = m.group(1)!.trim();
    if (!seen.contains(name)) seen.add(name);
  }
  return seen;
}

/// Skills (Pi's SKILL.md files), task templates with named parameters, and
/// skill proposals waiting for the user, as sections in a left panel.
class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key});

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  List<SkillInfo> _skills = const [];
  List<TemplateInfo> _templates = const [];
  List<SkillProposal> _proposals = const [];
  String? _error;
  var _loading = true;
  late final AgentController _agent;

  /// 0 skills, 1 templates, 2 proposals; proposals open first when there are any.
  var _section = 0;
  var _chose = false;
  String? _scope;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.libraryRevision.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    _agent.libraryRevision.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        _agent.backend.call('skills.list', {'cwd': _agent.workspace}),
        _agent.backend.call('templates.list'),
        _agent.backend.call('proposals.list', {'status': 'pending'}),
      ]);
      List<Json> rows(Object? v) => v is List ? v.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() : const [];
      _skills = rows(results[0]).map(SkillInfo.fromJson).toList();
      _templates = rows(results[1]).map(TemplateInfo.fromJson).toList();
      _proposals = rows(results[2]).map(SkillProposal.fromJson).toList();
      _error = null;
      if (!_chose) {
        _chose = true;
        if (_proposals.isNotEmpty) _section = 2;
      }
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating, width: 520));

  Future<bool> _call(String method, Json params, {String? done}) async {
    try {
      await _agent.backend.call(method, params);
      if (done != null && mounted) _snack(done);
      await _load();
      return true;
    } catch (e) {
      if (mounted) _snack('操作失败：${SessionRuntime.describeError(e)}');
      await _load();
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final scopes = {for (final s in _skills) s.scope: s.scopeLabel};
    return SectionedPage(
      title: '技能与模板',
      items: [
        SideNavItem('技能', Icons.auto_stories_outlined, count: _skills.length),
        SideNavItem('任务模板', Icons.post_add_outlined, count: _templates.length),
        SideNavItem('待确认', Icons.rule, count: _proposals.length, alert: true),
      ],
      selected: _section,
      onSelect: (i) => setState(() => _section = i),
      panel: [
        if (_section == 0 && scopes.length > 1) ...[
          const PanelLabel('来源'),
          FilterRow(label: '全部', selected: _scope == null, onTap: () => setState(() => _scope = null)),
          for (final e in scopes.entries) FilterRow(label: e.value, selected: _scope == e.key, onTap: () => setState(() => _scope = e.key)),
        ],
      ],
      child: _error != null
          ? Center(
              child: Text(_error!, style: TextStyle(color: context.colors.danger)),
            )
          : _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : switch (_section) {
              1 => _templatesTab(),
              2 => _proposalsTab(),
              _ => _skillsTab(),
            },
    );
  }

  // ---- skills ----------------------------------------------------------------------

  Widget _skillsTab() {
    final shown = [
      for (final s in _skills)
        if (_scope == null || s.scope == _scope) s,
    ];
    return PageBody(
      children: [
        ContentHeader(
          title: '技能',
          description: 'Agent 平时只看到技能的名称和简介，需要时才读取全文。停用的技能不会出现在 Agent 的列表里。',
          actions: [
            OutlinedButton.icon(onPressed: _importSkill, icon: const Icon(Icons.drive_folder_upload_outlined, size: 18), label: const Text('从文件夹导入')),
            FilledButton.icon(
              onPressed: _agent.active == null || _agent.active!.isPristine ? null : _draftFromSession,
              icon: const Icon(Icons.auto_fix_high_outlined, size: 18),
              label: const Text('从当前会话整理'),
            ),
          ],
        ),
        if (shown.isEmpty) const EmptyState(title: '还没有技能', message: '可以从文件夹导入（文件夹里要有 SKILL.md），\n或者让 Agent 完成任务后建议保存。'),
        for (final s in shown)
          _SkillTile(
            skill: s,
            onToggle: (v) => _call('skills.setEnabled', {'filePath': s.filePath, 'enabled': v}),
            onAction: (v) => switch (v) {
              'view' => _viewSkill(s),
              'folder' => _agent.revealInExplorer(p.dirname(s.filePath)),
              _ => _removeSkill(s),
            },
          ),
      ],
    );
  }

  Future<void> _viewSkill(SkillInfo skill) async {
    try {
      final text = await _agent.backend.call('skills.read', {'filePath': skill.filePath});
      if (mounted) await showTextDialog(context, title: skill.name, text: text as String? ?? '');
    } catch (e) {
      _snack('读取失败：${SessionRuntime.describeError(e)}');
    }
  }

  Future<void> _removeSkill(SkillInfo skill) async {
    final ok = await confirmAction(
      context,
      title: '删除技能「${skill.name}」？',
      message: '技能文件夹会移到 DreamFlutter 数据目录的 trash 文件夹里，需要时可以找回。',
      confirm: '删除',
      danger: true,
    );
    if (ok) await _call('skills.remove', {'filePath': skill.filePath}, done: '已删除');
  }

  Future<void> _importSkill() async {
    final folder = await getDirectoryPath(confirmButtonText: '导入这个技能');
    if (folder == null) return;
    await _call('skills.import', {'folder': folder}, done: '已导入');
  }

  Future<void> _draftFromSession() async {
    _snack('正在用辅助模型整理当前会话，大约需要几十秒…');
    if (await _agent.draftSkillFromSession()) {
      await _load();
      if (mounted) setState(() => _section = 2);
    }
  }

  // ---- templates -------------------------------------------------------------------

  Widget _templatesTab() {
    return PageBody(
      children: [
        ContentHeader(
          title: '任务模板',
          description: '用 {{参数名}} 标出每次会变的部分，运行时会弹出表单让你填写。在输入框里输入 /模板名 也能用。',
          actions: [FilledButton.icon(onPressed: () => _editTemplate(null), icon: const Icon(Icons.add, size: 18), label: const Text('新建模板'))],
        ),
        if (_templates.isEmpty) const EmptyState(title: '还没有模板', message: '可以在对话页右上角菜单里把一次对话存成模板。'),
        for (final t in _templates)
          OutlinedCard(
            padding: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.gap, AppTokens.pad),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '/${t.name}',
                        style: context.text.titleSmall?.copyWith(
                          fontFamily: AppTokens.monoFamily,
                          fontFamilyFallback: AppTokens.monoFallback,
                          color: context.colors.accent,
                        ),
                      ),
                      if (t.description.isNotEmpty && t.description != t.name) ...[
                        const SizedBox(height: 4),
                        Text(t.description, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
                      ],
                      if (t.params.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Wrap(spacing: 6, runSpacing: 4, children: [for (final param in t.params) TagChip('{{${param.name}}}', color: context.colors.ochre)]),
                      ],
                    ],
                  ),
                ),
                OutlinedButton.icon(onPressed: () => runTemplateWithForm(context, t), icon: const Icon(Icons.play_arrow, size: 18), label: const Text('运行')),
                PopupMenuButton<String>(
                  tooltip: '操作',
                  icon: const Icon(Icons.more_horiz, size: 18),
                  onSelected: (v) async {
                    if (v == 'edit') {
                      await _editTemplate(t);
                    } else if (await confirmAction(context, title: '删除模板「${t.name}」？', message: '删除后 /${t.name} 命令也不能用了。', confirm: '删除', danger: true)) {
                      await _call('templates.remove', {'name': t.name}, done: '已删除');
                    }
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(
                      value: 'edit',
                      child: ListTile(dense: true, leading: Icon(Icons.edit_outlined), title: Text('编辑')),
                    ),
                    PopupMenuItem(
                      value: 'remove',
                      child: ListTile(dense: true, leading: Icon(Icons.delete_outline), title: Text('删除')),
                    ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }

  Future<void> _editTemplate(TemplateInfo? existing) async {
    await showTemplateEditor(
      context,
      name: existing?.name ?? '',
      description: existing?.description ?? '',
      body: existing?.body ?? '',
      params: existing?.params ?? const [],
      previousName: existing?.name,
    );
    await _load();
  }

  // ---- proposals -------------------------------------------------------------------

  Widget _proposalsTab() {
    return PageBody(
      children: [
        const ContentHeader(title: '等你确认的技能', description: 'Agent 觉得值得保存的做法，或者你让它从会话里整理的技能。确认后才会写入技能目录。'),
        if (_proposals.isEmpty) const EmptyState(title: '没有待确认的技能建议', message: '在对话页右上角菜单里选「存成技能」，整理好的草稿会出现在这里。'),
        for (final proposal in _proposals) _ProposalCard(proposal: proposal, onAction: _call),
      ],
    );
  }
}

/// One installed skill: a letter badge, name, source and description, an
/// on/off switch and a menu.
class _SkillTile extends StatelessWidget {
  const _SkillTile({required this.skill, required this.onToggle, required this.onAction});

  final SkillInfo skill;
  final ValueChanged<bool> onToggle;
  final ValueChanged<String> onAction;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final s = skill;
    final initial = s.name.isEmpty ? '?' : s.name.characters.first.toUpperCase();
    return OutlinedCard(
      padding: const EdgeInsets.fromLTRB(AppTokens.pad, AppTokens.pad, AppTokens.gap, AppTokens.pad),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: s.enabled ? colors.accentSoft : colors.codeBackground, borderRadius: BorderRadius.circular(AppTokens.radius)),
            child: Text(
              initial,
              style: context.serif(context.text.titleMedium).copyWith(color: s.enabled ? colors.accent : colors.muted, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: AppTokens.pad),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(s.name, style: context.text.titleSmall?.copyWith(color: s.enabled ? null : colors.muted)),
                    ),
                    const SizedBox(width: AppTokens.gap),
                    TagChip(s.scopeLabel),
                    if (!s.enabled) ...[const SizedBox(width: 6), TagChip('已停用', color: colors.warning)],
                  ],
                ),
                if (s.description.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    s.description,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.5),
                  ),
                ],
              ],
            ),
          ),
          Tooltip(
            message: s.enabled ? '停用' : '启用',
            child: Switch(value: s.enabled, onChanged: onToggle),
          ),
          PopupMenuButton<String>(
            tooltip: '操作',
            icon: const Icon(Icons.more_horiz, size: 18),
            onSelected: onAction,
            itemBuilder: (_) => const [
              PopupMenuItem(
                value: 'view',
                child: ListTile(dense: true, leading: Icon(Icons.article_outlined), title: Text('查看内容')),
              ),
              PopupMenuItem(
                value: 'folder',
                child: ListTile(dense: true, leading: Icon(Icons.folder_open_outlined), title: Text('打开所在文件夹')),
              ),
              PopupMenuItem(
                value: 'remove',
                child: ListTile(dense: true, leading: Icon(Icons.delete_outline), title: Text('删除')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ProposalCard extends StatelessWidget {
  const _ProposalCard({required this.proposal, required this.onAction});

  final SkillProposal proposal;
  final Future<bool> Function(String method, Json params, {String? done}) onAction;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final updating = proposal.previous != null;
    return OutlinedCard(
      highlight: Theme.of(context).colorScheme.primary,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(proposal.name, style: context.text.titleSmall),
              TagChip(updating ? '修改已有技能' : '新技能', color: updating ? colors.warning : Theme.of(context).colorScheme.primary),
              TagChip(proposal.scope == 'project' ? '本工作区' : '个人'),
              Text(formatDate(proposal.createdAt), style: muted),
            ],
          ),
          if (proposal.description.isNotEmpty) ...[const SizedBox(height: 4), Text(proposal.description)],
          if ((proposal.reason ?? '').isNotEmpty) ...[const SizedBox(height: 4), Text('理由：${proposal.reason}', style: muted)],
          const SizedBox(height: AppTokens.gap),
          Container(
            constraints: const BoxConstraints(maxHeight: 220),
            width: double.infinity,
            padding: const EdgeInsets.all(AppTokens.gap),
            decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
            child: SingleChildScrollView(
              child: SelectableText(
                proposal.content,
                style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback),
              ),
            ),
          ),
          const SizedBox(height: AppTokens.gap),
          Row(
            children: [
              FilledButton(
                onPressed: () => onAction('proposals.accept', {'id': proposal.id}, done: '技能「${proposal.name}」已保存'),
                child: const Text('保存技能'),
              ),
              const SizedBox(width: AppTokens.gap),
              OutlinedButton(onPressed: () => _edit(context), child: const Text('修改后保存')),
              if (updating) ...[
                const SizedBox(width: AppTokens.gap),
                TextButton(
                  onPressed: () => showTextDialog(context, title: '现在的版本', text: proposal.previous!),
                  child: const Text('对比现在的版本'),
                ),
              ],
              const Spacer(),
              TextButton(onPressed: () => onAction('proposals.reject', {'id': proposal.id}), child: const Text('不需要')),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _edit(BuildContext context) async {
    final values = await showFieldsDialog(
      context,
      title: '修改技能',
      width: 720,
      confirm: '保存技能',
      fields: [
        FieldSpec('技能名（小写字母、数字和横线）', initial: proposal.name, required: true),
        FieldSpec('SKILL.md 全文', initial: proposal.content, minLines: 12, maxLines: 20, mono: true, required: true),
      ],
    );
    if (values == null) return;
    await onAction('proposals.accept', {
      'id': proposal.id,
      'edited': {'name': values[0], 'content': values[1]},
    }, done: '技能已保存');
  }
}

/// Template editor (new, edit, or a draft from a conversation). Returns true when saved.
Future<bool> showTemplateEditor(
  BuildContext context, {
  String name = '',
  String description = '',
  String body = '',
  List<TemplateParam> params = const [],
  String? previousName,
}) async {
  final saved = await showDialog<bool>(
    context: context,
    builder: (_) => _TemplateEditor(name: name, description: description, body: body, params: params, previousName: previousName),
  );
  return saved == true;
}

class _TemplateEditor extends StatefulWidget {
  const _TemplateEditor({required this.name, required this.description, required this.body, required this.params, this.previousName});

  final String name;
  final String description;
  final String body;
  final List<TemplateParam> params;
  final String? previousName;

  @override
  State<_TemplateEditor> createState() => _TemplateEditorState();
}

class _TemplateEditorState extends State<_TemplateEditor> {
  late final _name = TextEditingController(text: widget.name);
  late final _description = TextEditingController(text: widget.description);
  late final _body = TextEditingController(text: widget.body);
  final _defaults = <String, TextEditingController>{};
  String? _error;
  var _saving = false;

  @override
  void initState() {
    super.initState();
    for (final p in widget.params) {
      _defaults[p.name] = TextEditingController(text: p.defaultValue ?? '');
    }
  }

  @override
  void dispose() {
    for (final c in [_name, _description, _body, ..._defaults.values]) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _defaultFor(String param) => _defaults.putIfAbsent(param, TextEditingController.new);

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final agent = AgentScope.read(context);
    try {
      await agent.backend.call('templates.save', {
        'name': _name.text.trim(),
        'description': _description.text.trim(),
        'body': _body.text,
        'params': [for (final name in templatePlaceholders(_body.text)) TemplateParam(name, _defaultFor(name).text.trim()).toJson()],
        'previousName': ?widget.previousName,
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() {
        _saving = false;
        _error = SessionRuntime.describeError(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final placeholders = templatePlaceholders(_body.text);
    return AlertDialog(
      title: Text(widget.previousName == null ? '保存任务模板' : '编辑任务模板'),
      content: SizedBox(
        width: 680,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _name,
                autofocus: widget.name.isEmpty,
                decoration: const InputDecoration(labelText: '模板名（会成为 /命令名，不能有空格）', prefixText: '/'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppTokens.pad),
              TextField(
                controller: _description,
                decoration: const InputDecoration(labelText: '一句话说明'),
              ),
              const SizedBox(height: AppTokens.pad),
              TextField(
                controller: _body,
                minLines: 6,
                maxLines: 14,
                decoration: const InputDecoration(labelText: '模板内容', hintText: '例如：把 {{文件}} 整理成一页周报，重点写 {{重点}}。', alignLabelWithHint: true),
                onChanged: (_) => setState(() {}),
              ),
              if (placeholders.isNotEmpty) ...[
                const SizedBox(height: AppTokens.pad),
                Text('参数默认值（可不填）', style: context.text.labelMedium),
                const SizedBox(height: 4),
                for (final name in placeholders)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: TextField(
                      controller: _defaultFor(name),
                      decoration: InputDecoration(labelText: name),
                    ),
                  ),
              ],
              if (_error != null) ...[const SizedBox(height: AppTokens.pad), Text(_error!, style: TextStyle(color: context.colors.danger))],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(onPressed: _saving || _name.text.trim().isEmpty || _body.text.trim().isEmpty ? null : _save, child: const Text('保存')),
      ],
    );
  }
}

/// Asks for the template's parameters, then runs it in the chat.
Future<void> runTemplateWithForm(BuildContext context, TemplateInfo template) async {
  final agent = AgentScope.read(context);
  if (template.params.isEmpty) {
    await agent.runTemplate(template.name, const {});
    return;
  }
  final values = await showFieldsDialog(
    context,
    title: '运行 /${template.name}',
    confirm: '运行',
    description: template.description.isNotEmpty && template.description != template.name ? template.description : null,
    fields: [for (final param in template.params) FieldSpec(param.name, initial: param.defaultValue ?? '')],
  );
  if (values == null) return;
  await agent.runTemplate(template.name, {for (final (i, param) in template.params.indexed) param.name: values[i]});
}

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';

/// The beginner's guide (route step 4, user 2026-11-18): ten lessons for people who have never
/// used an agent. The same Markdown files are the repository's guide (app/assets/guide), shipped
/// with the app so they read offline. Links `go:settings/<group>` and `go:section/<name>` take
/// the reader to that place in the app.
class GuideLesson {
  const GuideLesson(this.file, this.title, {this.required = false});
  final String file, title;
  final bool required;
  String get asset => 'assets/guide/$file';
}

const guideLessons = [
  GuideLesson('01-agent是什么.md', 'Agent 是什么', required: true),
  GuideLesson('02-接上一个模型.md', '接上一个模型', required: true),
  GuideLesson('03-第一次对话.md', '第一次对话', required: true),
  GuideLesson('04-让它动手干活.md', '让它动手干活', required: true),
  GuideLesson('05-认识蝶君.md', '认识蝶君', required: true),
  GuideLesson('06-它记住了什么.md', '它记住了什么'),
  GuideLesson('07-定时和长期目标.md', '定时和长期目标'),
  GuideLesson('08-技能和常用说法.md', '技能和常用说法'),
  GuideLesson('09-钱花在哪.md', '钱花在哪'),
  GuideLesson('10-出问题怎么办.md', '出问题怎么办'),
];

/// Where a `go:` link leads; false when it is not one the app knows.
bool openGuideTarget(AgentController agent, String target) {
  final parts = target.split('/');
  if (parts.length != 2) return false;
  if (parts[0] == 'settings') {
    agent.openSettings(parts[1]);
    return true;
  }
  if (parts[0] == 'section') {
    final section = AppSection.values.where((s) => s.name == parts[1]).firstOrNull;
    if (section == null) return false;
    agent.showSection(section);
    return true;
  }
  return false;
}

/// The row in 设置 › 关于与更新.
class GuideEntry extends StatelessWidget {
  const GuideEntry({super.key});
  @override
  Widget build(BuildContext context) => SettingRow('使用说明', desc: '从零开始的十课，不联网也能看',
      child: TextButton(onPressed: () => openGuide(context), child: const Text('打开')));
}

Future<void> openGuide(BuildContext context, {int lesson = 0}) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => GuidePage(initial: lesson)));

class GuidePage extends StatefulWidget {
  const GuidePage({super.key, this.initial = 0});
  final int initial;
  @override
  State<GuidePage> createState() => _GuidePageState();
}

class _GuidePageState extends State<GuidePage> {
  late int _lesson = widget.initial.clamp(0, guideLessons.length - 1);
  final _texts = <int, String>{};
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _load(_lesson);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load(int index) async {
    if (_texts.containsKey(index)) return;
    String text;
    try {
      text = await rootBundle.loadString(guideLessons[index].asset);
    } catch (_) {
      text = '这一课没有找到，请重新安装程序。';
    }
    if (mounted) setState(() => _texts[index] = text);
  }

  void _open(int index) {
    setState(() => _lesson = index);
    _load(index);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  Future<void> _link(String? href) async {
    if (href == null) return;
    if (href.startsWith('go:')) {
      final agent = AgentScope.read(context);
      Navigator.of(context).pop();
      openGuideTarget(agent, href.substring(3));
      return;
    }
    final lesson = guideLessons.indexWhere((l) => Uri.decodeFull(href) == l.file);
    if (lesson >= 0) return _open(lesson);
    if (href == 'README.md') return _open(0);
    final uri = Uri.tryParse(href);
    if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Widget _image(Uri uri, String? title, String? alt) {
    final name = uri.path.split("/").last;
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Image.asset('assets/guide/images/$name', errorBuilder: (context, _, _) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 14),
        decoration: BoxDecoration(color: colors.sunk, borderRadius: BorderRadius.circular(10), border: Border.all(color: colors.border)),
        child: Text('截图待补：${alt ?? name}', textAlign: TextAlign.center, style: context.text.bodySmall?.copyWith(color: colors.muted)),
      )),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = _texts[_lesson];
    final toc = ListView(padding: const EdgeInsets.fromLTRB(12, 16, 12, 16), children: [
      for (final (index, lesson) in guideLessons.indexed) ...[
        if (index == 5) Padding(padding: const EdgeInsets.fromLTRB(10, 14, 10, 4), child: Text('进阶', style: context.text.bodySmall?.copyWith(color: colors.muted))),
        if (index == 0) Padding(padding: const EdgeInsets.fromLTRB(10, 0, 10, 4), child: Text('必修', style: context.text.bodySmall?.copyWith(color: colors.muted))),
        Material(
          color: index == _lesson ? colors.accentSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
          child: InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => _open(index),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Text('${index + 1}  ${lesson.title}', style: context.text.bodyMedium?.copyWith(color: index == _lesson ? colors.accent : colors.ink2)),
            ),
          ),
        ),
      ],
    ]);
    final body = text == null
        ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
        : Markdown(
            controller: _scroll,
            data: text,
            selectable: true,
            padding: const EdgeInsets.fromLTRB(32, 20, 32, 48),
            onTapLink: (_, href, _) => _link(href),
            imageBuilder: _image,
            styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
              h1: context.serif(context.text.headlineSmall).copyWith(color: colors.ink),
              h2: context.text.titleMedium?.copyWith(color: colors.ink, fontWeight: FontWeight.w600),
              p: context.text.bodyLarge?.copyWith(color: colors.ink, height: 1.75),
              a: TextStyle(color: colors.accent),
              blockquoteDecoration: BoxDecoration(color: colors.sunk, borderRadius: BorderRadius.circular(8)),
              tableBorder: TableBorder.all(color: colors.border),
              code: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13, backgroundColor: Colors.transparent),
            ),
          );
    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(title: const Text('使用说明'), backgroundColor: colors.background, surfaceTintColor: Colors.transparent),
      body: LayoutBuilder(builder: (context, bounds) {
        if (bounds.maxWidth < 720) {
          return Column(children: [
            SizedBox(height: 46, child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
              for (final (index, lesson) in guideLessons.indexed)
                Padding(padding: const EdgeInsets.only(right: 6), child: ChoiceChip(label: Text('${index + 1} ${lesson.title}'), selected: index == _lesson, onSelected: (_) => _open(index))),
            ])),
            Expanded(child: body),
          ]);
        }
        return Row(children: [
          Container(width: 220, decoration: BoxDecoration(color: colors.sidebar, border: Border(right: BorderSide(color: colors.border))), child: toc),
          Expanded(child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 780), child: body))),
        ]);
      }),
    );
  }
}

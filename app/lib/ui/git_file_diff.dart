import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../theme.dart';
import 'message_widgets.dart' show DiffKind, DiffLine, DiffView;
import 'workspace_path.dart';

class GitFileDiff {
  const GitFileDiff({required this.paths, required this.lines});
  final List<String> paths;
  final List<DiffLine> lines;
}

// Git's quoted paths use C escapes and octal UTF-8 bytes, rather than JSON.
String _decodePath(String text) {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  final bytes = <int>[];
  final value = text.substring(1, text.length - 1);
  for (var i = 0; i < value.length;) {
    if (value[i] != r'\') {
      final start = i++;
      while (i < value.length && value[i] != r'\') { i++; }
      bytes.addAll(utf8.encode(value.substring(start, i)));
      continue;
    }
    i++;
    if (i == value.length) break;
    final octal = RegExp(r'^[0-7]{1,3}').firstMatch(value.substring(i));
    if (octal != null) { bytes.add(int.parse(octal[0]!, radix: 8)); i += octal[0]!.length; }
    else { bytes.addAll(utf8.encode(switch (value[i++]) { 't' => '\t', 'n' => '\n', 'r' => '\r', 'a' => '\x07', 'b' => '\b', 'f' => '\f', 'v' => '\x0b', final char => char })); }
  }
  return utf8.decode(bytes, allowMalformed: true);
}

/// Keeps protocol headers out of the view, including content that starts +++/---.
/// Authoritative paths also let mode-only/binary patches match unquoted spaces.
List<GitFileDiff> parseGitFileDiffs(String patch, List<String> paths) {
  final files = <GitFileDiff>[];
  final remaining = paths.toSet();
  final candidates = [...paths]..sort((a, b) => b.length.compareTo(a.length));
  for (final section in patch.split(RegExp(r'(?=^diff --git )', multiLine: true))) {
    if (!section.startsWith('diff --git ')) continue;
    final names = <String>{};
    final lines = <DiffLine>[];
    var inHunk = false;
    void name(String text, {bool prefix = false}) {
      var path = _decodePath(text.split('\t').first);
      if (path == '/dev/null') return;
      if (prefix && (path.startsWith('a/') || path.startsWith('b/'))) path = path.substring(2);
      if (paths.contains(path)) names.add(path);
    }
    final header = section.split('\n').first.substring('diff --git '.length);
    final quoted = RegExp(r'("(?:\\.|[^"\\])*")$').firstMatch(header);
    if (quoted != null) {
      name(header.substring(0, quoted.start).trimRight(), prefix: true); name(quoted[0]!, prefix: true);
    } else {
      for (final path in candidates) {
        if (header.endsWith(' b/$path')) { name(header.substring(0, header.length - ' b/$path'.length), prefix: true); name('b/$path', prefix: true); break; }
      }
    }
    for (final line in section.split('\n').skip(1)) {
      if (line.startsWith('@@')) {
        if (lines.isNotEmpty) lines.add(const DiffLine(DiffKind.gap, '⋯'));
        inHunk = true;
      } else if (inHunk) {
        if (line.startsWith('+')) { lines.add(DiffLine(DiffKind.added, line.substring(1))); }
        else if (line.startsWith('-')) { lines.add(DiffLine(DiffKind.removed, line.substring(1))); }
        else if (line.startsWith(' ')) { lines.add(DiffLine(DiffKind.context, line.substring(1))); }
      } else if (line.startsWith('--- ') || line.startsWith('+++ ')) { name(line.substring(4), prefix: true); }
      else if (line.startsWith('rename from ')) { name(line.substring(12)); }
      else if (line.startsWith('rename to ')) { name(line.substring(10)); }
      else if (line == '二进制文件已更改' || line.startsWith('Binary files ')) { lines.add(const DiffLine(DiffKind.context, '二进制文件已更改')); }
      else if (line.startsWith('old mode ')) { lines.add(const DiffLine(DiffKind.context, '文件权限已更改')); }
    }
    if (names.isEmpty) continue;
    files.add(GitFileDiff(paths: names.toList(), lines: lines)); remaining.removeAll(names);
  }
  for (final path in paths.where(remaining.contains)) { files.add(GitFileDiff(paths: [path], lines: const [])); }
  return files;
}

class GitFileDiffRow extends StatefulWidget {
  const GitFileDiffRow({super.key, required this.file, required this.root, required this.selected, required this.onChanged});
  final GitFileDiff file;
  final String root;
  final bool selected;
  final ValueChanged<bool>? onChanged;
  @override
  State<GitFileDiffRow> createState() => _GitFileDiffRowState();
}

class _GitFileDiffRowState extends State<GitFileDiffRow> {
  bool _expanded = false;
  @override
  Widget build(BuildContext context) {
    final file = widget.file;
    final full = [for (final path in file.paths) p.join(widget.root, path)];
    final label = full.map((path) => relativeWorkspacePath(workspaceOf(context), path)).join(' → ');
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Checkbox(key: ValueKey('commit-select-${file.paths.first}'), value: widget.selected, onChanged: widget.onChanged == null ? null : (value) => widget.onChanged!(value == true), semanticLabel: label),
        Expanded(child: InkWell(key: ValueKey('commit-expand-${file.paths.first}'), onTap: () => setState(() => _expanded = !_expanded), borderRadius: BorderRadius.circular(context.radius), child: Padding(padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4), child: Row(children: [
          Expanded(child: Tooltip(message: full.join('\n'), child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall))),
          Icon(_expanded ? Icons.expand_less : Icons.expand_more, size: 18, color: context.colors.muted),
        ])))),
      ]),
      AnimatedSize(duration: AppTokens.motion(context, AppTokens.medium), curve: AppTokens.curve, alignment: Alignment.topCenter, child: _expanded ? Padding(padding: const EdgeInsets.only(left: 12, bottom: 8), child: file.lines.isEmpty ? Text('没有文本差异', style: context.text.bodySmall) : DiffView(lines: file.lines)) : const SizedBox(width: double.infinity)),
    ]);
  }
}

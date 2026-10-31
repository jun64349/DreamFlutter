import 'package:path/path.dart' as p;

/// Something attached to a message besides images: a desk note, a desk
/// material, or a file or folder dropped or pasted into the input box.
///
/// It travels inside the message text in the same tags the core uses for
/// desk tasks (`<写笺>`, `<资料>`), so the agent reads files with its tools
/// and gets text inline; the window shows the tags as chips again.
class Mention {
  const Mention({required this.kind, required this.title, this.path, this.content});

  factory Mention.file(String path, {bool folder = false}) =>
      Mention(kind: folder ? MentionKind.folder : MentionKind.file, title: p.basename(path), path: path);

  final MentionKind kind;
  final String title;
  final String? path;
  final String? content;

  @override
  bool operator ==(Object other) => other is Mention && other.kind == kind && other.title == title && other.path == path;

  @override
  int get hashCode => Object.hash(kind, title, path);
}

/// document: a PDF, Word, Excel, PowerPoint or text file the core turned into
/// text ([Mention.content]); a large one carries only its path and a summary.
enum MentionKind { note, text, file, folder, document }

/// File types the core converts to text (core/src/modules/documents.ts).
const documentExtensions = {
  'pdf', 'docx', 'xlsx', 'xlsm', 'pptx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'xml', 'log', //
  'html', 'htm', 'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'dart', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', //
  'sql', 'sh', 'ps1', 'bat', 'css', 'scss', 'vue', 'tex', 'srt', 'vtt',
};

const _largeNote = '（内容较长，没有全部附上：需要时用 read_document 工具分段读取这个文件。）';

const _readHint = '需要时用工具读取上面列出的文件或文件夹。';

/// [text] with [mentions] appended as the core's tags.
String composeWithMentions(String text, List<Mention> mentions) {
  if (mentions.isEmpty) return text;
  final parts = [text.trim()];
  for (final note in mentions.where((m) => m.kind == MentionKind.note)) {
    parts.addAll(['', '<写笺 标题="${note.title}">', (note.content ?? '').trim().isEmpty ? '（空）' : note.content!.trim(), '</写笺>']);
  }
  final materials = mentions.where((m) => m.kind != MentionKind.note).toList();
  if (materials.isNotEmpty) {
    parts.addAll(['', '<资料>']);
    for (final m in materials) {
      switch (m.kind) {
        case MentionKind.text:
          final content = m.content ?? '';
          parts.addAll(['<文本 标题="${m.title}">', content.length > 20000 ? content.substring(0, 20000) : content, '</文本>']);
        case MentionKind.document:
          parts.addAll(['<文档 标题="${m.title}" 路径="${m.path}">', m.content ?? _largeNote, '</文档>']);
        case MentionKind.folder:
          parts.add('- 文件夹：${m.path}');
        case MentionKind.file || MentionKind.note:
          parts.add('- 文件：${m.path}');
      }
    }
    parts.addAll(['</资料>', _readHint]);
  }
  return parts.join('\n');
}

final _noteTag = RegExp(r'<写笺 标题="([^"]*)">\n?([\s\S]*?)\n?</写笺>');
final _materialBlock = RegExp(r'<资料>\n?([\s\S]*?)\n?</资料>\s*(' + _readHint + r')?');
final _textTag = RegExp(r'<文本 标题="([^"]*)">\n?([\s\S]*?)\n?</文本>');
final _documentTag = RegExp(r'<文档 标题="([^"]*)" 路径="([^"]*)">\n?([\s\S]*?)\n?</文档>');
final _pathLine = RegExp(r'^- (文件|文件夹)：(.+)$', multiLine: true);

/// The question as the user wrote it, and what was attached to it.
(String, List<Mention>) splitMentions(String text) {
  if (!text.contains('<写笺') && !text.contains('<资料>')) return (text, const []);
  final mentions = <Mention>[];
  for (final m in _noteTag.allMatches(text)) {
    mentions.add(Mention(kind: MentionKind.note, title: m.group(1)!, content: m.group(2)));
  }
  for (final block in _materialBlock.allMatches(text)) {
    final body = block.group(1)!;
    for (final t in _textTag.allMatches(body)) {
      mentions.add(Mention(kind: MentionKind.text, title: t.group(1)!, content: t.group(2)));
    }
    for (final d in _documentTag.allMatches(body)) {
      final content = d.group(3)!;
      mentions.add(Mention(kind: MentionKind.document, title: d.group(1)!, path: d.group(2), content: content == _largeNote ? null : content));
    }
    for (final line in _pathLine.allMatches(body.replaceAll(_textTag, '').replaceAll(_documentTag, ''))) {
      mentions.add(Mention.file(line.group(2)!.trim(), folder: line.group(1) == '文件夹'));
    }
  }
  final clean = text.replaceAll(_noteTag, '').replaceAll(_materialBlock, '').trim();
  return (clean, mentions);
}

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:file_selector/file_selector.dart';
import 'package:path/path.dart' as p;

import '../state/work_models.dart' show OutboxFile;
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';

const _imageExtensions = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'};
const _textExtensions = {
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.dart', '.py', '.java',
  '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.sh', '.ps1', '.bat', '.ini', '.toml', '.log', '.sql', '.tex',
};

bool canPreview(String path) {
  final ext = p.extension(path).toLowerCase();
  return _imageExtensions.contains(ext) || _textExtensions.contains(ext);
}

/// What kind of file a path is, for its icon and color (0.8.2: "用明显的图标区分文件类型").
enum FileKind { image, text, table, pdf, doc, slides, code, script, web, archive, data, other }

const _codeExtensions = {'.dart', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.swift', '.rb', '.php', '.lua', '.vue', '.svelte', '.m', '.ino'};
const _scriptExtensions = {'.ps1', '.psm1', '.bat', '.cmd', '.sh', '.bash', '.zsh'};
const _dataExtensions = {'.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf', '.env', '.sql', '.db', '.sqlite', '.jsonl'};

FileKind fileKind(String path) {
  final ext = p.extension(path).toLowerCase();
  if (_imageExtensions.contains(ext) || ext == '.svg') return FileKind.image;
  if (ext == '.md' || ext == '.markdown' || ext == '.txt' || ext == '.log' || ext == '.rst') return FileKind.text;
  if (ext == '.csv' || ext == '.tsv' || ext == '.xlsx' || ext == '.xls') return FileKind.table;
  if (ext == '.pdf') return FileKind.pdf;
  if (ext == '.docx' || ext == '.doc' || ext == '.rtf' || ext == '.odt') return FileKind.doc;
  if (ext == '.pptx' || ext == '.ppt' || ext == '.key') return FileKind.slides;
  if (ext == '.html' || ext == '.htm' || ext == '.css' || ext == '.scss') return FileKind.web;
  if (_scriptExtensions.contains(ext)) return FileKind.script;
  if (_codeExtensions.contains(ext)) return FileKind.code;
  if (ext == '.zip' || ext == '.7z' || ext == '.rar' || ext == '.tar' || ext == '.gz') return FileKind.archive;
  if (_dataExtensions.contains(ext)) return FileKind.data;
  return FileKind.other;
}

IconData fileIcon(String path) => switch (fileKind(path)) {
  FileKind.image => Icons.image_outlined,
  FileKind.text => Icons.article_outlined,
  FileKind.table => Icons.table_chart_outlined,
  FileKind.pdf => Icons.picture_as_pdf_outlined,
  FileKind.doc => Icons.description_outlined,
  FileKind.slides => Icons.slideshow_outlined,
  FileKind.code => Icons.code,
  FileKind.script => Icons.terminal,
  FileKind.web => Icons.language,
  FileKind.archive => Icons.folder_zip_outlined,
  FileKind.data => Icons.data_object,
  FileKind.other => Icons.insert_drive_file_outlined,
};

/// The file kind's color: fixed hues so a kind is recognised at a glance in every theme.
Color fileTypeColor(BuildContext context, String path) {
  final dark = Theme.of(context).brightness == Brightness.dark;
  Color c(int light, int night) => Color(dark ? night : light);
  return switch (fileKind(path)) {
    FileKind.image => c(0xFF8E5BB5, 0xFFC39BE3),
    FileKind.text => c(0xFF4A6B8A, 0xFF9DB9D6),
    FileKind.table => c(0xFF2E7D4F, 0xFF7FCB9B),
    FileKind.pdf => c(0xFFC0392B, 0xFFEF8C80),
    FileKind.doc => c(0xFF2F5FA8, 0xFF8FB0E8),
    FileKind.slides => c(0xFFD0662B, 0xFFF0A673),
    FileKind.code => c(0xFF6B5B95, 0xFFB3A6DA),
    FileKind.script => c(0xFF3D6F73, 0xFF8BC4C8),
    FileKind.web => c(0xFFB5762A, 0xFFE6B36E),
    FileKind.archive => c(0xFF7A6A55, 0xFFC2B39E),
    FileKind.data => c(0xFF8A6D1F, 0xFFD9BE6A),
    FileKind.other => context.colors.muted,
  };
}

/// A file the agent wrote or changed: preview, open, show in Explorer, and
/// optionally "continue working on it".
class ArtifactTile extends StatelessWidget {
  const ArtifactTile({super.key, required this.path, required this.exists, this.onContinue, this.subtitle});

  final String path;
  final bool exists;

  /// Second line instead of the folder (「来自「周报」 · 14:32」).
  final String? subtitle;
  final VoidCallback? onContinue;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.read(context);
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final ext = p.extension(path).replaceFirst('.', '').toUpperCase();
    return OutlinedCard(
      padding: const EdgeInsets.fromLTRB(AppTokens.gap, 6, 2, 6),
      child: Row(
        children: [
          // The file type as a small square badge (MD, PDF...).
          Container(
            width: 32,
            height: 32,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: exists ? colors.accentSoft : colors.codeBackground,
              borderRadius: BorderRadius.circular(context.radius),
            ),
            child: ext.isEmpty || ext.length > 4
                ? Icon(fileIcon(path), size: 16, color: exists ? colors.accent : colors.muted)
                : Text(ext, style: context.text.labelSmall?.copyWith(fontSize: 9.5, fontWeight: FontWeight.w700, color: exists ? colors.accent : colors.muted)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: InkWell(
              onTap: exists && canPreview(path) ? () => showFilePreview(context, path) : null,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(p.basename(path), maxLines: 1, overflow: TextOverflow.ellipsis, style: exists ? null : muted?.copyWith(decoration: TextDecoration.lineThrough)),
                  Text(exists ? (subtitle ?? p.dirname(path)) : '文件已不存在', maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
                ],
              ),
            ),
          ),
          if (exists)
            PopupMenuButton<String>(
              tooltip: '操作',
              icon: const Icon(Icons.more_horiz, size: 16),
              onSelected: (v) => switch (v) {
                'preview' => showFilePreview(context, path),
                'open' => agent.openFile(path),
                'reveal' => agent.revealFile(path),
                _ => onContinue?.call(),
              },
              itemBuilder: (_) => [
                if (canPreview(path)) const PopupMenuItem(value: 'preview', child: ListTile(dense: true, leading: Icon(Icons.visibility_outlined), title: Text('预览'))),
                const PopupMenuItem(value: 'open', child: ListTile(dense: true, leading: Icon(Icons.open_in_new), title: Text('用默认程序打开'))),
                const PopupMenuItem(value: 'reveal', child: ListTile(dense: true, leading: Icon(Icons.folder_open_outlined), title: Text('在资源管理器中显示'))),
                if (onContinue != null) const PopupMenuItem(value: 'continue', child: ListTile(dense: true, leading: Icon(Icons.edit_note), title: Text('继续修改'))),
              ],
            ),
        ],
      ),
    );
  }
}

/// Shows a text, Markdown or image file in a dialog.
Future<void> showFilePreview(BuildContext context, String path) async {
  final agent = AgentScope.read(context);
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(p.basename(path)),
      content: SizedBox(width: 760, height: 520, child: FilePreviewBody(path: path)),
      actions: [
        TextButton(onPressed: () => agent.revealFile(path), child: const Text('在资源管理器中显示')),
        TextButton(onPressed: () => agent.openFile(path), child: const Text('用默认程序打开')),
        FilledButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
      ],
    ),
  );
}

/// A file's content for reading: a picture (zoomable), Markdown, or plain text (0.8.2: shared by
/// the preview dialog and the right panel's preview).
class FilePreviewBody extends StatefulWidget {
  const FilePreviewBody({super.key, required this.path});
  final String path;
  @override
  State<FilePreviewBody> createState() => _FilePreviewBodyState();
}

class _FilePreviewBodyState extends State<FilePreviewBody> {
  String? _text;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(FilePreviewBody old) {
    super.didUpdateWidget(old);
    if (old.path != widget.path) { _text = null; _load(); }
  }

  bool get _image => _imageExtensions.contains(p.extension(widget.path).toLowerCase());

  Future<void> _load() async {
    if (_image) return;
    final path = widget.path;
    String text;
    try {
      final file = File(path);
      final length = await file.length();
      text = length > 400 * 1024 ? '${(await file.openRead(0, 400 * 1024).transform(const SystemEncoding().decoder).join())}\n\n……（文件太大，只显示开头）' : await file.readAsString();
    } catch (e) {
      text = canPreview(path) ? '无法读取：$e' : '这种文件不能在这里预览，用默认程序打开看。';
    }
    if (mounted && path == widget.path) setState(() => _text = text);
  }

  @override
  Widget build(BuildContext context) {
    if (_image) return InteractiveViewer(child: Image.file(File(widget.path), fit: BoxFit.contain));
    final text = _text;
    if (text == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final ext = p.extension(widget.path).toLowerCase();
    if (ext == '.md' || ext == '.markdown') {
      return Markdown(
        data: text,
        selectable: true,
        padding: EdgeInsets.zero,
        // The package's default code style has a ground that hides the selection (see ReplyMarkdown).
        styleSheet: MarkdownStyleSheet(
          code: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13, backgroundColor: Colors.transparent),
        ),
      );
    }
    return SingleChildScrollView(
      child: SelectableText(text, style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, height: 1.5)),
    );
  }
}

String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(bytes < 10 * 1024 ? 1 : 0)} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

/// Plain-text files small enough to change in place.
bool canEditText(String path, int size) => _textExtensions.contains(p.extension(path).toLowerCase()) && size <= 512 * 1024;

/// A file 蝶君 delivered to its outbox: preview, change a text file a
/// little, save a copy to this computer, or open it.
class OutboxTile extends StatelessWidget {
  const OutboxTile({super.key, required this.file, this.onChanged});

  final OutboxFile file;
  final VoidCallback? onChanged;

  Future<void> _save(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final location = await getSaveLocation(suggestedName: p.posix.basename(file.name), confirmButtonText: '保存到这里');
    if (location == null) return;
    try {
      await File(file.path).copy(location.path);
      messenger.showSnackBar(SnackBar(content: Text('已保存到 ${location.path}'), behavior: SnackBarBehavior.floating, width: 520));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('保存失败：$e'), behavior: SnackBarBehavior.floating, width: 520));
    }
  }

  Future<void> _edit(BuildContext context) async {
    String text;
    try {
      text = await File(file.path).readAsString();
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('读不了这个文件：$e')));
      return;
    }
    if (!context.mounted) return;
    final changed = await showDialog<String>(context: context, builder: (_) => _TextEditDialog(title: file.name, text: text));
    if (changed == null || changed == text) return;
    try {
      await File(file.path).writeAsString(changed);
      onChanged?.call();
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.read(context);
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    final editable = canEditText(file.path, file.size);
    return OutlinedCard(
      padding: const EdgeInsets.fromLTRB(AppTokens.gap, 6, 2, 6),
      child: Row(
        children: [
          Icon(fileIcon(file.path), size: 18, color: context.colors.accent),
          const SizedBox(width: 10),
          Expanded(
            child: InkWell(
              onTap: () => canPreview(file.path) ? showFilePreview(context, file.path) : agent.openFile(file.path),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(file.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                  Text('${formatBytes(file.size)} · ${formatDate(file.modifiedAt?.millisecondsSinceEpoch)}', maxLines: 1, style: muted),
                ],
              ),
            ),
          ),
          IconButton(tooltip: '保存到这台电脑', icon: const Icon(Icons.download_outlined, size: 18), visualDensity: VisualDensity.compact, onPressed: () => _save(context)),
          PopupMenuButton<String>(
            tooltip: '操作',
            icon: const Icon(Icons.more_horiz, size: 16),
            onSelected: (v) => switch (v) {
              'preview' => showFilePreview(context, file.path),
              'edit' => _edit(context),
              'open' => agent.openFile(file.path),
              _ => agent.revealFile(file.path),
            },
            itemBuilder: (_) => [
              if (canPreview(file.path)) const PopupMenuItem(value: 'preview', child: ListTile(dense: true, leading: Icon(Icons.visibility_outlined), title: Text('预览'))),
              if (editable) const PopupMenuItem(value: 'edit', child: ListTile(dense: true, leading: Icon(Icons.edit_outlined), title: Text('修改'))),
              const PopupMenuItem(value: 'open', child: ListTile(dense: true, leading: Icon(Icons.open_in_new), title: Text('用默认程序打开'))),
              const PopupMenuItem(value: 'reveal', child: ListTile(dense: true, leading: Icon(Icons.folder_open_outlined), title: Text('在资源管理器中显示'))),
            ],
          ),
        ],
      ),
    );
  }
}

class _TextEditDialog extends StatefulWidget {
  const _TextEditDialog({required this.title, required this.text});

  final String title;
  final String text;

  @override
  State<_TextEditDialog> createState() => _TextEditDialogState();
}

class _TextEditDialogState extends State<_TextEditDialog> {
  late final _controller = TextEditingController(text: widget.text);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 760,
        height: 520,
        child: TextField(
          controller: _controller,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, height: 1.5),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, _controller.text), child: const Text('保存')),
      ],
    );
  }
}

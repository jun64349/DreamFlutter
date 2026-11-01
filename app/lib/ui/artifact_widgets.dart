import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:path/path.dart' as p;

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

IconData fileIcon(String path) {
  final ext = p.extension(path).toLowerCase();
  if (_imageExtensions.contains(ext)) return Icons.image_outlined;
  if (ext == '.md' || ext == '.markdown' || ext == '.txt') return Icons.article_outlined;
  if (ext == '.csv' || ext == '.xlsx' || ext == '.xls') return Icons.table_chart_outlined;
  if (ext == '.pdf') return Icons.picture_as_pdf_outlined;
  return Icons.insert_drive_file_outlined;
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
  final ext = p.extension(path).toLowerCase();
  Widget body;
  if (_imageExtensions.contains(ext)) {
    body = InteractiveViewer(child: Image.file(File(path), fit: BoxFit.contain));
  } else {
    String text;
    try {
      final file = File(path);
      final length = await file.length();
      text = length > 400 * 1024 ? '${(await file.openRead(0, 400 * 1024).transform(const SystemEncoding().decoder).join())}\n\n……（文件太大，只显示开头）' : await file.readAsString();
    } catch (e) {
      text = '无法读取：$e';
    }
    if (!context.mounted) return;
    body = ext == '.md' || ext == '.markdown'
        ? Markdown(data: text, selectable: true, padding: EdgeInsets.zero)
        : SingleChildScrollView(
            child: SelectableText(text, style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, height: 1.5)),
          );
  }
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(p.basename(path)),
      content: SizedBox(width: 760, height: 520, child: body),
      actions: [
        TextButton(onPressed: () => agent.revealFile(path), child: const Text('在资源管理器中显示')),
        TextButton(onPressed: () => agent.openFile(path), child: const Text('用默认程序打开')),
        FilledButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
      ],
    ),
  );
}

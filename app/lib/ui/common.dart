import 'package:flutter/material.dart';

import '../theme.dart';

/// Small building blocks shared by the full-page views (memory, skills...).

/// A page next to the navigation rail: title row with actions, then content
/// limited to [AppTokens.contentMaxWidth].
class PageFrame extends StatelessWidget {
  const PageFrame({super.key, required this.title, this.actions = const [], this.subtitle, required this.child});

  final String title;
  final String? subtitle;
  final List<Widget> actions;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppTokens.padLg * 2, AppTokens.padLg, AppTokens.padLg * 2, AppTokens.pad),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: context.text.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
                    if (subtitle != null) ...[
                      const SizedBox(height: 2),
                      Text(subtitle!, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
                    ],
                  ],
                ),
              ),
              Wrap(spacing: AppTokens.gap, crossAxisAlignment: WrapCrossAlignment.center, children: actions),
            ],
          ),
        ),
        const Divider(),
        Expanded(child: child),
      ],
    );
  }
}

/// Scrollable page body with the standard width and padding.
class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg * 2, vertical: AppTokens.padLg),
      children: [
        for (final child in children)
          Center(
            child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth), child: child),
          ),
      ],
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.trailing, this.count});

  final String title;
  final int? count;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AppTokens.padLg, bottom: AppTokens.gap),
      child: Row(
        children: [
          Text(count == null ? title : '$title（$count）', style: context.text.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
          const Spacer(),
          ?trailing,
        ],
      ),
    );
  }
}

/// A bordered card used for list rows and confirmation cards.
class OutlinedCard extends StatelessWidget {
  const OutlinedCard({super.key, required this.child, this.highlight, this.padding = const EdgeInsets.all(AppTokens.pad)});

  final Widget child;

  /// Accent border color (e.g. for items waiting for the user).
  final Color? highlight;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.only(bottom: AppTokens.gap),
      padding: padding,
      decoration: BoxDecoration(
        color: highlight == null ? colors.card : highlight!.withValues(alpha: 0.05),
        border: Border.all(color: highlight?.withValues(alpha: 0.5) ?? colors.border),
        borderRadius: BorderRadius.circular(AppTokens.radius),
      ),
      child: child,
    );
  }
}

class EmptyNote extends StatelessWidget {
  const EmptyNote(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppTokens.padLg),
      child: Text(text, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
    );
  }
}

/// A small rounded label (kind, scope, status...).
class TagChip extends StatelessWidget {
  const TagChip(this.label, {super.key, this.color});

  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final tint = color ?? context.colors.muted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: tint.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
      child: Text(label, style: context.text.labelSmall?.copyWith(color: tint)),
    );
  }
}

Future<bool> confirmAction(BuildContext context, {required String title, required String message, String confirm = '确定', bool danger = false}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 480), child: Text(message)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: context.colors.danger) : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(confirm),
        ),
      ],
    ),
  );
  return ok == true;
}

/// Shows long read-only text (a skill file, a memory snapshot) in a dialog.
Future<void> showTextDialog(BuildContext context, {required String title, required String text, List<Widget> actions = const []}) {
  return showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: SizedBox(
        width: 720,
        height: 480,
        child: SingleChildScrollView(
          child: SelectableText(
            text,
            style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, height: 1.5),
          ),
        ),
      ),
      actions: [...actions, TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    ),
  );
}

String formatDate(int? millis) {
  if (millis == null || millis == 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(millis);
  final now = DateTime.now();
  String two(int v) => v.toString().padLeft(2, '0');
  final time = '${two(d.hour)}:${two(d.minute)}';
  if (d.year == now.year && d.month == now.month && d.day == now.day) return '今天 $time';
  if (d.year == now.year) return '${d.month}月${d.day}日 $time';
  return '${d.year}年${d.month}月${d.day}日';
}

/// One text field of [showFieldsDialog].
class FieldSpec {
  const FieldSpec(this.label, {this.initial = '', this.hint, this.minLines = 1, this.maxLines = 1, this.mono = false, this.required = false});

  final String label;
  final String initial;
  final String? hint;
  final int minLines;
  final int maxLines;
  final bool mono;
  final bool required;
}

/// A dialog with a few text fields; returns their values, or null when
/// cancelled. The dialog owns its controllers, so they outlive the closing
/// animation.
Future<List<String>?> showFieldsDialog(
  BuildContext context, {
  required String title,
  required List<FieldSpec> fields,
  String confirm = '确定',
  String? description,
  double width = 520,
}) {
  return showDialog<List<String>>(
    context: context,
    builder: (_) => _FieldsDialog(title: title, fields: fields, confirm: confirm, description: description, width: width),
  );
}

class _FieldsDialog extends StatefulWidget {
  const _FieldsDialog({required this.title, required this.fields, required this.confirm, required this.description, required this.width});

  final String title;
  final List<FieldSpec> fields;
  final String confirm;
  final String? description;
  final double width;

  @override
  State<_FieldsDialog> createState() => _FieldsDialogState();
}

class _FieldsDialogState extends State<_FieldsDialog> {
  late final _controllers = [for (final f in widget.fields) TextEditingController(text: f.initial)];

  @override
  void dispose() {
    for (final c in _controllers) {
      c.dispose();
    }
    super.dispose();
  }

  bool get _valid => [for (final (i, f) in widget.fields.indexed) !f.required || _controllers[i].text.trim().isNotEmpty].every((ok) => ok);

  void _submit() {
    if (_valid) Navigator.pop(context, [for (final c in _controllers) c.text.trim()]);
  }

  @override
  Widget build(BuildContext context) {
    final mono = context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback);
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: widget.width,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (widget.description != null)
                Padding(padding: const EdgeInsets.only(bottom: AppTokens.pad), child: Text(widget.description!, style: context.text.bodySmall)),
              for (final (i, f) in widget.fields.indexed)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppTokens.gap),
                  child: TextField(
                    controller: _controllers[i],
                    autofocus: i == 0,
                    minLines: f.minLines,
                    maxLines: f.maxLines,
                    style: f.mono ? mono : null,
                    decoration: InputDecoration(labelText: f.label, hintText: f.hint, alignLabelWithHint: f.maxLines > 1),
                    onChanged: (_) => setState(() {}),
                    onSubmitted: f.maxLines == 1 ? (_) => _submit() : null,
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: _valid ? _submit : null, child: Text(widget.confirm)),
      ],
    );
  }
}

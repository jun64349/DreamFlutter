import 'dart:convert';

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
                    if (subtitle != null) ...[const SizedBox(height: 2), Text(subtitle!, style: context.text.bodySmall?.copyWith(color: context.colors.muted))],
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

/// One section in the left panel of a [SectionedPage].
class SideNavItem {
  const SideNavItem(this.label, this.icon, {this.count, this.alert = false});

  final String label;
  final IconData icon;
  final int? count;

  /// Shows the count as a filled badge (things waiting for the user).
  final bool alert;
}

/// The frame of the work pages (tasks, memory, skills), like the desk and
/// the chat: a left panel with the page title, its sections and any filters,
/// and the selected section on the right.
class SectionedPage extends StatelessWidget {
  const SectionedPage({
    super.key,
    required this.title,
    required this.items,
    required this.selected,
    required this.onSelect,
    required this.child,
    this.header,
    this.panel = const [],
  });

  final String title;

  /// Under the title (e.g. the workspace switcher).
  final Widget? header;
  final List<SideNavItem> items;
  final int selected;
  final ValueChanged<int> onSelect;

  /// Extra panel content under the sections (filters...).
  final List<Widget> panel;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          width: AppTokens.sidebarWidth,
          decoration: BoxDecoration(
            border: Border(right: BorderSide(color: colors.border)),
          ),
          // A Material (not a colored box) so list tiles in the panel can paint.
          child: Material(
            color: colors.sidebar,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(10, AppTokens.padLg, 10, AppTokens.padLg),
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Text(title, style: context.serif(context.text.titleMedium).copyWith(fontSize: 18, fontWeight: FontWeight.w600)),
                ),
                if (header != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(6, 6, 6, 0),
                    child: Align(alignment: Alignment.centerLeft, child: header),
                  ),
                const SizedBox(height: AppTokens.pad),
                for (final (i, item) in items.indexed) _SideNavRow(item: item, selected: i == selected, onTap: () => onSelect(i)),
                ...panel,
              ],
            ),
          ),
        ),
        Expanded(child: child),
      ],
    );
  }
}

class _SideNavRow extends StatelessWidget {
  const _SideNavRow({required this.item, required this.selected, required this.onTap});

  final SideNavItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final count = item.count;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? colors.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(context.radius),
        child: InkWell(
          borderRadius: BorderRadius.circular(context.radius),
          onTap: onTap,
          child: SizedBox(
            height: 38,
            child: Row(
              children: [
                const SizedBox(width: 10),
                Icon(item.icon, size: 18, color: selected ? colors.accent : colors.muted),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    item.label,
                    style: context.text.bodyMedium?.copyWith(
                      color: selected ? colors.ink : colors.ink2,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
                if (count != null && (count > 0 || !item.alert))
                  item.alert
                      ? Container(
                          constraints: const BoxConstraints(minWidth: 20),
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(color: colors.seal, borderRadius: BorderRadius.circular(10)),
                          child: Text(
                            '$count',
                            textAlign: TextAlign.center,
                            style: context.text.labelSmall?.copyWith(color: colors.onAccent, fontWeight: FontWeight.w600),
                          ),
                        )
                      : Text('$count', style: context.label),
                const SizedBox(width: 10),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The heading of a section's content: a Song-type title, one line on what
/// the section is for, and its actions.
class ContentHeader extends StatelessWidget {
  const ContentHeader({super.key, required this.title, this.description, this.actions = const []});

  final String title;
  final String? description;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AppTokens.pad, bottom: AppTokens.padLg),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: context.serif(context.text.headlineSmall).copyWith(fontSize: 22, fontWeight: FontWeight.w600)),
                if (description != null) ...[
                  const SizedBox(height: 4),
                  Text(description!, style: context.text.bodySmall?.copyWith(color: context.colors.muted, height: 1.6)),
                ],
              ],
            ),
          ),
          if (actions.isNotEmpty) ...[const SizedBox(width: AppTokens.pad), Wrap(spacing: AppTokens.gap, children: actions)],
        ],
      ),
    );
  }
}

/// A quiet empty state: the butterfly, a line, and what to do next.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.message, this.action});

  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48),
      child: Column(
        children: [
          const ButterflyMark(size: 64),
          const SizedBox(height: AppTokens.pad),
          Text(title, style: context.serif(context.text.titleMedium)),
          if (message != null) ...[
            const SizedBox(height: 6),
            Text(
              message!,
              textAlign: TextAlign.center,
              style: context.text.bodySmall?.copyWith(color: context.colors.muted, height: 1.6),
            ),
          ],
          if (action != null) ...[const SizedBox(height: AppTokens.padLg), action!],
        ],
      ),
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
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth),
              child: child,
            ),
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

/// A small spaced-out label heading a group in a side panel (「写笺 3」),
/// with an optional action at the end.
class PanelLabel extends StatelessWidget {
  const PanelLabel(this.text, {super.key, this.count, this.trailing});

  final String text;
  final int? count;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, AppTokens.pad, 0, 4),
      child: SizedBox(
        height: 28,
        child: Row(
          children: [
            Flexible(
              child: Text(text, style: context.label, overflow: TextOverflow.ellipsis),
            ),
            if (count != null) ...[const SizedBox(width: 6), Text('$count', style: context.label)],
            const Spacer(),
            ?trailing,
          ],
        ),
      ),
    );
  }
}

/// One choice of a filter in a side panel: a small ring that fills when chosen.
class FilterRow extends StatelessWidget {
  const FilterRow({super.key, required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(context.radius),
      onTap: onTap,
      child: SizedBox(
        height: 32,
        child: Row(
          children: [
            const SizedBox(width: 12),
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: selected ? colors.accent : Colors.transparent,
                border: Border.all(color: selected ? colors.accent : colors.muted),
              ),
            ),
            const SizedBox(width: 12),
            Text(label, style: context.text.bodyMedium?.copyWith(color: selected ? colors.ink : colors.muted)),
          ],
        ),
      ),
    );
  }
}

/// A switch with a title and one line of explanation, sized for a side panel.
class PanelSwitch extends StatelessWidget {
  const PanelSwitch({super.key, required this.title, required this.value, required this.onChanged, this.subtitle});

  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      dense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 10),
      title: Text(title, style: context.text.bodyMedium),
      subtitle: subtitle == null ? null : Text(subtitle!, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      value: value,
      onChanged: onChanged,
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
        borderRadius: BorderRadius.circular(context.radius),
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
      decoration: BoxDecoration(color: tint.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(context.radiusSm)),
      child: Text(label, style: context.text.labelSmall?.copyWith(color: tint)),
    );
  }
}

final _decodedImages = <String, MemoryImage>{};

/// The picture for a base64 image, decoded once. Every streamed token rebuilds
/// the conversation, and a fresh [MemoryImage] each time is a new image to the
/// image cache: it was decoded again and blank for a frame (v0.3.2 test: the
/// pictures in the conversation flickered while a reply streamed).
MemoryImage memoryImageOf(String base64) {
  final cached = _decodedImages.remove(base64);
  final image = cached ?? MemoryImage(base64Decode(base64));
  _decodedImages[base64] = image; // most recently used last
  if (_decodedImages.length > 64) _decodedImages.remove(_decodedImages.keys.first);
  return image;
}

/// A picture in full: fits the window, zooms with the wheel or a pinch, closes on a click outside or Esc.
Future<void> showImagePreview(BuildContext context, String base64) => showDialog<void>(
  context: context,
  barrierColor: Colors.black.withValues(alpha: 0.72),
  builder: (context) => Dialog(
    backgroundColor: Colors.transparent,
    insetPadding: const EdgeInsets.all(32),
    child: Stack(
      children: [
        InteractiveViewer(
          maxScale: 6,
          child: Center(child: Image(image: memoryImageOf(base64), gaplessPlayback: true, errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined, color: Colors.white))),
        ),
        Positioned(
          top: 0,
          right: 0,
          child: IconButton.filledTonal(tooltip: '关闭', onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
        ),
      ],
    ),
  ),
);

/// A small picture that opens in full when clicked (0.4, test 32: pictures the agent looked at can be previewed).
class ImageThumb extends StatelessWidget {
  const ImageThumb({super.key, required this.base64, this.height = 72});

  final String base64;
  final double height;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: '点击查看大图',
    child: Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(context.radius),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => showImagePreview(context, base64),
        // Keeps its place (and can be clicked) before the picture is decoded.
        child: ConstrainedBox(
          constraints: BoxConstraints(minWidth: height * 0.75, minHeight: height),
          child: Image(
          image: memoryImageOf(base64),
          gaplessPlayback: true,
          height: height,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined),
        ),
        ),
      ),
    ),
  );
}

/// Whether a file drop target at [context] is on screen. A drop target hears
/// every drop on the window, wherever it is, so the pages kept alive behind the
/// shown one (the IndexedStacks of the navigation and of 蝶君) and the pages
/// under a pushed route must not take them (v0.3.2 test: images dropped on the
/// workbench also turned up in 蝶君's input box).
bool showsOnScreen(BuildContext context) => Visibility.of(context) && (ModalRoute.of(context)?.isCurrent ?? true);

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
      actions: [
        ...actions,
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
      ],
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
                Padding(
                  padding: const EdgeInsets.only(bottom: AppTokens.pad),
                  child: Text(widget.description!, style: context.text.bodySmall),
                ),
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

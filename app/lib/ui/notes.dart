import 'dart:async';

import 'package:flutter/material.dart';

import '../theme.dart';

/// Every short notice in one style (user 2026-11-17, prototype
/// docs/design/prototype/toast-proposal.html): a paper note at the top of the
/// conversation column, as wide as its words, a dot for its state, at most one
/// action. A new note replaces the current one.
enum NoteKind { done, info, fail }

class Note {
  Note(this.text, {this.kind = NoteKind.done, this.action, this.onAction, this.brief = false});
  final String text;
  final NoteKind kind;
  final String? action;
  final VoidCallback? onAction;
  /// A confirmation of something the user just did there (「已复制」): leaves sooner.
  final bool brief;

  /// Failures stay until closed; others leave on their own (hover holds them).
  Duration? get lifetime => kind == NoteKind.fail
      ? null
      : action != null
          ? const Duration(seconds: 6)
          : brief
              ? const Duration(milliseconds: 1600)
              : const Duration(seconds: 3);
}

/// The note on screen now (null = none). Read by [NoteLayer]; tests read it too.
final ValueNotifier<Note?> currentNote = ValueNotifier<Note?>(null);

/// Shows [text] as the note, replacing any other.
void showNote(String text, {NoteKind kind = NoteKind.done, String? action, VoidCallback? onAction, bool brief = false}) {
  currentNote.value = Note(text, kind: kind, action: action, onAction: onAction, brief: brief);
}

/// A failure note: stays until closed.
void showFailure(String text) => showNote(text, kind: NoteKind.fail);

/// Kind of a message the controller pushes without saying (its toasts): failures by their words.
NoteKind noteKindOf(String text) =>
    RegExp(r'失败|没能|无法|没有发出|读不到|不在了|还未准备好|还没结束|打不开|未保存').hasMatch(text) ? NoteKind.fail : NoteKind.info;

/// Marks the column notes are centred on (the conversation column).
final GlobalKey noteAnchorKey = GlobalKey(debugLabel: 'note-anchor');

/// A MaterialApp.builder that puts the note layer above every page and route (the app and widget tests).
Widget withNoteLayer(BuildContext context, Widget? child) =>
    Stack(fit: StackFit.expand, children: [child ?? const SizedBox.shrink(), const Positioned.fill(child: NoteLayer())]);

/// Above the whole window (in MaterialApp.builder): shows [currentNote].
class NoteLayer extends StatefulWidget {
  const NoteLayer({super.key});
  @override
  State<NoteLayer> createState() => _NoteLayerState();
}

class _NoteLayerState extends State<NoteLayer> with SingleTickerProviderStateMixin {
  late final AnimationController _motion = AnimationController(vsync: this, duration: const Duration(milliseconds: 160), reverseDuration: const Duration(milliseconds: 140));
  Note? _shown;
  Timer? _timer;
  bool _hovered = false;

  @override
  void initState() {
    super.initState();
    currentNote.addListener(_changed);
    if (currentNote.value != null) WidgetsBinding.instance.addPostFrameCallback((_) => _changed());
  }

  @override
  void dispose() {
    currentNote.removeListener(_changed);
    _timer?.cancel();
    _motion.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    final note = currentNote.value;
    _timer?.cancel();
    if (note == null) {
      _motion.reverse().whenComplete(() { if (mounted && currentNote.value == null) setState(() => _shown = null); });
      return;
    }
    setState(() => _shown = note);
    _motion.forward(from: MediaQuery.maybeDisableAnimationsOf(context) == true ? 1 : 0);
    _arm();
  }

  void _arm() {
    _timer?.cancel();
    final life = _shown?.lifetime;
    if (life == null || _hovered) return;
    final note = _shown;
    _timer = Timer(life, () { if (identical(currentNote.value, note)) currentNote.value = null; });
  }

  void _close() { if (identical(currentNote.value, _shown)) currentNote.value = null; }

  @override
  Widget build(BuildContext context) {
    final note = _shown;
    if (note == null) return const SizedBox.shrink();
    return LayoutBuilder(builder: (context, box) {
      // Centre on the conversation column when it is on screen, else on the window.
      var left = 0.0, width = box.maxWidth, top = 52.0;
      final anchor = noteAnchorKey.currentContext?.findRenderObject();
      final me = context.findRenderObject();
      if (anchor is RenderBox && anchor.attached && me is RenderBox && me.attached) {
        final origin = anchor.localToGlobal(Offset.zero) - me.localToGlobal(Offset.zero);
        left = origin.dx; width = anchor.size.width; top = origin.dy + 52;
      }
      final fade = CurvedAnimation(parent: _motion, curve: AppTokens.curve);
      return Stack(children: [
        Positioned(left: left, width: width, top: top, child: Center(child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: FadeTransition(opacity: fade, child: SlideTransition(
            position: Tween(begin: const Offset(0, -.25), end: Offset.zero).animate(fade),
            child: MouseRegion(
              onEnter: (_) { _hovered = true; _timer?.cancel(); },
              onExit: (_) { _hovered = false; _arm(); },
              child: NoteCard(note: note, onClose: _close),
            ),
          )),
        ))),
      ]);
    });
  }
}

class NoteCard extends StatelessWidget {
  const NoteCard({super.key, required this.note, required this.onClose});
  final Note note;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final style = context.serif(TextStyle(fontSize: 13.5, height: 1.55, color: colors.ink));
    final dot = switch (note.kind) { NoteKind.done => colors.success, NoteKind.info => colors.muted, NoteKind.fail => colors.seal };
    final fail = note.kind == NoteKind.fail;
    final text = Text(note.text, style: style);
    return Semantics(
      liveRegion: true,
      container: true,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Material(
          type: MaterialType.transparency,
          child: Container(
            key: const ValueKey('note'),
            padding: const EdgeInsets.fromLTRB(12, 8, 14, 8),
            decoration: BoxDecoration(
              color: colors.card,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: fail ? Color.lerp(colors.border, colors.seal, .45)! : colors.border),
              boxShadow: [
                BoxShadow(color: Colors.black.withValues(alpha: Theme.of(context).brightness == Brightness.dark ? .45 : .14), blurRadius: 40, offset: const Offset(0, 12)),
                BoxShadow(color: Colors.black.withValues(alpha: Theme.of(context).brightness == Brightness.dark ? .2 : .06), blurRadius: 6, offset: const Offset(0, 2)),
              ],
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(width: 6, height: 6, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
              const SizedBox(width: 10),
              // Failures can be selected and copied (their detail matters).
              Flexible(child: fail ? SelectionArea(child: text) : text),
              if (note.action != null) ...[
                const SizedBox(width: 10),
                InkWell(
                  borderRadius: BorderRadius.circular(6),
                  onTap: () { onClose(); note.onAction?.call(); },
                  child: Padding(padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2), child: Text(note.action!, style: style.copyWith(color: colors.accent))),
                ),
              ],
              if (fail) ...[
                const SizedBox(width: 6),
                Tooltip(message: '关闭', child: InkWell(
                  borderRadius: BorderRadius.circular(6),
                  onTap: onClose,
                  child: SizedBox(width: 20, height: 20, child: Icon(Icons.close, size: 14, color: colors.muted)),
                )),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}

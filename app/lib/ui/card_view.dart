import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'web_surface.dart';

String _hex(Color c) => '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

/// The theme variables cards get from this window.
Map<String, String> themeVarsOf(BuildContext context) {
  final c = context.colors;
  return cardThemeVars(
    fg: _hex(c.ink),
    muted: _hex(c.muted),
    bg: _hex(c.background),
    surface: _hex(c.card),
    border: _hex(Color.alphaBlend(c.border, c.card)),
    accent: _hex(c.accent),
    chart: [c.accent, c.ochre, c.seal, const Color(0xFF4F7A8A), const Color(0xFFC9A14A), const Color(0xFF8C5D8F)].map(_hex).toList(),
    dark: Theme.of(context).brightness == Brightness.dark,
  );
}

String themeCssOf(Map<String, String> vars) => ':root{${vars.entries.map((e) => '${e.key}:${e.value}').join(';')}}';

/// A card the agent showed, inside a reply: title bar with actions, the card below.
class CardBlock extends StatefulWidget {
  const CardBlock({super.key, required this.run});

  final ToolRun run;

  @override
  State<CardBlock> createState() => _CardBlockState();
}

class _CardBlockState extends State<CardBlock> {
  CardInfo? _card;
  String? _error;
  String? _loadedFor;
  StreamSubscription<Json>? _events;

  String? get _cardId => widget.run.details['cardId'] as String?;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _events ??= AgentScope.read(context).backend.events.listen((event) {
      if (event['event'] == 'card.changed' && event['card'] is Map && (event['card'] as Map)['id'] == _cardId) {
        if (mounted) setState(() => _card = CardInfo.fromJson((event['card'] as Map).cast()));
      } else if (event['event'] == 'card.removed' && event['cardId'] == _cardId) {
        if (mounted) setState(() => _error = '这张卡片已经随对话删除了。');
      }
    });
    _load();
  }

  @override
  void didUpdateWidget(CardBlock old) {
    super.didUpdateWidget(old);
    _load();
  }

  @override
  void dispose() {
    _events?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final id = _cardId;
    if (id == null || id == _loadedFor) return;
    _loadedFor = id;
    try {
      final card = CardInfo.fromJson(asJsonMap(await AgentScope.read(context).backend.call('cards.get', {'id': id})));
      if (mounted) setState(() => _card = card);
    } catch (e) {
      if (mounted) setState(() => _error = '卡片打不开：${SessionRuntime.describeError(e)}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final run = widget.run;
    final title = _card?.title ?? (run.args['title'] as String?) ?? '卡片';
    if (run.isActive) {
      return _Frame(title: title, child: _Placeholder(icon: Icons.auto_awesome_outlined, text: '正在制作卡片「$title」…'));
    }
    if (_cardId == null) {
      return _Frame(title: title, child: _Placeholder(icon: Icons.error_outline, text: run.outputText.isEmpty ? '卡片没有做出来。' : run.outputText, color: colors.danger));
    }
    final card = _card;
    if (card == null) return _Frame(title: title, child: _Placeholder(icon: Icons.hourglass_empty, text: _error ?? '正在打开…'));
    return _Frame(title: card.title, actions: CardActions(card: card), child: CardView(card: card));
  }
}

class _Frame extends StatelessWidget {
  const _Frame({required this.title, required this.child, this.actions});

  final String title;
  final Widget child;
  final Widget? actions;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(context.radiusLg),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
            child: Row(
              children: [
                Icon(Icons.style_outlined, size: 15, color: colors.ochre),
                const SizedBox(width: 6),
                Expanded(child: Text(title, style: context.text.labelLarge, overflow: TextOverflow.ellipsis)),
                ?actions,
              ],
            ),
          ),
          Divider(height: 1, color: colors.border),
          child,
        ],
      ),
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.icon, required this.text, this.color});

  final IconData icon;
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 96,
    child: Center(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 18, color: color ?? context.colors.muted),
          const SizedBox(width: 8),
          Flexible(child: Text(text, style: context.text.bodySmall?.copyWith(color: color ?? context.colors.muted))),
        ],
      ),
    ),
  );
}

/// The menu on a card: enlarge, pin to the desk, export, permissions.
class CardActions extends StatelessWidget {
  const CardActions({super.key, required this.card, this.onDeleted});

  final CardInfo card;
  final VoidCallback? onDeleted;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          tooltip: '放大',
          iconSize: 16,
          visualDensity: VisualDensity.compact,
          onPressed: () => showCardDialog(context, card),
          icon: const Icon(Icons.open_in_full),
        ),
        PopupMenuButton<String>(
          tooltip: '更多',
          iconSize: 18,
          icon: const Icon(Icons.more_horiz),
          onSelected: (action) => _act(context, action),
          itemBuilder: (_) => [
            // The desk is 蝶君's 「工作」 now: cards are kept from its conversations.
            if (!card.resident && AgentScope.read(context).sandbox) const PopupMenuItem(value: 'pin', child: Text('收进「工作」')),
            const PopupMenuItem(value: 'export', child: Text('导出…')),
            const PopupMenuItem(value: 'grants', child: Text('权限')),
            const PopupMenuItem(value: 'reload', child: Text('重新载入')),
            if (card.resident) const PopupMenuItem(value: 'delete', child: Text('从「工作」删除')),
          ],
        ),
      ],
    );
  }

  Future<void> _act(BuildContext context, String action) async {
    final agent = AgentScope.read(context);
    final messenger = ScaffoldMessenger.of(context);
    void snack(String text) => messenger.showSnackBar(SnackBar(content: Text(text)));
    try {
      switch (action) {
        case 'pin':
          await agent.backend.call('cards.pin', {'id': card.id, 'cwd': agent.workspace});
          agent.workRevision.value++;
          snack('已收进「工作」：复制了一份，之后与对话里的这张互不影响。');
        case 'export':
          if (!context.mounted) return;
          await exportCard(context, card);
        case 'grants':
          if (!context.mounted) return;
          await showCardGrants(context, card);
        case 'reload':
          agent.cardStage.reload(card.id);
        case 'delete':
          if (!context.mounted) return;
          if (await confirmAction(context, title: '删除这张卡片？', message: '「${card.title}」和它保存的数据会被删除。', confirm: '删除', danger: true)) {
            await agent.backend.call('cards.delete', {'id': card.id});
            agent.workRevision.value++;
            onDeleted?.call();
          }
      }
    } catch (e) {
      snack('操作失败：${SessionRuntime.describeError(e)}');
    }
  }
}

/// Export (Showcard §6.3, §6.8: tell the user the data goes along).
Future<void> exportCard(BuildContext context, CardInfo card) async {
  final agent = AgentScope.read(context);
  final messenger = ScaffoldMessenger.of(context);
  final theme = themeVarsOf(context);
  final ok = await confirmAction(
    context,
    title: '导出卡片',
    message: '「${card.title}」会存成一个文件，可以用浏览器直接打开，也可以导入到别的支持 Showcard 的应用。\n\n卡片当前保存的数据会一起带出去。',
    confirm: '选择位置…',
  );
  if (!ok) return;
  final name = asJsonMap(await agent.backend.call('cards.exportName', {'id': card.id}))['name'] as String? ?? '${card.title}.card.html';
  final location = await getSaveLocation(
    suggestedName: name,
    acceptedTypeGroups: [XTypeGroup(label: 'Showcard', extensions: [name.endsWith('.zip') ? 'zip' : 'html'])],
  );
  if (location == null) return;
  final result = asJsonMap(await agent.backend.call('cards.export', {'id': card.id, 'path': location.path, 'theme': theme}));
  messenger.showSnackBar(SnackBar(content: Text('已导出到 ${result['path']}')));
}

/// Remembered permissions of a card, each revocable (§3.3), and what it declares.
Future<void> showCardGrants(BuildContext context, CardInfo card) {
  return showDialog<void>(context: context, builder: (_) => _GrantsDialog(card: card));
}

class _GrantsDialog extends StatefulWidget {
  const _GrantsDialog({required this.card});

  final CardInfo card;

  @override
  State<_GrantsDialog> createState() => _GrantsDialogState();
}

class _GrantsDialogState extends State<_GrantsDialog> {
  List<CardGrant>? _grants;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final rows = await AgentScope.read(context).backend.call('cards.grants', {'id': widget.card.id});
    if (mounted) setState(() => _grants = [for (final r in (rows as List? ?? const [])) if (r is Map) CardGrant.fromJson(r.cast())]);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final grants = _grants;
    return AlertDialog(
      title: Text('「${widget.card.title}」的权限'),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('已允许', style: context.label),
              const SizedBox(height: 6),
              if (grants == null)
                const LinearProgressIndicator()
              else if (grants.isEmpty)
                Text('还没有允许过任何操作。', style: context.text.bodySmall?.copyWith(color: colors.muted))
              else
                for (final g in grants)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text('${g.unit.kindLabel}：${g.unit.subject}'),
                    subtitle: Text(g.scope == 'always' ? '始终允许' : '本次会话内（后台重启后失效）'),
                    trailing: TextButton(
                      onPressed: () async {
                        await AgentScope.read(context).backend.call('cards.revoke', {'id': widget.card.id, 'kind': g.unit.kind, 'subject': g.unit.subject});
                        await _load();
                      },
                      child: const Text('撤销'),
                    ),
                  ),
              const SizedBox(height: 14),
              Text('这张卡片声明的工具', style: context.label),
              const SizedBox(height: 6),
              if (widget.card.bindings.isEmpty)
                Text('没有。它只在自己的页面里运行，不能调用任何工具。', style: context.text.bodySmall?.copyWith(color: colors.muted))
              else
                for (final b in widget.card.bindings)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text(
                      '${b.description ?? b.id} · ${b.known ? b.label : '本应用没有 ${b.tool}'}'
                      '${b.units.isEmpty ? '' : '（${b.units.map((u) => '${u.kindLabel} ${u.subject}').join('、')}）'}',
                      style: context.text.bodySmall,
                    ),
                  ),
            ],
          ),
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    );
  }
}

/// A card enlarged in a dialog (its own live instance, filling the frame).
Future<void> showCardDialog(BuildContext context, CardInfo card) {
  final agent = AgentScope.read(context);
  agent.cardStage.touch(card.id);
  return showDialog<void>(
    context: context,
    builder: (context) {
      final size = MediaQuery.sizeOf(context);
      return Dialog(
        insetPadding: const EdgeInsets.all(32),
        child: SizedBox(
          width: (card.preferredWidth ?? 960).clamp(360, size.width - 64),
          height: size.height - 64,
          child: _Frame(
            title: card.title,
            actions: IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close, size: 18), tooltip: '关闭'),
            child: Expanded(child: CardView(card: card, forceLive: true, sizing: 'viewport')),
          ),
        ),
      );
    },
  ).whenComplete(() => agent.cardStage.reload(card.id));
}

/// A card: a live WebView when it is one of the live cards (or [forceLive]),
/// else its last picture; clicking a picture makes it live.
class CardView extends StatefulWidget {
  const CardView({super.key, required this.card, this.forceLive = false, this.sizing = 'content'});

  final CardInfo card;
  final bool forceLive;

  /// content: height follows the card (chat); viewport: fills the frame (Showcard §1.7).
  final String sizing;

  @override
  State<CardView> createState() => _CardViewState();
}

class _CardViewState extends State<CardView> {
  static const _maxHeight = 900.0;
  static const _minHeight = 48.0;

  WebSurface? _surface;
  bool _starting = false;
  bool _unavailable = false;
  bool _loaded = false;
  late double _height = (widget.card.height ?? 220).clamp(_minHeight, _maxHeight);
  final _repaintKey = GlobalKey();
  StreamSubscription<Map<String, dynamic>>? _messages;
  Timer? _captureTimer;
  Timer? _heightTimer;
  final Set<String> _askedHosts = {};
  CardStage? _stage;
  int _reloadSeen = 0;
  Uint8List? _picture;
  Map<String, String> _themeVars = const {};

  bool get _live => widget.forceLive || (_stage?.isLive(widget.card.id) ?? false);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final stage = AgentScope.read(context).cardStage;
    if (_stage != stage) {
      _stage?.removeListener(_onStage);
      _stage = stage..addListener(_onStage);
    }
    final vars = themeVarsOf(context);
    if (!mapEquals(vars, _themeVars)) {
      _themeVars = vars;
      _surface?.post({'type': 'df:theme', 'css': themeCssOf(vars)});
    }
    _sync();
  }

  @override
  void didUpdateWidget(CardView old) {
    super.didUpdateWidget(old);
    if (old.card.version != widget.card.version && _surface != null) _surface!.post({'type': 'shell:reload'});
    _sync();
  }

  void _onStage() {
    final stage = _stage!;
    // The enlarged instance is the one that asks others to reload; it never reloads itself.
    if (!widget.forceLive && stage.reloadCount(widget.card.id) != _reloadSeen) {
      _reloadSeen = stage.reloadCount(widget.card.id);
      _surface?.post({'type': 'shell:reload'});
    }
    _sync();
    if (mounted) setState(() {});
  }

  void _sync() {
    if (_live && _surface == null && !_starting && !_unavailable) {
      unawaited(_start());
    } else if (!_live && _surface != null) {
      unawaited(_stop());
    }
    if (!_live && _picture == null) unawaited(_loadPicture());
  }

  Future<void> _start() async {
    _starting = true;
    final agent = AgentScope.read(context);
    final surface = await WebSurfaces.create();
    if (!mounted || !_live) {
      await surface?.dispose();
      _starting = false;
      return;
    }
    if (surface == null) {
      setState(() {
        _unavailable = true;
        _starting = false;
      });
      return;
    }
    _messages = surface.messages.listen(_onMessage);
    try {
      final opened = asJsonMap(await agent.backend.call('cards.open', {'id': widget.card.id, 'theme': _themeVars, 'sizing': widget.sizing}));
      await surface.load(opened['url'] as String);
    } catch (_) {
      await surface.dispose();
      _starting = false;
      if (mounted) setState(() => _unavailable = true);
      return;
    }
    _reloadSeen = _stage?.reloadCount(widget.card.id) ?? 0;
    if (!mounted) {
      await surface.dispose();
      return;
    }
    setState(() {
      _surface = surface;
      _starting = false;
    });
  }

  Future<void> _stop() async {
    final surface = _surface;
    if (surface == null) return;
    await _capture();
    _surface = null;
    _loaded = false;
    await _messages?.cancel();
    await surface.dispose();
    if (mounted) setState(() {});
  }

  Future<void> _loadPicture() async {
    final stage = _stage;
    if (stage == null) return;
    final cached = stage.snapshot(widget.card.id, widget.card.snapshotAt ?? 0);
    if (cached != null) {
      setState(() => _picture = cached);
      return;
    }
    if (widget.card.snapshotAt == null) return;
    try {
      final data = asJsonMap(await AgentScope.read(context).backend.call('cards.snapshot', {'id': widget.card.id}))['png'];
      if (data is String && mounted) {
        final png = base64Decode(data);
        stage.putSnapshot(widget.card.id, widget.card.snapshotAt ?? 0, png);
        setState(() => _picture = png);
      }
    } catch (_) {}
  }

  Future<void> _onMessage(Map<String, dynamic> message) async {
    final agent = AgentScope.read(context);
    switch (message['type']) {
      case 'shell:loaded':
        _loaded = true;
        _scheduleCapture();
      case 'df:resize':
        final h = (message['height'] as num?)?.toDouble();
        if (h == null || widget.sizing == 'viewport') return;
        final next = h.clamp(_minHeight, _maxHeight);
        if ((next - _height).abs() >= 1 && mounted) {
          setState(() => _height = next);
          _heightTimer?.cancel();
          _heightTimer = Timer(const Duration(seconds: 1), () => agent.backend.call('cards.setHeight', {'id': widget.card.id, 'height': next}).ignore());
        }
        _scheduleCapture();
      case 'df:csp':
        await _askDirectNetwork(message['blockedURI'] as String? ?? '');
      case 'card:request':
        final requestId = message['requestId'];
        final envelope = await _answer(message['capability'], message['payload']);
        await _surface?.post({'type': 'card:response', 'requestId': requestId, ...envelope});
        _scheduleCapture();
    }
  }

  /// One card request through the core; questions go to the user first (§3.2).
  Future<Map<String, Object?>> _answer(Object? capability, Object? payload) async {
    final agent = AgentScope.read(context);
    final params = <String, Object?>{'id': widget.card.id, 'capability': capability, 'payload': payload, if (!agent.cardStage.armed(widget.card.id)) 'armed': false};
    try {
      var reply = asJsonMap(await agent.backend.call('cards.request', params, const Duration(minutes: 2)));
      final ask = reply['ask'];
      if (ask is Map) {
        final question = CardQuestion(ask.cast());
        final grant = mounted ? await askCardPermission(context, widget.card, question) : 'deny';
        reply = asJsonMap(
          await agent.backend.call('cards.request', {
            ...params,
            'answer': {'grant': grant, 'epoch': question.epoch, 'digest': question.digest},
          }, const Duration(minutes: 2)),
        );
      }
      return reply;
    } catch (e) {
      return {'ok': false, 'code': 'CARD_HOST_TOOL_FAILED', 'error': SessionRuntime.describeError(e), 'result': <String, Object?>{}};
    }
  }

  /// A direct request to a host the card may not reach yet (§3.5): ask once per host,
  /// and on yes reload so the next load carries it.
  Future<void> _askDirectNetwork(String blocked) async {
    final uri = Uri.tryParse(blocked);
    if (uri == null || uri.scheme != 'https' || uri.host.isEmpty || !_askedHosts.add(uri.host)) return;
    final agent = AgentScope.read(context);
    final question = CardQuestion({
      'kind': 'net',
      'subject': uri.host,
      'label': '直接访问网络',
      'tool': 'fetch',
      'call': '卡片自己的页面向 ${uri.host} 发起请求（例如加载图片、数据）。允许后从下一次载入开始生效。',
      'origin': widget.card.origin,
    });
    final grant = await askCardPermission(context, widget.card, question);
    if (grant == 'deny') return;
    await agent.backend.call('cards.grant', {'id': widget.card.id, 'kind': 'net', 'subject': uri.host, 'scope': grant});
    await _surface?.post({'type': 'shell:reload'});
  }

  void _scheduleCapture() {
    _captureTimer?.cancel();
    _captureTimer = Timer(const Duration(milliseconds: 1500), () => unawaited(_capture()));
  }

  Future<void> _capture() async {
    if (!_loaded || widget.sizing == 'viewport') return;
    final png = await WebSurfaces.capture(_repaintKey);
    if (png == null || png.length < 200 || !mounted) return;
    final agent = AgentScope.read(context);
    final stamp = DateTime.now().millisecondsSinceEpoch;
    agent.cardStage.putSnapshot(widget.card.id, stamp, png);
    _picture = png;
    unawaited(agent.backend.call('cards.saveSnapshot', {'id': widget.card.id, 'png': base64Encode(png), 'height': _height}).catchError((_) => null));
  }

  @override
  void dispose() {
    _stage?.removeListener(_onStage);
    _captureTimer?.cancel();
    _heightTimer?.cancel();
    _messages?.cancel();
    final surface = _surface;
    _surface = null;
    if (surface != null) unawaited(surface.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final width = widget.card.preferredWidth;
    Widget body;
    if (_unavailable) {
      body = _Placeholder(icon: Icons.web_asset_off_outlined, text: '这台电脑缺少 Microsoft Edge WebView2 运行库，无法显示卡片。');
    } else if (_live && _surface != null) {
      body = Listener(
        onPointerDown: (_) => _stage?.touch(widget.card.id),
        onPointerUp: (_) => _scheduleCapture(),
        child: _surface!.view(repaintKey: _repaintKey),
      );
    } else {
      final picture = _picture;
      body = Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: _live ? null : () => _stage?.activate(widget.card.id),
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (picture != null) Image.memory(picture, fit: BoxFit.fitWidth, alignment: Alignment.topCenter, gaplessPlayback: true),
              if (!_live)
                Align(
                  alignment: Alignment.bottomRight,
                  child: Container(
                    margin: const EdgeInsets.all(8),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(color: colors.card.withValues(alpha: 0.92), borderRadius: BorderRadius.circular(context.radius), border: Border.all(color: colors.border)),
                    child: Text(picture == null ? '点一下打开卡片' : '点一下激活', style: context.text.labelSmall?.copyWith(color: colors.muted)),
                  ),
                )
              else
                const Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
            ],
          ),
        ),
      );
    }
    if (widget.sizing == 'viewport') return body;
    return Align(
      alignment: Alignment.topLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: width ?? double.infinity),
        child: AnimatedSize(duration: AppTokens.fast, child: SizedBox(height: _height, width: double.infinity, child: body)),
      ),
    );
  }
}

bool mapEquals(Map<String, String> a, Map<String, String> b) => a.length == b.length && a.entries.every((e) => b[e.key] == e.value);

Future<void> _questions = Future.value();

/// Asks the user before a card's binding runs (Showcard §3.2, §4.6): the
/// complete call, once / this session / always, or no. One question at a time.
Future<String> askCardPermission(BuildContext context, CardInfo card, CardQuestion question) {
  final completer = Completer<String>();
  _questions = _questions.then((_) async {
    if (!context.mounted) return completer.complete('deny');
    final answer = await showDialog<String>(context: context, barrierDismissible: false, builder: (_) => _PermissionDialog(card: card, question: question));
    completer.complete(answer ?? 'deny');
  });
  return completer.future;
}

class _PermissionDialog extends StatelessWidget {
  const _PermissionDialog({required this.card, required this.question});

  final CardInfo card;
  final CardQuestion question;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final unit = question.unit;
    return AlertDialog(
      title: Text('卡片「${card.title}」想要${question.label}'),
      content: SizedBox(
        width: 520,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${unit.kindLabel}：${unit.subject}', style: context.text.titleSmall),
            if (question.description != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('卡片的说明：${question.description}', style: context.text.bodySmall)),
            const SizedBox(height: 10),
            Text('将要执行', style: context.label),
            const SizedBox(height: 4),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(context.radius)),
              child: SelectableText(question.call, style: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12.5, color: colors.ink)),
            ),
            if (question.danger) ...[
              const SizedBox(height: 10),
              _Warning(text: '注意：这张卡片既能读取这台电脑上的文件，又能向外发送数据。两样一起，就可能把文件内容发出去。只在你信任它时允许。', color: colors.danger),
            ],
            if (question.imported) ...[
              const SizedBox(height: 10),
              _Warning(text: '这是导入的卡片，不是这里的 Agent 做的。', color: colors.warning),
            ],
            const SizedBox(height: 10),
            Text('「本次会话内」：直到 DreamFlutter 后台下次重启。允许过的项目可以在卡片菜单的「权限」里撤销。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, 'deny'), child: const Text('不允许')),
        TextButton(onPressed: () => Navigator.pop(context, 'once'), child: const Text('只这一次')),
        TextButton(onPressed: () => Navigator.pop(context, 'session'), child: const Text('本次会话内')),
        FilledButton(onPressed: () => Navigator.pop(context, 'always'), child: const Text('始终允许')),
      ],
    );
  }
}

class _Warning extends StatelessWidget {
  const _Warning({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(color: color.withValues(alpha: 0.08), border: Border.all(color: color.withValues(alpha: 0.4)), borderRadius: BorderRadius.circular(context.radius)),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.warning_amber_rounded, size: 16, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: context.text.bodySmall?.copyWith(color: color))),
      ],
    ),
  );
}

/// A resident card on the desk: its last picture and title; opens live in a dialog.
class DeskCardTile extends StatefulWidget {
  const DeskCardTile({super.key, required this.card, required this.onChanged});

  final CardInfo card;
  final VoidCallback onChanged;

  @override
  State<DeskCardTile> createState() => _DeskCardTileState();
}

class _DeskCardTileState extends State<DeskCardTile> {
  Uint8List? _picture;

  @override
  void initState() {
    super.initState();
    _loadPicture();
  }

  @override
  void didUpdateWidget(DeskCardTile old) {
    super.didUpdateWidget(old);
    if (old.card.snapshotAt != widget.card.snapshotAt) _loadPicture();
  }

  Future<void> _loadPicture() async {
    if (widget.card.snapshotAt == null) return;
    try {
      final data = asJsonMap(await AgentScope.read(context).backend.call('cards.snapshot', {'id': widget.card.id}))['png'];
      if (data is String && mounted) setState(() => _picture = base64Decode(data));
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final card = widget.card;
    final picture = _picture;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () async {
          await showCardDialog(context, card);
          widget.onChanged();
        },
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (picture != null)
              SizedBox(height: 120, child: Image.memory(picture, fit: BoxFit.cover, alignment: Alignment.topCenter))
            else
              Container(height: 56, color: colors.codeBackground, child: Icon(Icons.style_outlined, color: colors.muted)),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 2, 0, 2),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(card.title, style: context.text.bodyMedium, maxLines: 1, overflow: TextOverflow.ellipsis),
                        Text(card.origin == 'import' ? '导入' : '从对话收藏', style: context.text.labelSmall?.copyWith(color: colors.muted)),
                      ],
                    ),
                  ),
                  CardActions(card: card, onDeleted: widget.onChanged),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

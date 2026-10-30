import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';

enum ConnectionStatus {
  /// Opening the session in the core (or waiting on its trust prompt).
  starting,
  ready,

  /// The session or the core went away; [SessionRuntime.statusDetail] says why.
  crashed,

  /// The core could not be started (Node.js or the core files are missing).
  missingRuntime,
}

/// Versions of one user message: an edited and resent message is a sibling of
/// the original in Pi's session tree (`df_branches` in the core).
class MessageBranch {
  const MessageBranch({required this.entryId, required this.index, required this.total, required this.targets});

  factory MessageBranch.fromJson(Json json) => MessageBranch(
    entryId: json['entryId'] as String? ?? '',
    index: (json['index'] as num?)?.toInt() ?? 0,
    total: (json['total'] as num?)?.toInt() ?? 1,
    targets: (json['targets'] as List? ?? const []).whereType<String>().toList(),
  );

  final String entryId;

  /// 0-based position among the versions, oldest first.
  final int index;
  final int total;

  /// Where to navigate to show each version (its latest continuation).
  final List<String> targets;
}

/// Opens or attaches to a session. The real one runs it in the core; tests
/// substitute a fake Pi.
typedef ClientLauncher = LaunchedSession Function(SessionTarget target);

/// One session hosted by the core and what this window shows of it:
/// transcript, model and thinking selection, stats. Several runtimes can live
/// side by side, so a session keeps running in the background while the user
/// works in another, and closing the window leaves it running in the core.
class SessionRuntime extends ChangeNotifier {
  SessionRuntime({
    required this.workspace,
    required this.launch,
    required this.onToast,
    this.onSettled,
    this.onAttention,
    this.onModelChosen,
    this.onThinkingChosen,
    this.incognito = false,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now,
       lastActivity = (clock ?? DateTime.now)();

  /// The agent's working directory.
  final String workspace;

  /// Temporary chat: kept in memory only, never saved, indexed or remembered.
  final bool incognito;
  final ClientLauncher launch;
  final DateTime Function() _clock;
  final void Function(String message) onToast;

  /// Called after every run settles (used for unread markers and list refresh).
  final void Function(SessionRuntime runtime)? onSettled;

  /// Called when an extension dialog needs the user's answer.
  final void Function(SessionRuntime runtime, ExtensionUiRequest request)? onAttention;

  /// The user picked a model / thinking level; it becomes the default for new sessions.
  final void Function(PiModel model)? onModelChosen;
  final void Function(String level)? onThinkingChosen;

  PiRpcClient? _client;
  LaunchedSession? _launched;
  StreamSubscription<PiEvent>? _eventSub;
  StreamSubscription<ExtensionUiRequest>? _uiSub;
  Timer? _notifyTimer;
  var _disposed = false;

  final transcript = Transcript();
  ConnectionStatus status = ConnectionStatus.starting;
  String statusDetail = '';
  SessionState? state;
  List<PiModel> models = const [];
  List<String> thinkingLevels = const [];
  SessionStats stats = SessionStats.empty;

  /// Extension commands, prompt templates and skills, runnable as `/name`.
  List<SlashCommand> commands = const [];

  /// Extension dialogs waiting for an answer, oldest first.
  final List<ExtensionUiRequest> pendingDialogs = [];

  /// Status texts and widget lines published by extensions, by key.
  final Map<String, String> extensionStatuses = {};
  final Map<String, List<String>> extensionWidgets = {};

  /// Text an extension (or a fork) asked to place in the input box. The
  /// composer consumes it when [editorTextRevision] changes.
  String editorText = '';
  int editorTextRevision = 0;

  /// True while a manual compaction requested from the GUI is in progress.
  bool isCompacting = false;

  /// Why the last manual compaction failed, in plain words (null if it worked).
  String? lastCompactionError;

  /// Last time this session did or received something; drives idle cleanup.
  DateTime lastActivity;

  bool get isRunning => transcript.isRunning;
  bool get isReady => status == ConnectionStatus.ready;
  bool get isDisposed => _disposed;

  /// Versions of the user messages on the active branch, oldest first.
  List<MessageBranch> branches = const [];

  /// The core slot hosting this session (null for test doubles).
  String? get slotId => _launched?.slotId?.call();

  /// Session file path. Pi assigns it when the session is created, before the
  /// file is first written.
  String? get sessionPath => state?.sessionFile;

  /// A session nobody has typed into yet.
  bool get isPristine => transcript.items.isEmpty && !isRunning;

  PiModel? get model => state?.model;
  String get thinkingLevel => state?.thinkingLevel ?? 'off';

  String get title {
    final name = state?.sessionName;
    if (name != null && name.trim().isNotEmpty) return name;
    final firstUser = transcript.items.whereType<UserItem>().firstOrNull;
    return firstUser == null ? '新会话' : firstUser.text.replaceAll(RegExp(r'\s+'), ' ').trim();
  }

  // --- Lifecycle -----------------------------------------------------------

  /// Opens a new session, [sessionPath] to resume one, or attaches to the
  /// live core slot [attachSlotId] (a session that kept running while no
  /// window was open). The core applies the default model to new sessions.
  Future<void> start({String? sessionPath, String? attachSlotId}) async {
    await _stopClient();
    transcript.clear();
    pendingDialogs.clear();
    status = ConnectionStatus.starting;
    statusDetail = '';
    _notifyNow();

    try {
      final launched = launch(
        SessionTarget(cwd: workspace, sessionPath: sessionPath, attachSlotId: attachSlotId, incognito: incognito),
      );
      final client = launched.client;
      _launched = launched;
      _client = client;
      // Listen before awaiting: the trust prompt arrives while the session starts.
      _eventSub = client.events.listen(_onEvent);
      _uiSub = client.uiRequests.listen(_onUiRequest);
      client.closed.then((_) => _onClientClosed(client));
      await launched.ready;
      if (_disposed) {
        await client.dispose();
        return;
      }

      final results = await Future.wait([client.getAvailableModels(), client.getAvailableThinkingLevels()]);
      models = results[0] as List<PiModel>;
      thinkingLevels = results[1] as List<String>;
      try {
        commands = await client.getCommands();
      } catch (_) {
        commands = const [];
      }
      if (sessionPath != null || attachSlotId != null) transcript.loadHistory(await client.getMessages());
      launched.afterHistory();
      await _refreshState(client);
      await _refreshBranches();
      status = ConnectionStatus.ready;
    } catch (e) {
      status = ConnectionStatus.crashed;
      statusDetail = describeError(e);
    }
    _touch();
    _notifyNow();
  }

  Future<void> _refreshState(PiRpcClient client) async {
    final results = await Future.wait([client.getState(), client.getSessionStats()]);
    state = results[0] as SessionState;
    stats = results[1] as SessionStats;
  }

  Future<void> _stopClient() async {
    final client = _client;
    _client = null;
    await _eventSub?.cancel();
    await _uiSub?.cancel();
    _eventSub = null;
    _uiSub = null;
    if (client != null) await client.dispose();
  }

  void _onClientClosed(PiRpcClient client) {
    if (_disposed || !identical(client, _client)) return; // intentional shutdown
    status = ConnectionStatus.crashed;
    final tail = client.stderrTail;
    statusDetail = [
      client.exitCode == -1 ? '与后台的连接断开了。' : '这个会话在后台被关闭了。',
      if (tail.isNotEmpty) ...tail.skip(tail.length > 12 ? tail.length - 12 : 0),
    ].join('\n');
    transcript.apply(const AgentSettledEvent({'type': 'agent_settled', 'aborted': true}, aborted: true));
    pendingDialogs.clear();
    _notifyNow();
    onSettled?.call(this);
  }

  /// Reopens the same session (after a crash or a core restart). A session
  /// that was never written to disk starts fresh.
  Future<void> restart() {
    final path = sessionPath;
    return start(sessionPath: path != null && File(path).existsSync() ? path : null);
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _notifyTimer?.cancel();
    unawaited(_stopClient());
    super.dispose();
  }

  // --- Events --------------------------------------------------------------

  void _onEvent(PiEvent event) {
    _touch();
    final changed = transcript.apply(event);
    switch (event) {
      case AgentStartEvent():
        _notifyNow();
      case AgentSettledEvent():
        // A run that ended cannot be waiting for an answer any more.
        pendingDialogs.clear();
        _notifyNow();
        unawaited(_afterRun());
      case SessionInfoChangedEvent() || ThinkingLevelChangedEvent():
        final client = _client;
        if (client != null) unawaited(_refreshState(client).then((_) => _notifyNow(), onError: (_) {}));
      default:
        if (changed) _scheduleNotify();
    }
  }

  Future<void> _afterRun() async {
    final client = _client;
    if (client == null) return;
    try {
      await _refreshState(client);
      await _refreshBranches();
    } catch (_) {}
    _notifyNow();
    onSettled?.call(this);
  }

  void _onUiRequest(ExtensionUiRequest request) {
    _touch();
    switch (request.method) {
      case 'select' || 'confirm' || 'input' || 'editor':
        pendingDialogs.add(request);
        onAttention?.call(this, request);
      case 'notify':
        onToast(request.message);
      case 'setStatus':
        final text = request.raw['statusText'];
        final key = request.raw['statusKey'] as String? ?? '';
        if (text is String && text.isNotEmpty) {
          extensionStatuses[key] = text;
        } else {
          extensionStatuses.remove(key);
        }
      case 'setWidget':
        final lines = request.raw['widgetLines'];
        final key = request.raw['widgetKey'] as String? ?? '';
        if (lines is List && lines.isNotEmpty) {
          extensionWidgets[key] = lines.whereType<String>().toList();
        } else {
          extensionWidgets.remove(key);
        }
      case 'set_editor_text':
        _setEditorText(request.raw['text'] as String? ?? '');
      default:
        return; // setTitle and unknown methods have no place in this UI
    }
    _notifyNow();
  }

  /// Answers an extension dialog. Pass exactly one of [value], [confirmed] or
  /// [cancelled].
  void answerDialog(ExtensionUiRequest request, {String? value, bool? confirmed, bool cancelled = false}) {
    if (!pendingDialogs.remove(request)) return;
    _client?.respondToUi(request.id, value: value, confirmed: confirmed, cancelled: cancelled);
    _touch();
    _notifyNow();
  }

  void _setEditorText(String text) {
    editorText = text;
    editorTextRevision++;
  }

  /// Coalesces streaming updates to ~25 rebuilds per second.
  void _scheduleNotify() {
    _notifyTimer ??= Timer(const Duration(milliseconds: 40), _notifyNow);
  }

  void _notifyNow() {
    _notifyTimer?.cancel();
    _notifyTimer = null;
    if (!_disposed) notifyListeners();
  }

  void _touch() => lastActivity = _clock();

  // --- Actions -------------------------------------------------------------

  /// Sends a prompt; while a run is active it steers the current run.
  Future<void> send(String text, {List<ImageBlock> images = const []}) async {
    final client = _client;
    final message = text.trim();
    if (client == null || (message.isEmpty && images.isEmpty) || !isReady) return;
    _touch();
    try {
      final disposition = await client.prompt(message, images: images, streamingBehavior: isRunning ? 'steer' : null);
      // Extension commands may change the session name, commands, etc.
      if (disposition == PromptDisposition.handled) {
        await _refreshState(client);
        _notifyNow();
      }
    } catch (e) {
      onToast('发送失败：${describeError(e)}');
    }
  }

  // --- Context -------------------------------------------------------------

  /// Summarizes older history. Returns a short result description, or null.
  Future<CompactionResult?> compact({String? instructions}) async {
    final client = _client;
    if (client == null || !isReady || isRunning || isCompacting) return null;
    isCompacting = true;
    lastCompactionError = null;
    _notifyNow();
    try {
      final result = await client.compact(customInstructions: instructions);
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      return result;
    } catch (e) {
      final message = describeError(e);
      lastCompactionError = message.contains('Nothing to compact')
          ? '会话内容还不多，暂时不需要压缩。'
          : message.contains('Already compacted')
          ? '已经压缩过了，后面还没有新的内容。'
          : '压缩失败：$message';
      return null;
    } finally {
      isCompacting = false;
      _touch();
      _notifyNow();
    }
  }

  Future<void> setAutoCompaction(bool enabled) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setAutoCompaction(enabled);
      await _refreshState(client);
    } catch (e) {
      onToast('设置自动压缩失败：${describeError(e)}');
    }
    _notifyNow();
  }

  // --- Branching -----------------------------------------------------------

  /// Forks a new session just before [message] and puts its text back into
  /// the input box for editing. Only valid while idle.
  Future<bool> forkFrom(UserItem message) async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    try {
      final points = await client.getForkMessages();
      final users = transcript.items.whereType<UserItem>().where((u) => u.text == message.text).toList();
      final occurrence = users.indexOf(message);
      final matches = points.where((point) => point.text.trim() == message.text.trim()).toList();
      if (matches.isEmpty) {
        onToast('这条消息不在当前分支上，无法分叉。');
        return false;
      }
      final point = matches[occurrence.clamp(0, matches.length - 1)];
      final text = await client.fork(point.entryId);
      if (text == null) return false;
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      _setEditorText(text);
      _touch();
      return true;
    } catch (e) {
      onToast('分叉失败：${describeError(e)}');
      return false;
    } finally {
      _notifyNow();
    }
  }

  /// Forks a new session that ends with the reply before [nextMessage]: the
  /// fork point is the next question, whose text is not put back for editing.
  /// The last reply ([nextMessage] null) forks by duplicating the session.
  Future<bool> forkAfterReply(UserItem? nextMessage) async {
    if (nextMessage == null) return cloneSession();
    if (!await forkFrom(nextMessage)) return false;
    _setEditorText('');
    _notifyNow();
    return true;
  }

  /// Duplicates the current session into a new one. Only valid while idle.
  Future<bool> cloneSession() async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    try {
      if (!await client.clone()) return false;
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      _touch();
      return true;
    } catch (e) {
      onToast('复制会话失败：${describeError(e)}');
      return false;
    } finally {
      _notifyNow();
    }
  }

  Future<void> rename(String name) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setSessionName(name.trim());
      await _refreshState(client);
    } catch (e) {
      onToast('重命名失败：${describeError(e)}');
    }
    _notifyNow();
  }

  // --- Versions within the session (tree navigation) -------------------------

  Future<void> _refreshBranches() async {
    final client = _client;
    if (client == null) return;
    try {
      final data = await client.send('df_branches');
      branches = ((data as Map?)?['branches'] as List? ?? const []).whereType<Map>().map((b) => MessageBranch.fromJson(b.cast<String, dynamic>())).toList();
    } catch (_) {
      branches = const []; // older cores and test doubles have no tree info
    }
  }

  /// Version info for [item]. History may be compacted, so the transcript's
  /// user messages are matched to the active branch from the end.
  MessageBranch? branchFor(UserItem item) {
    final users = transcript.items.whereType<UserItem>().toList();
    final fromEnd = users.length - 1 - users.indexOf(item);
    if (fromEnd < 0 || fromEnd >= users.length) return null;
    final index = branches.length - 1 - fromEnd;
    return index >= 0 && index < branches.length ? branches[index] : null;
  }

  Future<bool> _navigate(String entryId) async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    final data = (await client.send('df_navigate_tree', {'entryId': entryId}, const Duration(minutes: 2))) as Map?;
    if (data?['cancelled'] == true) return false;
    transcript.loadHistory(await client.getMessages());
    await _refreshState(client);
    await _refreshBranches();
    final text = data?['editorText'];
    if (text is String) _setEditorText(text);
    _touch();
    return true;
  }

  /// Shows another version of an edited message (and what followed it).
  Future<void> switchVersion(UserItem item, int index) async {
    final branch = branchFor(item);
    if (branch == null || index < 0 || index >= branch.targets.length || index == branch.index) return;
    try {
      // Navigating to a leaf continues after it, so the editor stays empty.
      await _navigate(branch.targets[index]);
      _setEditorText('');
    } catch (e) {
      onToast('切换版本失败：${describeError(e)}');
    } finally {
      _notifyNow();
    }
  }

  /// Puts [item] back in the input box to edit; sending it adds a new version
  /// next to the original instead of replacing it.
  Future<bool> editMessage(UserItem item) async {
    final branch = branchFor(item);
    if (branch == null) return false;
    try {
      return await _navigate(branch.entryId);
    } catch (e) {
      onToast('编辑失败：${describeError(e)}');
      return false;
    } finally {
      _notifyNow();
    }
  }

  /// Asks the same question again as a new version of [item], optionally with
  /// another [model] (which then stays selected for the session).
  Future<void> regenerate(UserItem item, {PiModel? model}) async {
    if (model != null && model != this.model) await selectModel(model);
    if (!await editMessage(item)) return;
    final text = editorText;
    _setEditorText('');
    _notifyNow();
    await send(text, images: item.images);
  }

  /// Writes the active branch to [outputPath] as Markdown, HTML or JSONL.
  Future<String?> export(String format, String outputPath) async {
    try {
      final data = (await command('df_export', {'format': format, 'outputPath': outputPath})) as Map?;
      return data?['path'] as String?;
    } catch (e) {
      onToast('导出失败：${describeError(e)}');
      return null;
    }
  }

  Future<void> abort() async {
    try {
      await _client?.abort();
    } catch (e) {
      onToast('停止失败：${describeError(e)}');
    }
  }

  /// Starts a fresh session in this process. Only valid while idle.
  Future<bool> newSessionInPlace() async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    try {
      if (!await client.newSession()) return false;
      transcript.clear();
      branches = const [];
      await _refreshState(client);
      _touch();
      return true;
    } catch (e) {
      onToast('新建会话失败：${describeError(e)}');
      return false;
    } finally {
      _notifyNow();
    }
  }

  /// Switches this process to another persisted session. Only valid while idle.
  Future<bool> switchInPlace(String path) async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    status = ConnectionStatus.starting;
    _notifyNow();
    try {
      if (!await client.switchSession(path)) return false;
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      await _refreshBranches();
      _touch();
      return true;
    } catch (e) {
      onToast('打开会话失败：${describeError(e)}');
      return false;
    } finally {
      status = ConnectionStatus.ready;
      _notifyNow();
    }
  }

  Future<void> selectModel(PiModel model) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setModel(model.provider, model.id);
      onModelChosen?.call(model);
      await _refreshState(client);
    } catch (e) {
      onToast('切换模型失败：${describeError(e)}');
    }
    _notifyNow();
  }

  Future<void> selectThinkingLevel(String level) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setThinkingLevel(level);
      onThinkingChosen?.call(level);
      await _refreshState(client);
    } catch (e) {
      onToast('切换思考级别失败：${describeError(e)}');
    }
    _notifyNow();
  }

  /// Sends a Pi RPC command this class has no typed wrapper for (df_* extensions).
  Future<Object?> command(String type, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]) async {
    final client = _client;
    if (client == null) throw PiConnectionClosedException(type);
    _touch();
    return client.send(type, params, timeout);
  }

  static String describeError(Object error) => switch (error) {
    PiRpcException(:final message) => message,
    CoreException(:final message) => message,
    ProcessException(:final message) => message,
    _ => '$error',
  };
}

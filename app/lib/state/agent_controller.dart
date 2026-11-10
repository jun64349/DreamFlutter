import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:url_launcher/url_launcher.dart';

import 'backend.dart';
import 'attention.dart';
import 'cards.dart';
import 'mentions.dart';
import 'memory_ui.dart';
import 'preferences.dart';
import 'session_runtime.dart';
import 'side_chat.dart';
import 'gateway_models.dart';
import 'garden_deletions.dart';
import '../theme.dart';
import 'work_models.dart';

export 'backend.dart' show AgentBackend, CoreBackend, asJsonMap;
export 'session_runtime.dart' show ClientLauncher, ConnectionStatus, SessionRuntime;
export 'work_models.dart';
export 'cards.dart';
export 'gateway_models.dart';

/// One row in the session sidebar: a persisted session, a live one, or both.
class SidebarEntry {
  const SidebarEntry({
    required this.path,
    required this.title,
    required this.modifiedAt,
    required this.isActive,
    required this.isRunning,
    required this.hasUnseenResult,
    required this.hasError,
    this.needsAttention = false,
    this.isFork = false,
    this.pinned = false,
    this.incognito = false,
    this.parentSession,
    this.isSideConversation = false,
    this.sideQuote,
  });

  final String path;
  final String title;
  final DateTime modifiedAt;
  final bool isActive;
  final bool isRunning;

  /// A background run finished and the user has not looked at it yet.
  final bool hasUnseenResult;
  final bool hasError;

  /// An extension (e.g. tool approval) is waiting for the user's answer.
  final bool needsAttention;

  /// Created by forking or cloning another session.
  final bool isFork;
  final bool pinned;

  /// Temporary chat (not saved).
  final bool incognito;
  final String? parentSession;
  final bool isSideConversation;
  final String? sideQuote;
}

/// A full-text search hit from the core's session index.
class SearchHit {
  const SearchHit({required this.path, required this.cwd, required this.title, required this.role, required this.snippet, this.modifiedAt});

  factory SearchHit.fromJson(Json json) => SearchHit(
    path: json['path'] as String? ?? '',
    cwd: json['cwd'] as String?,
    title: json['title'] as String? ?? '',
    role: json['role'] as String? ?? '',
    snippet: json['snippet'] as String? ?? '',
    modifiedAt: json['modifiedAt'] is num ? DateTime.fromMillisecondsSinceEpoch((json['modifiedAt'] as num).toInt()) : null,
  );

  final String path;
  final String? cwd;
  final String title;
  final String role;

  /// Matched text; the match is wrapped in 【】.
  final String snippet;
  final DateTime? modifiedAt;
}

/// Top-level pages of the window (the navigation rail): the workbench (chat), 蝶君, ...
enum AppSection { chat, butterfly, tasks, memory, library, spending, settings }

/// The two halves of 蝶君: talking with it, and its work (notes, materials, outbox).
enum ButterflyTab { talk, work }

/// How the window looks: light / dark / system, the painting theme for each,
/// text size, and whole-interface zoom.
typedef Appearance = ({ThemeMode themeMode, String? lightTheme, String? darkTheme, double textScale, double zoom});

/// A run the previous core process left unfinished (shown as a resume card).
class InterruptedRun {
  const InterruptedRun({required this.id, required this.sessionFile, required this.cwd, required this.prompt, required this.startedAt});

  factory InterruptedRun.fromJson(Json json) => InterruptedRun(
    id: json['id'] as String? ?? '',
    sessionFile: json['sessionFile'] as String?,
    cwd: json['cwd'] as String? ?? '',
    prompt: json['prompt'] as String?,
    startedAt: DateTime.fromMillisecondsSinceEpoch((json['startedAt'] as num?)?.toInt() ?? 0),
  );

  final String id;
  final String? sessionFile;
  final String cwd;
  final String? prompt;
  final DateTime startedAt;
}

/// Manages the sessions shown in this window. Sessions live in the core (a
/// background service), so a running session keeps going when the user
/// switches away, starts another one, or closes the window.
///
/// Reuse rules keep the number of live sessions low:
/// - New/open while the active session is idle: reuse it in place.
/// - New/open while it is running: leave it running in the background and
///   open (or re-activate) another one.
/// - Background sessions idle for [idleGrace] are let go of; the core closes
///   them later, their files stay on disk and reopen on demand.
class AgentController extends ChangeNotifier {
  AgentController({
    required this.preferences,
    AgentBackend? backend,
    SessionStore? sessionStore,
    this.idleGrace = const Duration(minutes: 5),
    this.maxProcesses = 8,
    DateTime Function()? clock,
    this.sandbox = false,
    this.parentController,
  }) : backend = backend ?? CoreBackend(),
       _clock = clock ?? DateTime.now,
       sessionStore = sessionStore ?? SessionStore();

  /// 蝶君's controller: its sessions run in the WSL sandbox and live in 蝶君's
  /// home, apart from the workbench. It shares the window's connection and
  /// lets the main controller ([main]) reconnect, show toasts and switch pages.
  final bool sandbox;
  final AgentController? parentController;

  /// The window's own controller (this one, unless this is 蝶君's).
  AgentController get main => parentController ?? this;

  final Preferences preferences;
  final SessionStore sessionStore;
  final AgentBackend backend;
  AttentionState? _attention;
  AttentionState get attention => main._attention ??= AttentionState(main.backend, onCountChanged: main._attentionChanged);
  void _attentionChanged(){final value=_attention;if(value?.available??false){pendingInbox=value!.total;pendingMemories=0;pendingProposals=0;}_notify();}
  late final GardenDeletions gardenDeletions = sandbox ? main.gardenDeletions : GardenDeletions(backend);
  Future<void> flushGardenDeletes() => main.gardenDeletions.flushPending();
  final _memoryUi = MemoryUi();
  MemoryUi get memoryUi => main._memoryUi;

  void openMemory({String tab = 'memory', String? itemId}) {
    memoryUi.open(tab: tab, itemId: itemId);
    main.showSection(AppSection.memory);
  }
  final DateTime Function() _clock;

  /// How long an idle background session stays attached.
  final Duration idleGrace;

  /// Soft cap on attached sessions; idle background ones are let go first.
  final int maxProcesses;

  final List<SessionRuntime> _runtimes = [];
  final Map<SessionRuntime, String> _backgroundSignature = {};
  final Set<String> _unseen = {};
  final _toasts = StreamController<String>.broadcast();
  final _mentions = StreamController<Mention>.broadcast();
  final _drops = StreamController<List<String>>.broadcast();
  final _emptyTranscript = Transcript();
  StreamSubscription<Json>? _backendEvents;
  Timer? _reaper;
  var _disposed = false;
  var _reconnecting = false;

  SessionRuntime? _active;
  String workspace = '';
  List<SessionSummary> _diskSessions = const [];
  int _sessionRefresh = 0;
  Set<String> _pinned = const {};

  /// Archived sessions of the workspace (shown on request).
  List<SessionSummary> archivedSessions = const [];

  /// Last `core.hello` (version, pid, data dir...), for the settings page.
  Json coreInfo = const {};

  /// Agent settings owned by the core (approval mode, default model...).
  Json coreSettings = const {};

  /// Why the core is unreachable (null when connected).
  String? backendProblem;

  /// Runs a previous core process left unfinished.
  List<InterruptedRun> interruptedRuns = const [];

  /// Memory candidates and skill proposals waiting for the user.
  int pendingMemories = 0;
  int pendingProposals = 0;

  /// Approvals, questions, limit cards and interrupted runs waiting in the inbox.
  int pendingInbox = 0;

  /// Bumped when tasks, the desk or the inbox change in the core.
  final workRevision = ValueNotifier<int>(0);

  /// Which cards run live; cards minted while this window runs may call tools at once.
  final cardStage = CardStage();

  /// Bumped when an image description arrives (the chat shows "图片由 X 转述").
  final visionRevision = ValueNotifier<int>(0);

  /// Bumped when memory, skills or templates change in the core, so open
  /// pages reload.
  final libraryRevision = ValueNotifier<int>(0);

  /// The model gateway's channels and model groups (names for model menus, the settings pages).
  List<GatewayChannel> gatewayChannels = const [];

  /// Bumped when channels, groups or their state change in the core.
  final gatewayRevision = ValueNotifier<int>(0);

  /// 蝶君's sandbox as the core last reported it (sandbox.changed), while it is being set up or changed.
  final sandboxStatus = ValueNotifier<Json?>(null);

  /// The backup or restore job the core is running or ran last (backup.job), for Settings › 数据与迁移.
  final backupJob = ValueNotifier<Json?>(null);

  /// What the last restore did (backup.restoreResult), once the core that applied it is connected.
  final restoreResult = ValueNotifier<Json?>(null);

  /// Short user-facing messages (errors, extension notifications).
  Stream<String> get toasts => _toasts.stream;

  /// The page shown next to the navigation rail.
  AppSection section = AppSection.chat;

  bool butterflySpace = false;
  final _conversationActions = StreamController<String>.broadcast();
  Stream<String> get conversationActions => _conversationActions.stream;
  void requestConversationAction(String action) => _conversationActions.add(action);
  final entryTarget = ValueNotifier<String?>(null);
  bool windowFocused = true;
  String? _presenceSignature;
  void setWindowFocused(bool focused) {
    main.windowFocused = focused;
    main.reportConversationPresence();
  }
  /// T-83's visibility contract; old cores keep their attached-slot fallback.
  void reportConversationPresence() {
    final owner = main;
    if (!identical(owner, this)) { owner.reportConversationPresence(); return; }
    if (_disposed || !backend.isConnected) { _presenceSignature = null; return; }
    final slot = section == AppSection.chat ? active?.slotId
        : section == AppSection.butterfly && butterflyTab.value == ButterflyTab.talk ? butterfly?.active?.slotId : null;
    final signature = '$windowFocused|$slot';
    if (signature == _presenceSignature) return;
    _presenceSignature = signature;
    unawaited(backend.call('notifications.presence', {'foreground': windowFocused, 'slotId': slot}).catchError((Object _) => null));
  }

  /// The settings group a "去设置" asked for (0.8.1 F.5); the settings page jumps to it and clears it.
  final settingsTarget = ValueNotifier<String?>(null);

  /// Opens settings at a group (通用 / 模型 / 工作台 / 蝶君 / 记忆 / 数据与安全 / 关于与更新).
  void openSettings(String group) {
    final parent = parentController;
    if (parent != null) return parent.openSettings(group);
    settingsTarget.value = group;
    showSection(AppSection.settings);
  }

  void showSection(AppSection value) {
    final parent = parentController;
    if (parent != null) return parent.showSection(value);
    if (section == value) return;
    if (value == AppSection.chat) butterflySpace = false;
    if (value == AppSection.butterfly) butterflySpace = true;
    section = value;
    _notify();
  }

  // --- 蝶君 ------------------------------------------------------------------

  /// 蝶君's home folder (its sessions' cwd), from the core; null for an older core.
  String? get butterflyHome => main.coreInfo['butterflyHome'] as String?;

  bool isButterflyCwd(String? cwd) {
    final home = butterflyHome;
    return home != null && cwd != null && SessionStore.samePath(cwd, home);
  }

  AgentController? _butterfly;

  /// 蝶君's sessions; null until 蝶君's conversation is first opened.
  AgentController? get butterfly => main._butterfly;

  /// Which half of 蝶君 is shown.
  final butterflyTab = ValueNotifier<ButterflyTab>(ButterflyTab.work);

  /// Bumped when 蝶君's outbox changes (after each of its runs).
  final outboxRevision = ValueNotifier<int>(0);

  /// Shows 蝶君 (optionally one half) and returns its controller.
  Future<AgentController?> openButterfly({ButterflyTab? tab}) async {
    final m = main;
    m.showSection(AppSection.butterfly);
    if (tab != null) m.butterflyTab.value = tab;
    return m.ensureButterfly();
  }

  /// Creates 蝶君's controller on first use (its sandbox must be set up).
  Future<AgentController?> ensureButterfly() async {
    final m = main;
    final existing = m._butterfly;
    if (existing != null) return existing;
    final home = butterflyHome;
    if (home == null) return null;
    final controller = AgentController(
      preferences: preferences,
      backend: backend,
      sessionStore: sessionStore,
      idleGrace: idleGrace,
      maxProcesses: maxProcesses,
      clock: _clock,
      sandbox: true,
      parentController: m,
    );
    m._butterfly = controller;
    // Called from a page's initState too: tell listeners only once it has started.
    await controller._initShared(home);
    // The rail shows when 蝶君 is working: only that change reaches the window
    // (not every streamed token), and after the frame, as it may come during a build.
    var busy = false;
    controller.addListener(() {
      final now = controller.isRunning || controller.backgroundRunning > 0;
      if (now == busy) return;
      busy = now;
      scheduleMicrotask(m._notify);
    });
    m._notify();
    return controller;
  }

  /// 蝶君's start: the main controller is connected already.
  Future<void> _initShared(String home) async {
    final parent = parentController!;
    workspace = home;
    coreInfo = parent.coreInfo;
    coreSettings = parent.coreSettings;
    gatewayChannels = parent.gatewayChannels;
    _backendEvents = backend.events.listen(_onBackendEvent);
    // Idle sessions are let go of by the main controller's timer.
    await _attachLiveSlots(coreInfo);
    final blank = _runtimes.where((r) => r.isPristine && !r.incognito).firstOrNull;
    await _activate(blank ?? await _spawn());
    unawaited(refreshSessions());
  }

  /// The main controller reconnected to a (possibly new) core.
  Future<void> _reattach(Json hello, {String? previousSessionsDir}) async {
    coreInfo = hello;
    coreSettings = asJsonMap(hello['settings']);
    for (final runtime in List.of(_runtimes)) {
      if (runtime.status == ConnectionStatus.crashed || !runtime.isReady) await runtime.restart(sessionsFrom: previousSessionsDir, sessionsTo: sessionStore.sessionsDir);
    }
    await _attachLiveSlots(hello);
    _notify();
  }

  /// Shows this controller's conversation: the workbench, or 蝶君's 交流.
  void _showChat() {
    if (sandbox) {
      main.showSection(AppSection.butterfly);
      main.butterflyTab.value = ButterflyTab.talk;
    } else {
      showSection(AppSection.chat);
    }
  }

  /// Hands a note to 蝶君: materials are copied into its inbox and the task runs in a new 蝶君 session.
  Future<void> handOffNote(String noteId, {String? title}) async {
    if (!sandbox) {
      final butterfly = await ensureButterfly();
      return butterfly?.handOffNote(noteId, title: title);
    }
    Json created;
    try {
      created = asJsonMap(await backend.call('butterfly.handOff', {'noteId': noteId}, const Duration(minutes: 5)));
    } catch (e) {
      _toast('交给蝶君失败：${SessionRuntime.describeError(e)}');
      return;
    }
    await _runTask(created, title: title);
  }

  // --- The active session, as the chat view sees it -------------------------

  SessionRuntime? get active => _active;
  List<SessionRuntime> get runtimes => List.unmodifiable(_runtimes);
  Transcript get transcript => _active?.transcript ?? _emptyTranscript;
  ConnectionStatus get status => backendProblem != null && _active == null
      ? ConnectionStatus.missingRuntime
      : _active?.status ?? ConnectionStatus.starting;
  String get statusDetail => _active?.statusDetail ?? backendProblem ?? '';
  bool get isReady => _active?.isReady ?? false;
  bool get isRunning => _active?.isRunning ?? false;
  PiModel? get model => _active?.model;
  String get thinkingLevel => _active?.thinkingLevel ?? 'off';

  /// Agent mode of the open session; new sessions start in [defaultAgentMode].
  String get agentMode => _active?.agentMode ?? defaultAgentMode;
  String get defaultAgentMode => coreSettings['agentMode'] == 'minimal' ? 'minimal' : 'standard';
  bool get planMode => _active?.planMode ?? false;
  List<Object?> get todos => _active?.todos ?? const [];
  List<PiModel> get models => _active?.models ?? const [];

  List<String> get thinkingLevels => _active?.thinkingLevels ?? const [];
  SessionStats get stats => _active?.stats ?? SessionStats.empty;
  String? get currentSessionPath => _active?.sessionPath;
  String get sessionTitle => _active?.title ?? '新对话';
  List<SlashCommand> get commands => _active?.commands ?? const [];
  bool get isCompacting => (_active?.isCompacting ?? false) || transcript.isCompacting;
  bool get autoCompactionEnabled => _active?.state?.autoCompactionEnabled ?? defaultAutoCompaction;

  /// The oldest extension dialog of the active session awaiting an answer.
  ExtensionUiRequest? get pendingDialog => _active?.pendingDialogs.firstOrNull;
  Map<String, String> get extensionStatuses => _active?.extensionStatuses ?? const {};
  Map<String, List<String>> get extensionWidgets => _active?.extensionWidgets ?? const {};

  // --- Settings and workspaces ----------------------------------------------

  /// Theme, text size and zoom, separate from the main notifier so streaming
  /// updates do not rebuild the whole app.
  late final appearance = ValueNotifier<Appearance>(_currentAppearance);

  Appearance get _currentAppearance => (
    themeMode: preferences.themeMode,
    lightTheme: preferences.lightTheme,
    darkTheme: preferences.darkTheme,
    textScale: preferences.textScale,
    zoom: preferences.zoom,
  );

  ThemeMode get themeMode => preferences.themeMode;
  double get textScale => preferences.textScale;
  double get zoom => preferences.zoom;
  ApprovalMode get approvalMode => ApprovalMode.parse(coreSettings['approvalMode'] as String?);
  bool get defaultAutoCompaction => coreSettings['autoCompaction'] != false;
  String? get defaultModelKey => coreSettings['defaultModel'] as String?;
  String? get defaultThinkingLevel => coreSettings['defaultThinking'] as String?;

  /// Recently used workspaces plus folders that have sessions, most recent first.
  List<String> recentWorkspaces = const [];

  /// Number of sessions running in the background.
  int get backgroundRunning => _runtimes.where((r) => r != _active && r.isRunning).length;

  // --- Sidebar --------------------------------------------------------------

  /// Sessions of the current workspace: persisted ones merged with live ones
  /// (a live session may not have a file yet), newest first.
  List<SidebarEntry> get sidebar {
    final byPath = <String, SidebarEntry>{};

    for (final s in _diskSessions) {
      byPath[_key(s.path)] = SidebarEntry(
        parentSession: s.parentSession,
        isSideConversation: s.isSideConversation,
        sideQuote: s.sideQuote,
        isFork: s.parentSession != null,
        path: s.path,
        title: s.title,
        modifiedAt: s.modifiedAt,
        isActive: false,
        isRunning: false,
        hasUnseenResult: _unseen.contains(_key(s.path)),
        hasError: false,
        pinned: _pinned.contains(_key(s.path)),
      );
    }
    for (final runtime in _runtimes) {
      final path = runtime.sessionPath;
      if (path == null || !SessionStore.samePath(runtime.workspace, workspace)) continue;
      final isActive = runtime == _active;
      if (runtime.isPristine && !isActive) continue;
      if (!isActive && archivedSessions.any((a) => _key(a.path) == _key(path))) continue;
      final disk = byPath[_key(path)];
      final diskSummary = _diskSessions.where((s) => _key(s.path) == _key(path)).firstOrNull;
      byPath[_key(path)] = SidebarEntry(
        parentSession: disk?.parentSession ?? runtime.forkOf,
        isSideConversation: disk?.isSideConversation ?? false,
        sideQuote: disk?.sideQuote,
        needsAttention: runtime.pendingDialogs.isNotEmpty,
        isFork: diskSummary?.parentSession != null,
        path: path,
        title: runtime.isPristine && disk != null ? disk.title : runtime.title,
        modifiedAt: disk == null || runtime.lastActivity.isAfter(disk.modifiedAt) ? runtime.lastActivity : disk.modifiedAt,
        isActive: isActive,
        isRunning: runtime.isRunning,
        hasUnseenResult: _unseen.contains(_key(path)),
        hasError: runtime.status == ConnectionStatus.crashed,
        pinned: _pinned.contains(_key(path)),
        incognito: runtime.incognito,
      );
    }
    return byPath.values.toList()..sort((a, b) => b.modifiedAt.compareTo(a.modifiedAt));
  }

  // --- Lifecycle -----------------------------------------------------------

  Future<void> init() async {
    workspace = preferences.workspace ?? Preferences.defaultWorkspace();
    _notify(); // show the workspace name while the core starts
    await Directory(workspace).create(recursive: true);
    await preferences.setWorkspace(workspace);
    _backendEvents = backend.events.listen(_onBackendEvent);
    _reaper = Timer.periodic(const Duration(seconds: 30), (_) {
      reapIdle();
      _butterfly?.reapIdle();
    });
    final hello = await _connect();
    if (hello == null) return;
    if (!sandbox) await gardenDeletions.resume();
    await _attachLiveSlots(hello);
    final blank = _runtimes.where((r) => r.isPristine && !r.incognito && SessionStore.samePath(r.workspace, workspace)).firstOrNull;
    await _activate(blank ?? await _spawn());
    unawaited(refreshSessions());
    unawaited(refreshPendingCounts());
    unawaited(refreshGateway());
  }

  /// Connects to the core; on failure records why and returns null.
  Future<Json?> _connect() async {
    try {
      final hello = await backend.connect();
      backendProblem = null;
      _applyHello(hello);
      await _migratePreferences();
      await _takeRestoreResult();
      unawaited(backend.disconnected.then((_) => _onBackendLost()));
      _notify();
      return hello;
    } catch (e) {
      backendProblem = '无法启动后台服务：${SessionRuntime.describeError(e)}';
      _notify();
      return null;
    }
  }

  void _applyHello(Json hello) {
    coreInfo = hello;
    final sessionsDir = hello['sessionDir'];
    if (sessionsDir is String && sessionsDir.isNotEmpty) sessionStore.sessionsDir = sessionsDir;
    coreSettings = asJsonMap(hello['settings']);
    interruptedRuns = [
      for (final run in (hello['interruptedRuns'] as List? ?? const []))
        if (run is Map) InterruptedRun.fromJson(run.cast<String, dynamic>()),
    ];
  }

  /// After a restore: the backup's window preferences are applied once, and the result is announced.
  Future<void> _takeRestoreResult() async {
    if (parentController != null) return;
    try {
      final result = await backend.call('backup.restoreResult');
      if (result is! Map || result['ok'] is! bool || result['at'] is! num) return;
      final json = asJsonMap(result);
      restoreResult.value = json;
      if (json['seen'] == true) return;
      final prefs = json['prefs'];
      // Acknowledged only once they are saved: otherwise the next start applies them again.
      final saved = json['ok'] == true && prefs is Map ? await preferences.importAll(prefs.cast<String, Object?>()) : true;
      if (saved) await backend.call('backup.ackResult');
      _toast(switch (json) {
        {'ok': false} => '恢复没有完成，原来的数据都还在：${json['error']}',
        {'undo': true} => '已撤销上次恢复，回到了恢复前的数据。',
        _ => prefs is Map ? '已恢复备份的数据。界面偏好（主题、工作区等）在重新打开窗口后完全生效。详情见「设置 › 数据与迁移」。' : '已恢复备份的数据。详情见「设置 › 数据与迁移」。',
      });
    } catch (_) {}
  }

  /// Settings that used to live in the window move to the core once.
  Future<void> _migratePreferences() async {
    if (preferences.migratedToCore) return;
    try {
      await updateCoreSettings({
        'approvalMode': preferences.approvalMode.id,
        'autoCompaction': preferences.autoCompaction,
        'defaultModel': preferences.modelKey,
        'defaultThinking': ?preferences.thinkingLevel,
      });
      await preferences.setMigratedToCore();
    } catch (_) {}
  }

  /// Sessions still open in the core from before this window started (they
  /// kept running while no window was open).
  Future<void> _attachLiveSlots(Json hello) async {
    for (final slot in (hello['slots'] as List? ?? const []).whereType<Map>()) {
      final info = slot.cast<String, dynamic>();
      final slotId = info['slotId'] as String?;
      final cwd = info['cwd'] as String?;
      if (slotId == null || cwd == null || info['unattended'] == true) continue;
      // A side conversation belongs to the window that opened it (4.7), never to the list.
      if (info['forkOf'] != null) continue;
      // 蝶君's sessions belong to its controller, the rest to the workbench.
      if ((info['sandbox'] == true) != sandbox) continue;
      if (_runtimes.any((r) => r.slotId == slotId)) continue;
      final runtime = _newRuntime(cwd, incognito: info['incognito'] == true);
      await runtime.start(attachSlotId: slotId);
      if (runtime.status != ConnectionStatus.ready) _close(runtime);
    }
  }

  /// The new core went away too while the windows were reattaching to it.
  bool _lostAgain = false;

  Future<void> _onBackendLost() async {
    if (_disposed) return;
    if (_reconnecting) {
      _lostAgain = true;
      return;
    }
    _reconnecting = true;
    backendProblem = '与后台的连接断开了，正在重新连接…';
    _notify();
    for (var attempt = 1; !_disposed; attempt++) {
      _lostAgain = false;
      final previousSessionsDir = sessionStore.sessionsDir;
      final hello = await _connect();
      if (hello != null) {
        // A new core has none of the old sessions: reopen them from disk.
        for (final runtime in List.of(_runtimes)) {
          if (runtime.status == ConnectionStatus.crashed || !runtime.isReady) await runtime.restart(sessionsFrom: previousSessionsDir, sessionsTo: sessionStore.sessionsDir);
        }
        await _attachLiveSlots(hello);
        await _butterfly?._reattach(hello, previousSessionsDir: previousSessionsDir);
        if (_lostAgain) continue;
        // The new core may hold other data (after a restore or the first-start move): read the lists again.
        unawaited(refreshSessions());
        unawaited(refreshPendingCounts());
        unawaited(refreshGateway(models: true));
        workRevision.value++;
        break;
      }
      await Future<void>.delayed(Duration(seconds: attempt.clamp(1, 10)));
    }
    _reconnecting = false;
    _notify();
  }

  /// Events only the main controller acts on (toasts, badges, the sandbox panel), so 蝶君's does not repeat them.
  static const _mainOnlyEvents = {
    'memory.unsaved', 'memory.notice', 'memory.warning', 'memory.task',
    'memory.changed', 'proposals.changed', 'skills.changed', 'templates.changed', 'mcp.changed', 'library.changed', 'schedules.delivered', //
    'gateway.alert', 'vision.missing', 'notices.changed', 'sandbox.changed', 'butterfly.outbox', //
    'backup.job', 'backup.restarting',
  };

  void _onBackendEvent(Json message) {
    if (sandbox && _mainOnlyEvents.contains(message['event'])) return;
    switch (message['event']) {
      case 'memory.unsaved':
        final id = message['sessionId'] as String?;
        if (id != null) {
          memoryUi.setClaim(id, message);
          unawaited(_bindMemoryEntries(id));
        }
      case 'memory.task':
        final id = message['sessionId'] as String?;
        if (id != null) {
          if (message['kind'] == 'guessed') {
            memoryUi.boundaries[id] = {...message};
            unawaited(_bindMemoryEntries(id));
          } else {
            memoryUi.boundaries.remove(id);
          }
          memoryUi.changed();
        }
      case 'memory.notice' || 'memory.warning':
        memoryUi.notices.add({...message});
        memoryUi.changed();
      case 'butterfly.outbox':
        outboxRevision.value++;
        final fresh = (message['fresh'] as List?)?.whereType<String>().toList() ?? const [];
        if (fresh.isNotEmpty) _toast('蝶君交付了：${fresh.take(3).join('、')}${fresh.length > 3 ? ' 等 ${fresh.length} 个文件' : ''}。在「蝶君 › 工作」里查看。');
      case 'settings.changed':
        coreSettings = asJsonMap(message['settings']);
        _notify();
      case 'memory.changed' || 'proposals.changed' || 'skills.changed' || 'templates.changed' || 'mcp.changed' || 'library.changed':
        libraryRevision.value++;
        unawaited(refreshPendingCounts());
      case 'tasks.changed' || 'desk.changed' || 'confirm.changed' || 'run.finished' || 'schedules.changed':
        workRevision.value++;
        final confirmation = message['confirmation'];
        if (confirmation is Map && confirmation['status'] != 'pending' && confirmation['id'] is String) {
          // Closed by the core (a question that timed out): close its window too.
          for (final runtime in [..._runtimes, if (sideChat != null) sideChat!.runtime]) {
            if (runtime.slotId == confirmation['slotId']) runtime.dropDialog(confirmation['id'] as String);
          }
        }
        if (message['event'] == 'confirm.changed' || message['event'] == 'run.finished' || message['event'] == 'schedules.changed') unawaited(refreshPendingCounts());
      case 'schedules.delivered':
        workRevision.value++;
        final title = message['title'];
        if (title is String) _toast(title);
      case 'gateway.changed':
        unawaited(refreshGateway(models: true));
      case 'sandbox.changed':
        if (message['status'] is Map) sandboxStatus.value = asJsonMap(message['status']);
      case 'backup.job':
        if (message['job'] is Map) backupJob.value = asJsonMap(message['job']);
      case 'backup.restarting':
        _toast('正在切换到备份的数据，后台会重启，稍等片刻…');
      case 'gateway.alert':
        _toast('${message['title']}：${message['body']}');
      case 'card.changed':
        final card = message['card'];
        if (card is Map && card['version'] == 1 && card['origin'] == 'agent') cardStage.markFresh(card['id'] as String);
        if (card is Map && card['resident'] == true) workRevision.value++;
      case 'card.removed':
        final id = message['cardId'];
        if (id is String) cardStage.forget(id);
        workRevision.value++;
      case 'vision.relayed':
        visionRevision.value++;
      case 'vision.missing':
        _toast('当前模型看不到图片，也没有可用的看图模型。到「设置 › 模型」里选一个看图模型。');
      case 'notices.changed':
        workRevision.value++;
        unawaited(refreshPendingCounts());
        final notice = message['notice'];
        if (notice is Map && notice['title'] is String) _toast('${notice['title']}。到「等你处理」里选择继续还是结束。');
    }
  }

  /// Loads the channels; with [models], sessions also reload their model lists.
  Future<void> refreshGateway({bool models = false}) async {
    try {
      gatewayChannels = jsonRows(await backend.call('gateway.channels')).map(GatewayChannel.fromJson).toList();
    } catch (_) {
      return; // an older core without the gateway
    }
    if (models) {
      for (final runtime in List.of(_runtimes)) {
        if (runtime.isReady) unawaited(runtime.refreshModels());
      }
    }
    gatewayRevision.value++;
    _notify();
  }

  /// A model's provider as people know it: the channel's name.
  String providerLabel(String provider) {
    return gatewayChannels.where((c) => c.provider == provider).firstOrNull?.name ?? provider;
  }

  /// Counts for the navigation badges.
  Future<void> refreshPendingCounts() async {
    if (sandbox) return; // the badges are the main controller's
    await attention.refresh();
    if (attention.available) { pendingInbox = attention.total; pendingMemories = 0; pendingProposals = 0; _notify(); return; }
    try {
      final memories = await backend.call('memory.list', {'status': 'candidate'});
      final proposals = await backend.call('proposals.list', {'status': 'pending'});
      pendingMemories = memories is List ? memories.length : 0;
      pendingProposals = proposals is List ? proposals.length : 0;
      try {
        final inbox = await backend.call('inbox.list');
        pendingInbox = jsonRows(inbox).map(InboxItem.fromJson).where((i) => i.isTaskItem).length;
      } catch (_) {}
      _attentionChanged();
    } catch (_) {}
  }

  /// Runs a task template in the active session (switching to a fresh one when busy).
  Future<void> runTemplate(String name, Map<String, String> values) async {
    try {
      final result = asJsonMap(await backend.call('templates.command', {'name': name, 'values': values}));
      final command = result['command'] as String?;
      if (command == null) return;
      await startTask(goal: command, title: '模板：$name', source: 'template');
    } catch (e) {
      _toast('运行模板失败：${SessionRuntime.describeError(e)}');
    }
  }

  // --- Tasks and the desk -----------------------------------------------------

  /// Creates a task in the core and runs it in a fresh session of the
  /// current workspace (a running session keeps going in the background).
  Future<void> startTask({
    required String goal,
    String? title,
    String source = 'note',
    String? noteId,
    List<String> materialIds = const [],
  }) async {
    Json created;
    try {
      created = asJsonMap(await backend.call('tasks.create', {
        'cwd': workspace,
        'goal': goal,
        'title': ?title,
        'source': source,
        'noteId': ?noteId,
        'materialIds': materialIds,
      }));
    } catch (e) {
      _toast('创建任务失败：${SessionRuntime.describeError(e)}');
      return;
    }
    await _runTask(created, title: title, goal: goal);
  }

  /// Runs a task the core created ({task, prompt}) in a fresh session of this controller.
  Future<void> _runTask(Json created, {String? title, String goal = ''}) async {
    final taskId = asJsonMap(created['task'])['id'] as String?;
    final prompt = created['prompt'] as String? ?? goal;
    _showChat();
    await newSession();
    final runtime = _active;
    if (runtime == null || !runtime.isReady) return;
    final slotId = runtime.slotId;
    if (taskId != null && slotId != null) {
      try {
        await backend.call('tasks.bind', {'taskId': taskId, 'slotId': slotId});
      } catch (_) {}
    }
    // Name the session after the task rather than its long composed prompt.
    if (title != null) await runtime.rename(title);
    await runtime.send(prompt);
  }

  /// Opens the session a task ran in.
  Future<void> openTask(TaskInfo task) async {
    final file = task.sessionFile;
    if (file == null || !File(file).existsSync()) {
      _toast('这个任务还没有会话记录，或者会话已经被删除。');
      return;
    }
    // Each side opens its own sessions.
    final owner = await _ownerOf(task.cwd);
    if (owner == null) return;
    if (owner != this) return owner.openTask(task);
    _showChat();
    if (!sandbox && !SessionStore.samePath(task.cwd, workspace) && Directory(task.cwd).existsSync()) await setWorkspace(task.cwd);
    await openSession(file);
  }

  /// The controller whose sessions run in [cwd]: 蝶君's for its home, the workbench's otherwise.
  Future<AgentController?> _ownerOf(String? cwd) async => isButterflyCwd(cwd) ? (sandbox ? this : await ensureButterfly()) : main;

  /// Opens [sessionFile] (when given) and puts a "keep working on this"
  /// request into the composer, for the user to complete and send.
  Future<void> continueWork({String? sessionFile, String? cwd, required String text}) async {
    final owner = await _ownerOf(cwd ?? workspace);
    if (owner == null) return;
    if (owner != this) return owner.continueWork(sessionFile: sessionFile, cwd: cwd, text: text);
    _showChat();
    if (cwd != null && !SessionStore.samePath(cwd, workspace) && Directory(cwd).existsSync()) await setWorkspace(cwd);
    if (sessionFile != null && File(sessionFile).existsSync()) {
      await openSession(sessionFile);
    } else {
      await newSession();
    }
    insertIntoComposer(text);
  }

  /// Continue or stop a run a limit paused.
  Future<void> resolveNotice(String id, {required bool continueRun}) async {
    try {
      await backend.call('notices.resolve', {'id': id, 'action': continueRun ? 'continue' : 'stop'}, const Duration(seconds: 120));
    } catch (e) {
      _toast('操作失败：${SessionRuntime.describeError(e)}');
    }
    await refreshPendingCounts();
  }

  /// Answers a confirmation card from the inbox (its session may be in the
  /// background or not shown in this window).
  Future<bool> answerConfirmation(String id, Json response) async {
    for (final runtime in _runtimes) {
      final request = runtime.pendingDialogs.where((r) => r.id == id).firstOrNull;
      if (request != null) {
        runtime.answerDialog(request, value: response['value'] as String?, confirmed: response['confirmed'] as bool?, cancelled: response['cancelled'] == true);
        await refreshPendingCounts();
        return true;
      }
    }
    try {
      await backend.call('confirm.answer', {'id': id, 'response': response});
      await refreshPendingCounts();
      return true;
    } catch (e) {
      _toast(SessionRuntime.describeError(e));
      await refreshPendingCounts();
      return false;
    }
  }

  /// Opens a file with its default program.
  Future<void> openFile(String path) async {
    try {
      // ShellExecute (no command shell: a name like a&calc&.txt stays a file name).
      if (!await launchUrl(Uri.file(path, windows: true))) _toast('无法打开文件：$path');
    } catch (e) {
      _toast('无法打开文件：$e');
    }
  }

  /// Shows a file selected in Windows Explorer.
  Future<void> revealFile(String path) async {
    try {
      await Process.start('explorer', ['/select,', path]);
    } catch (e) {
      _toast('无法打开文件夹：$e');
    }
  }

  // --- Memory and skills from the chat ----------------------------------------

  /// Pi session id of the active session (memory snapshots are keyed by it).
  String? get activeSessionId {
    final id = _active?.state?.sessionId;
    return id == null || id.isEmpty ? null : id;
  }

  Future<void> _bindMemoryEntries(String sessionId) async {
    final runtimes = [...main._runtimes, ...?main._butterfly?._runtimes];
    final runtime = runtimes.where((r) => r.state?.sessionId == sessionId).firstOrNull;
    if (runtime == null) return;
    await runtime.refreshEntryIds();
    if (_disposed) return;
    final boundary = memoryUi.boundaries[sessionId];
    if (boundary != null) {
      try {
        final tasks = memoryRows(await backend.call('memory.tasks', {'sessionId': sessionId}));
        final task = tasks.where((t) => t['id'] == boundary['taskId']).firstOrNull;
        if (task != null) {
          final anchor = await runtime.memoryTaskAnchor(task);
          if (identical(memoryUi.boundaries[sessionId], boundary)) boundary['userEntryId'] = anchor;
        }
      } catch (_) { /* Do not attach a boundary to a guessed message. */ }
    }
    if (!_disposed) memoryUi.changed();
  }

  Future<void> refreshMemorySession() async {
    final id = activeSessionId;
    if (id == null || _active?.incognito == true) return;
    final runtime = _active;
    final before = memoryUi.claimRevision(id);
    try {
      final claim = await backend.call('memory.unsaved', {'sessionId': id});
      if (_disposed) return;
      if (before == memoryUi.claimRevision(id)) memoryUi.setClaim(id, claim is Map && claim['runId'] != null ? memoryMap(claim) : null);
      await runtime?.refreshEntryIds();
      if (!_disposed) memoryUi.changed();
    } catch (_) {
      // A failed reconnect query does not erase a live warning.
    }
  }

  /// Asks the auxiliary model to turn the active session into a skill
  /// proposal; returns true when one was created.
  Future<bool> draftSkillFromSession() async {
    final runtime = _active;
    final slotId = runtime?.slotId;
    if (runtime == null || slotId == null || runtime.isPristine) {
      _toast('这个会话还没有内容。');
      return false;
    }
    try {
      await backend.call('skills.draftFromSession', {'slotId': slotId}, const Duration(seconds: 120));
      _toast('技能草稿已生成，到「等你处理」查看。');
      return true;
    } catch (e) {
      _toast('整理技能失败：${SessionRuntime.describeError(e)}');
      return false;
    }
  }

  /// A template draft from the last message the user sent in the active
  /// session (falls back to the message itself when the model fails).
  Future<Json?> draftTemplateFromSession() async {
    final last = transcript.items.whereType<UserItem>().lastOrNull;
    if (last == null || last.text.trim().isEmpty) {
      _toast('这个会话里还没有可以存成模板的请求。');
      return null;
    }
    try {
      return asJsonMap(await backend.call('templates.draft', {'text': last.text}, const Duration(seconds: 90)));
    } catch (e) {
      _toast('没能自动整理模板（${SessionRuntime.describeError(e)}），请手动修改。');
      return {'name': '', 'description': '', 'body': last.text};
    }
  }

  /// Rebuilds the memory snapshot at the next message of the active session.
  Future<void> refreshMemorySnapshot() async {
    final id = activeSessionId;
    if (id == null) return;
    try {
      await backend.call('memory.refresh', {'sessionId': id});
      _toast('下一条消息会带上最新的记忆。');
    } catch (e) {
      _toast('操作失败：${SessionRuntime.describeError(e)}');
    }
  }

  /// Memory snapshots the active session was given, newest first.
  Future<List<Json>> memorySnapshots() async {
    final id = activeSessionId;
    if (id == null) return const [];
    try {
      final rows = await backend.call('memory.snapshots', {'sessionId': id});
      return rows is List ? rows.whereType<Map>().map((r) => r.cast<String, dynamic>()).toList() : const [];
    } catch (_) {
      return const [];
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _attention?.dispose();
    if (!sandbox) gardenDeletions.dispose();
    backupJob.dispose();
    restoreResult.dispose();
    _butterfly?.dispose();
    if (sideChat case final side?) _endSideChat(side);
    _reaper?.cancel();
    _backendEvents?.cancel();
    for (final runtime in _runtimes) {
      runtime.dispose();
    }
    _runtimes.clear();
    _toasts.close();
    _mentions.close();
    _drops.close();
    _conversationActions.close();
    entryTarget.dispose();
    _memoryUi.dispose();
    super.dispose();
  }

  SessionRuntime _newRuntime(String cwd, {bool incognito = false, String? agentMode}) {
    final runtime = SessionRuntime(
      workspace: cwd,
      incognito: incognito,
      requestedAgentMode: agentMode,
      sandbox: sandbox,
      launch: backend.launch,
      onToast: _toast,
      onSettled: _onRuntimeSettled,
      onAttention: _onRuntimeAttention,
      onModelChosen: (model) => unawaited(updateCoreSettings({'defaultModel': model.key}).catchError((_) {})),
      // Current-session thinking is separate from the default for new sessions.
      clock: _clock,
    );
    runtime.addListener(() => _onRuntimeChanged(runtime));
    _runtimes.add(runtime);
    return runtime;
  }

  /// Opens a session for [cwd] (default: the workspace) in the core.
  Future<SessionRuntime> _spawn({String? sessionPath, String? cwd, bool incognito = false, String? agentMode}) async {
    reapIdle(makeRoomForOne: true);
    final runtime = _newRuntime(cwd ?? workspace, incognito: incognito, agentMode: agentMode);
    // Show the new session right away (with its startup spinner) instead of
    // leaving the previous one on screen while it opens.
    _active = runtime;
    final starting = runtime.start(sessionPath: sessionPath);
    _notify();
    await starting;
    return runtime;
  }

  Future<void> _activate(SessionRuntime runtime) async {
    entryTarget.value = null;
    _active = runtime;
    final path = runtime.sessionPath;
    if (path != null) _unseen.remove(_key(path));
    _notify();
    unawaited(refreshMemorySession());
  }

  void _onRuntimeChanged(SessionRuntime runtime) {
    if (runtime == _active) {
      _notify();
      return;
    }
    // Background sessions only matter to the sidebar: notify when their
    // visible state changes, not on every streamed token.
    final signature =
        '${runtime.isRunning}|${runtime.status}|${runtime.title}|${runtime.sessionPath}|${runtime.pendingDialogs.length}';
    if (_backgroundSignature[runtime] != signature) {
      _backgroundSignature[runtime] = signature;
      _notify();
    }
  }

  void _onRuntimeAttention(SessionRuntime runtime, ExtensionUiRequest request) {
    if (runtime != _active) _toast('「${runtime.title}」在等你确认。');
    _notify();
  }

  void _onRuntimeSettled(SessionRuntime runtime) {
    final path = runtime.sessionPath;
    if (runtime != _active && path != null) _unseen.add(_key(path));
    unawaited(refreshSessions());
  }

  /// Lets go of idle background sessions past [idleGrace]. With
  /// [makeRoomForOne], also the oldest idle ones when at the cap.
  @visibleForTesting
  void reapIdle({bool makeRoomForOne = false}) {
    final now = _clock();
    final idle = _runtimes.where((r) => r != _active && !r.isRunning && r.pendingDialogs.isEmpty).toList()
      ..sort((a, b) => a.lastActivity.compareTo(b.lastActivity));
    var live = _runtimes.length;
    for (final runtime in idle) {
      final expired = now.difference(runtime.lastActivity) >= idleGrace;
      final overCap = makeRoomForOne && live >= maxProcesses;
      if (!expired && !overCap) continue;
      _close(runtime);
      live--;
    }
  }

  /// Stops showing [runtime]. The session stays in the core until it is idle
  /// long enough for the core to close it.
  void _close(SessionRuntime runtime) {
    _runtimes.remove(runtime);
    _backgroundSignature.remove(runtime);
    runtime.dispose();
    _notify();
  }

  /// Closes the session in the core as well (delete, reload configuration).
  Future<void> _closeInCore(SessionRuntime runtime) async {
    final slotId = runtime.slotId;
    _close(runtime);
    if (slotId == null) return;
    try {
      await backend.call('slot.close', {'slotId': slotId});
    } catch (_) {}
  }

  SessionRuntime? _liveRuntimeFor(String path) =>
      _runtimes.where((r) => r.sessionPath != null && SessionStore.samePath(r.sessionPath!, path)).firstOrNull;

  // --- Actions -------------------------------------------------------------

  /// Starts a new session. A running session keeps running in the background.
  Future<void> newSession({bool forceNew = false}) async {
    if (forceNew || sandbox && _active?.slotId != null && butterflySlotHasPlan?.call(_active!.slotId!) == true) { await _activate(await _spawn()); return; }
    final current = _active;
    if (current != null && current.isPristine && current.isReady && !current.incognito) return; // already on a blank session
    final idleOther = _runtimes
        .where((r) => r != current && r.isPristine && r.isReady && !r.incognito && SessionStore.samePath(r.workspace, workspace))
        .firstOrNull;
    if (idleOther != null) return _activate(idleOther);
    if (current != null && current.isReady && !current.isRunning && !current.incognito && SessionStore.samePath(current.workspace, workspace)) {
      await current.newSessionInPlace();
      _notify();
      return;
    }
    final runtime = await _spawn();
    await _activate(runtime);
  }

  /// Reuse a still-open butterfly task slot without replacing its session.
  Future<bool> activateSlot(String slotId) async {
    final runtime = _runtimes.where((r) => r.slotId == slotId).firstOrNull;
    if (runtime == null) return false;
    await _activate(runtime); return true;
  }

  /// Opens a session from the sidebar. Running sessions are never interrupted.
  Future<void> openSession(String path) async {
    final current = _active;
    if (current?.sessionPath != null && SessionStore.samePath(current!.sessionPath!, path)) return;

    final live = _liveRuntimeFor(path);
    if (live != null) return _activate(live);

    final summary = _diskSessions.where((s) => SessionStore.samePath(s.path, path)).firstOrNull;
    final cwd = summary?.cwd ?? workspace;
    // A temporary chat stays temporary: saved history opens in a normal runtime.
    if (current != null && current.isReady && !current.isRunning && !current.incognito && SessionStore.samePath(current.workspace, cwd)) {
      if (await current.switchInPlace(path)) {
        _unseen.remove(_key(path));
        _notify();
        return;
      }
      // Not switched here (another window has it open): open it in its own runtime, which attaches to that one.
    }
    final runtime = await _spawn(sessionPath: path, cwd: cwd);
    await _activate(runtime);
  }

  Future<void> setWorkspace(String directory) async {
    if (sandbox || SessionStore.samePath(directory, workspace)) return; // 蝶君 always works in its home
    workspace = directory;
    await preferences.setWorkspace(directory);
    _diskSessions = const [];
    final blank = _runtimes.where((r) => r.isPristine && r.isReady && SessionStore.samePath(r.workspace, directory)).firstOrNull;
    await _activate(blank ?? await _spawn());
    await refreshSessions();
  }

  /// The butterfly page owns task preparation; the shared composer stays reusable.
  Future<void> Function(String, List<ImageBlock>)? butterflySubmission;
  bool Function(String slotId)? butterflySlotHasPlan;

  Future<void> send(String text, {List<ImageBlock> images = const []}) async {
    final submit = sandbox ? butterflySubmission : null;
    if (submit == null) { await _active?.send(text, images: images); return; }
    try { await submit(text, images); }
    catch (e) { _toast('没有发出：${SessionRuntime.describeError(e)}'); insertIntoComposer(text); }
  }
  Future<void> abort() async => _active?.abort();
  Future<void> selectModel(PiModel model) async => _active?.selectModel(model);

  /// Switches to [mode] ("standard" or "minimal"). A session keeps the mode
  /// it was created in, so this starts a new session in that mode (in place
  /// when the open one is still blank) and makes it the default.
  Future<void> selectAgentMode(String mode) async {
    if (mode != 'standard' && mode != 'minimal') return;
    unawaited(updateCoreSettings({'agentMode': mode}).catchError((_) {}));
    final current = _active;
    if (current != null && current.agentMode == mode && !current.incognito) return; // from 无痕 a saved session starts
    if (current != null && current.isPristine && current.isReady && !current.incognito) {
      await current.newSessionInPlace(agentMode: mode);
      _notify();
      return;
    }
    final runtime = await _spawn(agentMode: mode);
    await _activate(runtime);
  }

  Future<void> setPlanMode(bool on) async => _active?.setPlanMode(on);
  Future<void> selectThinkingLevel(String level) async => _active?.selectThinkingLevel(level);

  /// Reconnects to the core if needed and reopens the active session.
  Future<void> restart() async {
    final parent = parentController;
    if (parent != null && !backend.isConnected) {
      await parent.restart(); // reconnects, and reattaches 蝶君's sessions
      return;
    }
    if (!backend.isConnected) {
      final hello = await _connect();
      if (hello == null) return;
      await _butterfly?._reattach(hello);
    }
    final active = _active;
    if (active == null) {
      await _activate(await _spawn());
    } else {
      await active.restart();
    }
  }

  Future<void> refreshSessions() async {
    final revision = ++_sessionRefresh;
    final requestedWorkspace = workspace;
    bool stale() => _disposed || revision != _sessionRefresh || workspace != requestedWorkspace;
    try {
      final rows = await backend.call('sessions.list', {'cwd': requestedWorkspace, 'archived': 'include'});
      if (stale()) return;
      if (rows is! List) throw StateError('no index');
      final all = rows.whereType<Map>().map((r) => r.cast<String, dynamic>()).toList();
      SessionSummary summary(Json r) => SessionSummary(
        path: r['path'] as String,
        id: r['sessionId'] as String? ?? '',
        cwd: r['cwd'] as String? ?? requestedWorkspace,
        title: r['title'] as String? ?? '新对话',
        createdAt: DateTime.fromMillisecondsSinceEpoch((r['createdAt'] as num?)?.toInt() ?? 0),
        modifiedAt: DateTime.fromMillisecondsSinceEpoch((r['modifiedAt'] as num?)?.toInt() ?? 0),
        parentSession: r['parentSession'] as String?,
        isSideConversation: r['sessionType'] == 'side',
        sideQuote: r['quote'] as String?,
      );
      // The existing index keeps saved side chats out of sessions.list.
      // Its public children API already supplies them; no T-85 dependency.
      final paths = {for (final r in all) _key(r['path'] as String)};
      final children = await Future.wait(
        all.map((r) async {
          try {
            return jsonRows(
              await backend.call('sessions.children', {
                'parentSession': r['path'],
                'cwd': requestedWorkspace,
              }),
            );
          } catch (_) {
            return <Json>[];
          }
        }),
      );
      if (stale()) return;
      for (final rows in children) {
        for (final row in rows) {
          if (row['path'] is String && paths.add(_key(row['path'] as String))) { all.add(row); }
        }
      }
      _diskSessions = [for (final r in all) if (r['archived'] != true) summary(r)];
      archivedSessions = [for (final r in all) if (r['archived'] == true) summary(r)];
      _pinned = {for (final r in all) if (r['pinned'] == true) _key(r['path'] as String)};
    } catch (_) {
      if (stale()) return;
      // No core index (older core, tests): read the files directly.
      try {
        final sessions = await sessionStore.list(cwd: requestedWorkspace,
          includeSideConversations: true,
        );
        if (stale()) return;
        _diskSessions = sessions;
      } catch (_) {
        if (stale()) return;
        _diskSessions = const [];
      }
    }
    if (!sandbox) {
      try {
        final workspaces = await sessionStore.workspaces();
        if (stale()) return;
        final seen = <String>{};
        recentWorkspaces = [
          // 蝶君's home has sessions too, but it is not a workspace.
          for (final w in [...preferences.recentWorkspaces, ...workspaces])
            if (seen.add(_key(w)) && !isButterflyCwd(w) && Directory(w).existsSync()) w,
        ].take(Preferences.maxRecentWorkspaces).toList();
      } catch (_) {}
    }
    if (!stale()) _notify();
  }

  Future<void> forgetWorkspace(String directory) async {
    await preferences.removeRecentWorkspace(directory);
    await refreshSessions();
  }

  /// Opens a folder in Windows Explorer.
  Future<void> revealInExplorer(String path) async {
    try {
      await Process.start(Platform.isWindows ? 'explorer' : 'xdg-open', [path]);
    } catch (e) {
      _toast('无法打开文件夹：$e');
    }
  }

  /// Starts a 无痕 (incognito) chat: minimal mode, kept in memory only, never saved or remembered (0.4, 4.6).
  Future<void> newTemporarySession() async {
    final runtime = await _spawn(incognito: true, agentMode: 'minimal');
    await _activate(runtime);
  }

  /// Full-text search over every session (all branches), newest workspace first.
  Future<List<SearchHit>> searchSessions(String query, {bool thisWorkspaceOnly = false}) async {
    if (query.trim().isEmpty) return const [];
    try {
      final hits = await backend.call('sessions.search', {'query': query.trim(), if (thisWorkspaceOnly) 'cwd': workspace});
      return hits is List ? hits.whereType<Map>().map((h) => SearchHit.fromJson(h.cast<String, dynamic>())).toList() : const [];
    } catch (e) {
      _toast('搜索失败：${SessionRuntime.describeError(e)}');
      return const [];
    }
  }

  /// Opens a search hit, switching workspace when it belongs to another one.
  Future<void> openSearchHit(SearchHit hit) async {
    final cwd = hit.cwd;
    final owner = await _ownerOf(cwd ?? workspace);
    if (owner == null) return;
    if (owner != this) {
      owner._showChat();
      return owner.openSearchHit(hit);
    }
    if (sandbox) return openSession(hit.path);
    if (cwd != null && !SessionStore.samePath(cwd, workspace) && Directory(cwd).existsSync()) await setWorkspace(cwd);
    await openSession(hit.path);
  }

  Future<void> setPinned(String path, bool pinned) => _sessionFlag('sessions.setPinned', {'path': path, 'pinned': pinned});

  Future<void> setArchived(String path, bool archived) async {
    await _sessionFlag('sessions.setArchived', {'path': path, 'archived': archived});
    if (archived && _active?.sessionPath != null && SessionStore.samePath(_active!.sessionPath!, path)) await newSession();
  }

  Future<void> _sessionFlag(String method, Json params) async {
    try {
      await backend.call(method, params);
    } catch (e) {
      _toast('操作失败：${SessionRuntime.describeError(e)}');
    }
    await refreshSessions();
  }

  /// Exports the session at [path] (opening it first if needed).
  Future<String?> exportSession(String path, String format, String outputPath) async {
    var runtime = _liveRuntimeFor(path);
    if (runtime == null) {
      await openSession(path);
      runtime = _active;
    }
    return runtime?.export(format, outputPath);
  }

  Future<void> editMessage(UserItem item) async {
    final runtime = _active;
    if (runtime == null || runtime.isRunning) return;
    await runtime.editMessage(item);
  }

  Future<void> regenerate(UserItem item, {PiModel? model}) async {
    final runtime = _active;
    if (runtime == null || runtime.isRunning) return;
    await runtime.regenerate(item, model: model);
  }

  Future<void> switchVersion(UserItem item, int index) async => _active?.switchVersion(item, index);

  Future<List<QuestionNode>> questionTree() async => await _active?.questionTree() ?? const [];

  Future<void> openBranch(String target) async {
    final runtime = _active;
    if (runtime == null || runtime.isRunning) return;
    await runtime.openBranch(target);
  }

  /// Asks the input box to attach [mention] (from the desk tab, for example).
  void mention(Mention mention) => _mentions.add(mention);

  Stream<Mention> get mentionRequests => _mentions.stream;

  /// Images dragged out of browsers and chat apps land in %TEMP%\DreamFlutter\drops (the
  /// drop plugin); they move to the data folder's cache, where everything else is.
  String _keepDrop(String path) {
    final dataDir = coreInfo['dataDir'] as String?;
    final temp = Platform.environment['TEMP'];
    if (dataDir == null || temp == null || !p.isWithin(p.join(temp, 'DreamFlutter', 'drops'), path)) return path;
    try {
      final target = p.join(dataDir, 'cache', 'drops', p.basename(p.dirname(path)), p.basename(path));
      Directory(p.dirname(target)).createSync(recursive: true);
      return File(path).renameSync(target).path;
    } catch (_) {
      // Another drive: a copy, then the temporary file goes.
      try {
        final target = p.join(dataDir, 'cache', 'drops', p.basename(p.dirname(path)), p.basename(path));
        File(path).copySync(target);
        File(path).deleteSync();
        return target;
      } catch (_) {
        return path;
      }
    }
  }

  /// Asks the input box to attach files dropped anywhere on the conversation.
  void dropFiles(List<String> paths) {
    if (paths.isEmpty) {
      // The drop plugin turns paths, virtual files and bitmaps into files; anything else arrives empty.
      _toast('这个程序拖出的内容读不到。可以在那边复制图片，再在输入框里按 Ctrl+V 粘贴；或先把它保存成文件再拖进来。');
      return;
    }
    _drops.add([for (final path in paths) _keepDrop(path)]);
  }

  Stream<List<String>> get fileDrops => _drops.stream;

  // --- Interrupted runs ------------------------------------------------------

  /// Reopens the session of an interrupted run and asks the agent to go on.
  Future<void> resumeInterrupted(InterruptedRun run) async {
    await dismissInterrupted(run);
    final owner = await _ownerOf(run.cwd);
    if (owner == null) return;
    if (owner != this) return owner.resumeInterrupted(run);
    _showChat();
    final file = run.sessionFile;
    if (file == null || !File(file).existsSync()) {
      _toast('这个任务的会话文件已经不在了。');
      return;
    }
    if (!sandbox && !SessionStore.samePath(run.cwd, workspace) && Directory(run.cwd).existsSync()) await setWorkspace(run.cwd);
    await openSession(file);
    await _active?.send('上次运行被中断了（后台重启或电脑关机）。请检查已经完成到哪一步，然后继续完成剩下的部分。');
  }

  Future<void> dismissInterrupted(InterruptedRun run) async {
    interruptedRuns = interruptedRuns.where((r) => r.id != run.id).toList();
    _notify();
    try {
      await backend.call('runs.acknowledge', {'id': run.id});
    } catch (_) {}
  }

  // --- Extension dialogs ----------------------------------------------------

  void answerDialog(ExtensionUiRequest request, {String? value, bool? confirmed, bool cancelled = false}) {
    for (final runtime in _runtimes) {
      if (runtime.pendingDialogs.contains(request)) {
        runtime.answerDialog(request, value: value, confirmed: confirmed, cancelled: cancelled);
      }
    }
  }

  /// Puts [text] into the input box of the active session.
  void insertIntoComposer(String text) {
    final runtime = _active;
    if (runtime == null) return;
    runtime.editorText = text;
    runtime.editorTextRevision++;
    _notify();
  }

  /// Adds [text] as a quote to what is typed in the input box (0.4: 「回复」 on selected text,
  /// and a side conversation's answer brought back).
  void quoteInComposer(String text, {String? lead}) {
    final runtime = _active;
    if (runtime == null || text.trim().isEmpty) return;
    runtime.composerQuote = '${lead == null ? '' : '$lead\n'}$text';
    _notify();
  }

  void clearComposerQuote() {
    _active?.composerQuote = null;
    _notify();
  }

  // --- Side conversation (0.4, roadmap 4.7) ------------------------------------

  /// The side conversation in the details panel, if one is open.
  SideChat? sideChat;

  /// Saved parents fork their file; private parents use T-07's live slot.
  bool get canOpenSideChat => _active?.isReady == true && (_active?.sessionPath != null || (_active?.incognito == true && _active?.slotId != null));

  /// Opens a side conversation about [quote] in the details panel: an in-memory copy of the
  /// session so far, so asking there neither interrupts nor adds to the conversation.
  Future<void> openSideChat(String quote) async {
    final source = _active;
    final path = source?.sessionPath;
    if (source == null || !canOpenSideChat) {
      _toast('会话还未准备好，暂时不能开侧边对话。');
      return;
    }
    closeSideChat();
    final runtime = SessionRuntime(
      workspace: source.workspace,
      incognito: source.incognito,
      forkOf: source.incognito ? null : path,
      parentSlotId: source.incognito ? source.slotId : null,
      sideQuote: quote,
      rejectDialogsOnEnd: true,
      sandbox: sandbox,
      launch: backend.launch,
      onToast: _toast,
      clock: _clock,
    );
    final side = SideChat(quote: quote, runtime: runtime, sourcePath: path ?? '');
    sideChat = side;
    await preferences.setRunPanelOpen(true);
    _notifyBoth();
    await runtime.start();
    if (sideChat != side) return; // closed while it opened
    side.baseline = runtime.transcript.items.length;
    _notify();
  }

  Future<void> openSavedSideChat(Json row) async {
    final path = row['path'] as String?;
    if (path == null) throw StateError('侧边对话没有文件路径');
    closeSideChat();
    final runtime = SessionRuntime(workspace: row['cwd'] as String? ?? workspace, sandbox: sandbox, launch: backend.launch, onToast: _toast, clock: _clock, rejectDialogsOnEnd: true);
    final side = SideChat(quote: row['quote'] as String? ?? '', runtime: runtime, sourcePath: row['parentSession'] as String? ?? '', reopened: true, parentMissing: row['parentMissing'] == true);
    sideChat = side;
    await preferences.setRunPanelOpen(true);
    _notifyBoth();
    await runtime.start(sessionPath: path);
    if (sideChat != side) return;
    if (!runtime.isReady) throw StateError(runtime.statusDetail);
    try {
      await runtime.loadSideHistory();
      side.baseline = 0;
    } catch (e) {
      runtime.status = ConnectionStatus.crashed;
      runtime.statusDetail = SessionRuntime.describeError(e);
      rethrow;
    } finally {
      _notifyBoth();
    }
  }

  void closeSideChat() {
    final side = sideChat;
    if (side == null) return;
    sideChat = null;
    _endSideChat(side);
    _notify();
  }

  /// Closing the panel closes its runtime. Saved side files can be reopened through
  /// the children API; ordinary window reattachment must still skip them.
  void _endSideChat(SideChat side) {
    final slotId = side.runtime.slotId;
    side.runtime.dispose();
    if (slotId != null) unawaited(backend.call('slot.close', {'slotId': slotId}).then((_) {}, onError: (_) {}));
  }

  /// Puts the side conversation's latest answer into the main input box.
  void bringBackSideChat() {
    final answer = sideChat?.lastAnswer;
    if (answer != null) quoteInComposer(answer);
  }

  // --- Context ---------------------------------------------------------------

  Future<CompactionResult?> compact({String? instructions}) async => _active?.compact(instructions: instructions);

  Future<void> setSessionAutoCompaction(bool enabled) async => _active?.setAutoCompaction(enabled);

  // --- Session management -----------------------------------------------------

  Future<void> forkFrom(UserItem message) async {
    final runtime = _active;
    if (runtime == null) return;
    if (runtime.isRunning) {
      _toast('当前回复还没结束，先停止它再分叉。');
      return;
    }
    if (await runtime.forkFrom(message)) await refreshSessions();
  }

  /// Forks a new session that keeps everything up to the reply before
  /// [nextMessage] (null: the last reply).
  Future<void> forkAfterReply(UserItem? nextMessage) async {
    final runtime = _active;
    if (runtime == null) return;
    if (runtime.isRunning) {
      _toast('当前回复还没结束，先停止它再分叉。');
      return;
    }
    if (await runtime.forkAfterReply(nextMessage)) await refreshSessions();
  }

  /// Duplicates the session at [path] (opening it first if needed).
  Future<void> cloneSession(String path) async {
    await openSession(path);
    final runtime = _active;
    if (runtime == null || runtime.isRunning) {
      _toast('对话正在进行，等它结束后再复制。');
      return;
    }
    if (await runtime.cloneSession()) await refreshSessions();
  }

  /// Renames the session at [path] (opening it first if needed).
  Future<void> renameSession(String path, String name) async {
    var runtime = _liveRuntimeFor(path);
    if (runtime == null) {
      await openSession(path);
      runtime = _active;
    }
    if (runtime == null) return;
    await runtime.rename(name);
    await refreshSessions();
  }

  /// Moves a session file to the Recycle Bin, closing it in the core first.
  Future<bool> deleteSession(String path, {void Function(Json)? onReceipt}) async {
    final live = _liveRuntimeFor(path);
    final wasActive = live != null && live == _active;
    if (live != null) {
      if (live.isRunning) await live.abort();
      if (wasActive) _active = null;
      await _closeInCore(live);
    }
    var deleted = false;
    try {
      final result = await backend.call('sessions.delete', {'path': path});
      if (result is Map) onReceipt?.call(result.cast<String, dynamic>());
      deleted = true;
    } catch (e) {
      _toast('删除失败：$e');
    }
    _unseen.remove(_key(path));
    if (wasActive || _active == null) {
      final blank = _runtimes.where((r) => r.isPristine && r.isReady && SessionStore.samePath(r.workspace, workspace)).firstOrNull;
      await _activate(blank ?? await _spawn());
    }
    unawaited(refreshSessions());
    return deleted;
  }

  // --- Settings ----------------------------------------------------------------

  Future<void> updateCoreSettings(Json patch) async {
    final result = await backend.call('settings.update', patch);
    coreSettings = asJsonMap(result);
    _notify();
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    await preferences.setThemeMode(mode);
    appearance.value = _currentAppearance;
    _notify();
  }

  /// Picks the painting theme for its side (daytime or night).
  Future<void> setPaintingTheme(PaintingTheme theme) async {
    if (theme.isDark) {
      await preferences.setDarkTheme(theme.id);
    } else {
      await preferences.setLightTheme(theme.id);
    }
    appearance.value = _currentAppearance;
    _notify();
  }

  Future<void> setTextScale(double scale) async {
    await preferences.setTextScale(scale);
    appearance.value = _currentAppearance;
    _notify();
  }

  bool get onboarded => preferences.onboarded;

  Future<void> finishOnboarding() async {
    await preferences.setOnboarded();
    _notify();
  }

  bool get runPanelOpen => preferences.runPanelOpen;

  /// Bumped when the composer's context ring is clicked; the right panel's context block scrolls into view (0.8.1 R.2).
  final contextFocus = ValueNotifier<int>(0);

  /// Opens the right panel at its context block (replaces the old centred context dialog).
  Future<void> showContextPanel() async {
    closeSideChat();
    if (!runPanelOpen) await setRunPanelOpen(true);
    contextFocus.value++;
  }

  Future<void> setRunPanelOpen(bool open) async {
    if (!open) closeSideChat();
    await preferences.setRunPanelOpen(open);
    _notifyBoth();
  }

  double get sidebarWidth => preferences.sidebarWidth;
  double get panelWidth => preferences.panelWidth;

  Future<void> setSidebarWidth(double width) async {
    await preferences.setSidebarWidth(width);
    _notifyBoth();
  }

  Future<void> setPanelWidth(double width) async {
    await preferences.setPanelWidth(width);
    _notifyBoth();
  }

  /// Window-wide settings (panel, widths) are shown by both the workbench and 蝶君.
  void _notifyBoth() {
    main._notify();
    main._butterfly?._notify();
  }

  Future<void> setZoom(double zoom) async {
    await preferences.setZoom(zoom.clamp(Preferences.zoomLevels.first, Preferences.zoomLevels.last));
    appearance.value = _currentAppearance;
    _notify();
  }

  /// One zoom step up ([step] 1), down (-1), or back to 100% (0).
  Future<void> stepZoom(int step) {
    const levels = Preferences.zoomLevels;
    if (step == 0) return setZoom(1.0);
    final next = step > 0 ? levels.where((l) => l > zoom + 0.001).firstOrNull : levels.where((l) => l < zoom - 0.001).lastOrNull;
    return setZoom(next ?? zoom);
  }

  Future<void> setApprovalMode(ApprovalMode mode) => _setting({'approvalMode': mode.id});

  /// Default for new sessions; also applied to the active session.
  Future<void> setDefaultAutoCompaction(bool enabled) async {
    await _setting({'autoCompaction': enabled});
    await _active?.setAutoCompaction(enabled);
  }

  Future<void> setDefaultModel(PiModel model) => _setting({'defaultModel': model.key});

  Future<void> setDefaultThinkingLevel(String level) => _setting({'defaultThinking': level.isEmpty ? null : level});

  Future<void> _setting(Json patch) async {
    try {
      await updateCoreSettings(patch);
    } catch (e) {
      _toast('保存设置失败：${SessionRuntime.describeError(e)}');
    }
  }

  /// Reopens idle sessions so they pick up changed Pi configuration (models,
  /// credentials, extensions). Running sessions are left alone.
  Future<void> reloadIdleSessions() async {
    for (final runtime in List.of(_runtimes)) {
      if (runtime.isRunning) continue;
      if (runtime == _active) {
        final slotId = runtime.slotId;
        if (slotId != null) {
          try {
            await backend.call('slot.close', {'slotId': slotId});
          } catch (_) {}
        }
        await runtime.restart();
      } else {
        await _closeInCore(runtime);
      }
    }
    _toast('已重新加载配置。');
    _notify();
  }

  /// Stops the core (and every session in it). Used by "quit and stop background work".
  Future<void> shutdownCore() async {
    final core = backend;
    if (core is CoreBackend) return core.shutdownCore();
    try {
      await backend.call('core.shutdown');
    } catch (_) {}
  }

  void _toast(String message) {
    final parent = parentController;
    if (parent != null) return parent._toast(message);
    if (!_toasts.isClosed) _toasts.add(message);
  }

  void _notify() {
    if (!_disposed) { reportConversationPresence(); notifyListeners(); }
  }

  static String _key(String path) => Platform.isWindows ? p.normalize(path).toLowerCase() : p.normalize(path);
}

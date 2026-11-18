import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 'agent_controller.dart';
import 'preferences.dart';

/// 「入门 5 课」(route step 4, user 2026-11-18, design docs/design/prototype/onboarding-detail.html):
/// the five required lessons done in the real window. Each step dims the window except one place,
/// says in one plain sentence what to do there, and moves on when the app sees it done. The same
/// lessons, and five more, are the guide (app/assets/guide).

/// What a step's check can look at.
class TourContext {
  TourContext(this.agent, this.baseline, this.signals);
  final AgentController agent;
  /// Numbers taken when the step began (messages so far, …).
  final Map<String, int> baseline;
  /// Moments the app reported since the step began ('copied', 'approved', …).
  final Set<String> signals;
  AgentController? get butterfly => agent.butterfly;
}

enum TourAction { fillComposer, practiceFolder, provisionSandbox, later }

class TourStep {
  const TourStep(this.title, this.text, {this.anchor, this.fill, this.done, this.action, this.actionLabel});
  final String title, text;
  /// The TourAnchor id lit up; null: nothing dimmed, the card sits at the bottom.
  final String? anchor;
  /// Text 「帮我填好」 puts into the composer.
  final String? fill;
  /// Null: a step to read, with 「看懂了」.
  final bool Function(TourContext)? done;
  final TourAction? action;
  final String? actionLabel;
}

class TourLesson {
  const TourLesson(this.title, this.guide, this.steps, {this.alreadyDone});
  final String title;
  /// Index in guideLessons.
  final int guide;
  final List<TourStep> steps;
  /// The whole lesson is done already (a model connected in the setup wizard).
  final bool Function(AgentController)? alreadyDone;
}

int userMessages(AgentController? a) => a?.transcript.items.whereType<UserItem>().length ?? 0;
bool replied(AgentController? a) => a != null && !a.isRunning && a.transcript.items.isNotEmpty && a.transcript.items.last is AssistantItem;
bool modelConnected(AgentController a) => a.gatewayChannels.any((c) => c.enabled);

const practicePrompt = '把 销售记录.xlsx 里重复的行删掉，日期统一成 年-月-日，按月份汇总成一张新表，存成 汇总.xlsx';
const leavePrompt = '帮我写一张明天请假一天的请假条，理由是去医院复查';
const reportPrompt = '帮我查一下今年国内新能源车销量前五的品牌，写一份一页的小报告';

final tourLessons = <TourLesson>[
  TourLesson('Agent 是什么', 0, [
    const TourStep('它会动手', 'DreamFlutter 是一个会动手的助手：除了回答问题，它还能读写你电脑上的文件、运行程序、上网查资料，把一件事从头做到尾。'),
    const TourStep('两种用法', '「工作台」：你在旁边看着它做，它改你的文件前会先问你。「蝶君」：交给它一件事就可以走开，它在一个隔离的小系统里自己做完。', anchor: 'place-switch'),
    const TourStep('它需要一个大脑', '做这些事要靠一个 AI 模型来思考。下一课把它接上。'),
  ]),
  TourLesson('接上一个模型', 1, alreadyDone: modelConnected, [
    const TourStep('先弄懂两个词', '「模型」是帮你思考的 AI，「密钥」是你在模型公司的账号凭证，像一把钥匙。我们用 DeepSeek 举例：便宜，国内能直接用。'),
    TourStep('打开设置', '点左下角的齿轮。', anchor: 'settings-gear', done: (c) => c.agent.section == AppSection.settings),
    TourStep('添加渠道', '点左边的「模型」，再在「渠道」那块点「添加渠道」。', anchor: 'gateway-add|settings-nav-模型', done: (c) => c.signals.contains('channel-editor')),
    const TourStep('拿密钥', '服务商选「DeepSeek」，点「去 DeepSeek 拿密钥 ↗」。网站上的注册、充值、建密钥几步，点下面的「看图文说明」一张图一张图跟着做。'),
    TourStep('粘贴并保存', '把复制的密钥粘贴到「密钥」框里，看到「连接成功」后点「保存」。', done: (c) => modelConnected(c.agent)),
  ]),
  TourLesson('第一次对话', 2, [
    TourStep('开一个新对话', '点左边的「新对话」。', anchor: 'nav-new', done: (c) => c.agent.section == AppSection.chat && c.agent.transcript.items.isEmpty),
    TourStep('跟它说句话', '在这个框里打一句话，比如「$leavePrompt」。不想打字就点「帮我填好」，然后按 Enter。这一步会花几分钱。', anchor: 'composer', fill: leavePrompt, action: TourAction.fillComposer, actionLabel: '帮我填好', done: (c) => userMessages(c.agent) > (c.baseline['user'] ?? 0)),
    TourStep('看它写', '字是一点点冒出来的。想让它停，点右下角的方块。这次等它写完就好。', anchor: 'send', done: (c) => replied(c.agent)),
    TourStep('复制回复', '把鼠标移到它的回复上，下面会出现一排小按钮，点「复制」，就能粘到微信或 Word 里。', done: (c) => c.signals.contains('copied')),
    const TourStep('接着说', '不满意可以直接接着说，比如「语气再正式一点」。它记得前面说过的话。'),
  ]),
  TourLesson('让它动手干活', 3, [
    TourStep('换到练习文件夹', '「工作区」是它能动的文件夹。我们准备了一个练习文件夹，里面有一张乱的销售表，随便它改。点「用练习文件夹」。', anchor: 'workspace', action: TourAction.practiceFolder, actionLabel: '用练习文件夹', done: (c) => c.signals.contains('practice')),
    const TourStep('先问我', '看这里：「先问我」表示它要改文件、运行程序前会先问你。刚开始请一直开着。', anchor: 'ask-first'),
    TourStep('让它干活', '让它整理那张表。可以点「帮我填好」，然后按 Enter。', anchor: 'composer', fill: practicePrompt, action: TourAction.fillComposer, actionLabel: '帮我填好', done: (c) => userMessages(c.agent) > (c.baseline['user'] ?? 0)),
    TourStep('它会先问你', '它准备写文件或运行程序时，对话里会出现一张卡片。看清它要做什么，点「允许」。', done: (c) => c.signals.contains('approved') || replied(c.agent)),
    TourStep('看它改了什么', '做完后点右上角这个按钮，打开「这个对话」，在「文件」里能看到它新建的 汇总.xlsx，点一下就能打开。', anchor: 'details-toggle', done: (c) => c.agent.runPanelOpen),
  ]),
  TourLesson('认识蝶君', 4, [
    TourStep('切到蝶君', '点左上角的「蝶君」。', anchor: 'place-butterfly', done: (c) => c.agent.section == AppSection.butterfly),
    TourStep('建好沙箱', '蝶君在自己的「沙箱」里干活：一个隔离的小系统，看不到你的文件。第一次要先建好，会下载约 650 MB；没有 WSL 的电脑会弹出管理员确认，点「是」，可能要重启一次，重启后会自动接着建。建的时候可以先去做别的。', action: TourAction.provisionSandbox, actionLabel: '建立沙箱', done: (c) => c.agent.sandboxStatus.value?['state'] == 'ready'),
    TourStep('交给它一件事', '让它查资料写一份小报告。这件事大约 5–15 分钟、花 1–3 角钱。可以点「帮我填好」，然后按 Enter。', anchor: 'composer', fill: reportPrompt, action: TourAction.fillComposer, actionLabel: '帮我填好', done: (c) => userMessages(c.butterfly) > (c.baseline['butterfly'] ?? 0)),
    const TourStep('让它自己做', '它会先列个计划，然后自己去查、去写。右边能看到目标、进度和花了多少钱。你现在可以去干别的。'),
    TourStep('验收', '做完它会通知你，报告出现在「等你处理」的「等你验收」里。点「打开看看」，满意就点「收下」。', anchor: 'attention-page|nav-attention', action: TourAction.later, actionLabel: '做完再看', done: (c) => c.signals.contains('accepted')),
  ]),
];

/// Progress through the five lessons, kept in the window's preferences.
class OnboardingTour extends ChangeNotifier {
  OnboardingTour(this._prefs) {
    final saved = _prefs.tour;
    lesson = saved.lesson.clamp(0, tourLessons.length);
    step = saved.step;
    closed = saved.closed;
    waitingForReport = saved.waitingForReport;
    if (current != null && step >= current!.steps.length) step = 0;
  }
  final Preferences _prefs;
  int lesson = 0, step = 0;
  /// The card is showing (the user started or continued, and did not leave).
  bool showing = false;
  /// 「不用了」, or all five done: the sidebar card is gone for good.
  bool closed = false;
  final baseline = <String, int>{};
  final signals = <String>{};
  /// Lesson 5 left waiting for 蝶君's report (「做完再看」): the next acceptance finishes it.
  bool waitingForReport = false;

  bool get finished => lesson >= tourLessons.length;
  TourLesson? get current => finished ? null : tourLessons[lesson];
  TourStep? get currentStep => current?.steps[step];

  Future<void> _save() => _prefs.setTour(lesson: lesson, step: step, closed: closed, waitingForReport: waitingForReport);

  void start(AgentController agent) {
    showing = true;
    _begin(agent);
  }

  void leave() {
    showing = false;
    notifyListeners();
  }

  /// 「不用了」: the card goes away; the guide stays in 设置 › 关于与更新.
  void close() {
    closed = true;
    showing = false;
    notifyListeners();
    _save();
  }

  void _begin(AgentController agent) {
    signals.clear();
    baseline
      ..['user'] = userMessages(agent)
      ..['butterfly'] = userMessages(agent.butterfly);
    final lessonNow = current;
    if (lessonNow?.alreadyDone?.call(agent) == true && step == 0) {
      _nextLesson(agent);
      return;
    }
    notifyListeners();
    _save();
  }

  void _nextLesson(AgentController agent) {
    lesson++;
    step = 0;
    if (finished) {
      closed = true;
    }
    _begin(agent);
  }

  /// Next step (or lesson).
  void advance(AgentController agent) {
    final lessonNow = current;
    if (lessonNow == null) return;
    if (step + 1 < lessonNow.steps.length) {
      step++;
      _begin(agent);
    } else {
      _nextLesson(agent);
    }
  }

  /// 「做完再看」on the last step: the lesson waits for 蝶君's report in the background.
  void later(AgentController agent) {
    waitingForReport = true;
    showing = false;
    _nextLesson(agent);
  }

  /// A moment the app saw ('copied', 'approved', 'accepted', 'channel-editor', 'practice', 'sent').
  void signal(String name, AgentController agent) {
    if (name == 'accepted' && waitingForReport) {
      waitingForReport = false;
      _save();
    }
    if (!showing) return;
    signals.add(name);
    check(agent);
  }

  /// Moves on when the current step is done.
  void check(AgentController agent) {
    final s = currentStep;
    if (!showing || s?.done == null) return;
    if (s!.done!(TourContext(agent, baseline, signals))) advance(agent);
  }
}

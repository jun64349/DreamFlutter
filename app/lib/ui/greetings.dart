/// The one line under the butterfly on a new conversation (0.4, v0.3.1 test 5:
/// 「只保留 logo 和一句问候语，问候语多做一些然后随机显示」). Half the time a line for
/// the hour, half the time one for any hour; 蝶君 has its own.
library;

const _dawn = [
  '早，今天也轻盈一点。',
  '晨光正好，从哪件事开始？',
  '新的一天，先做最想做的那件。',
  '早安，蝴蝶刚醒。',
];

const _morning = [
  '上午好，想把什么理清楚？',
  '趁头脑清醒，啃一块硬骨头吧。',
  '上午的时间最值钱，交给我一件事。',
  '先把最重要的那件拿出来。',
];

const _afternoon = [
  '午后好，慢慢来，比较快。',
  '阳光斜了，事情还来得及。',
  '下午茶的工夫，也能做完一件事。',
  '午后困了？琐碎的交给我。',
];

const _evening = [
  '晚上好，收个尾，还是开个头？',
  '暮色温柔，适合整理今天。',
  '一天快过完了，还差哪一件？',
  '晚饭前，再推一小步。',
];

const _night = [
  '夜深了，做完这件就休息吧。',
  '灯还亮着，我陪你。',
  '夜里安静，正好想清楚一件事。',
  '星星都在，慢慢说。',
];

const _anyTime = [
  '栩栩然胡蝶也。',
  '今天想做点什么？',
  '有什么想交给我的？',
  '说说看，从哪里开始。',
  '一只蝴蝶，等你开口。',
  '把乱的理顺，把远的拉近。',
  '想到哪儿，就从哪儿开始。',
  '此刻，适合做一件小事。',
  '不急，一件一件来。',
  '梦里梦外，都可以聊聊。',
];

const _butterfly = [
  '蝶君在沙箱里，随时可以动手。',
  '交给蝶君吧，它不怕麻烦。',
  '装软件、跑代码，蝶君自己来。',
  '拖个文件进来，蝶君看看。',
  '蝶君醒着，等你吩咐。',
  '栩栩然胡蝶也。',
];

/// Every line there is, for a check that none is too long for the page.
List<String> get allGreetings => [..._dawn, ..._morning, ..._afternoon, ..._evening, ..._night, ..._anyTime, ..._butterfly];

/// The lines for the hour of [now].
List<String> greetingsFor(DateTime now) => switch (now.hour) {
  >= 5 && < 9 => _dawn,
  >= 9 && < 12 => _morning,
  >= 12 && < 18 => _afternoon,
  >= 18 && < 21 => _evening,
  _ => _night,
};

/// A greeting chosen by [seed] (the same seed gives the same line, so it does not change while the page is rebuilt).
String pickGreeting({required DateTime now, required int seed, bool butterfly = false}) {
  final n = seed.abs();
  if (butterfly) return _butterfly[n % _butterfly.length];
  final pool = n.isEven ? greetingsFor(now) : _anyTime;
  return pool[(n ~/ 2) % pool.length];
}

const literaryLines = [
  ('昔者庄周梦为胡蝶，栩栩然胡蝶也。', '《庄子·齐物论》'),
  ('天地有大美而不言。', '《庄子·知北游》'),
  ('且夫水之积也不厚，则其负大舟也无力。', '《庄子·逍遥游》'),
];

(String, String) pickLiteraryLine(int seed) => literaryLines[seed.abs() % literaryLines.length];

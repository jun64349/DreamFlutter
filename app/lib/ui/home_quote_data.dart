/// Each entry carries the page used to verify its original wording.
/// Chinese is simplified from Wikisource's classical text; English excerpts
/// preserve each author's words, with verse line breaks joined for the UI.
class HomeQuoteContent {
  const HomeQuoteContent(
    this.original,
    this.source,
    this.sourceUrl, {
    this.translation,
  });
  final String original;
  final String source;
  final String sourceUrl;
  final String? translation;
  bool get isForeign => translation != null;
}

const _xiao = 'https://zh.wikisource.org/zh-hans/%E9%80%8D%E9%81%A5%E6%B8%B8';
const _qiwu =
    'https://zh.wikisource.org/wiki/%E8%8E%8A%E5%AD%90/%E9%BD%8A%E7%89%A9%E8%AB%96';
const _tempest3 =
    'https://www.folger.edu/explore/shakespeares-works/the-tempest/read/3/2/';
const _tempest4 =
    'https://www.folger.edu/explore/shakespeares-works/the-tempest/read/4/1/';
const _tempest5 =
    'https://www.folger.edu/explore/shakespeares-works/the-tempest/read/5/1/';
const _sonnets =
    'https://www.folger.edu/explore/shakespeares-works/shakespeares-sonnets/read/';
const _asYouLikeIt =
    'https://www.folger.edu/explore/shakespeares-works/as-you-like-it/read/';
const _blake = 'https://www.gutenberg.org/files/45315/45315-h/45315-h.htm';
const _thoreau =
    'https://en.wikisource.org/wiki/Walden_(1854)_Thoreau/Where_I_Lived,_and_What_I_Lived_for';
const _walden = 'https://dev.gutenberg.org/cache/epub/205/pg205-images.html';
const _emerson = 'https://www.gutenberg.org/files/2944/2944-h/2944-h.htm';

const chineseHomeQuotes = <HomeQuoteContent>[
  HomeQuoteContent('北冥有鱼，其名为鲲。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('化而为鸟，其名为鹏。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('其翼若垂天之云。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('南冥者，天池也。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('野马也，尘埃也，生物之以息相吹也。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('天之苍苍，其正色邪？', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('小知不及大知，小年不及大年。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('朝菌不知晦朔，蟪蛄不知春秋。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('绝云气，负青天，然后图南。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('举世而誉之，而不加劝；举世而非之，而不加沮。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('夫列子御风而行，泠然善也。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('至人无己，神人无功，圣人无名。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('鹪鹩巢于深林，不过一枝。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('偃鼠饮河，不过满腹。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('彷徨乎无为其侧，逍遥乎寝卧其下。', '《庄子·逍遥游》', _xiao),
  HomeQuoteContent('今者吾丧我。', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('夫大块噫气，其名为风。', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('泠风则小和，飘风则大和。', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('彼出于是，是亦因彼。', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('道恶乎往而不存？', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('道，行之而成；物，谓之而然。', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('枢始得其环中，以应无穷。', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('天地与我并生，而万物与我为一。', '《庄子·齐物论》', _qiwu),
  HomeQuoteContent('故知止其所不知，至矣。', '《庄子·齐物论》', _qiwu),
];

const foreignHomeQuotes = <HomeQuoteContent>[
  HomeQuoteContent(
    'We are such stuff as dreams are made on, and our little life is rounded with a sleep.',
    '莎士比亚《暴风雨》第四幕第一场',
    _tempest4,
    translation: '我们由梦织成，短暂的一生也以睡眠收尾。',
  ),
  HomeQuoteContent(
    'The rarer action is in virtue than in vengeance.',
    '莎士比亚《暴风雨》第五幕第一场',
    _tempest5,
    translation: '宽厚比报复更难得。',
  ),
  HomeQuoteContent(
    'The isle is full of noises, sounds and sweet airs that give delight and hurt not.',
    '莎士比亚《暴风雨》第三幕第二场',
    _tempest3,
    translation: '岛上满是声响与柔风，令人欣喜，不会伤人。',
  ),
  HomeQuoteContent(
    'Shall I compare thee to a summer’s day?',
    '莎士比亚《十四行诗》第18首',
    '${_sonnets}18/',
    translation: '我能否将你比作夏日？',
  ),
  HomeQuoteContent(
    'Thou art more lovely and more temperate.',
    '莎士比亚《十四行诗》第18首',
    '${_sonnets}18/',
    translation: '你更可爱，也更温和。',
  ),
  HomeQuoteContent(
    'So long as men can breathe or eyes can see, so long lives this, and this gives life to thee.',
    '莎士比亚《十四行诗》第18首',
    '${_sonnets}18/',
    translation: '只要人仍能呼吸、看见，此诗便长存，让你也长存。',
  ),
  HomeQuoteContent(
    'For thy sweet love remembered such wealth brings that then I scorn to change my state with kings.',
    '莎士比亚《十四行诗》第29首',
    '${_sonnets}29/',
    translation: '想起你的爱便觉富足，连王位也不愿换。',
  ),
  HomeQuoteContent(
    'But if the while I think on thee, dear friend, all losses are restored and sorrows end.',
    '莎士比亚《十四行诗》第30首',
    '${_sonnets}30/',
    translation: '可当我想起你，亲爱的朋友，失去的都归来，悲伤也止息。',
  ),
  HomeQuoteContent(
    'Like as the waves make towards the pebbled shore, so do our minutes hasten to their end.',
    '莎士比亚《十四行诗》第60首',
    '${_sonnets}60/',
    translation: '如波浪奔向卵石岸边，时光也奔向尽头。',
  ),
  HomeQuoteContent(
    'Let me not to the marriage of true minds admit impediments.',
    '莎士比亚《十四行诗》第116首',
    '${_sonnets}116/',
    translation: '愿我不阻碍两颗真心相合。',
  ),
  HomeQuoteContent(
    'Love alters not with his brief hours and weeks, but bears it out even to the edge of doom.',
    '莎士比亚《十四行诗》第116首',
    '${_sonnets}116/',
    translation: '爱不随时日而变，直到末日也始终如一。',
  ),
  HomeQuoteContent(
    'All the world’s a stage, and all the men and women merely players.',
    '莎士比亚《皆大欢喜》第二幕第七场',
    _asYouLikeIt,
    translation: '世界是舞台，世人都是台上的演员。',
  ),
  HomeQuoteContent(
    'In seed-time learn, in harvest teach, in winter enjoy.',
    '布莱克《天堂与地狱的婚姻》',
    _blake,
    translation: '播种时学习，收获时教导，冬日里享受。',
  ),
  HomeQuoteContent(
    'A fool sees not the same tree that a wise man sees.',
    '布莱克《天堂与地狱的婚姻》',
    _blake,
    translation: '愚人与智者看到的不是同一棵树。',
  ),
  HomeQuoteContent(
    'No bird soars too high if he soars with his own wings.',
    '布莱克《天堂与地狱的婚姻》',
    _blake,
    translation: '凭自己的翅膀飞翔，鸟儿不会飞得太高。',
  ),
  HomeQuoteContent(
    'What is now proved was once only imagined.',
    '布莱克《天堂与地狱的婚姻》',
    _blake,
    translation: '如今已被证实的，曾经只是想象。',
  ),
  HomeQuoteContent(
    'Our life is frittered away by detail.',
    '梭罗《瓦尔登湖》“我住在哪里，为何而活”',
    _thoreau,
    translation: '琐事耗散了我们的生命。',
  ),
  HomeQuoteContent(
    'Time is but the stream I go a-fishing in.',
    '梭罗《瓦尔登湖》“我住在哪里，为何而活”',
    _thoreau,
    translation: '时间只是我垂钓其中的一条溪流。',
  ),
  HomeQuoteContent(
    'Heaven is under our feet as well as over our heads.',
    '梭罗《瓦尔登湖》“池塘”',
    _walden,
    translation: '天堂既在头顶，也在脚下。',
  ),
  HomeQuoteContent(
    'The morning wind forever blows, the poem of creation is uninterrupted; but few are the ears that hear it.',
    '梭罗《瓦尔登湖》“我住在哪里，为何而活”',
    _thoreau,
    translation: '晨风永远吹拂，创世的诗篇从未停歇，却少有人倾听。',
  ),
  HomeQuoteContent(
    'Trust thyself: every heart vibrates to that iron string.',
    '爱默生《论自立》',
    _emerson,
    translation: '相信自己：每颗心都与这根铁弦共振。',
  ),
  HomeQuoteContent(
    'Insist on yourself; never imitate.',
    '爱默生《论自立》',
    _emerson,
    translation: '坚持做自己，不要模仿。',
  ),
  HomeQuoteContent(
    'Nothing is at last sacred but the integrity of your own mind.',
    '爱默生《论自立》',
    _emerson,
    translation: '归根到底，唯有内心的完整不可侵犯。',
  ),
  HomeQuoteContent(
    'Nothing can bring you peace but yourself.',
    '爱默生《论自立》',
    _emerson,
    translation: '唯有自己能带给你安宁。',
  ),
];

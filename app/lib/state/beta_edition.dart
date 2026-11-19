/// 内测版（第 6 步朋友内测，用户 2026-11-19 定，见 docs/design/beta-pool.md）。
/// 打包时加 `--dart-define=DREAMFLUTTER_BETA=true`；平时的开发和开放版都是 false。
library;

const kBetaEdition = bool.fromEnvironment('DREAMFLUTTER_BETA');

/// 用户的腾讯文档反馈表。
const betaFeedbackUrl = 'https://docs.qq.com/doc/DVm1zU2VmU1JIVHZn';

/// 只走随想 GPT Pro 分组；激活码就是用户在随想上给每人建的 API Key。
const betaChannelName = '模型池';
const betaBaseUrl = 'https://www.sui-xiang.net/v1';
const betaTerra = 'gpt-6.1-terra';
const betaSol = 'gpt-6.2-sol';

/// 价格是随想实际扣费（官方价 × 0.25），美元 / 百万 token。
/// gpt-6.2-sol 的价格随想价目里还没有，先按 gpt-6.1-sol 记，核对后再改。
const _efforts = ['low', 'medium', 'high'];
List<Map<String, Object?>> betaModels() => [
  {'id': betaTerra, 'name': 'GPT-6.1 Terra', 'reasoning': true, 'input': ['text', 'image'], 'contextWindow': 500000, 'maxTokens': 64000,
    'cost': {'input': 0.25, 'output': 1.25, 'cacheRead': 0.0125, 'cacheWrite': 0}, 'efforts': _efforts},
  {'id': betaSol, 'name': 'GPT-6.2 Sol', 'reasoning': true, 'input': ['text', 'image'], 'contextWindow': 500000, 'maxTokens': 64000,
    'cost': {'input': 0.5, 'output': 2.5, 'cacheRead': 0.025, 'cacheWrite': 0}, 'efforts': _efforts},
];

/// 激活或换激活码失败时给朋友看的一句话（用户 2026-11-19：额度用完要说明白）。
/// 随想：Key 停用或不对是 401 INVALID_API_KEY，额度用完是 429 API_KEY_QUOTA_EXHAUSTED。
String betaActivationError(Object error) {
  final t = '$error';
  if (RegExp(r'QUOTA_EXHAUSTED|额度已用完|额度用完|quota', caseSensitive: false).hasMatch(t)) return '这个激活码的额度已经用完';
  if (RegExp(r'401|403|INVALID_API_KEY|无效|停用|invalid', caseSensitive: false).hasMatch(t)) return '激活码不对或已经停用';
  return '暂时连不上，检查网络后再试';
}

/// 模型菜单里跟在模型名后面的用途（用户 2026-11-19）；不是内测版或别的模型时为 null。
String? betaModelNote(String id) => !kBetaEdition ? null : switch (id) {
  betaTerra => '日常对话、工作任务',
  betaSol => '困难、深度任务',
  _ => null,
};

Map<String, Object?> betaChannel(String key, {String? id}) => {
  'id': ?id,
  'name': betaChannelName,
  'platform': 'openai-relay',
  'kind': 'relay',
  'api': 'openai-completions',
  'baseUrl': betaBaseUrl,
  'models': betaModels(),
  'keys': [{'secret': key}],
};

/// 四个用途：对话、小任务、看图用 Terra，大任务用 Sol。
Map<String, String> betaUses(String provider) => {
  'conversation': '$provider/$betaTerra',
  'small': '$provider/$betaTerra',
  'large': '$provider/$betaSol',
  'vision': '$provider/$betaTerra',
};

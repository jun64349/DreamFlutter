export const BUTTERFLY_MEMORY_SOURCES = ["chat", "work", "learning"] as const;
export type ButterflyMemorySource = (typeof BUTTERFLY_MEMORY_SOURCES)[number];

export function isButterflyMemorySource(value: unknown): value is ButterflyMemorySource {
	return BUTTERFLY_MEMORY_SOURCES.some(source => source === value);
}

/** Catch the known name attribution error even when the model omitted kind=persona. */
export function misattributesButterflyName(content: string): boolean {
	return /^\s*用户\s*(?:的(?:名字|昵称)(?:是|叫)|叫(?:作)?|名叫|是)\s*[「『"'“‘]?蝶君(?:[」』"'”’\s，。！？、；：,.!?;:]|$)/u.test(content);
}

export function startsWithUserProfile(content: string): boolean {
	return /^\s*用户\s*(?:的(?:名字|姓名|昵称|偏好|生日|住址|职业)|叫(?:作)?|名叫|偏好|喜欢|不喜欢|讨厌|习惯|住在|出生于)/u.test(content);
}

/** Shared by logs, diagnostics and tool-result adapters. Values never leave this process. */
export const MASK = "〔已遮盖：疑似密钥〕";
const known = new Set<string>();

export function rememberSecret(value: string): void {
	if (value) known.add(value);
}

export function redact(text: string, diagnostic = false, preserveLines = false): string {
	const replacement = (value: string) => MASK + (preserveLines ? "\n".repeat((value.match(/\n/g) ?? []).length) : "");
	let result = text.replace(/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g, replacement);
	// A tail-only tool result can retain the END marker after its BEGIN was truncated.
	result = result.replace(/^[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/, replacement);
	for (const secret of [...known].sort((a, b) => b.length - a.length)) result = result.split(secret).join(replacement(secret));
	result = result.replace(/\b(?:sk-(?:ant-[\w-]+|[A-Za-z0-9_-]{20,})|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, MASK);
	if (diagnostic) {
		result = result.replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s"',}]+/gi, `$1${MASK}`);
		result = result.replace(/\b(https?|socks5h?):\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, `$1://${MASK}@`);
	}
	return result;
}

/** Preserves structure, including binary content; text is scrubbed before serialization. */
export function redactValue<T>(value: T, diagnostic = false): T {
	if (typeof value === "string") return redact(value, diagnostic) as T;
	if (Array.isArray(value)) return value.map((v) => redactValue(v, diagnostic)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
			diagnostic && /^(authorization|proxy-authorization)$/i.test(k) ? MASK : redactValue(v, diagnostic),
		])) as T;
	}
	return value;
}

/** Channel-page sign-in policy only; stored credentials and Pi refresh are unchanged. */
export const CHATGPT_OAUTH_PROVIDER = "openai";
const CHANNEL_OAUTH_LOGIN_PROVIDERS: ReadonlySet<string> = new Set([CHATGPT_OAUTH_PROVIDER]);

export function canLoginChannelOAuth(provider: string): boolean {
	return CHANNEL_OAUTH_LOGIN_PROVIDERS.has(provider);
}

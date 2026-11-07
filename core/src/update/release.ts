export const LATEST_RELEASE = "https://api.github.com/repos/jun64349/DreamFlutter/releases/latest";
export const ISSUES = "https://github.com/jun64349/DreamFlutter/issues/new";
export class UpdateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export interface ReleaseAsset { name: string; size: number; url: string; sha256: string; signatureUrl?: string; }
export interface Release { version: string; notes: string; page: string; asset: ReleaseAsset; }
export interface Version { numbers: bigint[]; pre: string[]; }
export function version(value: string): Version {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || value.length > 150) throw new UpdateError("invalid_version", "发布版本格式不正确，未开始更新。");
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((s) => /^\d+$/.test(s) && s.length > 1 && s.startsWith("0"))) throw new UpdateError("invalid_version", "发布版本格式不正确，未开始更新。");
  return { numbers: match.slice(1, 4).map((s) => BigInt(s!)), pre };
}
export function compareVersions(a: string, b: string): number {
  const x = version(a), y = version(b);
  const compare = (a: bigint | string, b: bigint | string) => a === b ? 0 : a > b ? 1 : -1;
  for (let i = 0; i < 3; i++) { const d = compare(x.numbers[i]!, y.numbers[i]!); if (d) return d; }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const a = x.pre[i], b = y.pre[i]; if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    const d = an && bn ? compare(BigInt(a), BigInt(b)) : an !== bn ? an ? -1 : 1 : compare(a, b); if (d) return d;
  }
  return 0;
}
export function localSource(value?: string): string | undefined {
  if (!value) return;
  let url: URL; try { url = new URL(value); } catch { throw new UpdateError("invalid_source", "开发更新源地址不正确。"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash || url.search) throw new UpdateError("invalid_source", "开发更新源只允许本机 HTTP 地址。");
  return url.href.replace(/\/$/, "");
}
export function permittedUrl(value: string, testSource?: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new UpdateError("invalid_asset", "更新附件地址不正确。"); }
  if (url.username || url.password || url.hash) throw new UpdateError("invalid_asset", "更新附件地址不受信任。");
  if (testSource) { if (url.origin === new URL(testSource).origin) return url; }
  else if (url.protocol === "https:" && ["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(url.hostname)) return url;
  throw new UpdateError("invalid_asset", "更新附件地址不受信任。");
}
export async function request(url: string, options: { testSource?: string; signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<Response> {
  let current = permittedUrl(url, options.testSource);
  for (let redirects = 0; redirects <= 5; redirects++) {
    let response: Response;
    try { response = await (options.fetch ?? fetch)(current, { redirect: "manual", headers: { "User-Agent": "DreamFlutter-updates", Accept: "application/vnd.github+json" }, signal: options.signal ?? AbortSignal.timeout(30_000), credentials: "omit" }); }
    catch { if (options.signal?.aborted) throw new UpdateError("cancelled", "更新操作已取消。"); throw new UpdateError("offline", "无法连接更新服务，请检查网络后重试。"); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); const location = response.headers.get("location"); if (!location) break;
      current = permittedUrl(new URL(location, current).href, options.testSource); continue;
    }
    if (response.status === 404) { await response.body?.cancel(); throw new UpdateError("no_release", "尚无可用发布。"); }
    if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") { await response.body?.cancel(); throw new UpdateError("rate_limited", "更新服务暂时限流，请稍后重试。"); }
    if (!response.ok) { await response.body?.cancel(); throw new UpdateError("service_error", "更新服务暂时不可用，请稍后重试。"); }
    return response;
  }
  throw new UpdateError("invalid_asset", "更新服务重定向次数过多。");
}
export async function limitedText(response: Response, max = 1024 * 1024): Promise<string> {
  let length = 0; const parts: Uint8Array[] = [];
  if (!response.body) throw new UpdateError("invalid_release", "更新服务返回的内容不完整。");
  const reader = response.body.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > max) throw new UpdateError("invalid_release", "更新服务返回的内容过大。"); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString("utf8");
}
/** Exact name binds platform, architecture and full-package type; source archives cannot match. */
export async function parseRelease(data: unknown, options: { platform?: string; arch?: string; testSource?: string; checksum?: (url: string) => Promise<string> }): Promise<Release> {
  const release = data as any;
  if (!release || typeof release.tag_name !== "string") throw new UpdateError("invalid_version", "发布版本格式不正确，未开始更新。");
  version(release.tag_name); const tag = release.tag_name.replace(/^v/, "");
  if (release.draft === true) throw new UpdateError("no_release", "尚无可用发布。");
  const rid = `${options.platform === "win32" || options.platform === undefined ? "win" : options.platform}-${options.arch ?? "x64"}`;
  const name = `DreamFlutter-${tag}-${rid}-full.nupkg`;
  const matches = (Array.isArray(release.assets) ? release.assets : []).filter((asset: any) => asset.name === name);
  if (matches.length !== 1) throw new UpdateError("no_asset", "此版本没有匹配当前平台、架构的更新包。");
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 4 * 1024 ** 3 || typeof asset.browser_download_url !== "string") throw new UpdateError("invalid_asset", "更新附件信息不完整。");
  permittedUrl(asset.browser_download_url, options.testSource);
  let sha256 = /^sha256:([a-f\d]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
  if (!sha256 && options.checksum) {
    const checks = release.assets.filter((a: any) => a.name === "SHA256SUMS" || a.name === `${name}.sha256`);
    if (checks.length === 1) {
      permittedUrl(checks[0].browser_download_url, options.testSource);
      const lines = (await options.checksum(checks[0].browser_download_url)).split(/\r?\n/);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hashes = lines.flatMap((line: string) => { const m = new RegExp(`^([a-fA-F0-9]{64})(?:\\s+\\*?${escaped})?\\s*$`).exec(line); return m ? [m[1]!.toLowerCase()] : []; });
      if (hashes.length === 1) sha256 = hashes[0];
    }
  }
  if (!sha256) throw new UpdateError("missing_digest", "更新包缺少 SHA-256 校验信息，无法下载。");
  const signatures = release.assets.filter((a: any) => a.name === `${name}.signature.json`);
  if (signatures.length > 1) throw new UpdateError("invalid_asset", "更新签名附件不唯一。");
  const signatureUrl = signatures[0]?.browser_download_url;
  if (signatureUrl) permittedUrl(signatureUrl, options.testSource);
  return { version: tag, notes: typeof release.body === "string" ? release.body.slice(0, 100_000) : "", page: typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/jun64349/DreamFlutter/releases/") ? release.html_url : "", asset: { name, size: asset.size, url: asset.browser_download_url, sha256, signatureUrl } };
}

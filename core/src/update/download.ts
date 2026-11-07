import { createHash, verify, X509Certificate } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { limitedText, request, UpdateError, type ReleaseAsset } from "./release.ts";

export interface PackageSignature { state: "unsigned" | "untrusted" | "trusted-test"; thumbprint?: string; subject?: string; }
export function verifySignature(sha256: string, data: unknown, testThumbprints: string[] = []): PackageSignature {
  try {
    const proof = data as { certificate: string; signature: string; algorithm: string };
    if (proof.algorithm !== "RSA-SHA256" || typeof proof.certificate !== "string" || typeof proof.signature !== "string" || proof.certificate.length > 32_000 || proof.signature.length > 16_000) throw Error();
    const cert = new X509Certificate(proof.certificate);
    if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) < Date.now() || !verify("sha256", Buffer.from(sha256, "ascii"), cert.publicKey, Buffer.from(proof.signature, "base64"))) throw Error();
    const thumbprint = cert.fingerprint256.replaceAll(":", "").toLowerCase();
    return { state: testThumbprints.map((x) => x.toLowerCase()).includes(thumbprint) ? "trusted-test" : "untrusted", thumbprint, subject: cert.subject.slice(0, 200) };
  } catch { throw new UpdateError("invalid_signature", "更新包签名校验失败，已阻止安装。"); }
}
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}
export async function downloadPackage(asset: ReleaseAsset, out: string, options: { testSource?: string; fetch?: typeof fetch; signal?: AbortSignal; testThumbprints?: string[]; onProgress?: (received: number) => void } = {}): Promise<PackageSignature> {
  const partial = out + ".partial"; await mkdir(dirname(out), { recursive: true });
  try {
    const response = await request(asset.url, options);
    const header = response.headers.get("content-length");
    if (header && Number(header) !== asset.size) { await response.body?.cancel(); throw new UpdateError("size_mismatch", "更新包大小不一致，已删除下载。"); }
    if (!response.body) throw new UpdateError("size_mismatch", "更新包下载不完整。");
    const file = await open(partial, "wx", 0o600), hash = createHash("sha256"); let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        options.signal?.throwIfAborted(); size += value.length;
        if (size > asset.size) throw new UpdateError("size_mismatch", "更新包大小不一致，已删除下载。");
        hash.update(value); await file.writeFile(value); options.onProgress?.(size);
      }
    } finally { await reader.cancel().catch(() => {}); await file.close(); }
    if (size !== asset.size) throw new UpdateError("size_mismatch", "更新包下载不完整，已删除下载。");
    if (hash.digest("hex") !== asset.sha256) throw new UpdateError("hash_mismatch", "更新包 SHA-256 不一致，已删除下载。");
    const signature = asset.signatureUrl ? verifySignature(asset.sha256, JSON.parse(await limitedText(await request(asset.signatureUrl, options), 64 * 1024)), options.testThumbprints) : { state: "unsigned" as const };
    await rename(partial, out); return signature;
  } catch (error) { await rm(partial, { force: true }); await rm(out, { force: true }); throw error; }
}
export async function recheckPackage(path: string, asset: ReleaseAsset): Promise<void> {
  if ((await stat(path)).size !== asset.size || await hashFile(path) !== asset.sha256) throw new UpdateError("hash_mismatch", "下载后的更新包已改变，请重新下载。");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { compareVersions, localSource, parseRelease, request } from "../src/update/release.ts";
import { downloadPackage } from "../src/update/download.ts";

it("update semver follows numeric prerelease order, stable precedence and ignores build metadata", () => {
  assert.equal(compareVersions("v0.6.0-test.10", "0.6.0-test.2"), 1);
  assert.equal(compareVersions("0.6.0", "0.6.0-test.999"), 1);
  assert.equal(compareVersions("1.0.0+build1", "1.0.0+build2"), 0);
  assert.equal(compareVersions("0.6.0-a", "0.6.0-2"), 1);
  assert.throws(() => compareVersions("0.6.0-test.01", "0.6.0"));
  assert.throws(() => compareVersions("v1.2", "0.6.0"));
});

it("update sources are development-only local HTTP; assets exactly bind runtime and full nupkg", async () => {
  assert.equal(localSource("http://127.0.0.1:1234/"), "http://127.0.0.1:1234");
  for (const invalid of ["https://mirror.invalid", "http://user:pass@localhost", "file:///C:/test"]) assert.throws(() => localSource(invalid));
  const asset = { name: "DreamFlutter-0.6.0-win-x64-full.nupkg", size: 123, browser_download_url: "https://github.com/jun64349/DreamFlutter/releases/download/v0.6.0/package", digest: "sha256:" + "a".repeat(64) };
  const release = { tag_name: "v0.6.0", body: "notes", assets: [{ ...asset, name: "source.zip" }, { ...asset, name: "DreamFlutter-0.6.0-win-arm64-full.nupkg" }, asset] };
  assert.equal((await parseRelease(release, { platform: "win32", arch: "x64" })).asset.name, asset.name);
  await assert.rejects(parseRelease(release, { platform: "linux", arch: "x64" }), (e: any) => e.code === "no_asset");
  await assert.rejects(parseRelease({ ...release, assets: [asset, asset] }, {}), (e: any) => e.code === "no_asset");
  await assert.rejects(parseRelease({ ...release, assets: [{ ...asset, digest: undefined }] }, {}), (e: any) => e.code === "missing_digest");
});

it("update checks distinguish no release, offline and rate limiting and reject hostile redirects", async () => {
  for (const [status, code, headers] of [[404, "no_release", {}], [429, "rate_limited", {}], [403, "rate_limited", { "x-ratelimit-remaining": "0" }], [500, "service_error", {}]] as const) {
    await assert.rejects(request("http://127.0.0.1:1/latest", { testSource: "http://127.0.0.1:1", fetch: (async () => new Response("", { status, headers: headers as HeadersInit })) as typeof fetch }), (e: any) => e.code === code);
  }
  await assert.rejects(request("http://127.0.0.1:1/latest", { testSource: "http://127.0.0.1:1", fetch: (async () => { throw Error("offline"); }) as typeof fetch }), (e: any) => e.code === "offline");
  await assert.rejects(request("http://127.0.0.1:1/latest", { testSource: "http://127.0.0.1:1", fetch: (async () => new Response("", { status: 302, headers: { location: "https://attacker.invalid/package" } })) as typeof fetch }), (e: any) => e.code === "invalid_asset");
});

it("update downloads enforce streamed size and hash, remove bad files and keep unsigned packages explicit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-update-download-")), out = join(dir, "package.nupkg"), data = Buffer.from("synthetic package");
  const asset = { name: "package.nupkg", size: data.length, url: "http://127.0.0.1:1/package", sha256: createHash("sha256").update(data).digest("hex") };
  const options = { testSource: "http://127.0.0.1:1", fetch: (async () => new Response(data)) as typeof fetch };
  try {
    await assert.rejects(downloadPackage({ ...asset, size: data.length - 1 }, out, options), (e: any) => e.code === "size_mismatch");
    assert.equal(existsSync(out + ".partial"), false);
    await assert.rejects(downloadPackage({ ...asset, sha256: "0".repeat(64) }, out, options), (e: any) => e.code === "hash_mismatch");
    assert.equal(existsSync(out), false);
    assert.deepEqual(await downloadPackage(asset, out, options), { state: "unsigned" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

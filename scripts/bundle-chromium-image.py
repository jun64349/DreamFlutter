"""Build the pinned Debian browser layer offline on the existing T-75 image."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent.parent
IMAGE_DIR = ROOT / "core/sandbox-image"
IMAGE_NAME = "dreamflutter-sandbox.tar.gz"
LOCK_FILE = ROOT / "core/sandbox-browser.lock.json"
LOCK = json.loads(LOCK_FILE.read_text(encoding="utf-8"))


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(path, entry):
    if not path.is_file() or ("bytes" in entry and path.stat().st_size != entry["bytes"]) or sha256(path) != entry["sha256"]:
        raise RuntimeError(f"Pinned sandbox build input is missing or changed: {path}")


def download(cache, packages):
    for entry in packages:
        path = cache / entry["file"]
        if not path.exists():
            candidate = path.with_name(path.name + "." + uuid.uuid4().hex)
            try:
                subprocess.run(["curl.exe", "--fail", "--silent", "--show-error", "--location", "--retry", "2",
                                entry["url"], "--output", str(candidate)], check=True)
                verify(candidate, entry)
                candidate.replace(path)
            finally:
                candidate.unlink(missing_ok=True)
        verify(path, entry)


# Runs as root inside the selected WSL builder. The extracted image is never booted here.
INSTALL = r"""
import json, os, pathlib, subprocess, sys, tarfile
root = pathlib.Path(sys.argv[1])
expected, browser, font = json.loads(sys.argv[2])
stage = root / 'tmp/t104-debs'
stage.mkdir()
tarfile.open(fileobj=sys.stdin.buffer, mode='r|').extractall(stage, filter='data')

def versions():
    query = subprocess.run(['chroot', str(root), '/usr/bin/dpkg-query', '-W',
                            '-f=${Package}\t${Version}\n'], check=True, stdout=subprocess.PIPE, text=True)
    return dict(line.split('\t') for line in query.stdout.splitlines())

before = versions()
auto = set(subprocess.check_output(['chroot', str(root), '/usr/bin/apt-mark', 'showauto'], text=True).splitlines())
logs = ['var/log/dpkg.log', 'var/log/apt/history.log', 'var/log/apt/term.log', 'var/log/alternatives.log']
original_logs = {name: (root / name).read_bytes() for name in logs if (root / name).is_file()}
paths = []
for index, entry in enumerate(sorted(stage.iterdir())):
    name = f'{index:02}.deb'
    entry.rename(stage / name)
    paths.append('/tmp/t104-debs/' + name)
subprocess.run(['unshare', '--net', '--', 'chroot', str(root), '/usr/bin/env', '-i',
                'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', 'DEBIAN_FRONTEND=noninteractive',
                '/usr/bin/apt-get', '-o', 'Dpkg::Use-Pty=0', '-o', 'Dir::Etc::sourcelist=/dev/null', '-o', 'Dir::Etc::sourceparts=-',
                '--yes', '--no-install-recommends', '--no-remove',
                'install', *paths], check=True, stdout=sys.stderr)
after = versions()
changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
if changed != set(expected) or not before.keys() <= after.keys():
    raise RuntimeError(f'Unexpected Debian package changes: {sorted(changed ^ set(expected))}')
if after.get(browser['name']) != browser['version'] or after.get(font['name']) != font['version'] or before.get(font['name']) != font['version']:
    raise RuntimeError('Pinned browser or existing Chinese font differs')
if not os.access(root / 'usr/bin/chromium-headless-shell', os.X_OK):
    raise RuntimeError('The Chromium executable is missing')
dependencies = (changed - before.keys()) | (changed & auto)
dependencies.discard(browser['name'])
subprocess.run(['chroot', str(root), '/usr/bin/apt-mark', 'auto', *sorted(dependencies)], check=True, stdout=sys.stderr)
for name in logs:
    path = root / name
    if name in original_logs:
        path.write_bytes(original_logs[name])
    else:
        path.unlink(missing_ok=True)
# These caches encode installation timestamps or host filesystem identities.
for name in ['var/cache/apt/pkgcache.bin', 'var/cache/apt/srcpkgcache.bin', 'var/cache/ldconfig/aux-cache']:
    (root / name).unlink(missing_ok=True)
for path in stage.iterdir():
    path.unlink()
stage.rmdir()
inventory = ''.join(f'{name}\t{version}\n' for name, version in sorted(after.items()))
(root / 'usr/share/dreamflutter/packages.txt').write_text(inventory)
sys.stdout.write(inventory)
"""

EXPORT = """
set -eu
cd "$1"
export LC_ALL=C
tar --sort=name --numeric-owner --format=gnu --mtime="@$2" -cf - . | gzip -n -6
"""


def build(args):
    cache, out = Path(args.cache).resolve(), Path(args.out).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    base = cache / LOCK["base"]["file"]
    if not base.exists():
        source = IMAGE_DIR / IMAGE_NAME
        verify(source, LOCK["base"])
        shutil.copyfile(source, base)
    verify(base, LOCK["base"])
    if args.download_browser:
        download(cache, LOCK["packages"])
    for entry in LOCK["packages"]:
        verify(cache / entry["file"], entry)
    info = json.loads((IMAGE_DIR / "dreamflutter-sandbox.json").read_text(encoding="utf-8"))
    if info.get("officeLayer", {}).get("sha256") != LOCK["base"]["sha256"]:
        raise RuntimeError("T-75 office-layer provenance does not match the pinned browser baseline")

    remote = "/tmp/dreamflutter-t104-image-" + uuid.uuid4().hex
    root = remote + "/root"
    wsl = ["wsl.exe", "-d", args.distro, "-u", "root", "--cd", "/", "--exec"]
    env = {**os.environ, "WSL_UTF8": "1", "WSLENV": ""}

    def run(command, **kwargs):
        return subprocess.run(wsl + command, env=env, check=True, timeout=600, **kwargs)

    print("Assembling the browser in a disposable WSL tree", flush=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="df-t104-image-", dir=out.parent) as temp:
        candidate = Path(temp) / out.name
        try:
            run(["/usr/bin/mkdir", "-p", root])
            with base.open("rb") as stream:
                run(["/usr/bin/tar", "--numeric-owner", "-xzf", "-", "-C", root], stdin=stream)
            with tempfile.TemporaryFile(dir=temp) as stream:
                with tarfile.open(fileobj=stream, mode="w") as archive:
                    for entry in LOCK["packages"]:
                        archive.add(cache / entry["file"], arcname=entry["file"])
                stream.seek(0)
                names = sorted(entry["file"].split("_", 1)[0] for entry in LOCK["packages"])
                result = run(["/usr/bin/python3", "-I", "-B", "-c", INSTALL, root,
                              json.dumps([names, LOCK["browser"], LOCK["font"]])], stdin=stream, stdout=subprocess.PIPE)
            inventory = result.stdout.decode("utf-8").splitlines()
            if not all(len(line.split("\t")) == 2 for line in inventory):
                raise RuntimeError("Invalid Debian package inventory")
            with candidate.open("wb") as stream:
                run(["/bin/bash", "-o", "pipefail", "-c", EXPORT, "export-browser-image", root,
                     str(info["builtAt"] // 1000)], stdout=stream)
            proof = {"lockSha256": sha256(LOCK_FILE), "baseSha256": LOCK["base"]["sha256"],
                     "package": LOCK["browser"], "font": LOCK["font"], "dependencyPackages": len(names) - 1,
                     "deltaGzipBytes": candidate.stat().st_size - base.stat().st_size}
            info.update(file=out.name, sha256=sha256(candidate), bytes=candidate.stat().st_size,
                        packages=len(inventory), browserLayer=proof)
            sidecar = out.name.removesuffix(".tar.gz")
            output = {
                sidecar + ".json": json.dumps(info, indent=2),
                sidecar + ".packages.txt": "\n".join(inventory),
                "office-layer.json": json.dumps(info["officeLayer"], indent=2),
            }
            for name, data in output.items():
                (Path(temp) / name).write_text(data + "\n", encoding="utf-8", newline="\n")
            candidate.replace(out)
            for name in output:
                (Path(temp) / name).replace(out.parent / name)
            print(json.dumps({"sha256": info["sha256"], "bytes": info["bytes"], **proof}), flush=True)
        finally:
            run(["/usr/bin/python3", "-I", "-B", "-c",
                 "import pathlib,re,shutil,sys; p=pathlib.Path(sys.argv[1]); "
                 "assert p.resolve()==p and p.parent==pathlib.Path('/tmp') and re.fullmatch('dreamflutter-t104-image-[0-9a-f]{32}',p.name); "
                 "shutil.rmtree(p) if p.exists() else None", remote])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--distro", default="DreamFlutterSandbox")
    parser.add_argument("--download-browser", action="store_true")
    build(parser.parse_args())

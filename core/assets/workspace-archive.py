"""Read or write a portable Butterfly workspace archive inside its Windows AppContainer."""
import gzip
import os
from pathlib import Path, PureWindowsPath
import shutil
import stat
import sys
import tarfile


def export_workspace(root):
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz", dereference=True) as archive:
        def add(path, name):
            info = path.lstat()
            if getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT or path.is_symlink():
                raise ValueError(f"workspace contains a link: {name}")
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError(f"unsupported workspace entry: {name}")
            archive.add(path, arcname=name, recursive=False)
            if path.is_dir():
                for child in path.iterdir():
                    if path == root and child.name.casefold() in {"home", "temp"}:
                        continue
                    add(child, name + "/" + child.name)

        add(root, "workspace")
        add(root / "home", "home/agent")


class BoundedInput:
    # stdin also owns the Job lifetime. Stop at the advertised archive length
    # without waiting for the host to disconnect.
    def __init__(self, size):
        self.remaining = size

    def read(self, count=-1):
        wanted = self.remaining if count < 0 else min(self.remaining, count)
        chunk = sys.stdin.buffer.read(wanted)
        if wanted and not chunk:
            raise EOFError("workspace archive ended early")
        self.remaining -= len(chunk)
        return chunk


def destination(root, name):
    parts = name.rstrip("/").split("/")
    if parts[:1] == ["workspace"]:
        base, tail = root, parts[1:]
        if tail and tail[0].casefold() in {"home", "temp"}:
            raise ValueError(f"reserved workspace folder: {name}")
    elif parts[:2] == ["home", "agent"]:
        base, tail = root / "home", parts[2:]
    else:
        raise ValueError(f"unknown workspace archive entry: {name}")
    for part in tail:
        if part in {"", ".", ".."} or "\\" in part or os.path.isreserved(part):
            raise ValueError(f"invalid workspace filename: {name}")
    return base.joinpath(*tail)


def git_link_prefix(path):
    parts = tuple(part.casefold() for part in path.parts)
    if parts[-1] == ".git":
        return "gitdir: "
    if len(parts) >= 4 and parts[-4:-2] == (".git", "worktrees") and parts[-1] in {"gitdir", "commondir"}:
        return ""
    return None


def relocate_git_links(paths, source, destination):
    for file, prefix in paths:
        try:
            data = file.read_bytes().decode("utf-8")
        except UnicodeDecodeError:
            continue
        line = data.rstrip("\r\n")
        if "\n" in line or "\r" in line or not line.startswith(prefix):
            continue
        old = PureWindowsPath(line[len(prefix):])
        if not old.is_absolute() or ".." in old.parts:
            continue
        try:
            relative = old.relative_to(source)
        except ValueError:
            continue
        file.write_bytes((prefix + (destination / relative).as_posix() + data[len(line):]).encode("utf-8"))


def restore_workspace(root, size, source_workspace):
    for path in root.iterdir():
        if path.name not in {"home", "temp"} or not path.is_dir() or path.is_symlink() or path.is_junction() or any(path.iterdir()):
            raise ValueError("restoring requires a fresh workspace")
    compressed = BoundedInput(size)
    total = 0
    seen = set()
    git_links = []
    with gzip.GzipFile(fileobj=compressed, mode="rb") as stream:
        with tarfile.open(fileobj=stream, mode="r|") as archive:
            for entry in archive:
                path = destination(root, entry.name)
                if path in seen or len(seen) >= 500000:
                    raise ValueError("duplicate or excessive workspace archive entries")
                seen.add(path)
                if entry.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                elif entry.isreg() and not entry.issparse():
                    total += entry.size
                    if total > 64 * 1024**3:
                        raise ValueError("workspace archive is too large")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(entry) as src, path.open("xb") as dst:
                        shutil.copyfileobj(src, dst, 1024 * 1024)
                    if source_workspace and entry.size <= 128 * 1024:
                        prefix = git_link_prefix(path)
                        if prefix is not None:
                            git_links.append((path, prefix))
                else:
                    raise ValueError(f"unsupported workspace archive entry: {entry.name}")
        # Finish the gzip trailer and validate the checksum before reporting success.
        if stream.read(1024 * 1024).strip(b"\x00") or stream.read(1):
            raise ValueError("unexpected data after workspace archive")
    if compressed.remaining or root not in seen:
        raise ValueError("incomplete workspace archive")
    if git_links:
        relocate_git_links(git_links, PureWindowsPath(source_workspace), PureWindowsPath(root))


if sys.argv[1] == "export":
    export_workspace(Path.cwd())
elif sys.argv[1] == "restore":
    restore_workspace(Path.cwd(), int(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "")
else:
    raise ValueError("unknown archive operation")

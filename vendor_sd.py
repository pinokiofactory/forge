"""Materialize the vendored Stable Diffusion tree into Forge's repositories/ dir.

Forge clones Stability-AI/stablediffusion at a pinned commit
(cf1d67a6fd5ea1aa600c4df58e5b47da45f6bdbf) and imports `ldm` from it. That
repository was taken down upstream, so there is nothing left to clone. The parts
Forge actually uses -- the `ldm` package and `configs/stable-diffusion` -- are
vendored under vendor/ instead, byte-identical to that commit and checked here
against MANIFEST.sha256.

The tree still has to be a git repository, because launch_utils.git_clone()
only skips the clone when `git rev-parse HEAD` matches the hash it was given
(modules/launch_utils.py:186). The real commit cannot be reproduced without the
full 74MB of history, so this creates a local commit and records its hash in
app/.sd-vendor-commit.json; install.js and start.js read that back and hand it to
Forge as STABLE_DIFFUSION_COMMIT_HASH. Integrity comes from the manifest rather
than from git, which is why the manifest is verified on every run.

Idempotent: re-running with everything already in place does nothing but verify.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(ROOT, "vendor", "stable-diffusion-stability-ai")
TARGET = os.path.join(ROOT, "app", "repositories", "stable-diffusion-stability-ai")
STAMP = os.path.join(ROOT, "app", ".sd-vendor-commit.json")
MANIFEST = os.path.join(VENDOR, "MANIFEST.sha256")
# paths.py:29 probes for this exact file to locate the tree
SENTINEL = os.path.join("ldm", "models", "diffusion", "ddpm.py")
UPSTREAM = "cf1d67a6fd5ea1aa600c4df58e5b47da45f6bdbf"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_manifest():
    entries = []
    with open(MANIFEST, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line:
                digest, path = line.split("  ", 1)
                entries.append((digest, path))
    return entries


def verify(base, entries):
    """Return the list of paths that are missing or do not match the manifest."""
    bad = []
    for digest, path in entries:
        full = os.path.join(base, path.replace("/", os.sep))
        if not os.path.isfile(full) or sha256(full) != digest:
            bad.append(path)
    return bad


def git(*args, **kw):
    return subprocess.run(
        ["git", "-C", TARGET, *args],
        check=kw.get("check", True),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    ).stdout.decode(errors="replace").strip()


def head():
    try:
        return git("rev-parse", "HEAD")
    except (subprocess.CalledProcessError, OSError):
        return None


def materialize(entries):
    if os.path.exists(TARGET):
        shutil.rmtree(TARGET, ignore_errors=True)
    for _, path in entries:
        src = os.path.join(VENDOR, path.replace("/", os.sep))
        dst = os.path.join(TARGET, path.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)


def commit():
    # -c overrides rather than `git config`, so this works on machines with no
    # global identity set and leaves the user's own config untouched.
    ident = [
        "-c", "user.name=pinokio",
        "-c", "user.email=pinokio@localhost",
        "-c", "core.autocrlf=false",
        "-c", "commit.gpgsign=false",
    ]
    subprocess.run(["git", "-C", TARGET, "init", "-q"], check=True)
    subprocess.run(["git", "-C", TARGET, *ident, "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", TARGET, *ident, "commit", "-q", "-m",
         f"Vendored subset of Stability-AI/stablediffusion @ {UPSTREAM}"],
        check=True,
    )
    return head()


def main():
    if not os.path.isfile(MANIFEST):
        sys.exit(f"missing manifest: {MANIFEST}")

    entries = read_manifest()

    bad = verify(VENDOR, entries)
    if bad:
        sys.exit(
            "vendored tree does not match MANIFEST.sha256 "
            f"({len(bad)} file(s), first: {bad[0]}). Refusing to install a tree "
            "that is not byte-identical to upstream " + UPSTREAM + "."
        )

    stamped = None
    if os.path.isfile(STAMP):
        try:
            with open(STAMP, encoding="utf-8") as f:
                stamped = json.load(f).get("hash")
        except (ValueError, OSError):
            stamped = None

    current = head()
    intact = (
        current is not None
        and current == stamped
        and os.path.isfile(os.path.join(TARGET, SENTINEL))
        and not verify(TARGET, entries)
    )
    if intact:
        print(f"Stable Diffusion tree already in place at {current[:10]} "
              f"({len(entries)} files verified against upstream {UPSTREAM[:10]})")
        return

    print(f"Materializing {len(entries)} vendored files into repositories/"
          "stable-diffusion-stability-ai")
    materialize(entries)
    commit_hash = commit()
    if not commit_hash:
        sys.exit("could not determine the commit hash of the vendored tree")

    os.makedirs(os.path.dirname(STAMP), exist_ok=True)
    with open(STAMP, "w", encoding="utf-8") as f:
        json.dump({"hash": commit_hash, "upstream": UPSTREAM}, f, indent=2)

    print(f"Vendored tree committed as {commit_hash[:10]} "
          f"(subset of upstream {UPSTREAM[:10]}, verified against manifest)")


if __name__ == "__main__":
    main()

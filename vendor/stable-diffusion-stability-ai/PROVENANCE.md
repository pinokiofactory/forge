# Vendored Stable Diffusion tree

This is a subset of [Stability-AI/stablediffusion](https://github.com/Stability-AI/stablediffusion)
at commit `cf1d67a6fd5ea1aa600c4df58e5b47da45f6bdbf` — the commit Forge pins in
`modules/launch_utils.py:399`. Every file is byte-identical to that commit.

## Why it is here

That repository was taken down upstream and now 404s, so `prepare_environment()`
cannot clone it and Forge will not start. Pointing `STABLE_DIFFUSION_REPO` at a
third-party mirror works, but makes every install depend on a stranger's account
staying up and staying honest. Vendoring removes that dependency.

## What is included

Only what Forge actually loads:

- `ldm/` — the package imported via `modules/paths.py:28`, which puts this
  directory on `sys.path` and probes for `ldm/models/diffusion/ddpm.py`.
- `configs/` — `configs/stable-diffusion` supplies the SD2, SD2-v, SD2-inpainting
  and depth-model configs referenced from `modules/sd_models_config.py:13-19`.
- `LICENSE` and `LICENSE-MODEL` — upstream's code and model licenses, retained.

The upstream commit is 149 MB; 73 MB of that is `assets/`, example imagery Forge
never touches. The vendored subset is 73 files, ~1 MB.

## Integrity

`MANIFEST.sha256` lists a SHA-256 per file, generated from git blob contents
rather than a working tree, so it does not depend on platform or on
`core.autocrlf`. `vendor_sd.py` verifies every file against it before installing
the tree, and again on every launch, and refuses to proceed on a mismatch.

To check it against upstream yourself, from a clone of the original repository at
that commit:

```sh
git -C <stablediffusion-clone> ls-tree -r cf1d67a6 --name-only \
  | grep -E '^(ldm/|configs/|LICENSE)' | sort | while read -r p; do
      printf '%s  %s\n' \
        "$(git -C <stablediffusion-clone> cat-file blob "cf1d67a6:$p" | sha256sum | cut -d' ' -f1)" "$p"
    done | diff - MANIFEST.sha256
```

## Why it becomes a git repository at install time

`launch_utils.git_clone()` skips cloning only when `git rev-parse HEAD` in the
target directory equals the hash it was passed (`modules/launch_utils.py:186`).
Reproducing `cf1d67a6` itself would require the full 74 MB of history, so
`vendor_sd.py` commits this subset locally and records the resulting hash in
`app/.sd-vendor-commit.json`; `install.js` and `start.js` pass it to Forge as
`STABLE_DIFFUSION_COMMIT_HASH`. That hash is therefore local and machine-specific
and is not an upstream identifier — `MANIFEST.sha256` is what establishes that
the contents are genuine.

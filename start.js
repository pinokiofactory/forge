module.exports = async (kernel) => {
  let env = {
    SD_WEBUI_RESTARTING: 1,
    // github.com/Stability-AI/stablediffusion was taken down (404), so Forge's
    // hardcoded default in modules/launch_utils.py can no longer be cloned. The
    // parts it uses are vendored under vendor/ instead — see PROVENANCE.md there.
    // vendor_sd.py puts that tree in place and records the hash of the local
    // commit it makes; handing it back as STABLE_DIFFUSION_COMMIT_HASH is what
    // makes git_clone() skip cloning (modules/launch_utils.py:186).
    STABLE_DIFFUSION_COMMIT_HASH: "{{local.sd.hash}}",
    // Belt and braces: if the tree ever does go missing, this makes the clone
    // attempt fail fast instead of Git Credential Manager opening a browser auth
    // prompt that hangs the shell.
    GIT_TERMINAL_PROMPT: 0
  }
  if (kernel.platform === 'darwin' && kernel.arch === 'x64') {
    env.PYTORCH_MPS_HIGH_WATERMARK_RATIO = 0
  }
  return {
    daemon: true,
    run: [{
      // Verify the vendored Stable Diffusion tree and put it in place if it is
      // missing or damaged. Idempotent and cheap — a clean tree is 73 SHA-256
      // sums over ~1MB — and it runs every launch so a deleted or half-written
      // repositories/ directory heals itself instead of failing the start.
      method: "shell.run",
      params: {
        message: "python vendor_sd.py"
      }
    }, {
      // Hash of the local commit vendor_sd.py just made, read back for the env
      // above. Written to app/, which is not part of the launcher repo, because
      // it describes this machine's checkout rather than the launcher.
      method: "json.get",
      params: {
        sd: "app/.sd-vendor-commit.json"
      }
    }, {
      // opencv-python 5.x hard-requires numpy>=2, which overrides Forge's own
      // numpy==1.26.2 pin in requirements_versions.txt. torch 2.1.2 and
      // scikit-image 0.21.0 are compiled against the numpy 1.x ABI, so numpy 2
      // makes `from skimage import exposure` die with "numpy.dtype size changed".
      // Hold both back to the versions this Forge vintage was built against.
      // Cheap on every start: uv audits an already-satisfied set in well under a second.
      method: "shell.run",
      params: {
        venv: "venv",
        path: "app",
        message: [
          "uv pip install numpy==1.26.2 opencv-python==4.8.0.76 opencv-contrib-python==4.8.0.76 opencv-python-headless==4.8.0.76"
        ]
      }
    }, {
      // Reserve the port up front so the URL is known before Forge starts.
      method: "local.set",
      params: {
        port: "{{port}}"
      }
    }, {
      // DEVIATION FROM THE CRITICAL PATTERN LOCK — approved by the user.
      //
      // The documented pattern derives `url` by regex-matching the server's output via
      // the shell.run `on` handler. That handler does not fire at all on this kernel
      // (8.0.40). Isolation test, 2026-08-09: a throwaway script ran
      // `echo Startup time: 19.2s ...` with `on: [{ event: "/Startup time:/",
      // done: true }]`. The line is right there in the shell log at t+0s, yet the next
      // step did not run until t+60s, when the shell finished its last command on its
      // own — and its `input` was `{id}` alone, with no `event` key, which an
      // event-driven advance would have carried. So the miss is not about Forge's
      // output or the pattern; `on` simply never matches here.
      //
      // Everything downstream follows from that:
      //   - `url` cannot be captured from output, so it is built from the port
      //     reserved above.
      //   - This step must run BEFORE the launch step. Without a firing `on`, that
      //     step never returns (docs: a shell.run with no `on` ends only at the next
      //     terminal prompt), so any step after it is unreachable.
      // A readiness gate is what belongs here — `process.wait` on
      // `tcp:127.0.0.1:{{local.port}}` would express it exactly — but it is
      // unreachable for the same reason, so the Open Web UI tab necessarily appears
      // while Forge is still booting (~20-35s). Clicking it early returns a connection
      // error; that is the launch still starting, not a failure.
      method: "local.set",
      params: {
        "url": "http://127.0.0.1:{{local.port}}"
      }
    }, {
      // Also before the launch step, and for the same reason: after it, this would
      // never run. Registering the proxy ahead of the server is fine — it maps the
      // URL, and starts serving once Forge binds the port.
      "method": "proxy.start",
      "params": {
        "uri": "{{local.url}}",
        "name": "Local Sharing"
      }
    }, {
      method: "shell.run",
      params: {
        path: "app",
        message: (kernel.platform === 'win32' ? 'webui-user.bat' : 'bash webui.sh -f'),
        // GRADIO_SERVER_PORT is how the reserved port reaches Forge. Passing --port
        // on the command line would not work: webui-user.bat hardcodes
        // `set COMMANDLINE_ARGS=--no-download-sd-model`, clobbering anything inherited,
        // and webui.bat forwards only its own argv. Gradio reads this env var directly
        // (gradio/networking.py:26) because Forge leaves --port at its None default
        // (cmd_args.py:78 -> webui.py:87), so this sets the port without touching app/.
        env: Object.assign({}, env, { GRADIO_SERVER_PORT: "{{local.port}}" })
        // No `on` handler: it would never fire (see above), and without one the shell
        // stays in the foreground for the life of the server, which is what a daemon
        // script wants.
      }
    }]
  }
}

module.exports = async (kernel) => {
  // Environment shared by the warm-up step below.
  let warmupEnv = {
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

  // Warm-up step: install dependencies, clone the repositories, and run the
  // extension installers, then exit without ever starting a server.
  //
  // This used to run the full launcher and rely on an `on` handler matching the
  // server's URL to kill it. That match never fires for Forge (see start.js), so
  // once the install actually succeeded the step would hang forever. Forge's own
  // --exit flag removes the need to detect readiness: it sits at the end of
  // prepare_environment() (modules/launch_utils.py:488), after the repo clones,
  // the requirements install, and run_extensions_installers(). The process then
  // exits 0 by itself, so shell.run returns with no `on` handler at all.
  //
  // How --exit is delivered differs per platform, for concrete reasons:
  //
  // Windows: call launch.py directly under Pinokio's venv rather than a .bat.
  // webui.bat is only a bootstrap -- locate python, create/activate the venv,
  // run `launch.py %*` -- and Pinokio's `venv` attribute already covers that. It
  // also ends in `pause`, which blocks the shell forever once launch.py exits
  // (verified: the step printed "Exiting because of --exit argument" and then sat
  // at "Press any key to continue"). webui-user.bat is unusable here regardless,
  // since it hardcodes COMMANDLINE_ARGS and would clobber the value below.
  //
  // macOS/Linux: keep webui.sh, which sources webui-macos-env.sh for the mac
  // defaults (TORCH_COMMAND, --skip-torch-cuda-test, PYTORCH_ENABLE_MPS_FALLBACK)
  // that a direct launch.py call would lose. That file also *exports*
  // COMMANDLINE_ARGS, overwriting anything passed in, so --exit has to travel as a
  // real argument instead. webui.sh forwards "$@" to launch.py (webui.sh:286) and
  // -f is a declared no-op argument (cmd_args.py:10), so both parse cleanly.
  // webui.sh has no pause; its restart loop ends when launch.py exits.
  let warmup = kernel.platform === 'win32' ? {
    method: "shell.run",
    params: {
      venv: "venv",
      path: "app",
      message: "python launch.py",
      // Forge merges this into sys.argv (modules/paths_internal.py:13), which is
      // what the --exit check reads.
      env: Object.assign({}, warmupEnv, {
        COMMANDLINE_ARGS: "--no-download-sd-model --exit"
      })
    }
  } : {
    method: "shell.run",
    params: {
      path: "app",
      message: "bash webui.sh -f --exit",
      env: warmupEnv
    }
  }

  let script = {
    run: [{
      method: "shell.run",
      params: {
        message: [
          //"git clone -b dev2 https://github.com/betapeanut/stable-diffusion-webui-forge app",
          "git clone https://github.com/betapeanut/stable-diffusion-webui-forge app",
        ]
      }
    }, {
      method: "fs.link",
      params: {
        drive: {
          checkpoints: "app/models/Stable-diffusion",
          vae: "app/models/VAE",
          loras: [
            "app/models/Lora",
            "app/models/LyCORIS"
          ],
          upscale_models: [
            "app/models/ESRGAN",
            "app/models/RealESRGAN",
            "app/models/SwinIR"
          ],
          embeddings: "app/embeddings",
          hypernetworks: "app/models/hypernetworks",
          controlnet: "app/models/ControlNet"
        },
        peers: [
          "https://github.com/pinokiofactory/comfy.git",
          "https://github.com/cocktailpeanutlabs/comfyui.git",
          "https://github.com/cocktailpeanutlabs/fooocus.git",
          "https://github.com/cocktailpeanutlabs/automatic1111.git",
        ]
      }
    }, {
      method: "fs.link",
      params: {
        drive: {
          outputs: "app/output"
        }
      }
//    }, {
//      when: "{{platform === 'darwin' && arch !== 'arm64'}}",  // intel mac
//      method: "self.set",
//      params: {
//        "app/ui-config.json": {
//          "txt2img/Sampling steps/value": 1,
//          "txt2img/CFG Scale/value": 1.0
//        }
//      }
//    }, {
//      when: "{{platform === 'darwin' && arch !== 'arm64'}}",  // intel mac
//      method: "fs.download",
//      params: {
//        uri: "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors?download=true",
//        dir: "app/models/Stable-diffusion"
//      }
    }, {
      method: "fs.download",
      params: {
        url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
        dir: "app/models/Stable-diffusion"
      }
    }, {
      method: "fs.download",
      params: {
        url: "https://huggingface.co/stabilityai/stable-diffusion-xl-refiner-1.0/resolve/main/sd_xl_refiner_1.0.safetensors",
        dir: "app/models/Stable-diffusion"
      }
    }, {
      // Pre-place the live-preview models so Forge never has to fetch them itself.
      //
      // On the first generation, modules/sd_vae_approx.py:39 pulls these through
      // torch.hub.download_url_to_file, which uses urllib's default HTTPS context.
      // On machines where Python cannot parse the Windows certificate store that
      // throws `ssl.SSLError: [ASN1: NOT_ENOUGH_DATA]` inside
      // ssl.create_default_context(), and the whole request fails with a 500 even
      // though generation itself is fine. SSL_CERT_FILE and REQUESTS_CA_BUNDLE do
      // not help, because the Windows store is loaded before either is consulted.
      //
      // Pinokio's downloader is Node-based and unaffected, and sd_vae_approx.py
      // only downloads when the file is missing, so fetching them here sidesteps
      // the problem entirely. Two files, ~209KB each: vaeapprox-sdxl.pt for SDXL
      // checkpoints and model.pt for everything else (sd_vae_approx.py:43).
      method: "fs.download",
      params: {
        uri: [
          "https://github.com/AUTOMATIC1111/stable-diffusion-webui/releases/download/v1.0.0-pre/vaeapprox-sdxl.pt",
          "https://github.com/AUTOMATIC1111/stable-diffusion-webui/releases/download/v1.0.0-pre/model.pt"
        ],
        dir: "app/models/VAE-approx"
      }
    }, {
      uri: "setup.js",
      method: "write"
    }, {
      // Put the vendored Stable Diffusion tree in place before the warm-up below,
      // which is what runs prepare_environment() and would otherwise try to clone
      // the dead upstream repository. Verifies all 73 files against
      // MANIFEST.sha256 and refuses to continue on a mismatch.
      method: "shell.run",
      params: {
        message: "python vendor_sd.py"
      }
    }, {
      // Hash of the local commit vendor_sd.py just made, read back for warmupEnv.
      method: "json.get",
      params: {
        sd: "app/.sd-vendor-commit.json"
      }
    }, warmup, {
      // Runs after the step above, because that is what installs Forge's base and
      // extension requirements — and what drags in opencv-python 5.x, whose
      // numpy>=2 requirement overrides Forge's own numpy==1.26.2 pin. torch 2.1.2
      // and scikit-image 0.21.0 are built against the numpy 1.x ABI, so numpy 2
      // breaks `from skimage import exposure`. Repair the pins once deps are in place.
      method: "shell.run",
      params: {
        venv: "venv",
        path: "app",
        message: [
          "uv pip install numpy==1.26.2 opencv-python==4.8.0.76 opencv-contrib-python==4.8.0.76 opencv-python-headless==4.8.0.76"
        ]
      }
    }, {
      method: "notify",
      params: {
        html: "Click the 'start' tab to launch the app"
      }
    }]
  }
  if (kernel.platform === 'darwin') {
    script.requires = [{
      platform: "darwin",
      type: "conda",
      name: ["cmake", "protobuf", "rust", "wget"],
      args: "-c conda-forge"
    }]
  }
  return script
}

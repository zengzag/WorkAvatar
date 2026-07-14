/**
 * Install DirectML-enabled sherpa-onnx DLLs into node_modules.
 *
 * The DirectML DLLs are stored in resources/native/sherpa-directml-win-x64/
 * (tracked via Git LFS) and copied to node_modules/sherpa-onnx-win-x64/ after
 * `npm install` so that the CPU-version DLLs shipped by the npm package are
 * replaced with the DirectML build.
 *
 * The existing sherpa-onnx.node addon is ABI-compatible and NOT replaced —
 * SHERPA_ONNX_ENABLE_DIRECTML only adds implementation code paths via #if
 * directives without changing the C API function signatures or struct layouts.
 */
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const srcDir = path.join(projectRoot, "resources", "native", "sherpa-directml-win-x64");
const targetDir = path.join(projectRoot, "node_modules", "sherpa-onnx-win-x64");

const DLLS_TO_COPY = [
  "sherpa-onnx-c-api.dll",
  "sherpa-onnx-cxx-api.dll",
  "onnxruntime.dll",
  "DirectML.dll",
];

// CPU-only file that is not needed by the DirectML build
const CPU_ONLY_FILES = ["onnxruntime_providers_shared.dll"];

function log(msg) {
  console.log(`[sherpa-directml] ${msg}`);
}

function main() {
  // Skip on non-Windows
  if (process.platform !== "win32") {
    log("Skipped (non-Windows platform)");
    return;
  }

  // Skip if source DLLs don't exist (e.g. fresh clone before LFS pull)
  if (!fs.existsSync(srcDir)) {
    log("Skipped (resources/native/sherpa-directml-win-x64/ not found)");
    return;
  }

  // Skip if sherpa-onnx-win-x64 package is not installed
  if (!fs.existsSync(targetDir)) {
    log("Skipped (node_modules/sherpa-onnx-win-x64/ not found)");
    return;
  }

  let copied = 0;
  for (const dll of DLLS_TO_COPY) {
    const src = path.join(srcDir, dll);
    const dst = path.join(targetDir, dll);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      copied++;
    } else {
      log(`Warning: ${dll} not found in resources/native/`);
    }
  }

  // Remove CPU-only files
  for (const file of CPU_ONLY_FILES) {
    const fp = path.join(targetDir, file);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  }

  if (copied > 0) {
    log(`Installed ${copied} DirectML DLLs into node_modules/sherpa-onnx-win-x64/`);
  } else {
    log("No DLLs copied (source directory empty?)");
  }
}

main();

#!/usr/bin/env node
// One-time setup for free local narration (Kokoro): a private Python venv, the packages and the model files.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const { venvPython } = require('../utils/local-tts-service');

const ROOT = process.env.LOCAL_TTS_DIR || path.join(__dirname, '..', 'data', 'local-tts');
const BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const FILES = [
  { name: 'kokoro-v1.0.onnx', minBytes: 300e6 },
  { name: 'voices-v1.0.bin', minBytes: 20e6 }
];

function findPython() {
  for (const candidate of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      const version = execFileSync(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']).toString().trim();
      const [major, minor] = version.split('.').map(Number);
      if (major === 3 && minor >= 10) return candidate;
    } catch (_error) { /* try the next candidate */ }
  }
  throw new Error('Python 3.10+ is required for local narration (https://www.python.org/downloads/)');
}

async function download(name, minBytes) {
  const target = path.join(ROOT, name);
  if (fs.existsSync(target) && fs.statSync(target).size >= minBytes) return console.log(`✓ ${name} already downloaded`);
  console.log(`↓ ${name}`);
  const response = await axios.get(`${BASE}/${name}`, { responseType: 'stream', maxRedirects: 5 });
  const partial = `${target}.part`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partial);
    response.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    response.data.on('error', reject);
  });
  if (fs.statSync(partial).size < minBytes) throw new Error(`${name} download is incomplete`);
  fs.renameSync(partial, target);
}

(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const python = venvPython(ROOT);
  if (!fs.existsSync(python)) {
    console.log('Creating the private Python environment…');
    execFileSync(findPython(), ['-m', 'venv', path.join(ROOT, 'venv')], { stdio: 'inherit' });
  }
  console.log('Installing kokoro-onnx…');
  execFileSync(python, ['-m', 'pip', 'install', '--quiet', 'kokoro-onnx', 'soundfile'], { stdio: 'inherit' });
  for (const file of FILES) await download(file.name, file.minBytes);
  execFileSync(python, ['-c', 'import kokoro_onnx, soundfile'], { stdio: 'inherit' });
  console.log(`\nLocal narration is ready in ${ROOT}. It is used automatically when no paid voice provider is configured.`);
})().catch(error => {
  console.error(`Local narration setup failed: ${error.message}`);
  process.exit(1);
});

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { runFFmpeg } = require('./ffmpeg');
const { Logger } = require('./logger');
const { detectLanguage, normalizeLanguage, KOKORO_LANGUAGES } = require('./language');

// Free, offline neural narration through Kokoro. No API key: `npm run tts:setup` installs it once.
// It runs in its own virtual environment so it never touches the system Python.

const ROOT = path.join(__dirname, '..', 'data', 'local-tts');

function venvPython(root) {
  return process.platform === 'win32'
    ? path.join(root, 'venv', 'Scripts', 'python.exe')
    : path.join(root, 'venv', 'bin', 'python');
}

class LocalTTSService {
  constructor(options = {}) {
    this.root = options.root || process.env.LOCAL_TTS_DIR || ROOT;
    this.python = options.python || venvPython(this.root);
    this.model = path.join(this.root, 'kokoro-v1.0.onnx');
    this.voices = path.join(this.root, 'voices-v1.0.bin');
    this.script = options.script || path.join(__dirname, '..', 'scripts', 'tts', 'kokoro_tts.py');
    this.logger = options.logger || new Logger('LocalTTS');
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.timeoutMs = Number(options.timeoutMs || process.env.LOCAL_TTS_TIMEOUT_MS || 30 * 60 * 1000);
    this.cachedAvailability = null;
  }

  async isAvailable() {
    if (process.env.LOCAL_TTS === 'off') return false;
    if (this.cachedAvailability !== null) return this.cachedAvailability;
    const exists = async file => fs.stat(file).then(stats => stats.isFile() && stats.size > 0, () => false);
    this.cachedAvailability = (await Promise.all([this.python, this.model, this.voices, this.script].map(exists))).every(Boolean);
    return this.cachedAvailability;
  }

  resolveLanguage(text, requested) {
    return normalizeLanguage(requested) || normalizeLanguage(process.env.NARRATION_LANGUAGE) || detectLanguage(text);
  }

  supports(language) {
    return Boolean(KOKORO_LANGUAGES[language]);
  }

  /**
   * Narrates `text` into an MP3 at `outputPath`.
   * @param {object} options { language, voice, speed }
   * @returns {{ path, voice, language, seconds, model }}
   */
  async synthesize(text, outputPath, options = {}) {
    const language = this.resolveLanguage(text, options.language);
    const profile = KOKORO_LANGUAGES[language];
    if (!profile) throw new Error(`Local narration does not support ${language}`);
    const voice = options.voice || process.env.LOCAL_TTS_VOICE || profile.voice;
    const speed = Math.min(1.4, Math.max(0.7, Number(options.speed) || 1));
    const wavPath = outputPath.replace(/\.[a-z0-9]+$/i, '') + '.local.wav';
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const result = await new Promise((resolve, reject) => {
      const child = execFile(this.python, [
        this.script, '--model', this.model, '--voices', this.voices,
        '--lang', profile.lang, '--voice', voice, '--speed', String(speed), '--out', wavPath
      ], { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`Local narration failed: ${String(stderr || error.message).trim().split('\n').pop()}`));
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch (_e) { reject(new Error('Local narration returned an unreadable result')); }
      });
      child.stdin.end(String(text));
    });
    if (result.error) throw new Error(`Local narration failed: ${result.error}`);

    try {
      await this.runFFmpeg(['-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '160k', outputPath]);
    } finally {
      await fs.unlink(wavPath).catch(() => {});
    }
    this.logger.info(`Local narration ready: ${result.seconds}s with ${voice} (${language})`);
    return { path: outputPath, voice, language, seconds: result.seconds, model: 'kokoro-v1.0' };
  }
}

module.exports = { LocalTTSService, venvPython };

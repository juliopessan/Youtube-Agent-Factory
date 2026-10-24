const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { runFFmpeg } = require('./ffmpeg');
const { venvPython } = require('./local-tts-service');
const { Logger } = require('./logger');

// Original ambient music for the wellness channel: numpy-synthesized pads and plucks, then an FFmpeg
// pass for reverb, an optional nature bed (rain or ocean) and loudness normalization. Nothing is
// sampled and no API is called. If Python is not set up, a plainer drone is rendered with FFmpeg alone.

const MOODS = ['sleep', 'calm', 'focus', 'meditation', 'morning'];
const NATURE = ['rain', 'ocean', 'none'];
const TARGET_LUFS = -19;

async function stderrOf(run, args) {
  const result = await run(args).catch(error => ({ stderr: error.stderr || '' }));
  return String(result.stderr || '');
}

class AmbientMusicService {
  constructor(options = {}) {
    this.root = options.root || process.env.LOCAL_TTS_DIR || path.join(__dirname, '..', 'data', 'local-tts');
    this.python = options.python || process.env.AMBIENT_PYTHON || venvPython(this.root);
    this.script = options.script || path.join(__dirname, '..', 'scripts', 'music', 'ambient_music.py');
    this.run = options.runFFmpeg || runFFmpeg;
    this.logger = options.logger || new Logger('AmbientMusic');
    this.timeoutMs = Number(options.timeoutMs || 60 * 60 * 1000);
    this.cachedPython = null;
  }

  async hasSynth() {
    if (this.cachedPython !== null) return this.cachedPython;
    const exists = file => fs.stat(file).then(stats => stats.isFile(), () => false);
    if (!await exists(this.python) || !await exists(this.script)) return (this.cachedPython = false);
    this.cachedPython = await new Promise(resolve => {
      execFile(this.python, ['-c', 'import numpy, soundfile'], error => resolve(!error));
    });
    return this.cachedPython;
  }

  synthesize(args) {
    return new Promise((resolve, reject) => {
      execFile(this.python, [this.script, ...args], { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`Ambient synthesis failed: ${String(stderr || error.message).trim().split('\n').pop()}`));
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch (_e) { reject(new Error('Ambient synthesis returned an unreadable result')); }
      });
    });
  }

  async levels(file, filter) {
    const log = await stderrOf(this.run, ['-hide_banner', '-i', file, ...(filter ? ['-af', filter] : []), '-vn', '-f', 'null', '-']);
    const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(log);
    return mean ? Number(mean[1]) : null;
  }

  // Rain or sea at a fixed distance under the music, so any mood and length stays balanced.
  async natureBed(kind, seconds, file, musicMeanDb) {
    const T = Math.ceil(seconds + 1);
    const source = kind === 'rain'
      ? `anoisesrc=d=${T}:c=pink:a=0.5,highpass=f=700,lowpass=f=9000,tremolo=f=0.1:d=0.3`
      : `anoisesrc=d=${T}:c=brown:a=0.9,lowpass=f=1100,tremolo=f=0.1:d=0.85`;
    await this.run(['-y', '-f', 'lavfi', '-i', source, '-af', 'aformat=sample_rates=44100:channel_layouts=stereo', file]);
    const mean = await this.levels(file, 'volumedetect');
    const offset = kind === 'rain' ? -9 : -7; // below the music's mean level
    return (musicMeanDb ?? -24) + offset - (mean ?? -20);
  }

  /**
   * @param {object} spec { mood, minutes, seed, nature, outPath, dir }
   * @returns {{ path, seconds, mood, key, chords, nature, loudness, engine }}
   */
  async compose(spec) {
    const mood = MOODS.includes(spec.mood) ? spec.mood : 'calm';
    const nature = NATURE.includes(spec.nature) ? spec.nature : 'none';
    const minutes = Math.max(0.2, Number(spec.minutes) || 4);
    const seconds = minutes * 60;
    await fs.mkdir(spec.dir, { recursive: true });
    const dry = path.join(spec.dir, 'dry.wav');

    let plan = null;
    let engine = 'numpy-pads';
    if (await this.hasSynth()) {
      plan = await this.synthesize(['--mood', mood, '--minutes', String(minutes), '--seed', String(spec.seed || 7), '--out', dry]);
    } else {
      // Plain FFmpeg drone: three low sines and brown noise under a slow tremolo.
      engine = 'ffmpeg-drone';
      const T = Math.ceil(seconds + 2);
      await this.run([
        '-y', '-f', 'lavfi', '-i', `sine=f=110:d=${T}`, '-f', 'lavfi', '-i', `sine=f=164.81:d=${T}`, '-f', 'lavfi', '-i', `sine=f=220:d=${T}`, '-f', 'lavfi', '-i', `anoisesrc=d=${T}:c=brown:a=0.05`,
        '-filter_complex', '[0][1][2][3]amix=inputs=4:normalize=0,lowpass=f=900,tremolo=f=0.1:d=0.5,aformat=sample_rates=44100:channel_layouts=stereo', dry
      ]);
      plan = { seconds, key: 'A', mood, chords: [{ start: 0, name: 'A+0:drone' }], plucks: 0 };
    }

    const musicMean = await this.levels(dry, 'volumedetect');
    const reverb = 'aecho=0.8:0.88:70:0.35,aecho=0.8:0.9:1100|1900:0.28|0.2,lowpass=f=9500';
    const normalize = `loudnorm=I=${TARGET_LUFS}:TP=-2:LRA=9,aresample=48000,aformat=channel_layouts=stereo`;
    if (nature === 'none') {
      await this.run(['-y', '-i', dry, '-af', `${reverb},${normalize}`, '-t', seconds.toFixed(2), spec.outPath]);
    } else {
      const bed = path.join(spec.dir, `${nature}.wav`);
      const gain = await this.natureBed(nature, seconds, bed, musicMean);
      await this.run([
        '-y', '-i', dry, '-i', bed,
        '-filter_complex', `[0:a]${reverb}[music];[1:a]volume=${gain.toFixed(2)}dB[bed];[music][bed]amix=inputs=2:normalize=0:duration=first,${normalize}`,
        '-t', seconds.toFixed(2), spec.outPath
      ]);
    }
    await fs.rm(spec.dir, { recursive: true, force: true }).catch(() => {});

    const log = await stderrOf(this.run, ['-hide_banner', '-i', spec.outPath, '-af', 'ebur128=peak=true', '-vn', '-f', 'null', '-']);
    const integrated = /I:\s*(-?[\d.]+) LUFS/.exec(log.split('Summary:').pop());
    const peak = /Peak:\s*(-?[\d.]+) dBFS/.exec(log.split('Summary:').pop());
    return {
      path: spec.outPath, seconds: plan.seconds, mood, key: plan.key, chords: plan.chords, plucks: plan.plucks, nature, engine,
      loudness: { lufs: integrated ? Number(integrated[1]) : null, truePeakDb: peak ? Number(peak[1]) : null }
    };
  }
}

module.exports = { AmbientMusicService, MOODS, NATURE, TARGET_LUFS };

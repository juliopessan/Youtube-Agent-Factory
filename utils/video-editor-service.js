const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { Logger } = require('./logger');
const { buildOverlays, buildASS, subtitlesFilter } = require('./text-overlay-service');

// The factory's video editor: it does what the editor in SOP-EDV-001 ("Edição de Vídeo de Canal Dark")
// does by hand, from the Director's storyboard and the scene manifest, using FFmpeg only.
//   03 sync visuals to narration, a new scene every 6-10 s and never beyond 12 s
//   04 hook text in the first seconds       05 one colour look on every scene
//   06 yellow on-screen text at 4-6 moments 07 sound design: narration -6..-3 dB, music -20..-18 dB, 2-4 SFX
//   08 hard cuts at impact, 500 ms fades on soft transitions      09 end screen in the last 20 s
//   11 export H.264 1920x1080 30 fps VBR 2-pass, target 12 Mbps and max 16 Mbps, AAC 320 kbps

const SOP = {
  code: 'SOP-EDV-001',
  width: 1920,
  height: 1080,
  fps: 30,
  scene: { min: 6, max: 10, hardMax: 12 },
  fadeSeconds: 0.5,
  narrationPeakDb: -4.5,
  musicMeanDb: -19,
  sfx: { min: 2, max: 4 },
  endScreenSeconds: 20,
  video: { bitrate: '12M', maxrate: '16M', bufsize: '32M' },
  audioBitrate: '320k'
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv']);

// Dark two-colour palettes per visual style: the procedural backdrop when no real footage exists.
const PALETTES = {
  noir: [['0x0b0b0e', '0x3b3b44'], ['0x111114', '0x2c2c33'], ['0x08080a', '0x45454f']],
  cinematic: [['0x07161c', '0x35210f'], ['0x0a1a22', '0x2c1c12'], ['0x081218', '0x3a2a1c']],
  realistic: [['0x10181c', '0x2b3a40'], ['0x141c20', '0x34454c'], ['0x0d1417', '0x263338']],
  '3d_animation': [['0x1b1237', '0x0d3b66'], ['0x142a4a', '0x4a1d6b'], ['0x0f2f3d', '0x2a1f5a']],
  anime_manga: [['0x2a1038', '0x0b3a5a'], ['0x3a1030', '0x12304f'], ['0x1c1248', '0x5a1840']],
  retro_vintage: [['0x2b1a0c', '0x5a3a1a'], ['0x331f10', '0x4a3216'], ['0x24160a', '0x634322']]
};
const GRADIENT_TYPES = ['linear', 'radial', 'circular', 'spiral'];
const DEFAULT_LOOK = 'eq=contrast=1.08:saturation=0.9:gamma=0.98';

function frames(seconds) {
  return Math.max(1, Math.round(seconds * SOP.fps));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

// ffmpeg writes its diagnostics to stderr whether the command succeeds or not.
async function stderrOf(run, args) {
  const result = await run(args).catch(error => ({ stderr: error.stderr || '' }));
  return String(result.stderr || '');
}

async function fileExists(file) {
  return fs.stat(file).then(stats => stats.isFile() && stats.size > 0, () => false);
}

// "20261024_01_armadilhas-mentais.mp4": [Data]_[NumeroVideo]_[TemaCurto].mp4
function deliveryName({ date = new Date(), number = 1, title = 'video' }) {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  const slug = String(title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 4).join('-') || 'video';
  return `${day}_${String(number).padStart(2, '0')}_${slug}.mp4`;
}

class VideoEditorService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('VideoEditor');
    this.run = options.runFFmpeg || runFFmpeg;
    this.getDuration = options.getMediaDuration || getMediaDuration;
    this.parallel = Math.max(1, Number(options.parallel || process.env.EDIT_PARALLEL || Math.min(4, os.cpus().length)));
    this.preset = options.preset || process.env.EDIT_PRESET || 'veryfast';
  }

  /**
   * Scenes → timeline. Durations are rescaled to the real narration; impact scenes (hook, re-hook)
   * start with a hard cut, soft transitions are a 500 ms dip; a scene beyond 12 s is split.
   */
  planTimeline(scenes, storyboard, narrationSeconds = null) {
    const ordered = [...scenes].sort((a, b) => a.position - b.position);
    const total = ordered.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
    const scale = narrationSeconds && total ? narrationSeconds / total : 1;
    const roles = new Map((storyboard?.shots || []).map(shot => [shot.label, shot.narrativeRole]));

    const entries = [];
    let cursor = 0;
    for (const scene of ordered) {
      const duration = Number(scene.duration || 0) * scale;
      const parts = Math.max(1, Math.ceil(duration / SOP.scene.hardMax));
      for (let part = 0; part < parts; part++) {
        const length = Math.round((duration / parts) * SOP.fps) / SOP.fps;
        const role = roles.get(scene.label) || null;
        const previous = entries[entries.length - 1];
        const impact = role === 'hook' || role === 'rehook' || previous?.role === 'hook';
        entries.push({
          index: entries.length, sceneId: scene.id, label: scene.label, role, part,
          start: cursor, duration: length,
          transitionIn: !previous || impact || part > 0 ? 'cut' : 'fade',
          asset: scene
        });
        cursor += length;
      }
    }
    entries.forEach((entry, index) => { entry.fadeOut = entries[index + 1]?.transitionIn === 'fade'; });

    const durations = entries.map(entry => entry.duration);
    return {
      entries,
      totalSeconds: cursor,
      stats: {
        scenes: entries.length,
        medianSeconds: Number(median(durations).toFixed(2)),
        minSeconds: Number(Math.min(...durations).toFixed(2)),
        maxSeconds: Number(Math.max(...durations).toFixed(2)),
        hardCuts: entries.filter(entry => entry.transitionIn === 'cut').length - 1,
        fades: entries.filter(entry => entry.transitionIn === 'fade').length,
        splitScenes: entries.filter(entry => entry.part > 0).length,
        durations: durations.map(value => Number(value.toFixed(2)))
      }
    };
  }

  async usableAsset(scene) {
    const extension = path.extname(scene?.assetPath || '').toLowerCase();
    if (!scene?.assetPath || !await fileExists(scene.assetPath)) return null;
    if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', file: scene.assetPath };
    if (VIDEO_EXTENSIONS.has(extension)) return { kind: 'video', file: scene.assetPath };
    return null; // a ".info" placeholder is not footage
  }

  // 500 ms dips (250 out + 250 in) on soft transitions, applied once on the joined video so the
  // rendered scenes stay clean and reusable as scene assets. Every fade is limited to its own window
  // with `enable`: without it ffmpeg paints the whole video black outside the fade.
  fadeFilters(timeline, withEndScreen) {
    const half = SOP.fadeSeconds / 2;
    const windowed = (type, start) =>
      `fade=t=${type}:st=${start.toFixed(3)}:d=${half}:enable='between(t,${start.toFixed(3)},${(start + half).toFixed(3)})'`;
    const filters = [];
    for (const entry of timeline.entries) {
      if (entry.transitionIn === 'fade') filters.push(windowed('in', entry.start));
      if (entry.fadeOut) filters.push(windowed('out', entry.start + entry.duration - half));
    }
    if (withEndScreen) {
      filters.push(windowed('out', timeline.totalSeconds - half));
      filters.push(windowed('in', timeline.totalSeconds));
    }
    return filters;
  }

  async renderSegment(entry, file, { style, asset }) {
    const common = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(SOP.fps), '-an', file];
    const size = `${SOP.width}:${SOP.height}`;
    const fit = `scale=${size}:force_original_aspect_ratio=increase,crop=${size}`;
    const D = entry.duration.toFixed(3);

    if (asset?.kind === 'video') {
      return this.run(['-y', '-stream_loop', '-1', '-i', asset.file, '-t', D, '-vf', [fit, `fps=${SOP.fps}`].join(','), ...common]);
    }
    if (asset?.kind === 'image') {
      // Ken Burns: four motions in rotation so two neighbours never move the same way.
      const n = frames(entry.duration);
      const motions = [
        `z='min(1+0.0006*on,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
        `z='max(1.15-0.0006*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
        `z=1.12:x='(iw-iw/zoom)*on/${n}':y='ih/2-(ih/zoom/2)'`,
        `z=1.12:x='(iw-iw/zoom)*(1-on/${n})':y='ih/2-(ih/zoom/2)'`
      ];
      const motion = motions[entry.index % motions.length];
      return this.run(['-y', '-i', asset.file, '-vf', [`scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440`, `zoompan=${motion}:d=${n}:s=${size.replace(':', 'x')}:fps=${SOP.fps}`].join(','), '-t', D, ...common]);
    }

    // No footage for this scene: a slow animated gradient in the style's palette, rendered at half
    // size (it is smooth) and scaled up, with a vignette. Different type and seed on every scene.
    const palettes = PALETTES[style] || PALETTES.cinematic;
    const [c0, c1] = palettes[entry.index % palettes.length];
    const type = GRADIENT_TYPES[entry.index % GRADIENT_TYPES.length];
    return this.run([
      '-y', '-f', 'lavfi', '-i', `gradients=size=${SOP.width / 2}x${SOP.height / 2}:rate=${SOP.fps}:duration=${D}:c0=${c0}:c1=${c1}:nb_colors=2:seed=${entry.index + 3}:speed=0.02:type=${type}`,
      '-vf', [`scale=${size}:flags=bicubic`, 'vignette=PI/5'].join(','), ...common
    ]);
  }

  async renderEndScreen(file, seconds, style, index) {
    const [c0, c1] = (PALETTES[style] || PALETTES.cinematic)[index % 3];
    // Two faint frames mark where the creator places the YouTube end-screen video elements.
    const box = x => `drawbox=x=${x}:y=300:w=720:h=405:color=white@0.35:t=3`;
    return this.run([
      '-y', '-f', 'lavfi', '-i', `gradients=size=${SOP.width / 2}x${SOP.height / 2}:rate=${SOP.fps}:duration=${seconds}:c0=${c0}:c1=${c1}:nb_colors=2:seed=99:speed=0.01:type=radial`,
      '-vf', `scale=${SOP.width}:${SOP.height}:flags=bicubic,vignette=PI/4,${box(150)},${box(1050)}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(SOP.fps), '-an', file
    ]);
  }

  async levels(file, filter = null) {
    const log = await stderrOf(this.run, ['-hide_banner', '-i', file, ...(filter ? ['-af', `${filter},volumedetect`] : ['-af', 'volumedetect']), '-vn', '-f', 'null', '-']);
    const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(log);
    const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(log);
    return { meanDb: mean ? Number(mean[1]) : null, peakDb: peak ? Number(peak[1]) : null };
  }

  // Slow drone in low sines: original, license-free, and not "generic stock music".
  async renderDrone(file, seconds) {
    const T = Math.ceil(seconds + 2);
    await this.run([
      '-y', '-f', 'lavfi', '-i', `sine=f=55:d=${T}`, '-f', 'lavfi', '-i', `sine=f=82.41:d=${T}`, '-f', 'lavfi', '-i', `sine=f=110:d=${T}`,
      '-f', 'lavfi', '-i', `anoisesrc=d=${T}:c=brown:a=0.08`,
      '-filter_complex', '[0][1][2][3]amix=inputs=4:normalize=0,lowpass=f=500,tremolo=f=0.12:d=0.5,aecho=0.8:0.8:900|1700:0.35|0.25,aformat=sample_rates=24000:channel_layouts=mono',
      file
    ]);
  }

  async renderSfx(dir) {
    const files = { whoosh: path.join(dir, 'whoosh.wav'), stinger: path.join(dir, 'stinger.wav') };
    await this.run(['-y', '-f', 'lavfi', '-i', 'anoisesrc=d=1.1:c=pink:a=0.6', '-af', 'highpass=f=300,lowpass=f=5000,afade=t=in:d=0.5,afade=t=out:st=0.5:d=0.6', files.whoosh]);
    await this.run([
      '-y', '-f', 'lavfi', '-i', 'sine=f=58:d=2.2', '-f', 'lavfi', '-i', 'sine=f=87:d=2.2', '-f', 'lavfi', '-i', 'anoisesrc=d=2.2:c=brown:a=0.9',
      '-filter_complex', '[2]afade=t=out:st=0:d=0.3[n];[0][1][n]amix=inputs=3:normalize=0,afade=t=out:st=0.1:d=2.0,aecho=0.8:0.7:70:0.4,volume=1.4',
      files.stinger
    ]);
    return files;
  }

  // Where the 2-4 strategic effects go: a stinger on the hook, whooshes on re-hooks, a stinger on the first figure.
  planSfx(timeline, overlays) {
    const placements = [{ type: 'stinger', at: 0.15 }];
    for (const entry of timeline.entries.filter(item => item.role === 'rehook').slice(0, 2)) {
      placements.push({ type: 'whoosh', at: Math.max(0.5, entry.start - 0.25) });
    }
    const figure = overlays.find(item => /\d/.test(item.headline));
    if (figure && placements.length < SOP.sfx.max) placements.push({ type: 'stinger', at: figure.start });
    if (placements.length < SOP.sfx.min) {
      const cut = timeline.entries.find(item => item.start > timeline.totalSeconds * 0.3 && item.transitionIn === 'cut') || timeline.entries[Math.floor(timeline.entries.length / 2)];
      placements.push({ type: 'whoosh', at: Math.max(0.5, cut.start - 0.25) });
    }
    return placements.slice(0, SOP.sfx.max).sort((a, b) => a.at - b.at);
  }

  // Narration peak at -4.5 dB, music bed at a mean of -19 dB, effects underneath; one limiter on the sum.
  async mixSound({ narrationPath, totalSeconds, timeline, overlays, musicPath, dir }) {
    const evidence = { narrationPeakDb: null, musicMeanDb: null, musicSource: null, sfx: [] };
    const inputs = [];
    const chains = [];
    const labels = [];

    if (narrationPath && await fileExists(narrationPath)) {
      const { peakDb } = await this.levels(narrationPath);
      const gain = Math.max(-12, Math.min(18, SOP.narrationPeakDb - (peakDb ?? SOP.narrationPeakDb)));
      evidence.narrationPeakDb = Number(((peakDb ?? SOP.narrationPeakDb) + gain).toFixed(1));
      inputs.push(narrationPath);
      chains.push(`[${inputs.length - 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${gain.toFixed(2)}dB[narration]`);
      labels.push('[narration]');
    }

    let bed = musicPath && await fileExists(musicPath) ? musicPath : null;
    evidence.musicSource = bed ? path.basename(bed) : 'procedural-drone';
    if (!bed) {
      bed = path.join(dir, 'drone.wav');
      await this.renderDrone(bed, totalSeconds);
    }
    const { meanDb } = await this.levels(bed);
    const musicGain = SOP.musicMeanDb - (meanDb ?? SOP.musicMeanDb);
    evidence.musicMeanDb = Number(((meanDb ?? SOP.musicMeanDb) + musicGain).toFixed(1));
    inputs.push(bed);
    chains.push(`[${inputs.length - 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${musicGain.toFixed(2)}dB,atrim=0:${totalSeconds.toFixed(2)},afade=t=out:st=${Math.max(0, totalSeconds - 4).toFixed(2)}:d=4[music]`);
    labels.push('[music]');

    const sfxFiles = await this.renderSfx(dir);
    for (const [index, placement] of this.planSfx(timeline, overlays).entries()) {
      inputs.push(sfxFiles[placement.type]);
      const delay = Math.round(placement.at * 1000);
      chains.push(`[${inputs.length - 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=-9dB,adelay=${delay}|${delay}[sfx${index}]`);
      labels.push(`[sfx${index}]`);
      evidence.sfx.push({ type: placement.type, at: Number(placement.at.toFixed(2)) });
    }

    const mix = path.join(dir, 'mix.wav');
    await this.run([
      '-y', ...inputs.flatMap(file => ['-i', file]),
      '-filter_complex', `${chains.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,alimiter=limit=0.95,atrim=0:${totalSeconds.toFixed(2)}[mixed]`,
      '-map', '[mixed]', '-ar', '48000', mix
    ]);
    return { mix, evidence };
  }

  async exportVideo({ segments, mixPath, assPath, lutPath, outputPath, totalSeconds, dir, fades = [] }) {
    const list = path.join(dir, 'segments.txt');
    await fs.writeFile(list, segments.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
    const lut = lutPath && await fileExists(lutPath) ? `lut3d=file='${lutPath.replaceAll('\\', '/').replace(':', '\\:')}'` : null;
    const look = lut || DEFAULT_LOOK;
    const grain = process.env.EDIT_GRAIN === 'on' ? ',noise=alls=6:allf=t' : '';
    const filter = [look + grain, ...fades, subtitlesFilter(assPath), 'format=yuv420p'].join(',');
    const log = path.join(dir, 'x264');
    const encode = ['-c:v', 'libx264', '-preset', this.preset, '-b:v', SOP.video.bitrate, '-maxrate', SOP.video.maxrate, '-bufsize', SOP.video.bufsize, '-r', String(SOP.fps), '-passlogfile', log];

    await this.run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', filter, ...encode, '-pass', '1', '-an', '-f', 'mp4', process.platform === 'win32' ? 'NUL' : '/dev/null']);
    await this.run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', mixPath, '-vf', filter, ...encode, '-pass', '2',
      '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', SOP.audioBitrate, '-ar', '48000', '-movflags', '+faststart', '-t', totalSeconds.toFixed(2), outputPath]);
    return { look: lut ? 'lut3d' : 'channel-default', lutFile: lut ? path.basename(lutPath) : null };
  }

  async probeOutput(file) {
    const banner = await stderrOf(this.run, ['-hide_banner', '-i', file]);
    const video = /Video: (\w+)[^\n]*?(\d{3,5})x(\d{3,5})[^\n]*?(?:(\d+) kb\/s, )?([\d.]+) fps/.exec(banner);
    const audio = /Audio: (\w+)[^\n]*?(?:(\d+) kb\/s)?\s*(?:\(default\))?\s*$/m.exec(banner);
    const overall = /bitrate:\s*(\d+) kb\/s/.exec(banner);
    return {
      seconds: Number((await this.getDuration(file)).toFixed(2)),
      videoCodec: video?.[1] || null,
      width: video ? Number(video[2]) : null,
      height: video ? Number(video[3]) : null,
      fps: video ? Number(video[5]) : null,
      audioCodec: audio?.[1] || null,
      audioKbps: audio?.[2] ? Number(audio[2]) : null,
      overallKbps: overall ? Number(overall[1]) : null,
      bytes: (await fs.stat(file)).size
    };
  }

  /**
   * Builds the final video from the manifest scenes.
   * @param {object} input { scenes, storyboard, narrationPath, narrationSeconds, outputPath, dir, style, lutPath, musicPath, endScreen }
   * @returns {{ path, evidence }} evidence is what the SOP quality gate checks
   */
  async edit(input) {
    const { scenes, storyboard, narrationPath, outputPath, dir, endScreen = true, assetsDir = null } = input;
    if (!scenes?.length) throw new Error('The editor needs the scene manifest');
    const narrationSeconds = input.narrationSeconds || (narrationPath ? await this.getDuration(narrationPath).catch(() => null) : null);
    const style = input.style || storyboard?.style || 'cinematic';
    await fs.mkdir(dir, { recursive: true });

    const timeline = this.planTimeline(scenes, storyboard, narrationSeconds);
    const assets = await Promise.all(timeline.entries.map(entry => this.usableAsset(entry.asset)));
    this.logger.info(`Editing ${timeline.entries.length} scenes (${timeline.stats.medianSeconds}s median, ${timeline.stats.hardCuts} cuts, ${timeline.stats.fades} fades)`);

    const files = await mapLimit(timeline.entries, this.parallel, async (entry, index) => {
      const file = path.join(dir, `seg_${String(index).padStart(3, '0')}.mp4`);
      await this.renderSegment(entry, file, { style, asset: assets[index] });
      return file;
    });
    const endSeconds = endScreen ? SOP.endScreenSeconds : 0;
    if (endScreen) {
      const file = path.join(dir, 'end_screen.mp4');
      await this.renderEndScreen(file, endSeconds, style, timeline.entries.length);
      files.push(file);
    }
    const totalSeconds = timeline.totalSeconds + endSeconds;

    const overlays = buildOverlays(storyboard, scenes, narrationSeconds);
    const assPath = path.join(dir, 'text.ass');
    await fs.writeFile(assPath, buildASS(overlays, {
      endScreen: endScreen ? { start: timeline.totalSeconds + 0.5, end: totalSeconds, text: 'Assista a seguir' } : null
    }), 'utf8');

    const { mix, evidence: sound } = await this.mixSound({ narrationPath, totalSeconds, timeline, overlays, musicPath: input.musicPath, dir });
    const staged = path.join(dir, 'edited.mp4');
    const look = await this.exportVideo({
      segments: files, mixPath: mix, assPath, lutPath: input.lutPath, outputPath: staged, totalSeconds, dir,
      fades: this.fadeFilters(timeline, endScreen)
    });

    // Scenes that had no footage keep the backdrop that was rendered for them, so the manifest points
    // at a real, replaceable file and a later rebuild reuses it.
    const generated = [];
    if (assetsDir) {
      await fs.mkdir(assetsDir, { recursive: true });
      for (const entry of timeline.entries.filter(item => item.part === 0 && !assets[item.index])) {
        const target = path.join(assetsDir, `${entry.sceneId}.mp4`);
        await fs.copyFile(files[entry.index], target);
        generated.push({ sceneId: entry.sceneId, path: target });
      }
    }
    await fs.rename(staged, outputPath).catch(async () => { await fs.copyFile(staged, outputPath); });

    const probe = await this.probeOutput(outputPath);
    const evidence = {
      sop: SOP.code,
      renderedAt: new Date().toISOString(),
      timeline: timeline.stats,
      visuals: { real: assets.filter(Boolean).length, procedural: assets.filter(asset => !asset).length, style },
      look,
      text: { moments: overlays.length, font: 'Montserrat Bold', color: '#FFD600', sizePt: 64, firstAt: overlays[0] ? Number(overlays[0].start.toFixed(2)) : null },
      audio: sound,
      endScreen: endScreen ? { startSeconds: Number(timeline.totalSeconds.toFixed(2)), seconds: endSeconds, videos: 2 } : null,
      export: { ...probe, target: `${SOP.video.bitrate} VBR 2-pass`, maxrate: SOP.video.maxrate, audioBitrate: SOP.audioBitrate }
    };
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { path: outputPath, evidence, generated };
  }
}

module.exports = { VideoEditorService, SOP, deliveryName };

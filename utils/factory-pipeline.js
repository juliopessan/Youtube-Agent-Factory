const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { Logger } = require('./logger');

// End-to-end factory run: (mining) → topic → script → compliance → storyboard → narration →
// video → text overlays → quality gate → Shorts from the best moments → verified report.
// It drives the same agent the dashboard and scheduler use, then inspects the files that were
// really produced so a "completed" job can never hide a silent or placeholder video.

const REPORTS_ROOT = path.join(__dirname, '..', 'reports', 'factory');
const SILENT_DB = -50; // mean volume below this means the narration is effectively silent

// FFmpeg writes its diagnostics to stderr whether the command succeeds or not.
async function stderrOf(args) {
  const result = await runFFmpeg(args).catch(error => ({ stderr: error.stderr || '' }));
  return String(result.stderr || '');
}

// Stream facts parsed from FFmpeg's own banner: works with the bundled ffmpeg-static (no ffprobe).
async function probe(file) {
  const info = { exists: false, bytes: 0, seconds: null, width: null, height: null, hasVideo: false, hasAudio: false, meanVolumeDb: null };
  try {
    info.bytes = (await fs.stat(file)).size;
    info.exists = info.bytes > 0;
  } catch (_error) {
    return info;
  }
  try { info.seconds = Number((await getMediaDuration(file)).toFixed(2)); } catch (_error) { /* leave null */ }
  const banner = await stderrOf(['-hide_banner', '-i', file]);
  const video = /Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(banner);
  if (video) Object.assign(info, { hasVideo: true, width: Number(video[1]), height: Number(video[2]) });
  info.hasAudio = /Stream #\d+:\d+[^\n]*Audio:/.test(banner);
  if (info.hasAudio) {
    const levels = await stderrOf(['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(levels);
    if (match) info.meanVolumeDb = Number(match[1]);
  }
  return info;
}

function status(ok, warn = false) {
  return ok ? 'ok' : warn ? 'warning' : 'failed';
}

class FactoryPipeline {
  constructor(app, options = {}) {
    this.app = app;
    this.logger = options.logger || new Logger('FactoryPipeline');
    this.reportsRoot = options.reportsRoot || REPORTS_ROOT;
    this.now = options.now || (() => new Date());
    this.probe = options.probe || probe;
  }

  /**
   * @param {object} input { topic, style, length, mineTerms: string[], shorts: boolean, source: { script: string } }
   * @returns the run report (also written to reports/factory/<id>/)
   */
  async run(input = {}) {
    const startedAt = this.now();
    const run = {
      id: `factory_${startedAt.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`,
      startedAt: startedAt.toISOString(),
      input: { ...input, source: undefined },
      mode: this.app.offline ? 'offline (no YouTube upload)' : 'connected',
      stages: [],
      checks: [],
      files: {}
    };
    const stage = async (name, work) => {
      const began = Date.now();
      try {
        const detail = await work();
        run.stages.push({ ...detail, name, status: detail?.skipped ? 'skipped' : 'ok', ms: Date.now() - began });
        return detail;
      } catch (error) {
        run.stages.push({ name, status: 'failed', ms: Date.now() - began, error: error.message });
        throw error;
      }
    };

    try {
      const mined = await stage('mining', () => this.mine(input, run));
      const topic = await stage('topic', () => this.pickTopic(input, mined));
      const job = await stage('generation', () => this.generate(input, topic));
      // Jobs come straight from the database, which stores the column as production_id.
      const productionId = job.productionId || job.production_id;
      run.job = { id: job.id, status: job.status, productionId, title: job.title };
      await stage('verification', () => this.verify(productionId, run));
    } catch (error) {
      run.error = error.message;
    }

    run.finishedAt = this.now().toISOString();
    run.passed = !run.error && run.checks.every(check => check.status !== 'failed');
    run.reportDir = await this.writeReport(run);
    return run;
  }

  async mine(input, run) {
    if (!input.mineTerms?.length) return { skipped: true, reason: 'no search terms given' };
    const mining = this.app.agents?.channelMining;
    let youtube = null;
    try { youtube = this.app.credentials?.getYouTubeClient?.(); } catch (_error) { /* no OAuth */ }
    if (!mining || !youtube || this.app.offline) {
      return { skipped: true, reason: 'channel mining needs the YouTube Data API credentials' };
    }
    const rows = await mining.mine(input.mineTerms);
    const strategy = await mining.strategize(rows);
    const ideas = await mining.promoteToIdeas(rows, { plans: strategy.multilingualPlans });
    run.files.miningReport = await mining.exportStrategy(strategy);
    return { channels: rows.length, ideas: ideas.map(idea => idea.topic) };
  }

  async pickTopic(input, mined) {
    if (input.topic) return { topic: input.topic, from: 'input' };
    if (mined?.ideas?.length) return { topic: mined.ideas[0], from: 'mining' };
    const backlog = (await this.app.db.listContentIdeas()).find(idea => idea.status === 'backlog');
    if (backlog) {
      await this.app.db.updateContentIdea(backlog.id, { status: 'generating' });
      return { topic: backlog.topic, from: 'backlog', ideaId: backlog.id, angle: backlog.angle };
    }
    throw new Error('No topic: pass one, mine channels, or add an idea to the backlog');
  }

  async generate(input, picked) {
    const job = await this.app.startGenerationJob({
      topic: picked.topic,
      style: input.style || null,
      length: input.length || 'medium',
      source: 'factory',
      strategyContext: picked.angle ? { angle: picked.angle } : null
    });
    const finished = await this.app.waitForGenerationJob(job.id);
    if (picked.ideaId) await this.app.db.updateContentIdea(picked.ideaId, { status: finished.status === 'completed' ? 'generated' : 'backlog' });
    if (finished.status !== 'completed') throw new Error(`Generation ${finished.status} at "${finished.stage}": ${finished.error || 'no error recorded'}`);
    return { ...finished, topic: picked.topic };
  }

  // Looks at the real files and records, instead of trusting the job status.
  async verify(productionId, run) {
    const db = this.app.db;
    const bundle = await db.getProductionBundle(productionId);
    if (!bundle) throw new Error(`Production ${productionId} was not saved`);
    const check = (id, ok, message, warn = false) => run.checks.push({ id, status: status(ok, warn), message });

    const video = bundle.assets?.finalVideo || {};
    const audio = bundle.assets?.audio || {};
    const videoFacts = video.path ? await this.probe(video.path) : { exists: false };
    run.files.video = video.path || null;
    run.video = { ...videoFacts, provider: video.provider?.actualProvider || null, overlays: video.edit?.text?.moments || video.overlays?.count || 0, deliveredAs: video.delivery?.name || null };
    run.edit = video.edit || null;

    check('video_file', videoFacts.exists && videoFacts.hasVideo && !video.simulated,
      videoFacts.exists ? `Final MP4: ${videoFacts.width}x${videoFacts.height}, ${videoFacts.seconds}s, ${(videoFacts.bytes / 1e6).toFixed(1)} MB` : 'The final MP4 is missing or a placeholder');
    check('video_has_audio', videoFacts.hasAudio, videoFacts.hasAudio ? 'The video carries an audio track' : 'The video has no audio track');
    const audible = videoFacts.meanVolumeDb !== null && videoFacts.meanVolumeDb > SILENT_DB;
    check('narration_audible', audible, videoFacts.meanVolumeDb === null ? 'Could not measure the narration level' : `Narration mean volume ${videoFacts.meanVolumeDb} dB${audible ? '' : ' (silent)'}`);
    check('narration_provider', Boolean(audio.provider) && !audio.simulated,
      audio.provider ? `Narration via ${audio.provider}${audio.model ? ` (${audio.model})` : ''}` : 'No narration provider produced audio');
    const expected = Number(bundle.script?.storyboard?.summary?.totalSeconds || 0);
    if (expected && videoFacts.seconds) {
      const drift = Math.abs(videoFacts.seconds - expected) / expected;
      check('duration_matches_script', drift < 0.35, `Video ${videoFacts.seconds}s vs ${expected}s planned (${Math.round(drift * 100)}% apart)`, true);
    }

    const thumbnail = bundle.assets?.thumbnail?.path;
    const thumbFacts = thumbnail ? await this.probe(thumbnail) : { exists: false };
    run.files.thumbnail = thumbnail || null;
    check('thumbnail', thumbFacts.exists, thumbFacts.exists ? 'Thumbnail rendered' : 'Thumbnail missing', true);

    const storyboard = bundle.script?.storyboard;
    check('storyboard', Boolean(storyboard?.shots?.length),
      storyboard ? `${storyboard.summary.shots} shots, ${storyboard.summary.roleCounts.rehook || 0} re-hooks, style ${storyboard.styleLabel}, ${storyboard.summary.generatedClips} paid clips planned` : 'No storyboard was planned', true);
    check('scene_manifest', (bundle.scenes || []).length > 0, `${(bundle.scenes || []).length} scenes in the manifest`);

    const quality = bundle.qualityChecks || [];
    const failed = quality.filter(item => !item.passed);
    const blocking = failed.filter(item => item.blocking);
    check('quality_gate', blocking.length === 0,
      `${quality.length - failed.length}/${quality.length} quality checks passed; review status ${bundle.review_status}${blocking.length ? `; blocking: ${blocking.map(item => item.id).join(', ')}` : ''}`);
    run.quality = quality.map(item => ({ id: item.id, passed: item.passed, blocking: item.blocking, message: item.message }));

    if (this.app.compliance) {
      const compliance = await this.app.compliance.report({ ...bundle, editorData: bundle.editorData });
      run.compliance = { mandatoryDone: compliance.mandatoryDone, checks: compliance.checks.map(item => ({ id: item.id, passed: item.passed, message: item.message })) };
      const open = compliance.checks.filter(item => !item.passed);
      check('compliance', open.length === 0, open.length ? `${open.length} compliance item${open.length === 1 ? '' : 's'} open: ${open.map(item => item.id.replace('compliance_', '')).join(', ')}` : 'Every compliance check passed', true);
    }

    run.provenance = {
      script: bundle.script?.metadata?.generationSource || 'template',
      narration: audio.provider || 'none',
      visuals: video.provider?.actualProvider || 'unknown',
      upload: this.app.offline ? 'not performed (offline mode)' : (bundle.schedule?.status || 'not scheduled')
    };

    const shorts = await db.listShortClips(productionId);
    run.shorts = [];
    for (const clip of shorts) {
      const facts = clip.outputPath ? await this.probe(clip.outputPath) : { exists: false };
      run.shorts.push({ id: clip.id, title: clip.title, status: clip.status, mode: clip.selectionMode, score: clip.momentScore, seconds: facts.seconds, size: facts.exists ? `${facts.width}x${facts.height}` : null, path: clip.outputPath });
    }
    if (shorts.length || run.input.shorts !== false) {
      const good = run.shorts.filter(item => item.status === 'rendered' && item.size === '1080x1920');
      check('shorts', good.length > 0, `${good.length}/${shorts.length} Shorts rendered in 1080x1920`, true);
    }
    return { productionId, reviewStatus: bundle.review_status };
  }

  async writeReport(run) {
    const dir = path.join(this.reportsRoot, run.id);
    try {
      await fs.mkdir(path.join(dir, 'deliverables'), { recursive: true });
      const copy = async (source, name) => {
        if (!source) return null;
        const target = path.join(dir, 'deliverables', name);
        await fs.copyFile(source, target).catch(() => null);
        return target;
      };
      run.files.video = await copy(run.files.video, 'video.mp4') || run.files.video;
      run.files.thumbnail = await copy(run.files.thumbnail, 'thumbnail' + path.extname(run.files.thumbnail || '.jpg')) || run.files.thumbnail;
      for (const [index, short] of (run.shorts || []).entries()) {
        short.deliverable = await copy(short.path, `short-${index + 1}.mp4`);
      }
      await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(run, null, 2), 'utf8');
      await fs.writeFile(path.join(dir, 'report.md'), this.renderMarkdown(run), 'utf8');
    } catch (error) {
      this.logger.warn(`Could not write the factory report: ${error.message}`);
    }
    return dir;
  }

  renderMarkdown(run) {
    const icon = { ok: '✅', warning: '⚠️', failed: '❌', skipped: '⏭️' };
    const lines = [`# Factory run ${run.id}`, '', `**Result:** ${run.passed ? '✅ passed' : '❌ not passed'}${run.error ? ` — ${run.error}` : ''}`, `**Mode:** ${run.mode}`, '', '## Stages', ''];
    for (const item of run.stages) lines.push(`- ${icon[item.status]} **${item.name}** (${(item.ms / 1000).toFixed(1)}s)${item.reason ? ` — ${item.reason}` : ''}${item.error ? ` — ${item.error}` : ''}`);
    lines.push('', '## Checks', '');
    for (const item of run.checks) lines.push(`- ${icon[item.status]} \`${item.id}\` ${item.message}`);
    if (run.provenance) {
      lines.push('', '## What was real', '', `- Script: ${run.provenance.script}`, `- Narration: ${run.provenance.narration}`, `- Visuals: ${run.provenance.visuals}`, `- Upload: ${run.provenance.upload}`);
    }
    if (run.shorts?.length) {
      lines.push('', '## Shorts', '');
      for (const short of run.shorts) lines.push(`- ${short.status} · ${short.mode} · score ${short.score ?? 'n/a'} · ${short.seconds ?? '?'}s · ${short.size || 'not rendered'} · ${short.title}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

module.exports = { FactoryPipeline, probe };

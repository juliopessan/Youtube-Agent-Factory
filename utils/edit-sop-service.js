const { SOP } = require('./video-editor-service');

// "Critérios de qualidade" of SOP-EDV-001 as an automatic gate. It reads the evidence the editor
// records for the cut it delivered (`assets.finalVideo.edit`), so it is cheap and needs no FFmpeg.
// Like the compliance checklist it advises by default and blocks only with `edit_sop_strict`.

const NAME_PATTERN = /^\d{8}_\d{2}_[a-z0-9-]+\.mp4$/;

function stddev(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

// Three scenes in a row with (almost) the same length read as a metronome.
function longestRun(values, tolerance = 0.3) {
  let best = 1;
  let run = 1;
  for (let index = 1; index < values.length; index++) {
    run = Math.abs(values[index] - values[index - 1]) < tolerance ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

class EditSopService {
  constructor(db) {
    this.db = db;
  }

  async isStrict() {
    return this.db?.getSetting ? await this.db.getSetting('edit_sop_strict') === 'true' : false;
  }

  /** Pure evaluation of one delivered video: [{ id, passed, message }]. */
  evaluate(production = {}) {
    const video = production.assets?.finalVideo || {};
    const edit = video.edit;
    if (!edit) return [{ id: 'sop_edit', passed: false, message: `The video was not edited with ${SOP.code}: no cadence, sound design or export evidence` }];

    if (edit.profile === 'ambient') return this.evaluateAmbient(production, edit);
    const checks = [];
    const add = (id, passed, message) => checks.push({ id, passed: Boolean(passed), message });
    const t = edit.timeline || {};
    const sfx = edit.audio?.sfx || [];

    add('sop_edit', true, `Edited with ${edit.sop}: ${t.scenes} scenes, ${t.hardCuts} hard cuts, ${t.fades} soft fades`);

    const hookText = edit.text?.firstAt;
    const hookSound = sfx.some(item => item.at <= 7);
    add('sop_hook', hookText !== null && hookText !== undefined && hookText <= 7 && hookSound,
      hookText <= 7 && hookSound
        ? `Hook has on-screen text at ${hookText}s and a sound hit inside the first 7 seconds`
        : 'The first 7 seconds need a strong hook: on-screen claim and sound design');

    const cadenceOk = t.medianSeconds >= SOP.scene.min && t.medianSeconds <= SOP.scene.max && t.maxSeconds <= SOP.scene.hardMax && t.minSeconds >= 3;
    add('sop_cadence', cadenceOk, `Scene change every ${t.medianSeconds}s (median), from ${t.minSeconds}s to ${t.maxSeconds}s${cadenceOk ? '' : `; target ${SOP.scene.min}-${SOP.scene.max}s and never beyond ${SOP.scene.hardMax}s`}`);

    if (Array.isArray(t.durations) && t.durations.length > 2) {
      const spread = stddev(t.durations);
      const run = longestRun(t.durations);
      add('sop_variation', spread >= 1 && run < 3, `Scene lengths vary (σ ${spread.toFixed(1)}s, longest run of equal lengths: ${run})`);
    }

    add('sop_look', Boolean(edit.look?.look), `Colour look applied to every scene: ${edit.look?.look || 'none'}`);

    const text = edit.text || {};
    add('sop_text', text.moments >= 4 && text.moments <= 6 && /yellow|#ffd600/i.test(text.color || '') && text.sizePt >= 60,
      `${text.moments} on-screen text moments (${text.font}, ${text.color}, ${text.sizePt}pt)${text.moments >= 4 && text.moments <= 6 ? '' : '; target 4-6'}`);

    const narration = edit.audio?.narrationPeakDb;
    add('sop_narration_level', narration === null || narration === undefined ? true : narration >= -6 && narration <= -3,
      narration === null || narration === undefined ? 'No narration level to check (silent video)' : `Narration peaks at ${narration} dB (target -6 to -3 dB)`);
    const music = edit.audio?.musicMeanDb;
    add('sop_music_level', music >= -20 && music <= -18, `Music bed at ${music} dB mean (target -20 to -18 dB, source ${edit.audio?.musicSource})`);
    add('sop_sfx', sfx.length >= SOP.sfx.min && sfx.length <= SOP.sfx.max, `${sfx.length} strategic sound effects (target ${SOP.sfx.min}-${SOP.sfx.max})`);

    add('sop_end_screen', Boolean(edit.endScreen) && edit.endScreen.seconds >= SOP.endScreenSeconds,
      edit.endScreen ? `End screen over the last ${edit.endScreen.seconds}s pointing to ${edit.endScreen.videos} videos (attach them in YouTube Studio)` : 'No 20 second end screen');

    const scenes = production.scenes || [];
    if (scenes.length > 1) {
      const repeated = scenes.filter((scene, index) => index && scene.assetPath && scene.assetPath === scenes[index - 1].assetPath).length;
      add('sop_no_duplicates', repeated === 0, repeated ? `${repeated} scene${repeated === 1 ? '' : 's'} repeat the previous scene's footage` : 'No duplicated scenes in sequence');
    }

    const out = edit.export || {};
    const formatOk = out.width === SOP.width && out.height === SOP.height && Math.round(out.fps) === SOP.fps && out.videoCodec === 'h264' && out.audioCodec === 'aac' &&
      out.audioBitrate === '320k' && (out.audioKbps === null || out.audioKbps >= 192) && (out.overallKbps === null || out.overallKbps <= 16500);
    add('sop_export', formatOk, `Export ${out.width}x${out.height} ${out.fps}fps ${out.videoCodec}/${out.audioCodec}, ${out.overallKbps} kb/s overall (${out.target}, max ${out.maxrate}; AAC set to ${out.audioBitrate}, measured ${out.audioKbps} kb/s because the encoder spends fewer bits on simple audio)`);

    const name = video.delivery?.name;
    add('sop_naming', NAME_PATTERN.test(name || ''), name ? `Delivered as ${name} in the finalizado folder` : 'The delivery file name [Data]_[NumeroVideo]_[TemaCurto].mp4 is missing');
    return checks;
  }

  /** Relaxation video: long scenes, crossfades only, a calm loudness, a title and an end screen. */
  evaluateAmbient(production, edit) {
    const checks = [];
    const add = (id, passed, message) => checks.push({ id, passed: Boolean(passed), message });
    const t = edit.timeline || {};
    const audio = edit.audio || {};
    const out = edit.export || {};

    add('sop_edit', true, `Edited with ${edit.sop}: ${t.scenes} scenes joined by ${t.crossfadeSeconds}s crossfades`);
    add('ambient_cadence', t.medianSeconds >= 20 && t.medianSeconds <= 90 && t.minSeconds >= 15,
      `Scenes of ${t.medianSeconds}s (median), from ${t.minSeconds}s to ${t.maxSeconds}s (target 20-90s: nothing should startle a relaxed viewer)`);
    add('ambient_crossfades', t.hardCuts === 0 && t.fades >= t.scenes - 1, t.hardCuts === 0 ? 'Every scene change is a crossfade' : `${t.hardCuts} hard cut${t.hardCuts === 1 ? '' : 's'} in a relaxation video`);
    add('ambient_loudness', audio.lufs >= -22 && audio.lufs <= -16 && audio.truePeakDb <= -1,
      `Loudness ${audio.lufs} LUFS with a true peak of ${audio.truePeakDb} dB (target -22 to -16 LUFS, peak under -1 dB)`);
    add('ambient_title', edit.text?.moments >= 1, `${edit.text?.moments} on-screen text moment${edit.text?.moments === 1 ? '' : 's'}, starting with the title card`);
    add('sop_end_screen', Boolean(edit.endScreen) && edit.endScreen.seconds >= 20,
      edit.endScreen ? `End screen over the last ${edit.endScreen.seconds}s (attach the videos in YouTube Studio)` : 'No 20 second end screen');
    add('sop_export', out.width === 1920 && out.height === 1080 && Math.round(out.fps) === 30 && out.videoCodec === 'h264' && out.audioCodec === 'aac' && (out.overallKbps === null || out.overallKbps <= 9000),
      `Export ${out.width}x${out.height} ${out.fps}fps ${out.videoCodec}/${out.audioCodec}, ${out.overallKbps} kb/s overall (${out.target}, max ${out.maxrate})`);
    const name = production.assets?.finalVideo?.delivery?.name;
    add('sop_naming', NAME_PATTERN.test(name || ''), name ? `Delivered as ${name} in the finalizado folder` : 'The delivery file name [Data]_[NumeroVideo]_[TemaCurto].mp4 is missing');
    return checks;
  }

  // Checks as the quality gate expects them.
  async review(production = {}) {
    const strict = await this.isStrict();
    return this.evaluate(production).map(check => ({ ...check, blocking: strict, category: 'edit_sop' }));
  }
}

module.exports = { EditSopService, NAME_PATTERN, longestRun };

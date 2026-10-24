const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { Logger } = require('./logger');

// Headline + subheadline in the lower-left corner (the Flow "Textos de Destaque"),
// rendered as an ASS file through libass: the same filter the Shorts captions already use,
// so no font file has to be installed. The data comes from the Director's storyboard.

const MIN_SHOT_SECONDS = 4;
const MAX_OVERLAY_SECONDS = 5;
const LEAD_IN_SECONDS = 1;

function assTime(seconds) {
  const centis = Math.max(0, Math.round(Number(seconds) * 100));
  const h = Math.floor(centis / 360000);
  const m = Math.floor((centis % 360000) / 6000);
  const s = Math.floor((centis % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(centis % 100).padStart(2, '0')}`;
}

// Braces start override blocks and backslashes escape; neither may come from script text.
function assText(value) {
  return String(value || '').replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ').trim();
}

/**
 * When each overlay shows. Scene durations in the manifest are estimates, so the timeline is
 * rescaled to the real video length; storyboard shots are matched to scenes by label.
 */
function buildOverlays(storyboard, scenes = [], videoSeconds = null) {
  const shots = (storyboard?.shots || []).filter(shot => shot.showTextOverlay && shot.headline);
  if (!shots.length || !scenes.length) return [];
  const manifestTotal = scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
  const scale = videoSeconds && manifestTotal ? videoSeconds / manifestTotal : 1;

  const starts = new Map();
  let cursor = 0;
  for (const scene of scenes) {
    starts.set(scene.label, { start: cursor * scale, duration: Number(scene.duration || 0) * scale });
    cursor += Number(scene.duration || 0);
  }
  return shots.flatMap(shot => {
    const slot = starts.get(shot.label);
    if (!slot || slot.duration < MIN_SHOT_SECONDS) return [];
    const start = slot.start + LEAD_IN_SECONDS;
    const end = start + Math.min(MAX_OVERLAY_SECONDS, slot.duration - LEAD_IN_SECONDS);
    return [{ start, end, headline: shot.headline, subheadline: shot.subheadline || '' }];
  });
}

function buildASS(overlays, { vertical = false } = {}) {
  const [width, height] = vertical ? [1080, 1920] : [1920, 1080];
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Highlight,Arial,${Math.round(height * 0.06)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,1,${Math.round(width * 0.05)},${Math.round(width * 0.05)},${Math.round(height * 0.09)},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const events = overlays.map(item => {
    const headline = assText(item.headline).toUpperCase();
    const sub = assText(item.subheadline);
    const text = sub
      ? `{\\fad(250,250)}{\\b1}${headline}\\N{\\b0\\fs${Math.round(height * 0.038)}\\c&H00D7D7D7&}${sub}`
      : `{\\fad(250,250)}{\\b1}${headline}`;
    return `Dialogue: 0,${assTime(item.start)},${assTime(item.end)},Highlight,,0,0,0,,${text}`;
  });
  return `${[...header, ...events].join('\n')}\n`;
}

function filterPath(filePath) {
  return path.resolve(filePath).replaceAll('\\', '/').replace(':', '\\:').replaceAll("'", "\\'");
}

class TextOverlayService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('TextOverlay');
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.getMediaDuration = options.getMediaDuration || getMediaDuration;
  }

  /**
   * Burns the storyboard's overlays into the video, replacing the file in place.
   * Never throws: on any failure the original video is kept untouched.
   */
  async apply(videoPath, storyboard, scenes, { vertical = false } = {}) {
    try {
      let videoSeconds = null;
      try { videoSeconds = await this.getMediaDuration(videoPath); } catch (_error) { /* keep manifest timing */ }
      const overlays = buildOverlays(storyboard, scenes, videoSeconds);
      if (!overlays.length) return { applied: 0 };

      const assPath = videoPath.replace(/\.mp4$/i, '') + '_overlays.ass';
      const outputPath = videoPath.replace(/\.mp4$/i, '') + '_overlays.mp4';
      await fs.writeFile(assPath, buildASS(overlays, { vertical }), 'utf8');
      try {
        await this.runFFmpeg([
          '-y', '-i', videoPath, '-vf', `subtitles='${filterPath(assPath)}'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-movflags', '+faststart', outputPath
        ]);
        const stats = await fs.stat(outputPath);
        if (!stats.isFile() || stats.size <= 0) throw new Error('FFmpeg returned an empty video');
        await fs.rename(outputPath, videoPath);
      } finally {
        await fs.unlink(outputPath).catch(() => {});
      }
      this.logger.info(`Rendered ${overlays.length} text overlay${overlays.length === 1 ? '' : 's'} into ${path.basename(videoPath)}`);
      return { applied: overlays.length, assPath };
    } catch (error) {
      this.logger.warn(`Text overlays skipped, keeping the original video: ${error.message}`);
      return { applied: 0, error: error.message };
    }
  }
}

module.exports = { TextOverlayService, buildOverlays, buildASS, assText };

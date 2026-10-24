const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { Logger } = require('./logger');

// On-screen text for the Director's storyboard, rendered as an ASS file through libass: the same
// filter the Shorts captions already use, so no font file has to be installed.
// Style follows SOP-EDV-001: Montserrat Bold, yellow #FFD600 with a black outline, at least 60 pt
// on a 1080p frame, one line, lower-left. The headline is the only text drawn (60 pt leaves no
// room for a second line that is still readable on a phone).

const MIN_SHOT_SECONDS = 4; // a text moment needs room to be read
const MIN_HOOK_SECONDS = 2; // the hook claim appears at 0.3 s, so a short hook still fits it
const MAX_OVERLAY_SECONDS = 5;
const LEAD_IN_SECONDS = 1;
const HOOK_LEAD_IN_SECONDS = 0.3; // the claim must be on screen inside the first seconds
const FONT = { name: 'Montserrat', yellow: '&H0000D6FF', black: '&H00000000' };
// Montserrat Bold ships with the project (SIL OFL), so libass finds it on any machine.
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');

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
    if (!slot || slot.duration < (shot.narrativeRole === 'hook' ? MIN_HOOK_SECONDS : MIN_SHOT_SECONDS)) return [];
    const lead = shot.narrativeRole === 'hook' ? HOOK_LEAD_IN_SECONDS : LEAD_IN_SECONDS;
    const start = slot.start + lead;
    const end = start + Math.min(MAX_OVERLAY_SECONDS, slot.duration - lead);
    return end - start >= 1.5 ? [{ start, end, headline: shot.headline, role: shot.narrativeRole || null }] : [];
  });
}

function buildASS(overlays, { vertical = false, endScreen = null } = {}) {
  const [width, height] = vertical ? [1080, 1920] : [1920, 1080];
  // PlayRes equals the frame, so the font size in the style is the size in pixels (and points on a 1080p export).
  const size = vertical ? 78 : 64;
  const margin = Math.round(width * 0.05);
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Highlight,${FONT.name},${size},${FONT.yellow},&H000000FF,${FONT.black},&H80000000,-1,0,0,0,100,100,0,0,1,4,1,1,${margin},${margin},${Math.round(height * 0.09)},1`,
    `Style: EndScreen,${FONT.name},${Math.round(size * 0.9)},&H00FFFFFF,&H000000FF,${FONT.black},&H80000000,-1,0,0,0,100,100,0,0,1,3,1,8,${margin},${margin},${Math.round(height * 0.07)},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const events = overlays.map(item =>
    `Dialogue: 0,${assTime(item.start)},${assTime(item.end)},Highlight,,0,0,0,,{\\fad(250,250)}${assText(item.headline).toUpperCase()}`);
  if (endScreen) {
    events.push(`Dialogue: 0,${assTime(endScreen.start)},${assTime(endScreen.end)},EndScreen,,0,0,0,,{\\fad(400,0)}${assText(endScreen.text).toUpperCase()}`);
  }
  return `${[...header, ...events].join('\n')}\n`;
}

/**
 * Soft text for relaxation videos: a centered title card and quiet breathing lines, white and light,
 * with long fades. Nothing like the yellow, punchy text of the narrated profile.
 */
function buildAmbientASS({ title, captions = [], endScreen = null, vertical = false }) {
  const [width, height] = vertical ? [1080, 1920] : [1920, 1080];
  const margin = Math.round(width * 0.08);
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Title,${FONT.name},${vertical ? 84 : 76},&H00FFFFFF,&H000000FF,&H40000000,&H80000000,-1,0,0,0,100,100,2,0,1,2,2,5,${margin},${margin},0,1`,
    `Style: Caption,${FONT.name},${vertical ? 56 : 48},&H00F2F2F2,&H000000FF,&H40000000,&H80000000,0,0,0,0,100,100,1,0,1,2,1,2,${margin},${margin},${Math.round(height * 0.14)},1`,
    `Style: EndScreen,${FONT.name},${vertical ? 56 : 52},&H00FFFFFF,&H000000FF,&H40000000,&H80000000,-1,0,0,0,100,100,1,0,1,2,1,8,${margin},${margin},${Math.round(height * 0.07)},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const events = [];
  if (title) events.push(`Dialogue: 0,${assTime(2.5)},${assTime(11)},Title,,0,0,0,,{\\fad(1500,1500)}${assText(title).toUpperCase()}`);
  for (const caption of captions) {
    events.push(`Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Caption,,0,0,0,,{\\fad(1200,1200)}${assText(caption.text)}`);
  }
  if (endScreen) events.push(`Dialogue: 0,${assTime(endScreen.start)},${assTime(endScreen.end)},EndScreen,,0,0,0,,{\\fad(800,0)}${assText(endScreen.text).toUpperCase()}`);
  return `${[...header, ...events].join('\n')}\n`;
}

function filterPath(filePath) {
  return path.resolve(filePath).replaceAll('\\', '/').replace(':', '\\:').replaceAll("'", "\\'");
}

function subtitlesFilter(assPath) {
  return `subtitles='${filterPath(assPath)}':fontsdir='${filterPath(FONTS_DIR)}'`;
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
          '-y', '-i', videoPath, '-vf', subtitlesFilter(assPath),
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

module.exports = { TextOverlayService, buildOverlays, buildASS, buildAmbientASS, assText, subtitlesFilter, FONTS_DIR };

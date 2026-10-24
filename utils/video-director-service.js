const { Logger } = require('./logger');
const { scriptScenes } = require('./scene-repair-service');
const { nicheInfo } = require('./niche-intelligence');
const { detectLanguage, normalizeLanguage } = require('./language');

// AI Video Director adapted for YouTube.
// The original Flow tool turns a script into a storyboard of 4-10 second shots with a
// Hook / Re-hook / Meat / CTA retention architecture, a recurring cast and setting,
// per-shot narration pacing and a voice tone. Here the same ideas drive long-form
// videos (20+ min) and Shorts, and spend the paid-clip budget where retention is won.

const VISUAL_STYLES = {
  cinematic: { label: 'Cinematográfico 35mm', descriptor: 'cinematic 35mm anamorphic look, rich color grading, volumetric light', lighting: 'soft volumetric key light with deep shadows' },
  realistic: { label: 'Fotorrealista', descriptor: 'photorealistic high-fidelity footage, real-world textures', lighting: 'natural daylight with realistic falloff' },
  '3d_animation': { label: 'Animação 3D', descriptor: 'premium 3D animated feature-film render, stylized materials', lighting: 'bright global illumination with soft bounce light' },
  anime_manga: { label: 'Anime / Shonen', descriptor: 'clean-line anime illustration, dynamic saturated colors', lighting: 'bold cel-shaded lighting with strong rim light' },
  retro_vintage: { label: 'Vintage anos 70', descriptor: '1970s film stock, analog grain, warm faded tones', lighting: 'warm tungsten light with soft halation' },
  noir: { label: 'Film noir', descriptor: 'film noir, high-contrast chiaroscuro, suspenseful shadows, monochrome', lighting: 'hard single-source light with long shadows' }
};
const STYLE_IDS = Object.keys(VISUAL_STYLES);

// Which looks suit which niche (see niche-intelligence). First entry is the default.
const NICHE_STYLE_AFFINITY = {
  'História / Mistérios': ['noir', 'retro_vintage', 'cinematic'],
  'Finanças': ['cinematic', '3d_animation', 'realistic'],
  'Tecnologia': ['3d_animation', 'cinematic', 'realistic'],
  'Saúde / Psicologia': ['3d_animation', 'anime_manga', 'cinematic'],
  'Curiosidades / Ciência': ['realistic', '3d_animation', 'cinematic'],
  'Jardinagem / Natureza': ['realistic', 'cinematic', 'retro_vintage'],
  'Culinária / Receitas': ['realistic', 'cinematic'],
  'Relaxamento / Ambiente': ['cinematic', 'realistic', 'anime_manga']
};

const VOICE_TONES = {
  impactante: { label: 'Impactante e dinâmico', speed: 1.08, instructions: 'Speak with high energy, punchy and dynamic, like a trailer announcer.' },
  cinematografico: { label: 'Cinematográfico e épico', speed: 0.92, instructions: 'Deep, epic voice with dramatic pauses and cinematic diction.' },
  storyteller: { label: 'Storyteller e narrativo', speed: 1, instructions: 'Warm, immersive storyteller voice with natural pauses, as in a documentary.' },
  conversacional: { label: 'Conversacional e moderno', speed: 1.04, instructions: 'Natural and direct, like talking to a friend, relaxed and modern.' },
  persuasivo: { label: 'Persuasivo e enérgico', speed: 1.06, instructions: 'Energetic and persuasive, with a confident and direct call to action.' }
};

const PACING_WPM = { rapido: 170, moderado: 150, dramatico: 125, enfatico: 140 };
const ROLE_PACING = { hook: 'rapido', rehook: 'enfatico', meat: 'moderado', cta: 'moderado' };
const ROLE_LABEL = { hook: 'Hook', rehook: 'Re-hook', meat: 'Meat', cta: 'CTA' };
// Retention impact decides who gets the paid clips when the budget cannot cover every shot.
const ROLE_PRIORITY = { hook: 100, rehook: 80, cta: 70, meat: 50 };

const ROLE_CAMERAS = {
  hook: ['extreme close-up with a fast push-in', 'dramatic low-angle rush forward'],
  rehook: ['abrupt whip pan into a new scale', 'sudden pull-back reveal'],
  meat: ['slow dolly-in', 'smooth lateral tracking shot', 'high aerial drift', 'macro detail pan', 'slow orbit around the subject'],
  cta: ['slow pull-back to an open composition']
};
const ROLE_AUDIO = {
  hook: 'sharp impact hit with rising tension',
  rehook: 'sudden drop to silence, then a riser',
  meat: 'low ambient bed matching the mood',
  cta: 'resolving warm swell'
};
const ROLE_ACTION = {
  hook: 'a sudden dramatic motion that breaks the viewer\'s expectation',
  rehook: 'an abrupt shift in scale that reveals something unexpected',
  meat: 'steady, readable motion that illustrates the narration',
  cta: 'calm resolution as the motion settles'
};

// Long-form changes the visual every 6-10 s and re-hooks every two minutes;
// Shorts are 9:16, change shot every ~5s and re-hook every ~15s.
const FORMATS = {
  // SOP-EDV-001: change scene every 6-10 s, never beyond 12 s, and vary the length from scene to scene.
  long: { aspectRatio: '16:9', shotSeconds: [8, 6, 10, 7, 9, 6, 10, 8], maxShotSeconds: 12, rehookEvery: 120, maxSeconds: null, overlays: { min: 4, max: 6 } },
  short: { aspectRatio: '9:16', shotSeconds: [5, 4, 6], maxShotSeconds: 8, rehookEvery: 15, maxSeconds: 58, overlays: { min: 1, max: 3 } }
};

// A concrete figure or date worth highlighting on screen (never generic marketing text).
const FACT = /\b(1[0-9]{3}|20[0-9]{2})\b|\b\d[\d.,]*\s?(?:%|por cento|percent|milh(?:ão|ões)|bilh(?:ão|ões)|million|billion|km|anos|years|dias|days)(?=\W|$)/i;

function countWords(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function estimateSeconds(text, pacing = 'moderado') {
  const wpm = PACING_WPM[pacing] || PACING_WPM.moderado;
  return Math.max(2, Number(((countWords(text) / wpm) * 60).toFixed(1)));
}

// A sentence longer than the cap is cut at its commas, then at its middle word.
function splitLongSentence(sentence, pacing, maxSeconds) {
  if (estimateSeconds(sentence, pacing) <= maxSeconds) return [sentence];
  const clauses = sentence.split(/(?<=[,;:])\s+/).filter(Boolean);
  if (clauses.length > 1) return clauses.flatMap(clause => splitLongSentence(clause, pacing, maxSeconds));
  const words = sentence.split(/\s+/);
  if (words.length < 4) return [sentence];
  const middle = Math.ceil(words.length / 2);
  return [words.slice(0, middle).join(' '), words.slice(middle).join(' ')].flatMap(part => splitLongSentence(part, pacing, maxSeconds));
}

/**
 * Groups sentences into narration chunks. `targets` is one length in seconds or a list that is
 * cycled so consecutive scenes never share a duration; no chunk exceeds `maxSeconds`.
 */
function splitIntoChunks(text, targets, pacing = 'moderado', maxSeconds = Infinity) {
  const list = Array.isArray(targets) ? targets : [targets];
  const pieces = String(text || '').split(/(?<=[.!?…])\s+/).map(item => item.trim()).filter(Boolean)
    .flatMap(sentence => splitLongSentence(sentence, pacing, maxSeconds));
  if (!pieces.length) return [];
  const chunks = [];
  let current = [];
  const flush = () => { chunks.push(current.join(' ')); current = []; };
  for (const piece of pieces) {
    if (current.length && estimateSeconds([...current, piece].join(' '), pacing) > maxSeconds) flush();
    current.push(piece);
    if (estimateSeconds(current.join(' '), pacing) >= list[chunks.length % list.length]) flush();
  }
  if (current.length) {
    const rest = current.join(' ');
    const merged = chunks.length ? `${chunks[chunks.length - 1]} ${rest}` : null;
    if (merged && estimateSeconds(rest, pacing) < 3 && estimateSeconds(merged, pacing) <= maxSeconds) chunks[chunks.length - 1] = merged;
    else chunks.push(rest);
  }
  return chunks;
}

// The hook's first clause, as the on-screen claim (at most eight words).
function hookHeadline(text) {
  const clause = String(text || '').split(/[,;:.!?…]/)[0].trim().split(/\s+/).slice(0, 8).join(' ');
  return clause.toUpperCase();
}

// A section title without its "Armadilha um:" style prefix, kept short enough to read on a phone.
function keywordHeadline(title) {
  const text = String(title || '').split(':').pop().trim().toUpperCase();
  if (text.length <= 32) return text;
  return text.slice(0, 32).replace(/\s+\S*$/, '');
}

function classify(label) {
  const key = String(label || '').toLowerCase();
  if (key === 'hook') return 'hook';
  if (key === 'introduction') return 'intro';
  if (key === 'conclusion') return 'conclusion';
  if (key === 'call to action') return 'cta';
  return 'section';
}

function cleanText(value, limit = 300) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function extractJson(text) {
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

class VideoDirectorService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('VideoDirector');
    this.aiTextService = options.aiTextService || null;
  }

  setAIService(aiTextService) {
    this.aiTextService = aiTextService;
  }

  hasAI() {
    return Boolean(this.aiTextService?.client || this.aiTextService?.gemini);
  }

  async recentStyles(limit = 3) {
    const recent = this.db?.getRecentScriptSnapshots ? await this.db.getRecentScriptSnapshots(null, limit) : [];
    return recent.map(item => item.script?.storyboard?.style).filter(Boolean);
  }

  // Rotates away from the styles used in the latest videos so the channel never looks like one template.
  chooseStyle(requested, nicheName, recent = []) {
    if (requested && requested !== 'auto' && VISUAL_STYLES[requested]) return requested;
    const affinity = NICHE_STYLE_AFFINITY[nicheName] || STYLE_IDS;
    const pool = [...affinity, ...STYLE_IDS.filter(id => !affinity.includes(id))];
    return pool.find(id => !recent.includes(id)) || pool[0];
  }

  /**
   * Script → storyboard of narration-aligned shots with a retention role each.
   * Deterministic by default; the AI (when available) writes the visual idea of every shot
   * and proposes the recurring cast and setting.
   */
  async createStoryboard(script = {}, options = {}) {
    const format = FORMATS[options.format] ? options.format : 'long';
    const rules = FORMATS[format];
    const niche = nicheInfo([script.title, ...(script.keywords || []), script.metadata?.strategy?.topic].filter(Boolean).join(' '));
    const recent = options.recentStyles || await this.recentStyles();
    const style = this.chooseStyle(options.style, niche.niche, recent);
    const tone = VOICE_TONES[options.voiceTone] ? options.voiceTone : 'storyteller';

    const chunks = [];
    for (const beat of scriptScenes({ ...script, storyboard: undefined })) {
      const kind = classify(beat.label);
      const pacing = ROLE_PACING[kind === 'hook' ? 'hook' : kind === 'cta' ? 'cta' : 'meat'];
      // Chunk at the slowest role pace so no shot can overrun the cap once its role sets the speed.
      const pieces = splitIntoChunks(beat.scriptText, kind === 'hook' ? 8 : rules.shotSeconds, kind === 'hook' ? pacing : 'enfatico', rules.maxShotSeconds);
      pieces.forEach((text, index) => chunks.push({ kind, title: beat.label, text, first: index === 0, last: index === pieces.length - 1 }));
    }
    if (!chunks.length) return null;

    const planned = this.assignRoles(chunks, rules);
    const shots = planned.map((shot, index) => this.buildShot(shot, index, style));
    this.planOverlays(shots, planned, rules.overlays);
    const storyboard = {
      version: 1,
      format,
      style,
      styleLabel: VISUAL_STYLES[style].label,
      aspectRatio: options.aspectRatio || rules.aspectRatio,
      language: normalizeLanguage(options.language) || detectLanguage(chunks.map(chunk => chunk.text).join(' ')),
      niche: niche.niche,
      narration: { voiceTone: tone, label: VOICE_TONES[tone].label, instructions: VOICE_TONES[tone].instructions, speed: VOICE_TONES[tone].speed },
      rehookEverySeconds: rules.rehookEvery,
      characters: [],
      environments: [],
      shots,
      generatedAt: new Date().toISOString()
    };

    if (options.enrich !== false && this.hasAI()) await this.enrich(storyboard, script);
    this.allocateBudget(storyboard, options.maxGeneratedSeconds, options.clipSeconds);
    for (const shot of storyboard.shots) shot.prompt = this.buildPrompt(storyboard, shot);
    storyboard.summary = this.summarize(storyboard, rules);
    return storyboard;
  }

  // Hook first; the intro closes with the re-hook; then a pattern interrupt whenever the cadence runs out.
  assignRoles(chunks, rules) {
    const lastIntro = chunks.map(chunk => chunk.kind).lastIndexOf('intro');
    let sinceHook = 0;
    const shots = chunks.map((chunk, index) => {
      let role = 'meat';
      if (chunk.kind === 'hook') role = 'hook';
      else if (chunk.kind === 'cta') role = 'cta';
      else if (index === lastIntro) role = 'rehook';
      else if (chunk.kind === 'section' && sinceHook >= rules.rehookEvery) role = 'rehook';

      const seconds = estimateSeconds(chunk.text, ROLE_PACING[role]);
      sinceHook = role === 'hook' || role === 'rehook' ? 0 : sinceHook + seconds;
      return { ...chunk, role, seconds };
    });
    if (!shots.some(shot => shot.role === 'cta')) shots[shots.length - 1].role = 'cta';
    if (!shots.some(shot => shot.role === 'hook')) shots[0].role = 'hook';
    return shots;
  }

  buildShot(shot, index, styleId) {
    const style = VISUAL_STYLES[styleId];
    const cameras = ROLE_CAMERAS[shot.role];
    const firstSentence = shot.text.split(/(?<=[.!?…])\s+/)[0].slice(0, 180);
    const intro = shot.role === 'hook'
      ? 'Pattern-breaking opening image: '
      : shot.role === 'rehook' ? 'Pattern interrupt, sudden change of angle and scale: ' : '';
    return {
      id: `shot_${String(index + 1).padStart(3, '0')}`,
      sceneNumber: index + 1,
      label: ['Hook', 'Call to action'].includes(shot.title) ? `${ROLE_LABEL[shot.role]} ${index + 1}` : `${ROLE_LABEL[shot.role]} ${index + 1} · ${shot.title}`,
      title: shot.title,
      narrativeRole: shot.role,
      durationSec: shot.seconds,
      narrationScript: shot.text,
      narrationPacing: ROLE_PACING[shot.role],
      visualDescription: `${intro}${shot.title}. ${firstSentence}`.trim(),
      charactersPresent: [],
      actionExpression: ROLE_ACTION[shot.role],
      environmentLighting: style.lighting,
      cameraMovement: cameras[index % cameras.length],
      audioMusicCue: ROLE_AUDIO[shot.role],
      headline: '',
      subheadline: '',
      showTextOverlay: false,
      generate: false,
      priority: ROLE_PRIORITY[shot.role]
    };
  }

  /**
   * SOP-EDV-001: on-screen text at 4-6 moments (the hook's claim, a key figure, a keyword), never
   * generic marketing copy. The hook always gets one; the others are spread over the video.
   */
  planOverlays(shots, planned, limits = { min: 4, max: 6 }) {
    let cursor = 0;
    const starts = shots.map(shot => { const start = cursor; cursor += shot.durationSec; return start; });
    const candidates = [];
    planned.forEach((source, index) => {
      if (index === 0 && source.role === 'hook') {
        candidates.push({ index, headline: hookHeadline(source.text), priority: 100 });
        return;
      }
      if (source.role === 'cta' || source.role === 'hook') return;
      const fact = FACT.exec(source.text);
      if (fact) candidates.push({ index, headline: fact[0].toUpperCase().slice(0, 40), priority: 60 });
      else if (source.kind === 'section' && source.first) candidates.push({ index, headline: keywordHeadline(source.title), priority: 40 });
    });

    const chosen = [];
    const pick = (gap, max) => {
      for (const candidate of candidates.filter(item => !chosen.includes(item)).sort((a, b) => b.priority - a.priority || a.index - b.index)) {
        if (chosen.length >= max) break;
        if (candidate.headline && chosen.every(other => Math.abs(starts[other.index] - starts[candidate.index]) >= gap)) chosen.push(candidate);
      }
    };
    pick(20, limits.max);
    if (chosen.length < limits.min) pick(8, limits.max);
    for (const candidate of chosen) {
      Object.assign(shots[candidate.index], { headline: candidate.headline, subheadline: '', showTextOverlay: true });
    }
  }

  // One AI call: cast, setting and a specific visual idea per shot, kept consistent across the video.
  async enrich(storyboard, script) {
    const capped = storyboard.shots.slice(0, 80);
    try {
      const prompt = `Você é diretor de vídeo de um canal do YouTube sem rosto. Estilo visual: ${VISUAL_STYLES[storyboard.style].descriptor}. Título: "${script.title || ''}".
Crie um elenco recorrente (0 a 3 personagens/objetos-símbolo) e 1 a 2 ambientes, e para CADA tomada uma ideia visual concreta que ilustre a narração, sem texto na imagem, mantendo a continuidade visual.
Tomadas:
${capped.map(shot => `${shot.id} [${shot.narrativeRole}] ${shot.narrationScript.slice(0, 220)}`).join('\n')}
Responda apenas JSON em inglês: {"characters":[{"id":"c1","name":"","description":""}],"environments":[{"id":"e1","name":"","description":""}],"shots":[{"id":"shot_001","visualDescription":"","cameraMovement":"","environmentLighting":"","actionExpression":"","audioMusicCue":"","charactersPresent":["c1"]}]}`;
      const parsed = extractJson(await this.aiTextService.generateText(prompt, { maxTokens: 4000, temperature: 0.7 }));

      const collect = list => (Array.isArray(list) ? list : []).slice(0, 3)
        .map(item => ({ id: cleanText(item?.id, 20), name: cleanText(item?.name, 60), description: cleanText(item?.description, 240) }))
        .filter(item => item.id && item.name && item.description);
      storyboard.characters = collect(parsed.characters);
      storyboard.environments = collect(parsed.environments);
      const castIds = new Set(storyboard.characters.map(character => character.id));

      const byId = new Map(storyboard.shots.map(shot => [shot.id, shot]));
      for (const item of Array.isArray(parsed.shots) ? parsed.shots : []) {
        const shot = byId.get(item?.id);
        if (!shot) continue;
        for (const field of ['visualDescription', 'cameraMovement', 'environmentLighting', 'actionExpression', 'audioMusicCue']) {
          const value = cleanText(item[field]);
          if (value) shot[field] = value;
        }
        shot.charactersPresent = (Array.isArray(item.charactersPresent) ? item.charactersPresent : []).filter(id => castIds.has(id));
      }
    } catch (error) {
      this.logger.warn(`AI storyboard enrichment skipped, keeping the deterministic plan: ${error.message}`);
    }
  }

  // The paid-clip budget covers hooks, re-hooks and the CTA before any meat shot.
  allocateBudget(storyboard, maxGeneratedSeconds = 60, clipSeconds = 8) {
    const slots = Math.max(0, Math.floor(Number(maxGeneratedSeconds) / Math.max(1, Number(clipSeconds))));
    const retention = storyboard.shots.filter(shot => shot.narrativeRole !== 'meat')
      .sort((a, b) => b.priority - a.priority || a.sceneNumber - b.sceneNumber);
    const chosen = retention.slice(0, slots);
    // Leftover clips are spread across the meat so the visual rhythm does not cluster at the start.
    const left = slots - chosen.length;
    const meat = storyboard.shots.filter(shot => shot.narrativeRole === 'meat');
    if (left > 0 && meat.length) {
      if (left >= meat.length) chosen.push(...meat);
      else for (let i = 0; i < left; i++) chosen.push(meat[Math.floor((i + 0.5) * (meat.length / left))]);
    }
    chosen.forEach(shot => { shot.generate = true; });
    storyboard.clipSeconds = Number(clipSeconds);
  }

  buildPrompt(storyboard, shot) {
    const style = VISUAL_STYLES[storyboard.style];
    const environment = storyboard.environments[0];
    const cast = shot.charactersPresent
      .map(id => storyboard.characters.find(character => character.id === id))
      .filter(Boolean)
      .map(character => `${character.name}: ${character.description}`);
    return [
      `${style.descriptor}.`,
      environment ? `Setting: ${environment.name}, ${environment.description}.` : null,
      cast.length ? `Recurring subjects: ${cast.join('; ')}.` : null,
      `Shot: ${shot.visualDescription}.`,
      `Action: ${shot.actionExpression}.`,
      `Camera: ${shot.cameraMovement}. Lighting: ${shot.environmentLighting}.`,
      `${storyboard.aspectRatio} framing. No readable text, captions or logos.`
    ].filter(Boolean).join(' ').replace(/\.\./g, '.').slice(0, 1800);
  }

  summarize(storyboard, rules) {
    const roleCounts = storyboard.shots.reduce((acc, shot) => ({ ...acc, [shot.narrativeRole]: (acc[shot.narrativeRole] || 0) + 1 }), {});
    const totalSeconds = Number(storyboard.shots.reduce((sum, shot) => sum + shot.durationSec, 0).toFixed(1));
    const generated = storyboard.shots.filter(shot => shot.generate);
    return {
      shots: storyboard.shots.length,
      totalSeconds,
      roleCounts,
      generatedClips: generated.length,
      generatedSeconds: generated.length * storyboard.clipSeconds,
      overlays: storyboard.shots.filter(shot => shot.showTextOverlay).length,
      exceedsFormatLimit: Boolean(rules.maxSeconds && totalSeconds > rules.maxSeconds)
    };
  }

  /**
   * Reads the channel settings and attaches the storyboard to the script.
   * Never throws: a failed storyboard must not stop the generation pipeline.
   */
  async applyToScript(script) {
    try {
      const get = async (key, fallback) => (this.db?.getSetting ? await this.db.getSetting(key) : null) ?? fallback;
      if (await get('director_enabled', 'true') === 'false') return script;
      const storyboard = await this.createStoryboard(script, {
        format: 'long',
        style: await get('director_visual_style', 'auto'),
        voiceTone: await get('director_voice_tone', 'storyteller'),
        enrich: await get('director_ai_enrich', 'true') !== 'false',
        aspectRatio: await get('video_aspect_ratio', '16:9'),
        maxGeneratedSeconds: Number(await get('video_max_generated_seconds', 60)),
        clipSeconds: Number(await get('video_clip_duration', 8))
      });
      return storyboard ? { ...script, storyboard } : script;
    } catch (error) {
      this.logger.warn(`Video director skipped: ${error.message}`);
      return script;
    }
  }
}

module.exports = {
  VideoDirectorService,
  VISUAL_STYLES,
  VOICE_TONES,
  FORMATS,
  ROLE_PRIORITY,
  estimateSeconds,
  splitIntoChunks
};

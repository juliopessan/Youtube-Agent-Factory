// Best-moment finder for Shorts clipping.
// A long video is split into sentence-level segments (timed from the scene manifest),
// every window of 20-58 s that starts and ends on a sentence boundary is scored, and the
// best non-overlapping windows win. Pure functions: no network, no AI, no FFmpeg.

const FACT = /\b(1[0-9]{3}|20[0-9]{2})\b|\b\d[\d.,]*\s?(?:%|por cento|percent|milh(?:ão|ões)|bilh(?:ão|ões)|million|billion|km|anos|years|dias|days)(?=\W|$)/gi;
const CURIOSITY = /\b(ninguém|ninguem|segredo|nunca|jamais|verdade|ocult[oa]|proibid[oa]|chocante|surpreend\w*|descobr\w*|revel\w*|mistério|misterio|nobody|secret|never|truth|hidden|forbidden|shocking|discover\w*|reveal\w*|mystery)\b/i;
const CONTRAST = /\b(mas|porém|porem|no entanto|contudo|só que|but|however|yet|instead)\b/i;
const CONCLUSIVE = /\b(por isso|resultado|finalmente|no fim|that's why|in the end|as a result|finally)\b/i;
// A window that opens on a pronoun or connector needs the previous sentence to make sense.
const DEPENDENT_START = /^(e|mas|então|portanto|porém|isso|isto|esse|essa|esses|essas|ele|ela|eles|elas|assim|and|but|so|then|this|that|these|those|he|she|they|it)\b/i;

const DEFAULTS = { minSeconds: 20, maxSeconds: 58, minGapSeconds: 3, limit: 12 };
// Highest realistic heuristic score; used to put heuristic and AI scores on the same 0-10 scale.
const SCORE_CEILING = 12;

function countWords(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Sentence-level timeline: each scene's duration is shared among its sentences by word count.
function buildSegments(scenes = [], storyboard = null) {
  const roles = new Map((storyboard?.shots || []).map(shot => [shot.label, shot.narrativeRole]));
  const segments = [];
  let cursor = 0;
  for (const scene of scenes) {
    const duration = Math.max(0.5, Number(scene.duration) || 0);
    const text = String(scene.scriptText || '').trim();
    const sentences = text ? text.split(/(?<=[.!?…])\s+/).map(item => item.trim()).filter(Boolean) : [];
    const parts = sentences.length ? sentences : [scene.label || ''];
    const weights = parts.map(part => Math.max(1, countWords(part)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let offset = cursor;
    parts.forEach((part, index) => {
      const length = (duration * weights[index]) / total;
      segments.push({
        sceneId: scene.id,
        sceneLabel: scene.label,
        role: roles.get(scene.label) || null,
        text: part,
        start: offset,
        end: offset + length,
        firstOfScene: index === 0
      });
      offset += length;
    });
    cursor += duration;
  }
  return { segments, total: cursor };
}

// Every sentence-aligned window between minSeconds and maxSeconds.
function candidateWindows(segments, total, { minSeconds, maxSeconds }) {
  const min = Math.min(minSeconds, total);
  const windows = [];
  for (let from = 0; from < segments.length; from++) {
    for (let to = from; to < segments.length; to++) {
      const duration = segments[to].end - segments[from].start;
      if (duration > maxSeconds) {
        if (to === from) windows.push({ from, to, start: segments[from].start, duration: maxSeconds, trimmed: true });
        break;
      }
      if (duration >= min) windows.push({ from, to, start: segments[from].start, duration, trimmed: false });
    }
  }
  return windows;
}

function scoreWindow(segments, window, context = {}) {
  const items = segments.slice(window.from, window.to + 1);
  const first = items[0];
  const last = items[items.length - 1];
  const text = items.map(item => item.text).join(' ');
  const signals = [];
  let score = 0;
  const add = (points, label) => { score += points; signals.push(label); };

  if (first.role === 'hook') add(3, 'abre no hook do vídeo');
  else if (first.role === 'rehook') add(3, 'abre num re-hook');
  else if (items.some(item => item.role === 'rehook')) add(1, 'contém um re-hook');
  if (items.some(item => item.role === 'cta')) add(-3, 'contém o CTA do vídeo longo');

  if (/\?/.test(first.text) || CURIOSITY.test(first.text) || new RegExp(FACT.source, 'i').test(first.text)) {
    add(2, 'abertura com curiosidade ou dado');
  }
  if (first.firstOfScene) add(1, 'começa no início de uma cena');
  if (DEPENDENT_START.test(first.text)) add(-2, 'depende da frase anterior');

  const facts = Math.min(3, (text.match(FACT) || []).length);
  if (facts) add(facts, `${facts} dado${facts > 1 ? 's' : ''} concreto${facts > 1 ? 's' : ''}`);
  if (CONTRAST.test(text)) add(1, 'tem virada (contraste)');
  const questions = Math.min(2, (text.match(/\?/g) || []).length);
  if (questions) add(questions, `${questions} pergunta${questions > 1 ? 's' : ''}`);

  if (/[?…]$/.test(last.text.trim())) add(1, 'termina em gancho');
  else if (CONCLUSIVE.test(last.text)) add(1, 'termina em conclusão');
  if (!/[.!?…]["')]?$/.test(last.text.trim())) add(-1, 'termina no meio da frase');
  if (window.duration >= 25 && window.duration <= 50) add(1, 'duração ideal para Shorts');

  // Real audience evidence outweighs the heuristics (which top out around 9 for a strong passage).
  // YouTube's relative retention runs 0-1: about 0.5 is typical and 0.6+ is a strong hold.
  if (context.retention?.size) {
    const values = [...new Set(items.map(item => item.sceneId))].map(id => context.retention.get(id)).filter(Number.isFinite);
    if (values.length) {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      add(clamp((mean - 0.5) * 16, -4, 7), `retenção real de ${Math.round(mean * 100)}% (relativa a vídeos parecidos)`);
    }
  }
  return { score: round(score), signals };
}

/**
 * Best non-overlapping windows, highest score first.
 * @param {object[]} scenes manifest scenes ({ id, label, scriptText, duration })
 * @param {object} options { storyboard, retention: Map(sceneId → relative retention 0-1), minSeconds, maxSeconds, minGapSeconds, limit }
 */
function rankMoments(scenes, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const { segments, total } = buildSegments(scenes, options.storyboard);
  if (!segments.length) return { moments: [], total: 0 };

  const scored = candidateWindows(segments, total, settings)
    .map(window => ({ window, ...scoreWindow(segments, window, { retention: options.retention }) }))
    .sort((a, b) => b.score - a.score || a.window.start - b.window.start);

  const chosen = [];
  for (const candidate of scored) {
    if (chosen.length >= settings.limit) break;
    const start = candidate.window.start;
    const end = start + candidate.window.duration;
    const clashes = chosen.some(other => start < other.end + settings.minGapSeconds && end > other.start - settings.minGapSeconds);
    if (!clashes) chosen.push({ ...candidate, start, end });
  }

  const moments = chosen.map(candidate => {
    const items = segments.slice(candidate.window.from, candidate.window.to + 1);
    return {
      startSeconds: round(candidate.start),
      duration: round(candidate.window.duration),
      sceneIds: [...new Set(items.map(item => item.sceneId))],
      text: items.map(item => item.text).join(' '),
      firstSentence: items[0].text,
      firstRole: items[0].role,
      trimmed: candidate.window.trimmed,
      score: candidate.score,
      signals: candidate.signals,
      score10: round(clamp((candidate.score * 10) / SCORE_CEILING, 0, 10))
    };
  });
  return { moments, total: round(total) };
}

module.exports = { rankMoments, buildSegments, scoreWindow, candidateWindows, DEFAULTS, SCORE_CEILING };

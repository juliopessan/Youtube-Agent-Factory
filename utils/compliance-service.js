const { Logger } = require('./logger');

// Checklist de Compliance (Fórmula YouTube • Módulo 05 • Aula 02):
// "O YouTube não pune IA, pune fábrica de spam."
// Three human interventions are mandatory (originality, facts, direct hook);
// everything else is refinement. So by default every check is advisory, and
// only those three can block when `compliance_strict` is enabled.

const NATURAL_VOICE_PROVIDERS = new Set(['elevenlabs', 'openai', 'gemini', 'azure', 'kokoro']);
const HOOK_WINDOW_WORDS = 17; // the first ~7 seconds at ~150 words per minute
const RECENT_VIDEOS = 5;
const THRESHOLDS = { script: 0.3, title: 0.7, sameOpening: 2, visualRepeat: 3 };

const GENERIC_OPENINGS = [
  /\b(ol[áa]|oi)\b[^.!?]{0,30}\b(pessoal|galera|gente|amigos|pessoas)\b/i,
  /\be a[ií],? (galera|pessoal|gente)\b/i,
  /\bbem[- ]?vind[oa]s?\b/i,
  /\b(hoje|nesse v[ií]deo|neste v[ií]deo|nesta aula)\b[^.!?]{0,30}\b(vamos|vou|iremos|eu vou)\b[^.!?]{0,20}\b(falar|conversar|ver|mostrar|aprender|explicar)\b/i,
  /\b(hello|hi|hey)\b[^.!?]{0,20}\b(everyone|guys|folks|friends|there)\b/i,
  /\bwelcome (back )?to\b/i,
  /\btoday,? (we are|we're|i am|i'm|we will|we'll|i will|i'll) (going to )?(talk|discuss|look|learn|explore|cover)/i,
  /\bin this video\b/i,
  /\bhola\b[^.!?]{0,20}\b(amigos|a todos|chicos)\b/i,
  /\bbienvenid[oa]s?\b/i,
  /\b(hoy|en este v[ií]deo)\b[^.!?]{0,20}\b(vamos a|voy a)\b/i
];

const SIGNALS = [
  'Mesmo template visual em todos os vídeos sem variação',
  'Voz robótica de TTS genérico em volume alto',
  'Mesma estrutura de roteiro copiada vídeo após vídeo',
  'Múltiplos canais idênticos operados em paralelo',
  'Volume alto de uploads com pouca variação real'
];

const HUMAN_INTERVENTIONS = [
  { id: 'originality', field: 'originalityConfirmed', label: 'Garantir que o roteiro não é cópia', hint: 'Plágio mata. IA gerando original protege.' },
  { id: 'facts', field: 'factChecked', label: 'Revisar erros gritantes de informação', hint: 'IA inventa. Confira datas, nomes e dados nos pontos críticos.' },
  { id: 'hook', field: null, label: 'Ajustar abertura pra hook direto', hint: 'Sem preâmbulo. Os primeiros 7 segundos decidem tudo.' }
];

function words(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

function shingles(text, size = 3) {
  const list = words(text);
  const set = new Set();
  for (let i = 0; i + size <= list.length; i++) set.add(list.slice(i, i + size).join(' '));
  return set;
}

// What the narrator actually says: strips the title banner, rulers and "[0:00-0:15] HOOK" / "[VISUALS: ...]" lines.
function spokenText(script) {
  const raw = String(script?.fullScript || '');
  if (!raw) return hookText(script);
  return raw.split('\n').map(line => line.trim())
    .filter(line => line && !/^TITLE:/i.test(line) && !/^[═─=-]{3,}$/.test(line) && line !== 'MAIN CONTENT')
    .filter(line => {
      const bracketed = /^\[[^\]]*\](.*)$/.exec(line);
      return !bracketed || /[a-zà-ÿ]/.test(bracketed[1]);
    })
    .join(' ');
}

function hookText(script) {
  const hook = script?.hook;
  return String((typeof hook === 'object' && hook !== null ? hook.text : hook) || '').trim();
}

function thumbnailSignature(thumbnail) {
  const concept = thumbnail?.concept || {};
  return concept.style ? `${concept.style}|${concept.colors?.primary || ''}` : null;
}

class ComplianceService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('Compliance');
    this.aiTextService = options.aiTextService || null;
  }

  setAIService(aiTextService) {
    this.aiTextService = aiTextService;
  }

  hasAI() {
    return Boolean(this.aiTextService?.client || this.aiTextService?.gemini);
  }

  async isStrict() {
    return this.db?.getSetting ? await this.db.getSetting('compliance_strict') === 'true' : false;
  }

  check(id, passed, message, blocking = false) {
    return { id, passed: Boolean(passed), blocking: Boolean(blocking), message, category: 'compliance' };
  }

  // Item 03: no generic preamble inside the first ~7 seconds of narration.
  evaluateHook(script) {
    const opening = spokenText(script).split(/\s+/).filter(Boolean).slice(0, HOOK_WINDOW_WORDS).join(' ');
    const generic = GENERIC_OPENINGS.find(pattern => pattern.test(opening));
    return {
      passed: Boolean(opening) && !generic,
      opening,
      message: !opening
        ? 'Roteiro sem abertura para avaliar'
        : generic
          ? `Abertura com preâmbulo genérico ("${opening.slice(0, 70)}…"): vá direto ao tema nos primeiros 7 segundos`
          : 'Hook direto na abertura, sem preâmbulo genérico'
    };
  }

  // Item 04 / regra 01: variation against the last videos of the channel.
  evaluateVariation(script, title, recent) {
    if (!recent.length) return { passed: true, message: 'Sem vídeos anteriores para comparar variação' };
    const current = shingles(spokenText(script));
    const currentTitle = new Set(words(title));
    const currentOpening = words(spokenText(script)).slice(0, 6).join(' ');

    let maxScript = 0;
    let maxTitle = 0;
    let sameOpening = 0;
    for (const previous of recent) {
      maxScript = Math.max(maxScript, jaccard(current, shingles(spokenText(previous.script))));
      maxTitle = Math.max(maxTitle, jaccard(currentTitle, new Set(words(previous.script?.title || previous.title))));
      if (currentOpening && currentOpening === words(spokenText(previous.script)).slice(0, 6).join(' ')) sameOpening++;
    }
    const problems = [];
    if (maxScript >= THRESHOLDS.script) problems.push(`roteiro ${Math.round(maxScript * 100)}% parecido com um dos últimos vídeos`);
    if (maxTitle >= THRESHOLDS.title) problems.push(`título ${Math.round(maxTitle * 100)}% parecido`);
    if (sameOpening >= THRESHOLDS.sameOpening) problems.push(`mesma abertura em ${sameOpening} dos últimos ${recent.length} vídeos`);
    return {
      passed: problems.length === 0,
      maxScript: Number(maxScript.toFixed(2)),
      maxTitle: Number(maxTitle.toFixed(2)),
      sameOpening,
      message: problems.length
        ? `Pouca variação em relação aos últimos ${recent.length} vídeos: ${problems.join('; ')}. Mude tema, ângulo ou estrutura`
        : `Variação suficiente em relação aos últimos ${recent.length} vídeos`
    };
  }

  // Item 05 / regra 02: natural voice, never robotic generic TTS.
  evaluateVoice(audio = {}) {
    if (audio.intentionalSilence === true) return { passed: true, message: 'Vídeo sem narração por decisão do operador' };
    const provider = String(audio.provider || '').toLowerCase();
    if (!provider || audio.simulated || audio.status === 'unavailable') {
      return { passed: false, message: 'Nenhuma voz natural foi gerada: TTS robótico ou ausente dispara a política de conteúdo inautêntico' };
    }
    return NATURAL_VOICE_PROVIDERS.has(provider)
      ? { passed: true, message: `Voz neural via ${provider}${audio.model ? ` (${audio.model})` : ''}` }
      : { passed: false, message: `Provedor de voz "${provider}" não é reconhecido como voz natural; confirme que não é TTS genérico` };
  }

  // Signal 1: the same visual template in every video.
  evaluateVisualVariation(thumbnail, recent) {
    const current = thumbnailSignature(thumbnail);
    const previous = recent.map(item => thumbnailSignature(item.thumbnail)).filter(Boolean);
    if (!current || previous.length < THRESHOLDS.visualRepeat) {
      return { passed: true, message: 'Histórico insuficiente para avaliar repetição de template visual' };
    }
    const repeated = previous.every(signature => signature === current);
    return {
      passed: !repeated,
      message: repeated
        ? `Mesmo template visual nos últimos ${previous.length + 1} vídeos: varie estilo ou paleta da thumbnail`
        : 'Template visual varia em relação aos vídeos recentes'
    };
  }

  // Signal 5: heavy upload volume. Heuristic: more than 2x the daily post limit (minimum 3) in 24h.
  async evaluateVolume() {
    if (!this.db?.getRow) return { passed: true, message: 'Volume de uploads não avaliado' };
    const row = await this.db.getRow("SELECT COUNT(*) AS count FROM productions WHERE created_at >= datetime('now', '-1 day')");
    const limit = Math.max(3, Number(await this.db.getSetting('max_daily_posts') || 1) * 2);
    const count = Number(row?.count || 0);
    return {
      passed: count <= limit,
      message: count <= limit
        ? `${count} produç${count === 1 ? 'ão' : 'ões'} nas últimas 24h (limite de referência ${limit})`
        : `${count} produções nas últimas 24h (referência ${limit}): volume alto com pouca variação real parece fábrica`
    };
  }

  async recentVideos(excludeId, limit = RECENT_VIDEOS) {
    return this.db?.getRecentScriptSnapshots ? this.db.getRecentScriptSnapshots(excludeId, limit) : [];
  }

  /**
   * Run the checklist for a production (script, assets, provenance, editorData).
   * The three mandatory interventions block only in strict mode.
   */
  async review(production = {}) {
    const strict = await this.isStrict();
    const recent = await this.recentVideos(production.id);
    const editor = production.editorData || {};
    const title = production.seo?.title || production.script?.title || '';
    const checks = [];

    const hook = this.evaluateHook(production.script);
    checks.push(this.check('compliance_hook', hook.passed, hook.message, strict));

    checks.push(this.check('compliance_originality', editor.originalityConfirmed === true,
      editor.originalityConfirmed === true
        ? 'Roteiro confirmado como original (sem cópia direta)'
        : 'Confirme que o roteiro não é cópia de nenhum site, vídeo ou material existente', strict));

    const provenanceStatus = production.provenance?.status;
    const factsReviewed = provenanceStatus === 'verified' || editor.factChecked === true;
    checks.push(this.check('compliance_facts', factsReviewed,
      factsReviewed
        ? 'Informações principais conferidas'
        : 'Confira datas, nomes e dados principais: IA inventa fatos', strict));

    const variation = this.evaluateVariation(production.script, title, recent);
    checks.push(this.check('compliance_variation', variation.passed, variation.message));

    const voice = this.evaluateVoice(production.assets?.audio);
    checks.push(this.check('compliance_voice', voice.passed, voice.message));

    checks.push(this.check('compliance_audio_touch', editor.audioReviewed === true,
      editor.audioReviewed === true
        ? 'Áudio revisado (pausas e respirações ajustadas)'
        : 'Edite o áudio mesmo que minimamente: 5 minutos são a sua impressão digital'));

    const visual = this.evaluateVisualVariation(production.thumbnail, recent);
    checks.push(this.check('compliance_visual', visual.passed, visual.message));

    const volume = await this.evaluateVolume();
    checks.push(this.check('compliance_volume', volume.passed, volume.message));

    return checks;
  }

  // Structured view for the API/dashboard: the 3 interventions, the checks and the warning signals.
  async report(production = {}) {
    const checks = await this.review(production);
    const byId = new Map(checks.map(check => [check.id, check]));
    const editor = production.editorData || {};
    const interventions = HUMAN_INTERVENTIONS.map(item => {
      const check = byId.get(`compliance_${item.id}`);
      return { ...item, done: item.field ? editor[item.field] === true || Boolean(check?.passed) : Boolean(check?.passed), message: check?.message };
    });
    return {
      strict: await this.isStrict(),
      passed: checks.every(check => check.passed),
      mandatoryDone: interventions.every(item => item.done),
      interventions,
      checks,
      signals: SIGNALS
    };
  }

  /**
   * "Ajuste leva 30 segundos": when the opening is generic, ask the AI for a direct hook.
   * Returns a copy of the script; the original is only replaced if the new hook passes the check.
   */
  async fixOpening(script) {
    const before = this.evaluateHook(script);
    const original = hookText(script);
    if (before.passed || !original || !this.hasAI()) return { script, fixed: false, check: before };

    try {
      const prompt = `Reescreva a abertura abaixo de um vídeo do YouTube para começar DIRETO no tema, sem saudação, sem "olá", sem "bem-vindo", sem "hoje vamos falar". No máximo 25 palavras, mesmo idioma, preservando os fatos e sem inventar dados novos. Responda apenas com a nova abertura.\n\nAbertura: ${original}`;
      const rewritten = String(await this.aiTextService.generateText(prompt, { maxTokens: 200, temperature: 0.5 }))
        .trim().replace(/^["'“”]+|["'“”]+$/g, '');
      if (!rewritten) return { script, fixed: false, check: before };

      const next = {
        ...script,
        hook: typeof script.hook === 'object' && script.hook !== null ? { ...script.hook, text: rewritten } : rewritten,
        fullScript: script.fullScript ? script.fullScript.replace(original, rewritten) : script.fullScript
      };
      const after = this.evaluateHook(next);
      if (!after.passed) return { script, fixed: false, check: before };
      this.logger.info('Opening rewritten to a direct hook');
      return { script: next, fixed: true, before: original, after: rewritten, check: after };
    } catch (error) {
      this.logger.warn(`Could not rewrite the opening: ${error.message}`);
      return { script, fixed: false, check: before };
    }
  }
}

module.exports = {
  ComplianceService,
  GENERIC_OPENINGS,
  HUMAN_INTERVENTIONS,
  SIGNALS,
  THRESHOLDS,
  spokenText,
  hookText
};

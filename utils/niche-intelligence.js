// Niche intelligence for the dark channel mining agent:
//   1. Validação de nicho e micro-nichos (RPM por nicho)
//   2. Estratégia do outlier multilíngue
//   3. Posicionamento e diferenciação
// Everything here is pure (no network, no AI) so it can be unit-tested; the
// agent layers AI-written translations and positioning on top.

const OUTLIER_MULTIPLIER = 3;
const DEFAULT_VIDEOS_PER_MONTH = 8;
const BIG_PLAYER_SUBSCRIBERS = 500000;

// Long-form RPM bands in USD per 1,000 views (creator share). These are
// planning estimates, not measured data: calibrate with your own Studio numbers.
const NICHES = [
  {
    niche: 'Finanças', match: /financ|dinheiro|money|invest|crypto|cripto|econom|negóci|business/i, rpmMin: 10, rpmMax: 15, cpm: 'alto',
    micro: [
      { label: 'Psicologia do dinheiro', match: /psicolog|mente|mind|armadilha|mindset|mental/i },
      { label: 'Investimentos', match: /invest|ações|stock|dividend|etf|bolsa/i },
      { label: 'Cripto', match: /crypto|cripto|bitcoin|ethereum/i },
      { label: 'Renda extra', match: /renda extra|side hustle|passive|passiva|ganhar dinheiro/i }
    ]
  },
  {
    niche: 'Tecnologia', match: /tecnolog|tech|ia\b|\bai\b|software|program/i, rpmMin: 6, rpmMax: 10, cpm: 'alto',
    micro: [
      { label: 'Inteligência artificial', match: /\bia\b|\bai\b|inteligência artificial|artificial intelligence|chatgpt/i },
      { label: 'Programação', match: /program|código|code|developer|python|javascript/i },
      { label: 'Gadgets', match: /gadget|celular|phone|review/i }
    ]
  },
  {
    niche: 'Saúde / Psicologia', match: /saúde|health|psicolog|psycholog|mente|mind/i, rpmMin: 5, rpmMax: 9, cpm: 'médio-alto',
    micro: [
      { label: 'Psicologia', match: /psicolog|psycholog|comportamento|behavior/i },
      { label: 'Bem-estar', match: /bem-estar|wellness|meditação|meditation|ansiedade|anxiety/i },
      { label: 'Nutrição', match: /nutri|dieta|diet|alimenta/i }
    ]
  },
  {
    niche: 'História / Mistérios', match: /hist|mist|myster|ancient|civiliza|guerra|war/i, rpmMin: 4, rpmMax: 7, cpm: 'médio',
    micro: [
      { label: 'Civilizações antigas', match: /ancient|antig|civiliza|egito|egypt|roma/i },
      { label: 'Guerras', match: /guerra|war|batalha|battle/i },
      { label: 'Mistérios', match: /mist|myster|unsolved|inexplic/i }
    ]
  },
  {
    niche: 'Curiosidades / Ciência', match: /ciênc|scienc|oceano|ocean|espaço|space|universo|fato|facts|curios/i, rpmMin: 4, rpmMax: 7, cpm: 'médio',
    micro: [
      { label: 'Oceano', match: /oceano|ocean|mar\b|marin/i },
      { label: 'Espaço', match: /espaço|space|universo|universe|planeta|planet/i },
      { label: 'Animais', match: /animal|bicho|wildlife|fauna/i }
    ]
  },
  {
    niche: 'Jardinagem / Natureza', match: /jardin|garden|plant|árvore|tree|natureza|nature/i, rpmMin: 3, rpmMax: 6, cpm: 'médio',
    micro: [
      { label: 'Plantio', match: /plant|árvore|tree|semente|seed/i },
      { label: 'Paisagens', match: /paisagem|landscape|floresta|forest/i }
    ]
  },
  {
    niche: 'Culinária / Receitas', match: /receit|recipe|cozinh|cook|culinár|food/i, rpmMin: 2, rpmMax: 4, cpm: 'baixo',
    micro: [
      { label: 'Receitas rápidas', match: /fácil|facil|easy|rápid|quick|ingredientes|ingredients/i }
    ]
  },
  {
    niche: 'Relaxamento / Ambiente', match: /relax|sleep|dormir|music|música|ambient|asmr/i, rpmMin: 1, rpmMax: 3, cpm: 'baixo',
    micro: [
      { label: 'Sono', match: /sleep|dormir|sono/i },
      { label: 'Música ambiente', match: /music|música|ambient|lofi|lo-fi/i }
    ]
  }
];

const GENERIC_NICHE = { niche: 'Geral', rpmMin: 2, rpmMax: 5, cpm: 'médio', micro: [] };

const STOPWORDS = new Set((
  'de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem seu sua ou ser quando muito ' +
  'nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles você essa num nem ' +
  'the of and to in is that it for on with as are this was be at by from or an your you how why what when ' +
  'el la los las y un una por con para es su al lo más'
).split(' '));

function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function rpmLabel(entry) {
  return `$${entry.rpmMin}-${entry.rpmMax}`;
}

function nicheInfo(text) {
  const entry = NICHES.find(candidate => candidate.match.test(text)) || GENERIC_NICHE;
  const micro = entry.micro.find(candidate => candidate.match.test(text));
  return {
    niche: entry.niche,
    microNiche: micro ? micro.label : null,
    rpm: rpmLabel(entry),
    rpmMin: entry.rpmMin,
    rpmMax: entry.rpmMax,
    cpm: entry.cpm
  };
}

// Reference table so the RPM per niche is visible in reports and the API.
function rpmTable() {
  return [...NICHES, GENERIC_NICHE].map(entry => ({
    niche: entry.niche,
    rpm: rpmLabel(entry),
    rpmMid: (entry.rpmMin + entry.rpmMax) / 2,
    cpm: entry.cpm,
    microNiches: entry.micro.map(micro => micro.label)
  }));
}

function groupByNiche(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.niche}|${row.microNiche || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        niche: row.niche,
        microNiche: row.microNiche || null,
        label: row.microNiche ? `${row.niche} / ${row.microNiche}` : row.niche,
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

/**
 * Score each niche / micro-niche from the mined channels (0-100).
 * Demand 30 + outlier rate 20 + RPM 25 + language gaps 15 + low incumbency 10.
 */
function validateNiches(rows, { videosPerMonth = DEFAULT_VIDEOS_PER_MONTH } = {}) {
  return groupByNiche(rows).map(group => {
    const channels = group.rows;
    const ref = NICHES.find(entry => entry.niche === group.niche) || GENERIC_NICHE;
    const rpmMid = (ref.rpmMin + ref.rpmMax) / 2;
    const medianAvgViews = median(channels.map(r => r.avgViews));
    const viewsPerSub = median(channels.filter(r => r.subscribers > 0).map(r => r.avgViews / r.subscribers));
    const outlierRate = channels.filter(r => r.outlierRatio >= OUTLIER_MULTIPLIER).length / channels.length;
    const gapRate = channels.filter(r => r.opportunityLevel === 'ALTA').length / channels.length;
    const bigPlayers = channels.filter(r => r.subscribers >= BIG_PLAYER_SUBSCRIBERS).length;

    const score = Math.round(
      Math.min(viewsPerSub / 1.5, 1) * 30 +
      outlierRate * 20 +
      Math.min(rpmMid / 12, 1) * 25 +
      gapRate * 15 +
      (1 - bigPlayers / channels.length) * 10
    );
    const verdict = score >= 65 ? 'VALIDADO' : score >= 45 ? 'PROMISSOR' : 'EVITAR';

    return {
      key: group.key,
      niche: group.niche,
      microNiche: group.microNiche,
      label: group.label,
      channels: channels.length,
      rpm: rpmLabel(ref),
      rpmMid,
      cpm: ref.cpm,
      medianAvgViews: Math.round(medianAvgViews),
      medianSubscribers: Math.round(median(channels.map(r => r.subscribers))),
      viewsPerSub: Number(viewsPerSub.toFixed(2)),
      outlierRate: Number(outlierRate.toFixed(2)),
      gapRate: Number(gapRate.toFixed(2)),
      bigPlayers,
      estimatedMonthlyRevenue: Math.round(medianAvgViews * videosPerMonth * rpmMid / 1000),
      score,
      verdict,
      confidence: channels.length >= 5 ? 'alta' : channels.length >= 3 ? 'média' : 'baixa (amostra pequena)'
    };
  }).sort((a, b) => b.score - a.score);
}

const PLAYBOOK_STEPS = [
  'Decupar o outlier: gancho dos 30 primeiros segundos, estrutura de capítulos e duração.',
  'Escrever o roteiro nativo no idioma-alvo (adaptar exemplos e referências, não traduzir literalmente).',
  'Gerar narração com voz nativa e thumbnail com texto no idioma-alvo.',
  'Publicar 3 vídeos em 14 dias no canal do idioma e comparar com a média do canal de origem.',
  'Se atingir a meta em 28 dias, transformar em série; senão, descartar o idioma.'
];

/**
 * Multilingual play for one outlier: languages with no strong competitor first,
 * then weakly served ones. `translations` maps language → translated title.
 */
function buildLanguagePlan(row, translations = {}) {
  if (!row.outlierTitle || !Array.isArray(row.languageChecks)) return null;
  const targets = row.languageChecks
    .filter(check => check.strongChannels <= 1)
    .map(check => ({
      language: check.language,
      searchTerm: check.term,
      title: translations[check.language] || row.outlierTitle,
      needsTranslation: !translations[check.language],
      competition: check.strongChannels === 0 ? 'nenhuma' : 'baixa',
      priority: Number(((row.outlierRatio || 1) * (check.strongChannels === 0 ? 2 : 1)).toFixed(2))
    }))
    .sort((a, b) => b.priority - a.priority);
  if (!targets.length) return null;

  return {
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    outlierTitle: row.outlierTitle,
    outlierUrl: row.outlierUrl,
    outlierViews: row.outlierViews,
    outlierRatio: row.outlierRatio,
    sourceLanguage: row.originalLanguage,
    targets,
    steps: PLAYBOOK_STEPS,
    // Assumption: a foreign-language replica reaching 30% of the source channel's average is worth scaling.
    viewsTarget28d: Math.round((row.avgViews || 0) * 0.3)
  };
}

const TITLE_FORMULAS = [
  { label: 'Lista numerada ("5 armadilhas...")', match: /\b\d+\b/ },
  { label: 'Pergunta', match: /\?|^(como|por que|porque|why|how|what|qué|cómo)\b/i },
  { label: 'Segredo / "ninguém conta"', match: /ninguém|nobody|no one|nadie|secret|segredo|hidden|oculto/i },
  { label: 'Tutorial "como fazer"', match: /\bcomo\b|how to|cómo/i },
  { label: 'Prazo / resultado ("em 30 dias")', match: /\b(em|in|en)\s+\d+\s+(dias|days|días|min|horas|hours)\b/i }
];

/**
 * Where the niche is crowded and where there is room to differentiate.
 * Works on the titles collected during mining (outlier + top videos).
 */
function analyzePositioning(rows) {
  const titles = rows.flatMap(r => [r.outlierTitle, ...(r.topTitles || [])]).filter(Boolean);
  const unigrams = new Map();
  const bigrams = new Map();
  for (const title of new Set(titles)) {
    const words = String(title).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const seen = new Set();
    words.forEach((word, i) => {
      if (word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word)) seen.add(word);
      const next = words[i + 1];
      if (next && word.length > 2 && next.length > 2 && !STOPWORDS.has(word) && !STOPWORDS.has(next)) seen.add(`${word} ${next}`);
    });
    for (const gram of seen) {
      const bucket = gram.includes(' ') ? bigrams : unigrams;
      bucket.set(gram, (bucket.get(gram) || 0) + 1);
    }
  }
  const top = (map, limit) => [...map.entries()].filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, count]) => ({ term, count }));
  const saturatedAngles = top(bigrams, 5).length ? top(bigrams, 5) : top(unigrams, 5);

  const formulas = TITLE_FORMULAS
    .map(formula => ({ label: formula.label, count: titles.filter(t => formula.match.test(t)).length }))
    .filter(formula => formula.count > 0)
    .sort((a, b) => b.count - a.count);
  const unusedFormulas = TITLE_FORMULAS.filter(f => !formulas.some(used => used.label === f.label)).map(f => f.label);

  const models = rows.reduce((acc, r) => ({ ...acc, [r.model]: (acc[r.model] || 0) + 1 }), {});
  const medianSubs = median(rows.map(r => r.subscribers));
  const gapLanguages = [...new Set(rows.flatMap(r => (r.languageChecks || []).filter(c => c.strongChannels === 0).map(c => c.language)))];

  const whitespace = [];
  if (gapLanguages.length) whitespace.push(`Idiomas sem concorrência forte: ${gapLanguages.map(l => l.toUpperCase()).join(', ')} — entrar com o mesmo tema.`);
  if (unusedFormulas.length) whitespace.push(`Fórmulas de título pouco usadas no nicho: ${unusedFormulas.join('; ')}.`);
  if (saturatedAngles.length) whitespace.push(`Fugir do ângulo saturado "${saturatedAngles[0].term}" ou abordá-lo com um recorte contraintuitivo.`);
  whitespace.push('Formato em série numerada (episódios) em vez de vídeos avulsos, para aumentar retorno de audiência.');

  return {
    sampleTitles: titles.length,
    saturatedAngles,
    titleFormulas: formulas,
    modelMix: models,
    medianSubscribers: Math.round(medianSubs),
    entryBarrier: medianSubs >= 200000 ? 'alta (canais grandes dominam)' : medianSubs >= 50000 ? 'média' : 'baixa (canais pequenos já performam)',
    gapLanguages,
    whitespace
  };
}

function renderStrategyMarkdown(strategy) {
  const lines = [`# Mineração de canais dark — estratégia (${strategy.generatedAt.slice(0, 10)})`, ''];

  lines.push('## 1. Validação de nicho e micro-nichos (RPM por nicho)', '');
  lines.push('| Nicho / micro-nicho | Canais | RPM | Média de views (mediana) | Taxa de outliers | Lacuna de idioma | Receita/mês* | Score | Veredito |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const n of strategy.niches) {
    lines.push(`| ${n.label} | ${n.channels} | ${n.rpm} | ${n.medianAvgViews.toLocaleString('pt-BR')} | ${Math.round(n.outlierRate * 100)}% | ${Math.round(n.gapRate * 100)}% | $${n.estimatedMonthlyRevenue.toLocaleString('en-US')} | ${n.score} | ${n.verdict} (${n.confidence}) |`);
  }
  lines.push('', '*Estimativa por canal: mediana de views × 8 vídeos/mês × RPM médio da faixa. RPM por nicho é referência de planejamento, não dado medido.', '');

  lines.push('## 2. Estratégia do outlier multilíngue', '');
  if (!strategy.multilingualPlans.length) lines.push('Nenhum outlier com lacuna de idioma encontrado nesta rodada.', '');
  for (const plan of strategy.multilingualPlans) {
    lines.push(`### ${plan.outlierTitle}`, `Canal: ${plan.channelTitle} · ${plan.outlierViews.toLocaleString('pt-BR')} views (${plan.outlierRatio}x a média) · idioma de origem: ${plan.sourceLanguage}`, '');
    for (const target of plan.targets) {
      lines.push(`- **${target.language.toUpperCase()}** (concorrência ${target.competition}): busca "${target.searchTerm}" → título ${target.needsTranslation ? '(traduzir)' : ''}: ${target.title}`);
    }
    lines.push(`- Meta em 28 dias: ${plan.viewsTarget28d.toLocaleString('pt-BR')} views por vídeo`, '');
  }

  lines.push('## 3. Posicionamento e diferenciação', '');
  for (const item of strategy.positioning) {
    lines.push(`### ${item.niche}`, `Barreira de entrada: ${item.entryBarrier}`, '');
    if (item.saturatedAngles.length) lines.push(`Ângulos saturados: ${item.saturatedAngles.map(a => `${a.term} (${a.count})`).join(', ')}`, '');
    for (const space of item.whitespace) lines.push(`- ${space}`);
    if (item.ai) {
      lines.push('', `**Posicionamento sugerido:** ${item.ai.positioning || ''}`);
      for (const key of ['differentiators', 'pillars', 'titleFormulas', 'channelNames', 'avoid']) {
        if (Array.isArray(item.ai[key]) && item.ai[key].length) lines.push(`- ${key}: ${item.ai[key].join(' | ')}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  OUTLIER_MULTIPLIER,
  NICHES,
  nicheInfo,
  rpmTable,
  groupByNiche,
  validateNiches,
  buildLanguagePlan,
  analyzePositioning,
  renderStrategyMarkdown,
  median
};

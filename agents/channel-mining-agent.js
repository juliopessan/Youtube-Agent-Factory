const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const {
  OUTLIER_MULTIPLIER, nicheInfo, groupByNiche, validateNiches, buildLanguagePlan,
  analyzePositioning, renderStrategyMarkdown
} = require('../utils/niche-intelligence');

// Mineração de canais dark: reproduces the manual YouTube research routine
// (Tipo: Vídeo | Duração: Mais de 20 min | Upload: Esta semana) through the
// YouTube Data API and fills the same spreadsheet the team uses by hand.

const SEARCH_FILTERS = {
  type: 'video',
  videoDuration: 'long', // YouTube API "long" = more than 20 minutes
  uploadWindowDays: 7
};

const LANGUAGES = {
  pt: 'Português',
  en: 'Inglês',
  es: 'Espanhol',
  de: 'Alemão',
  fr: 'Francês',
  it: 'Italiano'
};

// Title/description hints that a channel is personality-led rather than dark.
const FACE_HINTS = /\b(vlog|eu fui|i tried|my life|minha vida|reagindo|reacting|reaction|podcast ep|entrevista|interview|ft\.|feat\.)\b/i;
const DARK_HINTS = /\b(documentár|documentary|explained|explicado|fatos|facts|história|history|mistér|myster|compilation|curiosidades|top \d+|\d+ (coisas|things|fatos))\b/i;

function parseIsoDuration(iso) {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!match) return 0;
  const [, d = 0, h = 0, m = 0, s = 0] = match.map(value => Number(value) || 0);
  return d * 86400 + h * 3600 + m * 60 + s;
}

function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString('pt-BR');
}

function average(values) {
  const list = values.filter(v => Number.isFinite(v));
  return list.length ? list.reduce((sum, v) => sum + v, 0) / list.length : 0;
}

function findOutlier(videos, avgViews) {
  const sorted = [...videos].sort((a, b) => b.views - a.views);
  const top = sorted[0];
  if (!top) return null;
  return { ...top, ratio: avgViews > 0 ? top.views / avgViews : 0, isOutlier: avgViews > 0 && top.views >= avgViews * OUTLIER_MULTIPLIER };
}

function uploadsPerWeek(videos) {
  const dates = videos.map(v => new Date(v.publishedAt).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  if (dates.length < 2) return dates.length;
  const weeks = Math.max((dates[dates.length - 1] - dates[0]) / (7 * 86400000), 1);
  return (dates.length - 1) / weeks;
}

// M1 = Canal de Marca (long, evergreen, low cadence); M2 = Canal Rápido (high cadence).
function classifyModel({ videos }) {
  const cadence = uploadsPerWeek(videos);
  const avgMinutes = average(videos.map(v => v.durationSeconds / 60));
  if (cadence >= 4 || avgMinutes < 25 && cadence >= 2.5) return 'M2';
  return 'M1';
}

function detectDarkSignals({ channel, videos }) {
  const text = [channel.title, channel.description, ...videos.map(v => v.title)].join(' ');
  const faceHits = (text.match(new RegExp(FACE_HINTS, 'gi')) || []).length;
  const darkHits = (text.match(new RegExp(DARK_HINTS, 'gi')) || []).length;
  const young = channel.publishedAt && (Date.now() - new Date(channel.publishedAt).getTime()) < 2 * 365 * 86400000;
  const viewsPerSub = channel.subscribers > 0 ? average(videos.map(v => v.views)) / channel.subscribers : 0;
  let score = 0;
  score += Math.min(darkHits, 4);
  score -= faceHits * 2;
  if (young) score += 1;
  if (viewsPerSub > 1) score += 1;
  return { score, isLikelyDark: score >= 1, young: Boolean(young), viewsPerSub };
}

// Competition of the same theme in another language → multilingual opportunity.
function rateMultilingual(languageChecks) {
  const gaps = languageChecks.filter(check => check.strongChannels === 0);
  const saturated = languageChecks.filter(check => check.strongChannels >= 3);
  if (languageChecks.length && saturated.length === languageChecks.length) {
    return { level: 'BAIXA', stars: '★', label: 'BAIXA ★', gaps, saturated };
  }
  if (gaps.length >= 1) return { level: 'ALTA', stars: '★★★', label: 'ALTA ★★★', gaps, saturated };
  return { level: 'MÉDIA', stars: '★★', label: 'MÉDIA ★★', gaps, saturated };
}

function describeLanguageAvailability(languageChecks) {
  if (!languageChecks.length) return 'Não verificado';
  const gaps = languageChecks.filter(c => c.strongChannels === 0).map(c => LANGUAGES[c.language] || c.language);
  const present = languageChecks.filter(c => c.strongChannels > 0).map(c => c.language.toUpperCase());
  if (gaps.length === languageChecks.length) return `Não existe em ${gaps.join(', ')}`;
  if (languageChecks.every(c => c.strongChannels >= 3)) return 'Saturado em todos idiomas';
  return gaps.length ? `Sim (${present.join(', ')}); não existe em ${gaps.join(', ')}` : `Sim (${present.join(', ')})`;
}

const CSV_COLUMNS = [
  ['index', 'Nº'], ['term', 'TERMO PESQUISADO'], ['channelTitle', 'CANAL ENCONTRADO'],
  ['subscribersLabel', 'INSCRITOS'], ['nicheLabel', 'NICHO / SUB-NICHO'], ['avgViewsLabel', 'MÉDIA DE VIEWS'],
  ['outlierTitle', 'VÍDEO OUTLIER (TÍTULO)'], ['outlierViewsLabel', 'VIEWS DO OUTLIER'], ['model', 'MODELO'],
  ['originalLanguage', 'IDIOMA ORIGINAL'], ['otherLanguages', 'EXISTE EM OUTROS IDIOMAS?'],
  ['opportunity', 'OPORTUNIDADE MULTILÍNGUE'], ['notes', 'OBSERVAÇÕES']
];

function toCSV(rows) {
  const escape = value => {
    const text = String(value ?? '');
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = CSV_COLUMNS.map(([, label]) => label).join(';');
  const lines = rows.map((row, i) => CSV_COLUMNS.map(([key]) => escape(key === 'index' ? i + 1 : row[key])).join(';'));
  return `\uFEFF${[header, ...lines].join('\n')}\n`;
}

function extractJson(text) {
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

class ChannelMiningAgent {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ChannelMining');
    this.aiTextService = options.aiTextService || new AITextService(credentials?.credentials || credentials || {});
    this.youtubeClient = options.youtubeClient || null;
    this.now = options.now || (() => new Date());
    this.reportsDir = options.reportsDir || path.join(__dirname, '..', 'reports', 'channel-mining');
  }

  async initialize() {
    this.logger.info('Initializing Channel Mining Agent...');
    return true;
  }

  getYouTube() {
    if (this.youtubeClient) return this.youtubeClient;
    if (!this.credentials?.getYouTubeClient) throw new Error('YouTube client is not configured');
    this.youtubeClient = this.credentials.getYouTubeClient();
    return this.youtubeClient;
  }

  publishedAfter() {
    return new Date(this.now().getTime() - SEARCH_FILTERS.uploadWindowDays * 86400000).toISOString();
  }

  // Step 1-2: search a term with the "dark channel" filters.
  async searchLongVideos(term, { language, regionCode, maxResults = 25 } = {}) {
    const response = await this.getYouTube().search.list({
      part: 'snippet',
      q: term,
      type: SEARCH_FILTERS.type,
      videoDuration: SEARCH_FILTERS.videoDuration,
      publishedAfter: this.publishedAfter(),
      order: 'viewCount',
      maxResults,
      ...(language ? { relevanceLanguage: language } : {}),
      ...(regionCode ? { regionCode } : {})
    });
    return (response.data.items || []).map(item => ({
      videoId: item.id?.videoId,
      channelId: item.snippet?.channelId,
      channelTitle: item.snippet?.channelTitle,
      title: item.snippet?.title
    })).filter(item => item.videoId && item.channelId);
  }

  async getVideoDetails(videoIds) {
    if (!videoIds.length) return [];
    const response = await this.getYouTube().videos.list({ part: 'snippet,statistics,contentDetails', id: videoIds.slice(0, 50).join(',') });
    return (response.data.items || []).map(video => ({
      videoId: video.id,
      channelId: video.snippet?.channelId,
      title: video.snippet?.title,
      publishedAt: video.snippet?.publishedAt,
      language: video.snippet?.defaultAudioLanguage || video.snippet?.defaultLanguage || null,
      views: Number(video.statistics?.viewCount) || 0,
      durationSeconds: parseIsoDuration(video.contentDetails?.duration),
      url: `https://www.youtube.com/watch?v=${video.id}`
    }));
  }

  async getChannels(channelIds) {
    if (!channelIds.length) return [];
    const response = await this.getYouTube().channels.list({ part: 'snippet,statistics,contentDetails,topicDetails,brandingSettings', id: channelIds.slice(0, 50).join(',') });
    return (response.data.items || []).map(channel => ({
      channelId: channel.id,
      title: channel.snippet?.title,
      description: channel.snippet?.description || '',
      country: channel.snippet?.country || null,
      language: channel.snippet?.defaultLanguage || null,
      publishedAt: channel.snippet?.publishedAt,
      subscribers: Number(channel.statistics?.subscriberCount) || 0,
      videoCount: Number(channel.statistics?.videoCount) || 0,
      keywords: channel.brandingSettings?.channel?.keywords || '',
      topics: (channel.topicDetails?.topicCategories || []).map(url => decodeURIComponent(String(url).split('/').pop()).replace(/_/g, ' ')),
      uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
      url: `https://www.youtube.com/channel/${channel.id}`
    }));
  }

  // Step 4: last 10 uploads → média de views, outlier, cadence.
  async getRecentUploads(channel, limit = 10) {
    if (!channel.uploadsPlaylistId) return [];
    const response = await this.getYouTube().playlistItems.list({ part: 'contentDetails', playlistId: channel.uploadsPlaylistId, maxResults: limit });
    const ids = (response.data.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
    return this.getVideoDetails(ids);
  }

  async translateTerm(term, languages) {
    const fallback = Object.fromEntries(languages.map(lang => [lang, term]));
    if (!this.aiTextService?.client && !this.aiTextService?.gemini) return fallback;
    try {
      const prompt = `Traduza o termo de busca do YouTube "${term}" para os idiomas ${languages.join(', ')} como um nativo pesquisaria. Responda apenas JSON no formato {"en":"..."}.`;
      const text = await this.aiTextService.generateText(prompt, { maxTokens: 300, temperature: 0.2 });
      return { ...fallback, ...extractJson(text) };
    } catch (error) {
      this.logger.warn(`Term translation failed, reusing original term: ${error.message}`);
      return fallback;
    }
  }

  // Step 6: same theme in other languages; "strong" = long video this week with ≥ minViews.
  async checkOtherLanguages(term, originalLanguage, { languages = ['en', 'es', 'de', 'fr', 'pt'], minViews = 50000 } = {}) {
    const targets = languages.filter(lang => lang !== originalLanguage);
    const translations = await this.translateTerm(term, targets);
    const checks = [];
    for (const language of targets) {
      try {
        const results = await this.searchLongVideos(translations[language], { language, maxResults: 15 });
        const details = await this.getVideoDetails(results.map(r => r.videoId));
        const strong = new Set(details.filter(v => v.views >= minViews && (!v.language || v.language.startsWith(language))).map(v => v.channelId));
        checks.push({ language, term: translations[language], strongChannels: strong.size, results: details.length });
      } catch (error) {
        this.logger.warn(`Language check failed for ${language}: ${error.message}`);
      }
    }
    return checks;
  }

  buildNotes({ niche, dark, outlier, opportunity, model }) {
    const notes = [`CPM ${niche.cpm}, RPM ${niche.rpm}`];
    if (outlier?.isOutlier) notes.push(`outlier ${outlier.ratio.toFixed(1)}x a média`);
    if (dark.young) notes.push('canal recente');
    if (opportunity.saturated.length) notes.push(`concorrência alta em ${opportunity.saturated.map(c => c.language.toUpperCase()).join(', ')}`);
    notes.push(model === 'M1' ? 'evergreen, bom pra Modelo 1' : 'cadência alta, formato rápido');
    return notes.join('; ');
  }

  // Full analysis of a single channel discovered for a term.
  async analyzeChannel(term, channel, { searchLanguage, languages, minViews } = {}) {
    const videos = await this.getRecentUploads(channel);
    const avgViews = average(videos.map(v => v.views));
    const outlier = findOutlier(videos, avgViews);
    const dark = detectDarkSignals({ channel, videos });
    const model = classifyModel({ videos });
    const originalLanguage = (channel.language || videos.find(v => v.language)?.language || searchLanguage || 'pt').slice(0, 2);
    const languageChecks = await this.checkOtherLanguages(term, originalLanguage, { languages, minViews });
    const opportunity = rateMultilingual(languageChecks);
    const niche = nicheInfo([term, channel.title, channel.description, channel.keywords, ...channel.topics, ...videos.map(v => v.title)].join(' '));

    return {
      term,
      channelId: channel.channelId,
      channelTitle: channel.title,
      channelUrl: channel.url,
      subscribers: channel.subscribers,
      subscribersLabel: formatCount(channel.subscribers),
      niche: niche.niche,
      microNiche: niche.microNiche,
      nicheLabel: niche.microNiche ? `${niche.niche} / ${niche.microNiche}` : niche.niche,
      rpm: niche.rpm,
      topTitles: [...videos].sort((a, b) => b.views - a.views).slice(0, 5).map(v => v.title),
      avgViews: Math.round(avgViews),
      avgViewsLabel: formatNumber(avgViews),
      outlierTitle: outlier?.title || '',
      outlierUrl: outlier?.url || '',
      outlierViews: outlier?.views || 0,
      outlierViewsLabel: formatNumber(outlier?.views),
      outlierRatio: outlier ? Number(outlier.ratio.toFixed(2)) : 0,
      model,
      originalLanguage: LANGUAGES[originalLanguage] || originalLanguage,
      otherLanguages: describeLanguageAvailability(languageChecks),
      opportunity: opportunity.label,
      opportunityLevel: opportunity.level,
      darkScore: dark.score,
      languageChecks,
      notes: this.buildNotes({ niche, dark, outlier, opportunity, model })
    };
  }

  /**
   * Mine dark channels for a list of terms.
   * @param {string[]} terms search terms (ex: "plantando uma árvore")
   * @param {object} options { language, regionCode, maxChannelsPerTerm, minSubscribers, maxSubscribers, languages, minViews, includeNonDark }
   */
  async mine(terms, options = {}) {
    const {
      language = 'pt', regionCode, maxChannelsPerTerm = 5, minSubscribers = 1000,
      maxSubscribers = 2000000, languages, minViews, includeNonDark = false
    } = options;
    const rows = [];
    const seen = new Set();

    for (const term of terms.map(t => String(t || '').trim()).filter(Boolean)) {
      this.logger.info(`Mining "${term}" (vídeo | +20 min | esta semana)`);
      const results = await this.searchLongVideos(term, { language, regionCode });
      const channelIds = [...new Set(results.map(r => r.channelId))].filter(id => !seen.has(id));
      const channels = (await this.getChannels(channelIds))
        .filter(c => c.subscribers >= minSubscribers && c.subscribers <= maxSubscribers);

      let kept = 0;
      for (const channel of channels) {
        if (kept >= maxChannelsPerTerm) break;
        try {
          const row = await this.analyzeChannel(term, channel, { searchLanguage: language, languages, minViews });
          if (!includeNonDark && row.darkScore < 1) continue;
          seen.add(channel.channelId);
          rows.push(row);
          kept++;
        } catch (error) {
          this.logger.warn(`Failed to analyze ${channel.title}: ${error.message}`);
        }
      }
    }

    const rank = { 'ALTA': 3, 'MÉDIA': 2, 'BAIXA': 1 };
    rows.sort((a, b) => rank[b.opportunityLevel] - rank[a.opportunityLevel] || b.outlierRatio - a.outlierRatio);
    await this.saveResults(rows);
    return rows;
  }

  async saveResults(rows) {
    if (!this.db?.saveChannelMiningResult) return;
    for (const row of rows) await this.db.saveChannelMiningResult(row);
  }

  async exportCSV(rows, filename) {
    await fs.mkdir(this.reportsDir, { recursive: true });
    const file = path.join(this.reportsDir, filename || `mineracao-${this.now().toISOString().slice(0, 10)}.csv`);
    await fs.writeFile(file, toCSV(rows), 'utf8');
    return file;
  }

  async translateTitles(title, languages) {
    if (!languages.length || (!this.aiTextService?.client && !this.aiTextService?.gemini)) return {};
    try {
      const prompt = `Adapte o título de YouTube "${title}" para os idiomas ${languages.join(', ')}, como um criador nativo escreveria (mesmo gancho, sem tradução literal, até 90 caracteres). Responda apenas JSON no formato {"en":"..."}.`;
      return extractJson(await this.aiTextService.generateText(prompt, { maxTokens: 500, temperature: 0.5 }));
    } catch (error) {
      this.logger.warn(`Title adaptation failed: ${error.message}`);
      return {};
    }
  }

  async generatePositioning(niche, heuristic) {
    if (!this.aiTextService?.client && !this.aiTextService?.gemini) return null;
    try {
      const prompt = `Você é estrategista de canais dark do YouTube (sem rosto). Nicho: ${niche.label} (RPM ${niche.rpm}, veredito ${niche.verdict}).
Ângulos saturados: ${heuristic.saturatedAngles.map(a => a.term).join(', ') || 'nenhum identificado'}.
Fórmulas de título dominantes: ${heuristic.titleFormulas.map(f => f.label).join(', ') || 'nenhuma'}.
Barreira de entrada: ${heuristic.entryBarrier}. Idiomas sem concorrência: ${heuristic.gapLanguages.join(', ') || 'nenhum'}.
Responda apenas JSON: {"positioning":"1 frase","differentiators":["3 itens"],"pillars":["3 pilares de conteúdo"],"titleFormulas":["3 fórmulas novas"],"channelNames":["3 nomes"],"avoid":["2 armadilhas"]}`;
      return extractJson(await this.aiTextService.generateText(prompt, { maxTokens: 900, temperature: 0.7 }));
    } catch (error) {
      this.logger.warn(`Positioning generation failed for ${niche.label}: ${error.message}`);
      return null;
    }
  }

  /**
   * Turn mined rows into the three strategy modules: niche validation with RPM,
   * the multilingual outlier plan, and positioning/differentiation.
   */
  async strategize(rows, { useAI = true } = {}) {
    const niches = validateNiches(rows);

    const multilingualPlans = [];
    const candidates = rows.filter(r => r.outlierRatio >= OUTLIER_MULTIPLIER && r.opportunityLevel !== 'BAIXA');
    for (const row of candidates) {
      const base = buildLanguagePlan(row);
      if (!base) continue;
      const translations = useAI ? await this.translateTitles(row.outlierTitle, base.targets.map(t => t.language)) : {};
      multilingualPlans.push(buildLanguagePlan(row, translations));
    }
    multilingualPlans.sort((a, b) => b.targets[0].priority - a.targets[0].priority);

    const groups = new Map(groupByNiche(rows).map(group => [group.key, group]));
    const positioning = [];
    for (const niche of niches.filter(n => n.verdict !== 'EVITAR')) {
      const heuristic = analyzePositioning(groups.get(niche.key).rows);
      positioning.push({ niche: niche.label, ...heuristic, ai: useAI ? await this.generatePositioning(niche, heuristic) : null });
    }

    return { generatedAt: this.now().toISOString(), niches, multilingualPlans, positioning };
  }

  async exportStrategy(strategy, basename) {
    await fs.mkdir(this.reportsDir, { recursive: true });
    const name = basename || `estrategia-${this.now().toISOString().slice(0, 10)}`;
    const markdown = path.join(this.reportsDir, `${name}.md`);
    await fs.writeFile(markdown, renderStrategyMarkdown(strategy), 'utf8');
    await fs.writeFile(path.join(this.reportsDir, `${name}.json`), JSON.stringify(strategy, null, 2), 'utf8');
    return markdown;
  }

  // Latest result per channel across previous mining runs.
  async loadStoredRows(limit = 500) {
    const stored = this.db?.listChannelMiningResults ? await this.db.listChannelMiningResults(limit) : [];
    const latest = new Map();
    for (const row of stored) if (!latest.has(row.channelId)) latest.set(row.channelId, row);
    return [...latest.values()];
  }

  // Hand-off to the factory: ALTA outliers become backlog ideas, one per gap
  // language when a plan exists (translated title), otherwise one in the source language.
  async promoteToIdeas(rows, { minLevel = 'ALTA', plans = [], maxLanguages = 2 } = {}) {
    if (!this.db?.createContentIdea) return [];
    const accept = minLevel === 'MÉDIA' ? ['ALTA', 'MÉDIA'] : ['ALTA'];
    const ideas = [];
    for (const row of rows.filter(r => accept.includes(r.opportunityLevel) && r.outlierTitle)) {
      const context = `Mineração: ${row.channelTitle} (${row.outlierViewsLabel} views, ${row.outlierRatio}x). ${row.notes}`;
      const plan = plans.find(p => p.channelId === row.channelId);
      if (plan) {
        for (const target of plan.targets.slice(0, maxLanguages)) {
          ideas.push(await this.db.createContentIdea({
            topic: target.title.slice(0, 200),
            angle: `Versão ${target.language.toUpperCase()}: ${target.searchTerm}`,
            style: row.model === 'M1' ? 'documentary' : 'listicle',
            rationale: `${context}${target.needsTranslation ? ' Título original: adaptar para o idioma-alvo.' : ''}`
          }));
        }
        continue;
      }
      const gap = row.languageChecks.find(c => c.strongChannels === 0);
      ideas.push(await this.db.createContentIdea({
        topic: row.outlierTitle.slice(0, 200),
        angle: gap ? `Versão ${gap.language.toUpperCase()}: ${gap.term}` : null,
        style: row.model === 'M1' ? 'documentary' : 'listicle',
        rationale: context
      }));
    }
    return ideas;
  }
}

module.exports = {
  ChannelMiningAgent,
  SEARCH_FILTERS,
  parseIsoDuration,
  formatCount,
  findOutlier,
  classifyModel,
  detectDarkSignals,
  rateMultilingual,
  describeLanguageAvailability,
  nicheInfo,
  toCSV
};

if (require.main === module) {
  (async () => {
    const { CredentialManager } = require('../utils/credential-manager');
    const { Database } = require('../database/db');
    const terms = process.argv.slice(2);
    if (!terms.length) {
      console.log('Uso: npm run agent:mining -- "plantando uma árvore" "psicologia do dinheiro"');
      process.exit(1);
    }
    const db = new Database();
    await db.initialize();
    const credentials = new CredentialManager();
    await credentials.initialize();
    const agent = new ChannelMiningAgent(db, credentials);
    const rows = await agent.mine(terms, { language: process.env.MINING_LANGUAGE || 'pt' });
    const file = await agent.exportCSV(rows);
    console.table(rows.map(r => ({ canal: r.channelTitle, inscritos: r.subscribersLabel, outlier: r.outlierViewsLabel, modelo: r.model, oportunidade: r.opportunity })));
    console.log(`Planilha salva em ${file}`);
    const strategy = await agent.strategize(rows, { useAI: process.env.MINING_AI !== 'false' });
    console.table(strategy.niches.map(n => ({ nicho: n.label, canais: n.channels, rpm: n.rpm, score: n.score, veredito: n.verdict })));
    console.log(`Estratégia salva em ${await agent.exportStrategy(strategy)}`);
    await db.close();
  })().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

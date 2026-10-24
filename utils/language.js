// Tiny stopword-based language detector: enough to pick a narration voice and caption language
// without another dependency or a network call.

const STOPWORDS = {
  'pt-BR': 'de que não uma para com os do da em um mais como mas você é está isso foi ao são também então porque muito já nos pelo pela seu sua ele ela eles quando só'.split(' '),
  'en-US': 'the of and to in is that it for on with as are this was be at by from or an your you how why what when not but have has they their will can'.split(' '),
  es: 'el la los las de que y en un una por con para es se su al lo más pero como está también porque muy cuando son fue sus esto esta ese'.split(' '),
  fr: 'le la les des et en un une pour que est dans qui pas sur ce il elle ils mais avec plus par au aux sont vous nous cette comme'.split(' '),
  it: 'il lo la gli le di che e in un una per con non è sono come ma più anche questo questa nel nella al dei delle suo sua quando'.split(' ')
};

// Languages Kokoro can narrate, mapped to its language code and default voice.
const KOKORO_LANGUAGES = {
  'pt-BR': { lang: 'pt-br', voice: 'pf_dora' },
  'en-US': { lang: 'en-us', voice: 'af_heart' },
  es: { lang: 'es', voice: 'ef_dora' },
  fr: { lang: 'fr-fr', voice: 'ff_siwis' },
  it: { lang: 'it', voice: 'if_sara' }
};

function detectLanguage(text, fallback = 'en-US') {
  const words = String(text || '').toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).slice(0, 600);
  if (words.length < 8) return fallback;
  let best = { code: fallback, score: 0 };
  for (const [code, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.filter(word => set.has(word)).length / words.length;
    if (score > best.score) best = { code, score };
  }
  return best.score >= 0.08 ? best.code : fallback;
}

// 'pt', 'pt_br' and 'PT-BR' all resolve to the canonical key.
function normalizeLanguage(value, fallback = null) {
  const key = String(value || '').toLowerCase().replace('_', '-');
  if (key.startsWith('pt')) return 'pt-BR';
  if (key.startsWith('en')) return 'en-US';
  if (key.startsWith('es')) return 'es';
  if (key.startsWith('fr')) return 'fr';
  if (key.startsWith('it')) return 'it';
  return fallback;
}

module.exports = { detectLanguage, normalizeLanguage, KOKORO_LANGUAGES };

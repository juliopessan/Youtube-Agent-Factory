const crypto = require('crypto');

// The wellness-music channel as a niche pack: who it is for, an idea bank that fills the backlog on
// its own, the plan of one track (movements, soft captions, mood, nature layer) and the SEO text.
// It needs no AI. With an AI provider the same stages can be written by the model instead.

const CHANNEL = {
  id: 'wellness-music',
  name: 'Quiet Hours',
  goal: 'Grow a calm wellness music channel with long instrumental tracks for sleep, focus and meditation',
  targetAudience: 'People who want to sleep, relax, study or meditate with calm instrumental music',
  brandVoice: 'Warm, quiet and unhurried. No hype, no clickbait, no health promises.',
  callToAction: 'Subscribe for a new calm track every week.',
  defaultStyle: 'ambient',
  visualStyle: 'soft gradients in pastel light, slow motion',
  // Wellness channels get demonetized and removed for medical claims, so the planner never makes them.
  bannedTopics: ['cure insomnia', 'cure anxiety', 'treat insomnia', 'treat anxiety', 'heal your', 'medical treatment'],
  timezone: 'America/Sao_Paulo',
  language: 'en'
};

const MOODS = {
  sleep: {
    label: 'Deep Sleep', nature: 'rain', palette: 'twilight',
    titles: ['Deep Sleep Music • Soft Rain & Slow Pads', 'Fall Asleep to Gentle Ambient Music • Rain Sounds'],
    sections: ['Arrival', 'Settling', 'Drifting', 'Deep calm', 'Floating', 'Fading'],
    captions: ['Let your shoulders drop.', 'Breathe in slowly… and out.', 'Nothing to do now.', 'Let the day go.', 'Heavy, warm, quiet.', 'Rest.'],
    tags: ['sleep music', 'deep sleep', 'rain sounds', 'relaxing music', 'ambient music', 'calm music', 'sleep ambient']
  },
  calm: {
    label: 'Calm Down', nature: 'ocean', palette: 'ocean',
    titles: ['Calm Down Music • Ocean Waves & Soft Piano Tones', 'Relaxing Ambient Music for Stress Relief • Ocean Sounds'],
    sections: ['Arrival', 'First wave', 'Slow tide', 'Open water', 'Shoreline', 'Stillness'],
    captions: ['Take one slow breath.', 'Let the waves set the pace.', 'Unclench your jaw.', 'Soft shoulders.', 'Nowhere to be.', 'Stillness.'],
    tags: ['calm music', 'relaxing music', 'ocean sounds', 'stress relief music', 'ambient music', 'meditation music', 'peaceful music']
  },
  focus: {
    label: 'Deep Focus', nature: 'none', palette: 'forest',
    titles: ['Deep Focus Music for Studying & Work • Calm Ambient Pads', 'Study Music • Gentle Ambient for Concentration'],
    sections: ['Settle in', 'Find the pace', 'Steady', 'Deep work', 'Still steady', 'Wind down'],
    captions: ['One task. One breath.', 'Find a steady pace.', 'Stay with it.', 'Quiet mind, clear page.', 'Keep going gently.', 'Well done.'],
    tags: ['focus music', 'study music', 'concentration music', 'ambient music', 'work music', 'calm focus', 'deep work']
  },
  meditation: {
    label: 'Meditation', nature: 'none', palette: 'lavender',
    titles: ['Meditation Music • Slow Ambient Pads for Mindfulness', 'Mindfulness Meditation Music • Peaceful Ambient'],
    sections: ['Begin', 'Breath', 'Awareness', 'Stillness', 'Spaciousness', 'Return'],
    captions: ['Sit comfortably.', 'Follow your breath.', 'Notice, and let go.', 'Rest in the quiet.', 'Wide and open.', 'Come back slowly.'],
    tags: ['meditation music', 'mindfulness', 'ambient music', 'relaxing music', 'breathing meditation', 'calm music', 'zen music']
  },
  morning: {
    label: 'Gentle Morning', nature: 'none', palette: 'sunrise',
    titles: ['Gentle Morning Music • Soft Ambient to Start Your Day', 'Peaceful Morning Music • Calm Start'],
    sections: ['First light', 'Waking', 'Warmth', 'Open window', 'Fresh start', 'Ready'],
    captions: ['A new day, softly.', 'Stretch if you like.', 'Warm light.', 'Take a deep breath.', 'Begin gently.', 'You are ready.'],
    tags: ['morning music', 'gentle morning', 'ambient music', 'relaxing music', 'calm morning', 'peaceful music', 'wake up music']
  }
};
// Search demand for sleep and relaxation is the largest, so the bank starts there.
const IDEA_ORDER = ['sleep', 'calm', 'focus', 'meditation', 'morning'];
const LENGTH_MINUTES = { short: 4, medium: 30, long: 60 };
const MIN_SECTION_SECONDS = 36;
const MAX_SCENES = 40;
const END_SCREEN_SECONDS = 20;

function seedFor(text) {
  return crypto.createHash('sha1').update(String(text)).digest().readUInt16BE(0);
}

function clock(totalSeconds) {
  const value = Math.round(totalSeconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  const pad = number => String(number).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// "mood=sleep;nature=rain;minutes=60" lives in the idea's angle, so an idea carries its own recipe.
function encodeRecipe({ mood, nature, minutes }) {
  return `mood=${mood};nature=${nature};minutes=${minutes}`;
}

function parseRecipe(angle) {
  const found = {};
  for (const part of String(angle || '').split(';')) {
    const [key, value] = part.split('=');
    if (key && value) found[key.trim()] = value.trim();
  }
  return found;
}

function moodOf(text) {
  const lower = String(text || '').toLowerCase();
  return IDEA_ORDER.find(mood => lower.includes(MOODS[mood].label.toLowerCase()) || lower.includes(mood)) || null;
}

class WellnessChannelService {
  constructor(db) {
    this.db = db;
  }

  ideas({ minutes = 60 } = {}) {
    return IDEA_ORDER.flatMap(mood => MOODS[mood].titles.map((title, variant) => ({
      topic: title,
      angle: encodeRecipe({ mood, nature: MOODS[mood].nature, minutes }),
      style: 'ambient',
      rationale: `${MOODS[mood].label} is a high-demand wellness search${variant ? '; second angle on the same mood' : ''}`,
      status: 'backlog'
    })));
  }

  /** Saves the channel profile and fills the backlog. Safe to run twice: existing ideas are kept. */
  async bootstrap(options = {}) {
    const profile = await this.db.saveChannelProfile({
      channelName: options.name || CHANNEL.name, goal: CHANNEL.goal, targetAudience: CHANNEL.targetAudience,
      brandVoice: CHANNEL.brandVoice, defaultStyle: CHANNEL.defaultStyle, callToAction: CHANNEL.callToAction,
      bannedTopics: CHANNEL.bannedTopics, visualStyle: CHANNEL.visualStyle, timezone: options.timezone || CHANNEL.timezone
    });
    const existing = new Set((await this.db.listContentIdeas()).map(idea => idea.topic));
    let added = 0;
    for (const idea of this.ideas({ minutes: options.minutes || 60 })) {
      if (existing.has(idea.topic)) continue;
      await this.db.createContentIdea(idea);
      added++;
    }
    return { channelName: profile.channel_name, defaultStyle: profile.default_style, ideasAdded: added, ideasTotal: existing.size + added };
  }

  /** The strategy for one track. With no topic, the next idea in the bank is used. */
  async strategyFor(topic, context = {}, lengthKey = 'medium') {
    let chosenTopic = topic;
    let recipe = parseRecipe(context.angle);
    if (!chosenTopic) {
      const done = Number((await this.db.getRow?.('SELECT COUNT(*) AS count FROM productions'))?.count || 0);
      const next = this.ideas()[done % this.ideas().length];
      chosenTopic = next.topic;
      recipe = parseRecipe(next.angle);
    }
    const mood = MOODS[recipe.mood] ? recipe.mood : (moodOf(chosenTopic) || 'calm');
    const preset = MOODS[mood];
    // A preview of the video length from the job ("short" = 4 minutes) beats the idea's full length.
    const minutes = Number(LENGTH_MINUTES[lengthKey]) || Number(recipe.minutes) || 30;
    return {
      topic: chosenTopic,
      angle: encodeRecipe({ mood, nature: recipe.nature || preset.nature, minutes }),
      contentType: 'Music',
      format: 'music',
      mood,
      nature: ['rain', 'ocean', 'none'].includes(recipe.nature) ? recipe.nature : preset.nature,
      minutes,
      palette: preset.palette,
      keywords: preset.tags,
      targetAudience: CHANNEL.targetAudience,
      researchSources: [],
      seed: seedFor(chosenTopic)
    };
  }

  /** Splits the track into movements of at least ~36 s; the last 20 s belong to the end screen. */
  planSections(totalSeconds, mood) {
    const preset = MOODS[mood];
    const body = Math.max(MIN_SECTION_SECONDS, totalSeconds - END_SCREEN_SECONDS);
    const count = Math.max(2, Math.min(MAX_SCENES, Math.floor(body / MIN_SECTION_SECONDS)));
    const length = body / count;
    return Array.from({ length: count }, (_, index) => ({
      index,
      title: preset.sections[index % preset.sections.length],
      caption: preset.captions[index % preset.captions.length],
      start: Number((index * length).toFixed(2)),
      seconds: Number(length.toFixed(2))
    }));
  }

  /** A "script" for a music video: a plan, not words to speak. */
  planTrack(strategy) {
    const preset = MOODS[strategy.mood];
    const totalSeconds = Math.round(strategy.minutes * 60);
    const sections = this.planSections(totalSeconds, strategy.mood);
    const title = strategy.topic;
    const plan = [
      `TRACK PLAN: ${title}`,
      `Mood: ${preset.label} · Nature layer: ${strategy.nature} · Length: ${clock(totalSeconds)} · Instrumental, original ambient music`,
      '',
      ...sections.map(section => `${clock(section.start)} ${section.title}: ${section.caption}`),
      `${clock(totalSeconds - END_SCREEN_SECONDS)} End screen`
    ].join('\n');

    const shots = sections.map(section => ({
      id: `shot_${String(section.index + 1).padStart(3, '0')}`,
      sceneNumber: section.index + 1,
      label: `Movement ${section.index + 1} · ${section.title}`,
      title: section.title,
      narrativeRole: 'meat',
      durationSec: section.seconds,
      // Not spoken: a soft on-screen line, and the caption of a Short cut from this movement.
      narrationScript: section.caption,
      caption: section.caption,
      narrationPacing: 'moderado',
      visualDescription: `${preset.label} backdrop, ${section.title.toLowerCase()}`,
      charactersPresent: [], showTextOverlay: false, headline: '', subheadline: '', generate: false,
      priority: 50
    }));

    return {
      kind: 'music',
      title,
      description: plan,
      fullScript: plan,
      duration: clock(totalSeconds),
      tone: 'calm',
      pacing: 'slow',
      keywords: strategy.keywords,
      claims: [],
      mainContent: { sections: sections.map(section => ({ title: section.title, duration: section.seconds, content: section.caption })), totalDuration: totalSeconds },
      music: { mood: strategy.mood, nature: strategy.nature, minutes: strategy.minutes, seed: strategy.seed, sections },
      storyboard: {
        version: 1, kind: 'ambient', profile: 'ambient', format: 'long', style: 'wellness', styleLabel: `${preset.label} (soft gradients)`,
        palette: strategy.palette, aspectRatio: '16:9', language: 'en-US', title,
        narration: { voiceTone: 'none', label: 'Instrumental' },
        shots,
        summary: { shots: shots.length, totalSeconds: totalSeconds - END_SCREEN_SECONDS, roleCounts: { meat: shots.length }, generatedClips: 0, generatedSeconds: 0, overlays: 0, exceedsFormatLimit: false }
      },
      metadata: { strategy, generatedAt: new Date().toISOString(), version: '1.0', generationSource: 'wellness-template' }
    };
  }

  /** Title, description with chapters, tags and the disclosure; no health claims. */
  seo(script, strategy) {
    const preset = MOODS[strategy.mood];
    const total = Math.round(strategy.minutes * 60);
    const chapters = script.music.sections.map(section => `${clock(section.start)} ${section.title}`);
    const description = [
      `${script.title}`,
      '',
      `${preset.label}: calm instrumental ambient music with ${strategy.nature === 'none' ? 'soft pads and gentle notes' : `${strategy.nature} sounds, soft pads and gentle notes`}. Put it on, breathe, and let it play.`,
      '',
      'Chapters',
      ...chapters,
      `${clock(total - END_SCREEN_SECONDS)} End screen`,
      '',
      'About this music: it is original and generated with software (algorithmic synthesis, no samples, no copyrighted material). It is made for relaxation and is not medical advice.',
      '',
      CHANNEL.callToAction,
      '',
      '#ambientmusic #relaxingmusic #calmmusic'
    ].join('\n');
    return {
      title: script.title.slice(0, 100),
      description,
      tags: [...new Set([...preset.tags, 'instrumental', 'no ads music', 'relax'])].slice(0, 15),
      hashtags: ['#ambientmusic', '#relaxingmusic', '#calmmusic'],
      chapters,
      categoryId: '10',
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
      score: 85
    };
  }
}

module.exports = { WellnessChannelService, CHANNEL, MOODS, IDEA_ORDER, LENGTH_MINUTES, END_SCREEN_SECONDS, clock, parseRecipe, encodeRecipe };

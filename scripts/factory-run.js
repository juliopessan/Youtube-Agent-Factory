#!/usr/bin/env node
// Runs the whole factory once, end to end, and writes a verified report to reports/factory/.
//
//   npm run factory -- --topic "5 armadilhas mentais que sabotam o seu dinheiro" --length short
//   npm run factory -- --offline --isolated --script-file examples/scripts/armadilhas-mentais.json
//
// Flags
//   --topic <text>         video topic (otherwise the oldest backlog idea is used)
//   --channel wellness-music   start a wellness music channel (profile + idea backlog) and make a track
//   --channel-name <text>  name for that channel (default Quiet Hours)
//   --mine "<a>,<b>"       search terms for dark-channel mining (needs YouTube Data API credentials)
//   --length short|medium|long      --style tutorial|explainer|list|story|review|music
//                          (a music track is 4, 30 or 60 minutes long for short, medium and long)
//   --script-file <json>   bring your own script instead of the AI/template writer
//   --offline              no YouTube credentials: produce locally, never upload
//   --isolated             use a throwaway database instead of data/youtube_automation.db
//   --no-approval          (isolated runs only) skip the human review step to exercise scheduling
//   --no-shorts            skip the automatic Shorts drafts
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; index++; }
  }
  return args;
}

// A script written elsewhere (by a person or another model) replaces the writer stage.
function useScriptFile(agent, file) {
  const writer = agent.agents.scriptWriter;
  const source = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  writer.generateScript = async strategy => {
    const script = JSON.parse(JSON.stringify(source));
    script.claims = script.claims || [];
    script.keywords = script.keywords || strategy.keywords || [];
    script.mainContent.totalDuration = script.mainContent.totalDuration || writer.calculateSectionsDuration(script.mainContent.sections);
    script.duration = script.duration || writer.estimateDuration(script.mainContent);
    script.metadata = { strategy, generatedAt: new Date().toISOString(), version: '1.0', generationSource: 'script-file' };
    script.fullScript = writer.formatFullScript(script);
    await writer.db.saveScript(script);
    return script;
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { YouTubeAutomationAgent } = require('../index');
  const { FactoryPipeline } = require('../utils/factory-pipeline');

  const dbPath = args.isolated ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-')), 'factory.db') : null;
  const agent = new YouTubeAutomationAgent();
  const ready = await agent.initialize({ offline: Boolean(args.offline), scheduler: false, dbPath });
  if (!ready || agent.setupRequired) {
    console.error('The factory is in setup mode. Configure credentials (npm run credentials:setup) or add --offline to produce locally.');
    process.exit(2);
  }
  if (args['script-file']) useScriptFile(agent, args['script-file']);
  if (args['no-approval']) {
    if (!args.isolated) {
      console.error('--no-approval only works with --isolated: it must never change the settings of your real channel.');
      process.exit(2);
    }
    await agent.db.setSetting('approval_required', 'false');
  }

  const run = await new FactoryPipeline(agent).run({
    topic: typeof args.topic === 'string' ? args.topic : null,
    style: typeof args.style === 'string' ? args.style : null,
    channel: typeof args.channel === 'string' ? args.channel : null,
    channelName: typeof args['channel-name'] === 'string' ? args['channel-name'] : undefined,
    length: typeof args.length === 'string' ? args.length : 'medium',
    mineTerms: typeof args.mine === 'string' ? args.mine.split(',').map(term => term.trim()).filter(Boolean) : [],
    shorts: !args['no-shorts']
  });

  const icon = { ok: '✅', warning: '⚠️ ', failed: '❌', skipped: '⏭️ ' };
  console.log('\n──────── Factory run ────────');
  for (const item of run.stages) console.log(`${icon[item.status]} ${item.name.padEnd(13)} ${(item.ms / 1000).toFixed(1)}s ${item.reason || item.error || ''}`);
  for (const item of run.checks) console.log(`${icon[item.status]} ${item.id.padEnd(22)} ${item.message}`);
  console.log(`\n${run.passed ? '✅ PASSED' : '❌ NOT PASSED'}${run.error ? ` — ${run.error}` : ''}\nReport: ${run.reportDir}`);
  await agent.db.close().catch(() => {});
  process.exit(run.passed ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});

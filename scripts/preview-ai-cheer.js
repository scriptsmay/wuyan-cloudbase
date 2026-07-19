'use strict';

/**
 * 测试示例：
 * 
  npm run preview:ai-cheer -- --mood daily --count 5
  npm run preview:ai-cheer -- --mood low --count 3 --text "最近有点低谷"
  npm run preview:ai-cheer -- --mood hope --count 3 --no-data
  npm run preview:ai-cheer -- --help
 */

const path = require('node:path');
const { createRequire } = require('node:module');

const projectRoot = path.resolve(__dirname, '..');
const aiCheerRoot = path.join(projectRoot, 'functions', 'ai-cheer');
const requireAiCheer = createRequire(path.join(aiCheerRoot, 'package.json'));
const cloudbase = requireAiCheer('@cloudbase/node-sdk');
const { __test: cheer } = require(path.join(aiCheerRoot, 'index.js'));

const ALLOWED_MOODS = new Set(['victory', 'low', 'daily', 'hope']);
const TRACKED_TERMS = ['同担', '守护', '冲冲冲', '杀回来'];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const envId = requireEnv('TCB_ENV');
  const modelId = requireEnv('AI_MODEL');
  const secretId = requireEnv('TENCENTCLOUD_SECRETID');
  const secretKey = requireEnv('TENCENTCLOUD_SECRETKEY');
  const sessionToken = process.env.TENCENTCLOUD_SESSIONTOKEN;
  const app = cloudbase.init({
    env: envId,
    secretId,
    secretKey,
    ...(sessionToken ? { sessionToken } : {}),
  });

  const source = options.useData ? await loadGroundedSource(app) : cheer.buildGroundedSource(null);
  const systemPrompt = cheer.buildSystemPrompt(options.mood, source);
  const userPrompt = cheer.buildUserPrompt(options.mood, options.text, source);

  console.log(`环境：${envId}`);
  console.log(`模型：${modelId}`);
  console.log(`心情：${options.mood}`);
  console.log(`生成次数：${options.count}`);
  console.log(`可引用数据：${source.promptLines.length ? source.promptLines.join('；') : '无'}`);

  if (options.showPrompt) {
    console.log('\n[system prompt]\n');
    console.log(systemPrompt);
    console.log('\n[user prompt]\n');
    console.log(userPrompt);
  }

  const model = app.ai().createModel('cloudbase');
  let invalidCount = 0;
  let totalTokens = 0;

  for (let index = 1; index <= options.count; index += 1) {
    const result = await model.generateText({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.85,
    });
    const rawText = result && result.text;
    const parsed = cheer.parseGeneratedText(rawText);
    const validated = cheer.validateGeneratedOutput(parsed, source);
    const usage = result && result.usage;
    const tokens = Number((usage && usage.total_tokens) || 0);
    totalTokens += tokens;

    console.log(`\n[${options.mood} ${index}]`);
    if (!validated) {
      invalidCount += 1;
      console.log('校验：未通过');
      console.log(`原始输出：${typeof rawText === 'string' ? rawText : JSON.stringify(rawText)}`);
      continue;
    }

    validated.lines.forEach((line, lineIndex) => {
      console.log(`${lineIndex + 1}. ${line}（${textLength(line)} 字）`);
    });
    console.log(`caption: ${validated.emoji_caption}`);
    console.log('校验：通过');
    console.log(`词频：${formatTermCounts([...validated.lines, validated.emoji_caption].join(''))}`);
    console.log(`Tokens：${tokens || '未返回'}`);
  }

  console.log(
    `\n完成：${options.count - invalidCount}/${options.count} 组通过校验，总 Tokens：${totalTokens || '未返回'}`
  );
  if (invalidCount > 0) process.exitCode = 1;
}

async function loadGroundedSource(app) {
  const result = await app.database().collection('season_summaries').orderBy('updated_at', 'desc').limit(1).get();
  const overview = result.data && result.data.length ? result.data[0] : null;
  return cheer.buildGroundedSource(overview);
}

function parseArgs(args) {
  const options = { mood: 'daily', count: 2, text: '', useData: true, showPrompt: true, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--no-data') {
      options.useData = false;
    } else if (argument === '--show-prompt') {
      options.showPrompt = true;
    } else if (argument === '--mood') {
      options.mood = readOptionValue(args, ++index, '--mood');
    } else if (argument === '--count') {
      options.count = Number(readOptionValue(args, ++index, '--count'));
    } else if (argument === '--text') {
      options.text = readOptionValue(args, ++index, '--text');
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  if (!ALLOWED_MOODS.has(options.mood)) {
    throw new Error(`--mood 必须是 ${[...ALLOWED_MOODS].join('、')} 之一`);
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 20) {
    throw new Error('--count 必须是 1 到 20 之间的整数');
  }
  if (textLength(options.text) > 120) throw new Error('--text 不能超过 120 个字符');
  return options;
}

function readOptionValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${optionName} 缺少参数值`);
  return value;
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`.env 缺少 ${name}`);
  return value;
}

function formatTermCounts(text) {
  return TRACKED_TERMS.map((term) => `${term} ${countOccurrences(text, term)} 次`).join('，');
}

function countOccurrences(text, term) {
  return text.split(term).length - 1;
}

function textLength(value) {
  return Array.from(String(value || '')).length;
}

function printHelp() {
  console.log(`用法：npm run preview:ai-cheer -- [选项]

选项：
  --mood <mood>   victory、low、daily、hope，默认 daily
  --count <n>      生成次数，1 到 20，默认 3
  --text <text>    用户补充内容，最多 120 个字符
  --no-data        不读取赛季数据，生成纯情绪文案
  --show-prompt    输出实际发送给模型的提示词
  --help, -h       显示帮助`);
}

main().catch((error) => {
  console.error(`预览失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

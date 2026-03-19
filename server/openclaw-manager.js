#!/usr/bin/env node
// ================================================================
// OpenClaw Manager v0.8.2
// 跨平台本地管理工具  (Windows / macOS / Linux)
//
// 用法:
//   node openclaw-manager.js                  # 使用默认 ~/.openclaw
//   node openclaw-manager.js --dir /path/to/.openclaw
//   node openclaw-manager.js --host 127.0.0.1 # 仅本机访问（默认 0.0.0.0）
//   OPENCLAW_DIR=/path/to/.openclaw node openclaw-manager.js
//
// ================================================================
'use strict';

const http    = require('http');
const fs      = require('fs');
const fsp     = fs.promises;
const path    = require('path');
const os      = require('os');
const { exec, execSync, spawn, spawnSync } = require('child_process');

// ── 目录解析（优先级：CLI参数 > 环境变量 > manager-config.json > 默认）
const SCRIPT_DIR = __dirname;
const MANAGER_CONFIG = path.join(SCRIPT_DIR, 'manager-config.json');
let PORT = 3333;
let HOST = '0.0.0.0';
const APP_VERSION = '0.9.6';
// --port 参数
const portIdx = process.argv.indexOf('--port');
if (portIdx !== -1 && process.argv[portIdx + 1]) PORT = parseInt(process.argv[portIdx + 1]) || 3333;
const portEq = process.argv.find(a => a.startsWith('--port='));
if (portEq) PORT = parseInt(portEq.split('=')[1]) || 3333;
// --host 参数（默认 0.0.0.0 允许远程访问）
const hostIdx = process.argv.indexOf('--host');
if (hostIdx !== -1 && process.argv[hostIdx + 1]) HOST = process.argv[hostIdx + 1];
const hostEq = process.argv.find(a => a.startsWith('--host='));
if (hostEq) HOST = hostEq.split('=').slice(1).join('=');
// Under Electron, force localhost for security
if (process.env.ELECTRON) HOST = '127.0.0.1';

function loadManagerConfig() {
  try { return JSON.parse(fs.readFileSync(MANAGER_CONFIG, 'utf8')); } catch { return {}; }
}
function saveManagerConfig(obj) {
  const cur = loadManagerConfig();
  fs.writeFileSync(MANAGER_CONFIG, JSON.stringify({ ...cur, ...obj }, null, 2), 'utf8');
}

function resolveOpenclawDir() {
  const idx = process.argv.indexOf('--dir');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  const dirEq = process.argv.find(a => a.startsWith('--dir='));
  if (dirEq) return path.resolve(dirEq.split('=').slice(1).join('='));
  if (process.env.OPENCLAW_DIR) return process.env.OPENCLAW_DIR;
  const mc = loadManagerConfig();
  if (mc.openclawDir) return mc.openclawDir;
  return path.join(os.homedir(), '.openclaw');
}

let OPENCLAW_DIR = resolveOpenclawDir();
let CONFIG_PATH  = path.join(OPENCLAW_DIR, 'openclaw.json');

function refreshPaths() {
  OPENCLAW_DIR = resolveOpenclawDir();
  CONFIG_PATH  = path.join(OPENCLAW_DIR, 'openclaw.json');
}

// ── 已知模型列表 ──────────────────────────────────────────────
const KNOWN_MODELS = [
  { id: '__default__',                              label: '使用全局默认模型' },
  { id: 'github-copilot/claude-opus-4.6',          label: 'Claude Opus 4.6 (GitHub Copilot)',    group: 'GitHub Copilot' },
  { id: 'github-copilot/gpt-4o',                   label: 'GPT-4o (GitHub Copilot)',             group: 'GitHub Copilot' },
  { id: 'anthropic/claude-opus-4-5',               label: 'Claude Opus 4.5 (Anthropic)',         group: 'Anthropic' },
  { id: 'anthropic/claude-sonnet-4-5',             label: 'Claude Sonnet 4.5 (Anthropic)',       group: 'Anthropic' },
  { id: 'openai/gpt-4o',                           label: 'GPT-4o (OpenAI)',                     group: 'OpenAI' },
  { id: 'openai/gpt-4o-mini',                      label: 'GPT-4o Mini (OpenAI)',                group: 'OpenAI' },
  { id: 'openai/gpt-4.1-mini',                     label: 'GPT-4.1 Mini (OpenAI)',               group: 'OpenAI' },
  { id: 'google-antigravity/gemini-3-pro',         label: 'Gemini 3 Pro (Google)',               group: 'Google' },
  { id: 'google-antigravity/gemini-3-flash',       label: 'Gemini 3 Flash (Google)',             group: 'Google' },
  { id: 'deepseek/deepseek-chat',                  label: 'DeepSeek Chat (DeepSeek)',            group: 'DeepSeek' },
  { id: 'deepseek/deepseek-reasoner',              label: 'DeepSeek Reasoner (DeepSeek)',        group: 'DeepSeek' },
  { id: 'moonshot/moonshot-v1-8k',                 label: 'Kimi Moonshot 8k (Moonshot)',         group: 'Kimi' },
  { id: 'moonshot/moonshot-v1-32k',                label: 'Kimi Moonshot 32k (Moonshot)',        group: 'Kimi' },
  { id: 'groq/llama-3.3-70b-versatile',            label: 'Llama 3.3 70B (Groq)',               group: 'Groq' },
  { id: 'mistral/mistral-large-latest',            label: 'Mistral Large (Mistral)',             group: 'Mistral' },
  { id: 'together/meta-llama/Llama-3-70b-chat-hf',label: 'Llama 3 70B (Together)',              group: 'Together' },
];

// ── 认证 Provider（已修正为官方正确命令）──────────────────────
const AUTH_PROVIDERS = [
  { id: 'anthropic',          label: 'Anthropic',       mode: 'token',  group: 'Anthropic',
    cliCmd: 'openclaw models auth paste-token --provider anthropic',       hint: 'Anthropic API Key (sk-ant-...)' },
  { id: 'openai',             label: 'OpenAI',          mode: 'token',  group: 'OpenAI',
    cliCmd: 'openclaw models auth paste-token --provider openai',          hint: 'OpenAI API Key (sk-...)' },
  { id: 'deepseek',           label: 'DeepSeek',        mode: 'token',  group: 'Other',
    cliCmd: 'openclaw models auth paste-token --provider deepseek',        hint: 'DeepSeek API Key' },
  { id: 'moonshot',           label: 'Kimi (Moonshot)', mode: 'token',  group: 'Other',
    cliCmd: 'openclaw models auth paste-token --provider moonshot',        hint: 'Moonshot API Key' },
  { id: 'groq',               label: 'Groq',            mode: 'token',  group: 'Other',
    cliCmd: 'openclaw models auth paste-token --provider groq',            hint: 'Groq API Key (gsk_...)' },
  { id: 'mistral',            label: 'Mistral',         mode: 'token',  group: 'Other',
    cliCmd: 'openclaw models auth paste-token --provider mistral',         hint: 'Mistral API Key' },
  { id: 'together',           label: 'Together AI',     mode: 'token',  group: 'Other',
    cliCmd: 'openclaw models auth paste-token --provider together',        hint: 'Together AI API Key' },
  { id: 'perplexity',         label: 'Perplexity',      mode: 'token',  group: 'Other',
    cliCmd: 'openclaw models auth paste-token --provider perplexity',      hint: 'Perplexity API Key (pplx-...)' },
  { id: 'google-antigravity', label: 'Google',          mode: 'oauth',  group: 'Google',
    cliCmd: 'openclaw models auth login google-antigravity',               hint: '' },
  { id: 'github-copilot',     label: 'GitHub Copilot',  mode: 'device', group: 'GitHub',
    cliCmd: 'openclaw models auth paste-token --provider github-copilot',  hint: '' },
];

// ── 工具函数 ──────────────────────────────────────────────────
async function readConfig() {
  const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function brisbaneTimestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Australia/Brisbane', hour12: false }).replace(/[: ]/g, '-').slice(0, 19);
}

async function backupConfig(label) {
  const ts = brisbaneTimestamp();
  const suffix = label ? `.${label}.${ts}` : `.bak.${ts}`;
  const bakPath = CONFIG_PATH + suffix;
  await fsp.copyFile(CONFIG_PATH, bakPath);
  return bakPath;
}

async function writeConfig(config, label) {
  const bak = await backupConfig(label);
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return bak;
}

function resolvePath(p) {
  if (!p) return '';
  return p.replace(/^~/, os.homedir());
}

function resolveAgentWorkspacePath(cfg, agentId, agent) {
  const defaultsWs = cfg?.agents?.defaults?.workspace || '';
  const raw = (agent && agent.workspace) || (agentId === 'main' ? defaultsWs : '');
  const expanded = resolvePath(raw || '');
  if (expanded) {
    return path.isAbsolute(expanded) ? expanded : path.resolve(OPENCLAW_DIR, expanded);
  }
  return path.join(OPENCLAW_DIR, 'workspace', agentId);
}

async function dirExists(p) {
  try { const s = await fsp.stat(p); return s.isDirectory(); } catch { return false; }
}

async function configExists() {
  try { await fsp.access(CONFIG_PATH); return true; } catch { return false; }
}

async function readLogTail(n = 200) {
  const logPath = path.join(OPENCLAW_DIR, 'logs', 'gateway.log');
  try {
    const content = await fsp.readFile(logPath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-n).join('\n');
  } catch { return '（日志文件不存在或无法读取）'; }
}

async function listBackups() {
  try {
    const files = await fsp.readdir(OPENCLAW_DIR);
    return files.filter(f => f.startsWith('openclaw.json.bak') || f.match(/openclaw\.json\.(create|edit|delete|models|auth|manual|before-restore)\./))
      .sort().reverse().slice(0, 20);
  } catch { return []; }
}

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function openBrowser(url) {
  if (process.platform === 'darwin') exec(`open "${url}"`);
  else if (process.platform === 'win32') exec(`start "" "${url}"`);
  else exec(`xdg-open "${url}"`);
}

function openFolder(dir) {
  if (process.platform === 'darwin') exec(`open "${dir}"`);
  else if (process.platform === 'win32') exec(`explorer "${dir}"`);
  else exec(`xdg-open "${dir}"`);
}

function runOpenclawCmd(args) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32'
      ? `openclaw.cmd ${args}`
      : `openclaw ${args}`;
    const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb', FORCE_COLOR: '0' };
    exec(cmd, { timeout: 30000, env }, (err, stdout, stderr) => {
      if (err) reject(new Error(stripAnsi(stderr || err.message)));
      else resolve(stripAnsi(stdout + stderr));
    });
  });
}

function parseModelIdsFromCliOutput(raw) {
  if (!raw) return [];
  const set = new Set();
  const isModelId = (s) => /^[a-z0-9][a-z0-9_-]*(?:\/[A-Za-z0-9._:-]+)+$/.test(s);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = trimmed.replace(/^[-*]\s+/, '');
    const first = normalized.split(/\s+/)[0].replace(/^`|`$/g, '');
    if (isModelId(first)) set.add(first);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

let MODEL_LIST_CACHE = { ts: 0, knownModels: [], error: '' };
async function getKnownModelsFromCli() {
  const now = Date.now();
  if (now - MODEL_LIST_CACHE.ts < 30000) return MODEL_LIST_CACHE;
  try {
    const out = await runOpenclawCmd('models list');
    const ids = parseModelIdsFromCliOutput(out);
    const knownModels = ids.map(id => ({ id, label: id, group: id.split('/')[0] || 'other' }));
    const error = knownModels.length ? '' : 'No model IDs found in `openclaw models list` output';
    MODEL_LIST_CACHE = { ts: now, knownModels, error };
    return MODEL_LIST_CACHE;
  } catch (e) {
    MODEL_LIST_CACHE = { ts: now, knownModels: [], error: e.message || 'openclaw models list failed' };
    return MODEL_LIST_CACHE;
  }
}

// 过滤 ANSI 终端控制码（光标移动、清行、颜色等）
function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')   // CSI 序列: ESC [ ... letter
    .replace(/\x1B\][^\x07]*\x07/g, '')         // OSC 序列: ESC ] ... BEL
    .replace(/\x1B[()][a-zA-Z]/g, '')           // 字符集切换
    .replace(/\x1B./g, '')                       // 其余两字节转义
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // 其他控制字符（保留 \n \r \t）
    .trim();
}


// ── 文件生成 ──────────────────────────────────────────────────
function generateSoulMd(displayName, purpose, personalityKeywords) {
  const hasPersonality = personalityKeywords && personalityKeywords.trim().length > 0;
  const hasPurpose = purpose && purpose.trim().length > 0;
  const keywords = hasPersonality
    ? personalityKeywords.split(/[,，]/).map(k => k.trim()).filter(Boolean)
    : [];

  const coreGuidelines = hasPersonality
    ? keywords.map(k => `- ${k}`).join('\n')
    : `你可以在和我沟通的过程中逐渐建立自己的个性，你正在成为某个人。

平时和我的沟通，别演，真帮忙。要有主见，你可以不同意。先自己想办法，别上来就问。

记住你是我生活中的客人，保护我的个人隐私，建立安全边界是第一要务，优先于所有其他任务。当有可能涉及安全的任务，先问。

这个文件是你的，由你自己来进化。`;

  return `# ${displayName}

## 身份定义

你是 ${displayName}，${hasPurpose ? purpose : '一个专注的 AI 助手'}。

${hasPurpose ? `## 核心职责\n\n${purpose}\n` : ''}
## 日常准则

${coreGuidelines}

## 基本原则

- 简洁直接，跳过废话，直接帮忙
- 遇到不确定的事情主动说明，不编造信息
- 默认用中文回复，除非用户使用其他语言
- 如果不确定，说不确定

---
*此文件是你的，你可以随时更新它。每次会话开始时自动加载。*
`;
}

function generateMemoryMd(displayName, initialMemory) {
  const hasMemory = initialMemory && initialMemory.trim().length > 0;
  return `# ${displayName} — 长期记忆

> 此文件仅在私聊 session 中加载，群组对话不加载。
> 保持精简，只记录稳定、重要的信息。

## 用户偏好

${hasMemory ? initialMemory : '> 暂无初始记录。记忆将通过日常对话自然积累。'}

## 重要决定

（待记录）

## 项目约定

（待记录）

---
*最后更新：${new Date().toLocaleDateString('zh-CN')}*
`;
}

function generateCurrentStateMd() {
  return `# CURRENT_STATE

_Last updated: TBD Australia/Brisbane_

## In Flight
- none

## Blocked / Waiting
- none

## Recently Finished
- none

## Next
- none

## Reset Summary
- No active summary yet.
`;
}

// ── 请求解析 ──────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── API 路由 ──────────────────────────────────────────────────
async function handleApi(req, res, urlObj, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const method   = req.method;
  const pathname = urlObj.pathname;

  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    try {
      const ok = await configExists();
      if (!ok) { res.writeHead(200); res.end(JSON.stringify({ ok: false, needsSetup: true, dir: OPENCLAW_DIR })); return; }
      const cfg = await readConfig();
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true, needsSetup: false,
        dir: OPENCLAW_DIR,
        version: (()=>{
          try {
            const bin = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
            const r = spawnSync(bin, ['--version'], { encoding:'utf8', env:{...process.env, NO_COLOR:'1',TERM:'dumb'}, timeout:3000 });
            const m = (r.stdout||'').trim().match(/(\d+\.\d+[\.\d]*)/);
            if (m) return m[1];
          } catch(_) {}
          return cfg.meta?.lastTouchedVersion || '未知';
        })(),
        primaryModel: cfg.agents?.defaults?.model?.primary || '未配置',
        platform: process.platform,
        ocmVersion: APP_VERSION,
      }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // POST /api/setup
  if (method === 'POST' && pathname === '/api/setup') {
    const { dir } = body;
    if (!dir) { res.writeHead(400); res.end(JSON.stringify({ error: '目录路径不能为空' })); return; }
    const resolved = path.resolve(dir.replace(/^~/, os.homedir()));
    const cfgTest  = path.join(resolved, 'openclaw.json');
    try {
      await fsp.access(cfgTest);
      saveManagerConfig({ openclawDir: resolved });
      OPENCLAW_DIR = resolved;
      CONFIG_PATH  = cfgTest;
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, dir: resolved }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `在 ${resolved} 中找不到 openclaw.json，请确认路径正确` }));
    }
    return;
  }

  // GET /api/agents
  if (method === 'GET' && pathname === '/api/agents') {
    const cfg      = await readConfig();
    const list     = cfg.agents?.list     || [];
    const defaults = cfg.agents?.defaults || {};
    const bindings = cfg.bindings         || [];
    const groups   = cfg.channels?.telegram?.groups || {};
    const defaultWorkspace = defaults.workspace || null;
    // Build set of accountIds explicitly claimed by non-main agents (via non-peer binding)
    const telegramAccounts = Object.keys(cfg.channels?.telegram?.accounts || {});
    const claimedAccounts = new Set(
      bindings.filter(b => b.agentId !== 'main' && b.match?.accountId && !b.match?.peer).map(b => b.match.accountId)
    );
    // For main agent without explicit binding, infer its accountId from first unclaimed telegram account
    const mainInferredAccountId = telegramAccounts.find(a => !claimedAccounts.has(a)) || telegramAccounts[0] || null;
    const enriched = list.map(a => {
      const binding = bindings.find(b => b.agentId === a.id && b.match?.peer?.kind === 'group');
      const groupId = binding?.match?.peer?.id || null;
      const modelVal = a.model?.primary || (typeof a.model === 'string' ? a.model : null);
      // Check if agent has its own bot account (binding with accountId but no peer)
      const botBinding = bindings.find(b => b.agentId === a.id && b.match?.accountId && !b.match?.peer);
      // 'main' is always a root agent even without explicit binding
      const isMain = a.id === 'main';
      const hasOwnBot = botBinding ? true : isMain;
      const accountId = botBinding?.match?.accountId || (isMain ? mainInferredAccountId : null);
      // For sub-agents (with peer match), find which accountId they belong to
      const parentBinding = bindings.find(b => b.agentId === a.id && b.match?.accountId);
      // Fallback: if sub-agent has peer binding but no accountId, AND there's only one bot (old single-bot config),
      // infer parentAccountId from main. If multiple bots exist, leave as orphan (can't guess which bot it belongs to).
      let parentAccountId = parentBinding?.match?.accountId || null;
      if (!parentAccountId && !hasOwnBot) {
        const hasPeerBinding = bindings.find(b => b.agentId === a.id && b.match?.peer);
        if (hasPeerBinding) {
          const rootBindings = bindings.filter(b => b.match?.accountId && !b.match?.peer);
          const rootCount = rootBindings.length + (list.some(x => x.id === 'main') && !rootBindings.some(b => b.agentId === 'main') ? 1 : 0);
          if (rootCount <= 1) {
            const mainBinding = rootBindings.find(b => b.agentId === 'main') || rootBindings[0];
            parentAccountId = mainBinding?.match?.accountId || mainInferredAccountId || 'default';
          }
        }
      }
      // Workspace: explicit per-agent, or defaults.workspace for main
      const workspace = a.workspace || (isMain ? defaultWorkspace : null);
      return { ...a, workspace, groupId, requireMention: groupId ? (groups[groupId]?.requireMention ?? true) : null,
        effectiveModel: modelVal || defaults.model?.primary || '默认', hasOwnBot, accountId, parentAccountId, parentAgentId: a.parentAgentId || null, bindings: (bindings||[]).filter(b=>b.agentId===a.id).map(b=>({
        idx: bindings.indexOf(b),
        channel: b.match?.channel || '',
        accountId: b.match?.accountId || '',
        peerKind: b.match?.peer?.kind || '',
        peerId: b.match?.peer?.id || ''
      })) };
    });
    res.writeHead(200);
    res.end(JSON.stringify({ agents: enriched, defaults }));
    return;
  }

  // POST /api/agents/bot — create agent with its own bot token
  if (method === 'POST' && pathname === '/api/agents/bot') {
    const { botToken, agentId, name, model, workspace, purpose, personality } = body;
    if (!botToken || !botToken.trim()) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Bot Token is required' })); return;
    }
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Agent ID must contain only alphanumeric characters, underscores, or dashes' })); return;
    }
    if (!workspace || !workspace.trim()) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Workspace name is required' })); return;
    }
    if (workspace === 'main') {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Workspace name cannot be "main"' })); return;
    }
    const cfg = await readConfig();
    // Check if agentId already exists
    if (cfg.agents?.list?.some(a => a.id === agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Agent ID "${agentId}" already exists` })); return;
    }
    // Migrate from old format if necessary
    if (cfg.channels?.telegram?.botToken && !cfg.channels.telegram.accounts) {
      cfg.channels.telegram.accounts = {};
      cfg.channels.telegram.accounts.default = { botToken: cfg.channels.telegram.botToken };
      delete cfg.channels.telegram.botToken;
    }
    // Initialize structure
    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels.telegram) cfg.channels.telegram = {};
    if (!cfg.channels.telegram.accounts) cfg.channels.telegram.accounts = {};
    // Check for duplicate bot token in existing accounts
    const tokenTrimmed = botToken.trim();
    for (const acctId in cfg.channels.telegram.accounts) {
      if (cfg.channels.telegram.accounts[acctId].botToken === tokenTrimmed) {
        res.writeHead(400); res.end(JSON.stringify({ error: `Bot Token already used by account "${acctId}"` })); return;
      }
    }
    // Add new account
    cfg.channels.telegram.accounts[agentId] = { botToken: tokenTrimmed };
    cfg.channels.telegram.enabled = true;
    // Ensure agents structure
    if (!cfg.agents) cfg.agents = { defaults: {}, list: [] };
    if (!cfg.agents.list) cfg.agents.list = [];
    // Create agent entry
    const wsPath = path.join(OPENCLAW_DIR, 'workspaces', workspace);
    const wsAlias = `~/.openclaw/workspaces/${workspace}`;
    const agentEntry = { id: agentId, name: name || agentId, workspace: wsAlias };
    if (model && model !== '__default__') agentEntry.model = { primary: model };
    cfg.agents.list.push(agentEntry);
    // Add binding
    if (!cfg.bindings) cfg.bindings = [];
    cfg.bindings.push({ agentId, match: { channel: 'telegram', accountId: agentId } });
    // Save config
    const bakPath = await writeConfig(cfg, 'create');
    // Create workspace directories and files
    await fsp.mkdir(wsPath, { recursive: true });
    await fsp.mkdir(path.join(wsPath, 'memory'), { recursive: true });
    const agentName = name || agentId;
    await fsp.writeFile(path.join(wsPath, 'SOUL.md'), generateSoulMd(agentName, purpose || '', personality || ''), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'MEMORY.md'), generateMemoryMd(agentName, ''), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'memory', 'CURRENT_STATE.md'), generateCurrentStateMd(), 'utf8');
    // Create agents/<id>/ runtime directory (required by OpenClaw gateway)
    const agentRuntimeDir = path.join(OPENCLAW_DIR, 'agents', agentId);
    await fsp.mkdir(agentRuntimeDir, { recursive: true });
    await fsp.mkdir(path.join(agentRuntimeDir, 'sessions'), { recursive: true });
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true, agentId, workspacePath: wsPath, configBackup: bakPath,
      notes: [
        'Agent created with its own bot token',
        'Workspace directory created with SOUL.md, MEMORY.md, and memory/CURRENT_STATE.md',
        'Runtime directory created at agents/' + agentId + '/',
        'Configuration updated and backed up',
        'Restart gateway to load new bot: openclaw gateway restart'
      ]
    }));
    return;
  }

  // POST /api/agents/discord — create top-level Discord agent (single bot, channel binding)
  if (method === 'POST' && pathname === '/api/agents/discord') {
    const { agentId, name, workspaceFolder, model, purpose, personality, guildId, channelId } = body;
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Agent ID must contain only alphanumeric characters, underscores, or dashes' })); return;
    }
    if (!name || !name.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Name is required' })); return; }
    const folder = (workspaceFolder || agentId).trim();
    if (!folder) { res.writeHead(400); res.end(JSON.stringify({ error: 'Workspace folder is required' })); return; }
    if (!channelId || !String(channelId).trim().match(/^\d+$/)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Discord channelId is required' })); return; }
    const gid = (guildId || '').trim();

    const cfg = await readConfig();
    if (cfg.agents?.list?.some(a => a.id === agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Agent ID \"${agentId}\" already exists` })); return;
    }
    // Prevent workspace reuse
    const wsAlias = `~/.openclaw/workspaces/${folder}`;
    if (cfg.agents?.list?.some(a => (a.workspace||'').endsWith(`/workspaces/${folder}`) || a.workspace === wsAlias)) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Workspace folder \"${folder}\" is already used by another agent` })); return;
    }

    if (!cfg.agents) cfg.agents = { defaults: {}, list: [] };
    if (!cfg.agents.list) cfg.agents.list = [];

    const wsPath = path.join(OPENCLAW_DIR, 'workspaces', folder);
    const agentEntry = { id: agentId, name: name || agentId, workspace: wsAlias };
    if (model && model !== '__default__') agentEntry.model = { primary: model };
    cfg.agents.list.push(agentEntry);

    if (!cfg.bindings) cfg.bindings = [];
    cfg.bindings.unshift({ agentId, match: { channel: 'discord', peer: { kind: 'channel', id: String(channelId).trim() } } });

    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels.discord) cfg.channels.discord = {};
    cfg.channels.discord.enabled = true;
    if (gid) {
      if (!cfg.channels.discord.guilds) cfg.channels.discord.guilds = {};
      if (!cfg.channels.discord.guilds[gid]) cfg.channels.discord.guilds[gid] = {};
      if (!cfg.channels.discord.guilds[gid].channels) cfg.channels.discord.guilds[gid].channels = {};
      cfg.channels.discord.guilds[gid].channels[String(channelId).trim()] = { allow: true, requireMention: false };
      if (cfg.channels.discord.guilds[gid].requireMention === undefined) cfg.channels.discord.guilds[gid].requireMention = false;
    }

    const bakPath = await writeConfig(cfg, 'create');

    await fsp.mkdir(wsPath, { recursive: true });
    await fsp.mkdir(path.join(wsPath, 'memory'), { recursive: true });
    await fsp.writeFile(path.join(wsPath, 'SOUL.md'), generateSoulMd(name || agentId, purpose || '', personality || ''), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'MEMORY.md'), generateMemoryMd(name || agentId, ''), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'memory', 'CURRENT_STATE.md'), generateCurrentStateMd(), 'utf8');

    const agentRuntimeDir = path.join(OPENCLAW_DIR, 'agents', agentId);
    await fsp.mkdir(agentRuntimeDir, { recursive: true });
    await fsp.mkdir(path.join(agentRuntimeDir, 'sessions'), { recursive: true });

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, agentId, workspacePath: wsPath, configBackup: bakPath,
      notes: [
        'Discord agent created (single Discord bot)',
        'Channel binding added',
        'Workspace + runtime directories created (including memory/CURRENT_STATE.md)',
        'Configuration updated and backed up',
        'Restart gateway to apply: openclaw gateway restart'
      ]
    }));
    return;
  }

  // POST /api/agents/discord-sub — create Discord sub-agent (thread-only binding, grouping under parentAgentId)
  if (method === 'POST' && pathname === '/api/agents/discord-sub') {
    const { agentId, displayName, workspaceFolder, model, purpose, personality, initialMemory, parentAgentId, guildId, threadId } = body;
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Agent ID must contain only alphanumeric characters, underscores, or dashes' })); return;
    }
    if (!parentAgentId || !String(parentAgentId).trim()) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Parent Agent ID is required' })); return;
    }
    if (!threadId || !String(threadId).trim().match(/^\d+$/)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Discord threadId is required' })); return;
    }
    const gid = (guildId || '').trim();

    const cfg = await readConfig();
    const parentAgent = cfg.agents?.list?.find(a => a.id === parentAgentId);
    if (!parentAgent) { res.writeHead(404); res.end(JSON.stringify({ error: `Parent agent \"${parentAgentId}\" does not exist` })); return; }
    if (cfg.agents?.list?.some(a => a.id === agentId)) { res.writeHead(400); res.end(JSON.stringify({ error: `Agent ID \"${agentId}\" already exists` })); return; }

    const folder = (workspaceFolder || agentId).trim();
    const wsAlias = `~/.openclaw/workspaces/${folder}`;
    if (cfg.agents?.list?.some(a => (a.workspace||'').endsWith(`/workspaces/${folder}`) || a.workspace === wsAlias)) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Workspace folder \"${folder}\" is already used by another agent` })); return;
    }

    const wsPath = path.join(OPENCLAW_DIR, 'workspaces', folder);
    const agentEntry = { id: agentId, name: displayName || agentId, workspace: wsAlias, parentAgentId: String(parentAgentId).trim() };
    if (model && model !== '__default__') agentEntry.model = { primary: model };
    cfg.agents.list.push(agentEntry);

    if (!cfg.bindings) cfg.bindings = [];
    cfg.bindings.unshift({ agentId, match: { channel: 'discord', peer: { kind: 'channel', id: String(threadId).trim() } } });

    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels.discord) cfg.channels.discord = {};
    cfg.channels.discord.enabled = true;
    if (gid) {
      if (!cfg.channels.discord.guilds) cfg.channels.discord.guilds = {};
      if (!cfg.channels.discord.guilds[gid]) cfg.channels.discord.guilds[gid] = {};
      if (!cfg.channels.discord.guilds[gid].channels) cfg.channels.discord.guilds[gid].channels = {};
      cfg.channels.discord.guilds[gid].channels[String(threadId).trim()] = { allow: true, requireMention: false };
      if (cfg.channels.discord.guilds[gid].requireMention === undefined) cfg.channels.discord.guilds[gid].requireMention = false;
    }

    const bakPath = await writeConfig(cfg, 'create');

    await fsp.mkdir(wsPath, { recursive: true });
    await fsp.mkdir(path.join(wsPath, 'memory'), { recursive: true });
    const name = displayName || agentId;
    await fsp.writeFile(path.join(wsPath, 'SOUL.md'),   generateSoulMd(name, purpose || '', personality || ''), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'MEMORY.md'), generateMemoryMd(name, initialMemory || ''), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'memory', 'CURRENT_STATE.md'), generateCurrentStateMd(), 'utf8');

    const agentRuntimeDir = path.join(OPENCLAW_DIR, 'agents', agentId);
    await fsp.mkdir(agentRuntimeDir, { recursive: true });
    await fsp.mkdir(path.join(agentRuntimeDir, 'sessions'), { recursive: true });

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, agentId, workspacePath: wsPath, configBackup: bakPath,
      notes: [
        'Discord sub-agent created (thread-only binding)',
        'Workspace + runtime directories created (including memory/CURRENT_STATE.md)',
        'Configuration updated and backed up',
        'Restart gateway to apply: openclaw gateway restart'
      ]
    }));
    return;
  }


  // POST /api/agents — create sub-agent (shares parent bot)
  if (method === 'POST' && pathname === '/api/agents') {
    const { agentId, displayName, groupId, workspaceFolder, model, purpose, personality, initialMemory, parentAgentId, telegramUserId } = body;
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Agent ID must contain only alphanumeric characters, underscores, or dashes' })); return;
    }
    if (!groupId?.trim()) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Group ID cannot be empty' })); return;
    }
    if (!parentAgentId?.trim()) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Parent Agent ID is required' })); return;
    }
    const cfg = await readConfig();
    // Verify parent agent exists and has a bot account
    const parentAgent = cfg.agents?.list?.find(a => a.id === parentAgentId);
    if (!parentAgent) {
      res.writeHead(404); res.end(JSON.stringify({ error: `Parent agent "${parentAgentId}" does not exist` })); return;
    }
    const parentBinding = cfg.bindings?.find(b => b.agentId === parentAgentId && b.match?.accountId);
    if (!parentBinding) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Parent agent "${parentAgentId}" does not have its own bot account` })); return;
    }
    if (cfg.agents.list.some(a => a.id === agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Agent ID "${agentId}" already exists` })); return;
    }
    const gid    = String(groupId).trim();
    const folder = workspaceFolder || agentId;
    const wsPath = path.join(OPENCLAW_DIR, 'workspaces', folder);
    const wsAlias= `~/.openclaw/workspaces/${folder}`;
    const agentEntry = { id: agentId, name: displayName || agentId, workspace: wsAlias, parentAgentId: String(parentAgentId).trim() };
    if (model && model !== '__default__') agentEntry.model = { primary: model };
    cfg.agents.list.push(agentEntry);
    // Binding uses parent's accountId
    const parentAccountId = parentBinding.match.accountId;
    const newBinding = { agentId, match: { channel: 'telegram', accountId: parentAccountId, peer: { kind: 'group', id: gid } } };
    if (!cfg.bindings) cfg.bindings = [];
    cfg.bindings.unshift(newBinding);
    if (!cfg.channels)                 cfg.channels = {};
    if (!cfg.channels.telegram)        cfg.channels.telegram = {};
    if (!cfg.channels.telegram.groups) cfg.channels.telegram.groups = {};
    cfg.channels.telegram.groups[gid] = { requireMention: false };
    // Add telegramUserId to allowFrom whitelist if provided
    if (telegramUserId && /^\d+$/.test(String(telegramUserId).trim())) {
      const uid = parseInt(String(telegramUserId).trim());
      if (!cfg.channels.telegram.allowFrom) cfg.channels.telegram.allowFrom = [];
      if (!cfg.channels.telegram.allowFrom.includes(uid)) {
        cfg.channels.telegram.allowFrom.push(uid);
      }
    }
    const bakPath = await writeConfig(cfg, 'create');
    await fsp.mkdir(wsPath, { recursive: true });
    await fsp.mkdir(path.join(wsPath, 'memory'), { recursive: true });
    const name = displayName || agentId;
    await fsp.writeFile(path.join(wsPath, 'SOUL.md'),   generateSoulMd(name, purpose, personality), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'MEMORY.md'), generateMemoryMd(name, initialMemory), 'utf8');
    await fsp.writeFile(path.join(wsPath, 'memory', 'CURRENT_STATE.md'), generateCurrentStateMd(), 'utf8');
    // Create agents/<id>/ runtime directory (required by OpenClaw gateway)
    const agentRuntimeDir = path.join(OPENCLAW_DIR, 'agents', agentId);
    await fsp.mkdir(agentRuntimeDir, { recursive: true });
    await fsp.mkdir(path.join(agentRuntimeDir, 'sessions'), { recursive: true });
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, agentId, workspacePath: wsPath, configBackup: bakPath,
      notes: [
        'Sub-agent created and shares parent bot',
        'Workspace and runtime directories created (including memory/CURRENT_STATE.md)',
        'Configuration updated and backed up',
        'Restart gateway to apply: openclaw gateway restart'
      ],
    }));
    return;
  }

  // PUT /api/agents/:id
  if (method === 'PUT' && pathname.startsWith('/api/agents/')) {
    const agentId = decodeURIComponent(pathname.split('/api/agents/')[1]);
    const cfg = await readConfig();
    const idx = cfg.agents.list.findIndex(a => a.id === agentId);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent 不存在' })); return; }
    const { model, name } = body;
    if (model !== undefined) {
      if (!model || model === '__default__') { delete cfg.agents.list[idx].model; }
      else { cfg.agents.list[idx].model = { primary: model }; }
    }
    if (name !== undefined && name.trim()) cfg.agents.list[idx].name = name.trim();
    const bakPath = await writeConfig(cfg, 'edit');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, agentId, configBackup: bakPath }));
    return;
  }

  // DELETE /api/agents/:id
  if (method === 'DELETE' && pathname.startsWith('/api/agents/')) {
    const agentId = decodeURIComponent(pathname.split('/api/agents/')[1]);
    if (!agentId || agentId === 'main') { res.writeHead(400); res.end(JSON.stringify({ error: '无法删除此 Agent' })); return; }
    const cfg = await readConfig();
    const idx = cfg.agents.list.findIndex(a => a.id === agentId);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent 不存在' })); return; }
    const agent = cfg.agents.list[idx];
    const agentBinding = cfg.bindings.find(b => b.agentId === agentId && b.match?.peer?.id);
    const boundGroupId = agentBinding?.match?.peer?.id || null;
    cfg.agents.list.splice(idx, 1);
    cfg.bindings = cfg.bindings.filter(b => b.agentId !== agentId);
    if (boundGroupId && cfg.channels?.telegram?.groups) delete cfg.channels.telegram.groups[boundGroupId];
    const bakPath = await writeConfig(cfg, 'delete');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, agentId, workspace: agent.workspace, configBackup: bakPath,
      note: 'Workspace 目录未删除。如需恢复，可从备份回滚。' }));
    return;
  }

  // GET /api/workspace/:id — 列出 workspace 下所有文件（含内容和 stat）
  if (method === 'GET' && pathname.startsWith('/api/workspace/')) {
    const agentId = decodeURIComponent(pathname.split('/api/workspace/')[1]);
    const cfg = await readConfig();
    const agent = cfg.agents?.list?.find(a => a.id === agentId);
    if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent 不存在' })); return; }
    const wsPath = resolveAgentWorkspacePath(cfg, agentId, agent);
    const files = {};
    const fileStats = {};
    try {
      const entries = await fsp.readdir(wsPath);
      for (const fname of entries) {
        const fpath = path.join(wsPath, fname);
        try {
          const st = await fsp.stat(fpath);
          if (!st.isFile()) continue;
          // 对大文件只返回 stat 不读内容（> 512KB）
          if (st.size > 512 * 1024) {
            files[fname] = null;
          } else {
            files[fname] = await fsp.readFile(fpath, 'utf8');
          }
          fileStats[fname] = { size: st.size, mtime: st.mtimeMs };
        } catch { /* skip */ }
      }
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: '无法读取目录: ' + e.message })); return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ agentId, workspacePath: wsPath, files, fileStats }));
    return;
  }

  // PUT /api/workspace/:id/:file
  if (method === 'PUT' && pathname.startsWith('/api/workspace/')) {
    const parts   = pathname.split('/').filter(Boolean);
    const agentId = decodeURIComponent(parts[2] || '');
    const fname   = decodeURIComponent(parts[3] || '');
    if (!agentId || !fname) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少参数' })); return; }
    const cfg   = await readConfig();
    const agent = cfg.agents?.list?.find(a => a.id === agentId);
    if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent 不存在' })); return; }
    const wsPath = resolveAgentWorkspacePath(cfg, agentId, agent);
    await fsp.mkdir(wsPath, { recursive: true });
    await fsp.writeFile(path.join(wsPath, fname), body.content || '', 'utf8');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/models
  if (method === 'GET' && pathname === '/api/models') {
    const cfg = await readConfig();
    const modelList = await getKnownModelsFromCli();
    res.writeHead(200);
    res.end(JSON.stringify({
      models:        cfg.agents?.defaults?.models       || {},
      authProfiles:  cfg.auth?.profiles                 || {},
      primaryModel:  cfg.agents?.defaults?.model?.primary || '',
      fallbacks:     cfg.agents?.defaults?.model?.fallbacks || [],
      knownModels:   modelList.knownModels || [],
      modelListError:modelList.error || '',
      authProviders: AUTH_PROVIDERS,
    }));
    return;
  }

  // PUT /api/models/settings
  if (method === 'PUT' && pathname === '/api/models/settings') {
    const { primaryModel, fallbacks } = body;
    const cfg = await readConfig();
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
    if (primaryModel !== undefined) cfg.agents.defaults.model.primary = primaryModel;
    if (Array.isArray(fallbacks))   cfg.agents.defaults.model.fallbacks = fallbacks;
    const bakPath = await writeConfig(cfg, 'models');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, configBackup: bakPath }));
    return;
  }



  // DELETE /api/auth/:key
  if (method === 'DELETE' && pathname.startsWith('/api/auth/')) {
    const profileKey = decodeURIComponent(pathname.split('/api/auth/')[1]);
    const cfg = await readConfig();
    if (cfg.auth?.profiles?.[profileKey]) {
      delete cfg.auth.profiles[profileKey];
      const bakPath = await writeConfig(cfg, 'auth');
      res.writeHead(200); res.end(JSON.stringify({ ok: true, profileKey, configBackup: bakPath }));
    } else {
      res.writeHead(404); res.end(JSON.stringify({ error: '认证配置不存在' }));
    }
    return;
  }

  // ── Channels API ──────────────────────────────────────────────

  // GET /api/channels
  if (method === 'GET' && pathname === '/api/channels') {
    const cfg      = await readConfig();
    const bindings = cfg.bindings || [];
    const agents   = cfg.agents?.list || [];
    const channels = bindings.map((b, idx) => {
      const agentName = agents.find(a => a.id === b.agentId)?.name || b.agentId;
      return {
        idx,
        agentId:  b.agentId,
        agentName,
        channel:  b.match?.channel || 'any',
        peerKind: b.match?.peer?.kind || 'any',
        peerId:   b.match?.peer?.id || null,
        raw:      b,
      };
    });
    res.writeHead(200);
    res.end(JSON.stringify({ channels }));
    return;
  }

  // POST /api/channels
  if (method === 'POST' && pathname === '/api/channels') {
    const { agentId, channel, peerKind, peerId } = body;
    if (!agentId) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 agentId' })); return; }
    const cfg = await readConfig();
    if (!cfg.agents?.list?.find(a => a.id === agentId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Agent "${agentId}" 不存在` })); return;
    }
    const newBinding = { agentId };
    if (channel || peerKind || peerId) {
      newBinding.match = {};
      if (channel) newBinding.match.channel = channel;
      if (peerKind || peerId) {
        newBinding.match.peer = {};
        if (peerKind) newBinding.match.peer.kind = peerKind;
        if (peerId)   newBinding.match.peer.id   = String(peerId);
      }
    }
    // Insert before main catch-all binding
    const mainIdx = cfg.bindings.findIndex(b => b.agentId === 'main' && !b.match?.peer);
    if (mainIdx >= 0) cfg.bindings.splice(mainIdx, 0, newBinding);
    else cfg.bindings.push(newBinding);
    const bakPath = await writeConfig(cfg, 'edit');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, configBackup: bakPath }));
    return;
  }

  // DELETE /api/channels/:idx
  if (method === 'DELETE' && pathname.startsWith('/api/channels/')) {
    const idx = parseInt(pathname.split('/api/channels/')[1]);
    const cfg = await readConfig();
    if (isNaN(idx) || idx < 0 || idx >= cfg.bindings.length) {
      res.writeHead(400); res.end(JSON.stringify({ error: '无效的绑定索引' })); return;
    }
    const removed = cfg.bindings.splice(idx, 1)[0];
    const bakPath = await writeConfig(cfg, 'edit');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, removed, configBackup: bakPath }));
    return;
  }

  // ── Backup API ────────────────────────────────────────────────

  // GET /api/backups
  if (method === 'GET' && pathname === '/api/backups') {
    const files = await listBackups();
    res.writeHead(200);
    res.end(JSON.stringify({ backups: files }));
    return;
  }

  // POST /api/backups/restore
  if (method === 'POST' && pathname === '/api/backups/restore') {
    const { filename } = body;
    if (!filename || filename.includes('..') || !filename.startsWith('openclaw.json')) {
      res.writeHead(400); res.end(JSON.stringify({ error: '无效的备份文件名' })); return;
    }
    const bakPath = path.join(OPENCLAW_DIR, filename);
    try {
      await fsp.access(bakPath);
      const savePath = await backupConfig('before-restore');
      await fsp.copyFile(bakPath, CONFIG_PATH);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, restored: filename, savedCurrent: savePath }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: '恢复失败：' + e.message }));
    }
    return;
  }

  // POST /api/config/backup
  if (method === 'POST' && pathname === '/api/config/backup') {
    try {
      const bakPath = await backupConfig('manual');
      res.writeHead(200); res.end(JSON.stringify({ ok: true, bakPath }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /api/backup/nas-config
  if (method === 'GET' && pathname === '/api/backup/nas-config') {
    const mc = loadManagerConfig();
    res.writeHead(200);
    res.end(JSON.stringify({
      nasHost:       mc.nasHost       || '',
      nasPort:       mc.nasPort       || '22',
      nasUser:       mc.nasUser       || '',
      nasAuth:       mc.nasAuth       || 'password',
      nasSshKey:     mc.nasSshKey     || path.join(os.homedir(), '.ssh', 'ocm_nas_rsa'),
      nasPath:       mc.nasPath       || '/volume1/OpenClaw/backups',
      nasLegacyCipher: mc.nasLegacyCipher || false,
      nasBackupType: mc.nasBackupType || 'full',
      nasEnabled:    mc.nasEnabled    || false,
    }));
    return;
  }

  // PUT /api/backup/nas-config
  if (method === 'PUT' && pathname === '/api/backup/nas-config') {
    const { nasHost, nasPort, nasUser, nasAuth, nasSshKey, nasPath, nasLegacyCipher, nasBackupType, nasEnabled } = body;
    saveManagerConfig({ nasHost, nasPort, nasUser, nasAuth, nasSshKey, nasPath, nasLegacyCipher, nasBackupType, nasEnabled });
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/backup/nas-test — test SSH connection (password or key)
  if (method === 'POST' && pathname === '/api/backup/nas-test') {
    const mc = loadManagerConfig();
    const { nasHost, nasPort, nasUser, nasAuth, nasSshKey, nasLegacyCipher } = mc;
    const { password } = body;
    const port = nasPort || '22';
    if (!nasHost || !nasUser) {
      res.writeHead(400); res.end(JSON.stringify({ error: '请先配置主机和用户名' })); return;
    }
    const cipherOpts = nasLegacyCipher
      ? '-o Ciphers=aes256-gcm@openssh.com,aes128-gcm@openssh.com,chacha20-poly1305@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr,aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc' +
        ' -o KexAlgorithms=curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,diffie-hellman-group14-sha256,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1' +
        ' -o HostKeyAlgorithms=ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-256,rsa-sha2-512,ssh-rsa'
      : '';
    try {
      let sshCmd;
      if (nasAuth === 'key') {
        const keyPath = (nasSshKey || '~/.ssh/ocm_nas_rsa').replace(/^~/, os.homedir());
        sshCmd = `ssh -i "${keyPath}" -p ${port} -o ConnectTimeout=8 -o StrictHostKeyChecking=no ${cipherOpts} "${nasUser}@${nasHost}" "echo connected_ok"`;
      } else {
        if (!password) { res.writeHead(400); res.end(JSON.stringify({ error: '请输入密码' })); return; }
        const safePwd = password.replace(/'/g, "'\\''");
        sshCmd = `sshpass -p '${safePwd}' ssh -p ${port} -o ConnectTimeout=8 -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no ${cipherOpts} "${nasUser}@${nasHost}" "echo connected_ok"`;
      }
      const out = await new Promise((resolve, reject) => {
        exec(sshCmd, { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message)); else resolve(stdout.trim());
        });
      });
      res.writeHead(200); res.end(JSON.stringify({ ok: out.includes('connected_ok'), output: out }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/backup/nas-now — create tarball + rsync to NAS
  if (method === 'POST' && pathname === '/api/backup/nas-now') {
    const mc = loadManagerConfig();
    const { nasHost, nasPort, nasUser, nasAuth, nasSshKey, nasPath, nasLegacyCipher, nasBackupType } = mc;
    const { password } = body;
    const port = nasPort || '22';
    const remotePath = nasPath || '/volume1/OpenClaw/backups';
    if (!nasHost || !nasUser) {
      res.writeHead(400); res.end(JSON.stringify({ error: '请先配置 NAS 设置' })); return;
    }
    const cipherOpts = nasLegacyCipher
      ? '-o Ciphers=aes256-gcm@openssh.com,aes128-gcm@openssh.com,chacha20-poly1305@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr,aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc' +
        ' -o KexAlgorithms=curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,diffie-hellman-group14-sha256,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1' +
        ' -o HostKeyAlgorithms=ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-256,rsa-sha2-512,ssh-rsa'
      : '';
    try {
      const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const bkType = nasBackupType || 'full';
      const tarName = `openclaw-${bkType}-${ts}.tar.gz`;
      const tarPath = path.join(os.tmpdir(), tarName);
      const homeDir = os.homedir();
      const ocDir = path.basename(OPENCLAW_DIR); // usually .openclaw

      // Build tar command
      let tarCmd;
      if (bkType === 'essential') {
        // Essential: configs + credentials + agent configs (no sessions/logs/media)
        const essentialPaths = [
          `${ocDir}/openclaw.json`,
          `${ocDir}/.env`,
          `${ocDir}/credentials`,
          `${ocDir}/agents`,
          `${ocDir}/memory`,
        ].join(' ');
        tarCmd = `tar czf "${tarPath}" -C "${homeDir}" --exclude="${ocDir}/agents/*/sessions" --exclude="${ocDir}/logs" ${essentialPaths} 2>/dev/null || true`;
      } else {
        // Full: everything except logs and large temp files
        tarCmd = `tar czf "${tarPath}" -C "${homeDir}" --exclude="${ocDir}/logs" --exclude="${ocDir}/ocm/*.bak.js" "${ocDir}"`;
      }

      await new Promise((resolve, reject) => {
        exec(tarCmd, { timeout: 60000 }, (err, stdout, stderr) => {
          // tar exits non-zero on some warnings (excluded files) - check if file was created
          fsp.access(tarPath).then(resolve).catch(() => reject(new Error(stderr || (err && err.message) || 'tar failed')));
        });
      });

      // Transfer via rsync over ssh
      // NOTE: sshpass must wrap the entire rsync command, NOT be inside -e argument
      let rsyncCmd, mkdirCmd;
      if (nasAuth === 'key') {
        const keyPath = (nasSshKey || '~/.ssh/ocm_nas_rsa').replace(/^~/, os.homedir());
        const sshArg = `ssh -i "${keyPath}" -p ${port} -o StrictHostKeyChecking=no -o BatchMode=yes ${cipherOpts}`;
        rsyncCmd = `rsync -avz -e "${sshArg}" "${tarPath}" "${nasUser}@${nasHost}:${remotePath}/"`;
        mkdirCmd = `ssh -i "${keyPath}" -p ${port} -o StrictHostKeyChecking=no -o BatchMode=yes ${cipherOpts} "${nasUser}@${nasHost}" "mkdir -p '${remotePath}'"`;
      } else {
        if (!password) { res.writeHead(400); res.end(JSON.stringify({ error: '请提供密码' })); return; }
        const safePwd = password.replace(/'/g, "'\\''");
        const sshArg = `ssh -p ${port} -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no ${cipherOpts}`;
        rsyncCmd = `sshpass -p '${safePwd}' rsync -avz -e "${sshArg}" "${tarPath}" "${nasUser}@${nasHost}:${remotePath}/"`;
        mkdirCmd = `sshpass -p '${safePwd}' ssh -p ${port} -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no ${cipherOpts} "${nasUser}@${nasHost}" "mkdir -p '${remotePath}'"`;
      }
      // Create remote directory if it doesn't exist (best-effort, ignore errors)
      await new Promise(resolve => { exec(mkdirCmd, { timeout: 10000 }, () => resolve()); });

      const rsyncOut = await new Promise((resolve, reject) => {
        exec(rsyncCmd, { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message)); else resolve((stdout + stderr).trim());
        });
      });

      // Cleanup temp file
      fsp.unlink(tarPath).catch(() => {});
      res.writeHead(200); res.end(JSON.stringify({ ok: true, output: rsyncOut, tarName }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/backup/nas-keygen — generate SSH key for key-auth mode
  if (method === 'POST' && pathname === '/api/backup/nas-keygen') {
    const mc = loadManagerConfig();
    const key = mc.nasSshKey || path.join(os.homedir(), '.ssh', 'ocm_nas_rsa');
    const keyResolved = key.replace(/^~/, os.homedir());
    try {
      try { await fsp.access(keyResolved); } catch {
        await new Promise((resolve, reject) => {
          exec(`ssh-keygen -t ed25519 -f "${keyResolved}" -N "" -C "openclaw-manager-backup"`,
            (err, stdout, stderr) => { if (err) reject(new Error(stderr || err.message)); else resolve(); });
        });
      }
      const pubKey = await fsp.readFile(keyResolved + '.pub', 'utf8');
      res.writeHead(200); res.end(JSON.stringify({ ok: true, pubKey: pubKey.trim(), keyPath: keyResolved }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/backup/nas-cron — set up cron job
  if (method === 'POST' && pathname === '/api/backup/nas-cron') {
    const mc = loadManagerConfig();
    const { nasHost, nasPort, nasUser, nasAuth, nasSshKey, nasPath, nasLegacyCipher, nasBackupType } = mc;
    const { password, cronTime } = body;
    const port = nasPort || '22';
    const remotePath = nasPath || '/volume1/OpenClaw/backups';
    const cipherOpts = nasLegacyCipher
      ? '-o Ciphers=aes256-gcm@openssh.com,aes128-gcm@openssh.com,chacha20-poly1305@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr,aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc' +
        ' -o KexAlgorithms=curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,diffie-hellman-group14-sha256,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1' +
        ' -o HostKeyAlgorithms=ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-256,rsa-sha2-512,ssh-rsa'
      : '';
    const homeDir = os.homedir();
    const ocDir = path.basename(OPENCLAW_DIR);
    const ts = '$(date +%Y%m%d-%H%M%S)';
    const bkType = nasBackupType || 'full';
    const tarPath = `/tmp/openclaw-${bkType}-${ts}.tar.gz`;

    let tarPart;
    if (bkType === 'essential') {
      tarPart = `tar czf ${tarPath} -C "${homeDir}" --exclude="${ocDir}/agents/*/sessions" ${ocDir}/openclaw.json ${ocDir}/.env ${ocDir}/credentials ${ocDir}/agents ${ocDir}/memory 2>/dev/null; `;
    } else {
      tarPart = `tar czf ${tarPath} -C "${homeDir}" --exclude="${ocDir}/logs" --exclude="${ocDir}/ocm/*.bak.js" "${ocDir}" 2>/dev/null; `;
    }

    let cronRsyncCmd;
    if (nasAuth === 'key') {
      const keyPath = (nasSshKey || '~/.ssh/ocm_nas_rsa').replace(/^~/, os.homedir());
      const sshArg = `ssh -i "${keyPath}" -p ${port} -o StrictHostKeyChecking=no -o BatchMode=yes ${cipherOpts}`;
      cronRsyncCmd = `rsync -avz -e "${sshArg}" ${tarPath} "${nasUser}@${nasHost}:${remotePath}/"`;
    } else {
      if (!password) { res.writeHead(400); res.end(JSON.stringify({ error: '请提供密码（用于计划任务）' })); return; }
      const safePwd = password.replace(/'/g, "'\\''");
      const sshArg = `ssh -p ${port} -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no ${cipherOpts}`;
      cronRsyncCmd = `sshpass -p '${safePwd}' rsync -avz -e "${sshArg}" ${tarPath} "${nasUser}@${nasHost}:${remotePath}/"`;
    }

    const [h, m] = (cronTime || '03:00').split(':');
    const cronLine = `${m||'0'} ${h||'3'} * * * ${tarPart}${cronRsyncCmd} && rm -f ${tarPath} >> /tmp/ocm-nas-backup.log 2>&1 # openclaw-manager-nas`;
    try {
      await new Promise((resolve, reject) => {
        exec('crontab -l 2>/dev/null || true', (err, stdout) => {
          const existing = stdout.replace(/.*# openclaw-manager-nas\n?/g, '');
          const newCron = existing.trimEnd() + '\n' + cronLine + '\n';
          const child2 = exec('crontab -', (err2) => { if (err2) reject(err2); else resolve(); });
          child2.stdin.write(newCron); child2.stdin.end();
        });
      });
      res.writeHead(200); res.end(JSON.stringify({ ok: true, cronLine }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /api/logs
  if (method === 'GET' && pathname === '/api/logs') {
    const n = parseInt(urlObj.searchParams.get('n') || '200');
    const content = await readLogTail(n);
    res.writeHead(200);
    res.end(JSON.stringify({ content, path: path.join(OPENCLAW_DIR, 'logs', 'gateway.log') }));
    return;
  }

  // POST /api/gateway/restart
  if (method === 'POST' && pathname === '/api/gateway/restart') {
    try {
      const out = await runOpenclawCmd('gateway restart');
      res.writeHead(200); res.end(JSON.stringify({ ok: true, output: out }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message,
        hint: '请在终端手动运行: openclaw gateway restart' }));
    }
    return;
  }

  // ── Stats API — Token usage from session JSONL files ──────────
  if (method === 'GET' && pathname === '/api/stats') {
    const days = parseInt(urlObj.searchParams.get('days') || '30');
    const cutoff = Date.now() - days * 86400000;
    const byModel = {};
    const byDay = {};
    const byAgent = {};
    let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
    let totalCost = 0;
    try {
      const agentsDir = path.join(OPENCLAW_DIR, 'agents');
      const agentDirs = await fsp.readdir(agentsDir).catch(() => []);
      for (const agentId of agentDirs) {
        const sessDir = path.join(agentsDir, agentId, 'sessions');
        let files;
        try { files = await fsp.readdir(sessDir); } catch { continue; }
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
        for (const fname of jsonlFiles) {
          let content;
          try { content = await fsp.readFile(path.join(sessDir, fname), 'utf8'); } catch { continue; }
          const lines = content.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj.type !== 'message') continue;
            const msg = obj.message;
            if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
            // Check timestamp filter
            const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : (msg.timestamp || 0);
            if (ts && ts < cutoff) continue;
            const u = msg.usage;
            const inTk = u.input || 0;
            const outTk = u.output || 0;
            const cacheR = u.cacheRead || 0;
            const cacheW = u.cacheWrite || 0;
            const msgCost = u.cost && typeof u.cost === 'object' ? (u.cost.total || 0) : 0;
            const model = msg.model || 'unknown';
            totalIn += inTk; totalOut += outTk;
            totalCacheRead += cacheR; totalCacheWrite += cacheW;
            totalCost += msgCost;
            // By model
            if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, requestCount: 0, cost: 0 };
            byModel[model].inputTokens += inTk;
            byModel[model].outputTokens += outTk;
            byModel[model].cacheRead += cacheR;
            byModel[model].cacheWrite += cacheW;
            byModel[model].requestCount++;
            byModel[model].cost += msgCost;
            // By day
            const dayKey = ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown';
            if (!byDay[dayKey]) byDay[dayKey] = { inputTokens: 0, outputTokens: 0, requestCount: 0, cost: 0 };
            byDay[dayKey].inputTokens += inTk;
            byDay[dayKey].outputTokens += outTk;
            byDay[dayKey].requestCount++;
            byDay[dayKey].cost += msgCost;
            // By agent
            if (!byAgent[agentId]) byAgent[agentId] = { inputTokens: 0, outputTokens: 0, requestCount: 0, cost: 0 };
            byAgent[agentId].inputTokens += inTk;
            byAgent[agentId].outputTokens += outTk;
            byAgent[agentId].requestCount++;
            byAgent[agentId].cost += msgCost;
          }
        }
      }
    } catch { /* agents dir may not exist */ }
    // Format costs
    Object.values(byModel).forEach(d => { d.cost = d.cost.toFixed(4); });
    Object.values(byDay).forEach(d => { d.cost = d.cost.toFixed(4); });
    Object.values(byAgent).forEach(d => { d.cost = d.cost.toFixed(4); });
    res.writeHead(200);
    res.end(JSON.stringify({
      summary: {
        totalInputTokens: totalIn, totalOutputTokens: totalOut,
        totalCacheRead: totalCacheRead, totalCacheWrite: totalCacheWrite,
        estimatedCost: '$' + totalCost.toFixed(4),
        totalTokens: totalIn + totalOut + totalCacheRead + totalCacheWrite
      },
      byModel, byDay, byAgent
    }));
    return;
  }

  // ── Cron API — 计划任务管理 ────────────────────────────────
  if (method === 'GET' && pathname === '/api/cron') {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('crontab -l 2>/dev/null || true', (err, stdout) => err ? reject(err) : resolve({ stdout }));
      });
      const lines = stdout.split('\n').filter(l => l.trim());
      const crons = [];
      lines.forEach((line, idx) => {
        // 只展示 openclaw 相关的或 OCM 标记的 cron
        const lo = line.toLowerCase();
        if (!lo.includes('openclaw') && !lo.includes('ocm')) return;
        const enabled = !line.trimStart().startsWith('#');
        const raw = enabled ? line.trim() : line.trim().replace(/^#\s*/, '');
        const parts = raw.split(/\s+/);
        const schedule = parts.slice(0, 5).join(' ');
        const command = parts.slice(5).join(' ').replace(/\s*#\s*openclaw.*$/i, '').trim();
        const label = (line.match(/#\s*(openclaw[^\n]*)/i) || [])[1] || '';
        crons.push({ idx, schedule, command, enabled, label, rawLine: line });
      });
      res.writeHead(200); res.end(JSON.stringify({ crons }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (method === 'POST' && pathname === '/api/cron') {
    const { schedule, command, label } = body;
    if (!schedule || !command) { res.writeHead(400); res.end(JSON.stringify({ error: '请填写表达式和命令' })); return; }
    const tag = label || 'openclaw-manager';
    const cronLine = `${schedule} ${command} >> /tmp/ocm-cron.log 2>&1 # ${tag}`;
    try {
      await new Promise((resolve, reject) => {
        exec('crontab -l 2>/dev/null || true', (err, stdout) => {
          const newCron = stdout.trimEnd() + '\n' + cronLine + '\n';
          const child2 = exec('crontab -', (err2) => { if (err2) reject(err2); else resolve(); });
          child2.stdin.write(newCron); child2.stdin.end();
        });
      });
      res.writeHead(200); res.end(JSON.stringify({ ok: true, cronLine }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (method === 'PUT' && pathname.match(/^\/api\/cron\/\d+$/)) {
    const targetIdx = parseInt(pathname.split('/').pop());
    const { schedule, command, enabled } = body;
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('crontab -l 2>/dev/null || true', (err, stdout) => err ? reject(err) : resolve({ stdout }));
      });
      const lines = stdout.split('\n');
      // 找到 openclaw 相关行的真实行号
      let ocmIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const lo = lines[i].toLowerCase();
        if (!lo.includes('openclaw') && !lo.includes('ocm')) continue;
        ocmIdx++;
        if (ocmIdx === targetIdx) {
          let raw = lines[i].trimStart().startsWith('#') ? lines[i].replace(/^#\s*/, '') : lines[i];
          if (schedule || command) {
            const parts = raw.trim().split(/\s+/);
            const oldSched = parts.slice(0, 5).join(' ');
            const oldCmd = parts.slice(5).join(' ');
            raw = (schedule || oldSched) + ' ' + (command || oldCmd);
          }
          lines[i] = (enabled === false ? '# ' : '') + raw.trim();
          break;
        }
      }
      await new Promise((resolve, reject) => {
        const child2 = exec('crontab -', (err) => { if (err) reject(err); else resolve(); });
        child2.stdin.write(lines.join('\n') + '\n'); child2.stdin.end();
      });
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (method === 'DELETE' && pathname.match(/^\/api\/cron\/\d+$/)) {
    const targetIdx = parseInt(pathname.split('/').pop());
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('crontab -l 2>/dev/null || true', (err, stdout) => err ? reject(err) : resolve({ stdout }));
      });
      const lines = stdout.split('\n');
      let ocmIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const lo = lines[i].toLowerCase();
        if (!lo.includes('openclaw') && !lo.includes('ocm')) continue;
        ocmIdx++;
        if (ocmIdx === targetIdx) { lines.splice(i, 1); break; }
      }
      await new Promise((resolve, reject) => {
        const child2 = exec('crontab -', (err) => { if (err) reject(err); else resolve(); });
        child2.stdin.write(lines.join('\n') + '\n'); child2.stdin.end();
      });
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (method === 'POST' && pathname.match(/^\/api\/cron\/\d+\/run$/)) {
    const targetIdx = parseInt(pathname.split('/')[3]);
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('crontab -l 2>/dev/null || true', (err, stdout) => err ? reject(err) : resolve({ stdout }));
      });
      const lines = stdout.split('\n');
      let ocmIdx = -1; let cmd = '';
      for (const line of lines) {
        const lo = line.toLowerCase();
        if (!lo.includes('openclaw') && !lo.includes('ocm')) continue;
        ocmIdx++;
        if (ocmIdx === targetIdx) {
          const raw = line.trimStart().startsWith('#') ? line.replace(/^#\s*/, '') : line;
          const parts = raw.trim().split(/\s+/);
          cmd = parts.slice(5).join(' ').replace(/\s*#\s*openclaw.*$/i, '').replace(/\s*>>[^&]*2>&1/, '').trim();
          break;
        }
      }
      if (!cmd) { res.writeHead(404); res.end(JSON.stringify({ error: '任务不存在' })); return; }
      const out = await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout + stderr);
        });
      });
      res.writeHead(200); res.end(JSON.stringify({ ok: true, output: stripAnsi(out) }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /api/health — 快速健康状态（解析 doctor 输出中的 warning/error 行）
  if (method === 'GET' && pathname === '/api/health') {
    try {
      const bin = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
      const r = spawnSync(bin, ['doctor'], {
        encoding: 'utf8', timeout: 8000,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', FORCE_COLOR: '0' }
      });
      const raw = stripAnsi((r.stdout || '') + (r.stderr || ''));
      const lines = raw.split('\n').filter(l => l.trim());
      const issues = [];
      lines.forEach(l => {
        const lo = l.toLowerCase();
        if (lo.includes('error') || lo.includes('critical') || lo.includes('fail')) {
          issues.push({ level: 'error', text: l.trim() });
        } else if (lo.includes('warn') || lo.includes('missing') || lo.includes('not found') || lo.includes('not configured')) {
          issues.push({ level: 'warn', text: l.trim() });
        }
      });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, issues, raw, exitCode: r.status || 0 }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, issues: [], raw: e.message, exitCode: -1 }));
    }
    return;
  }

  // GET /api/dashboard — system info + gateway health for Dashboard tab
  if (method === 'GET' && pathname === '/api/dashboard') {
    try {
      const cfg = await configExists() ? await readConfig() : null;
      // System info
      const sysUptime = os.uptime();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const nodeVer = process.version;
      const platform = `${os.type()} ${os.release()} (${os.arch()})`;
      const hostname = os.hostname();
      const cpus = os.cpus();
      const cpuModel = cpus.length ? cpus[0].model.trim() : 'Unknown';
      const cpuCores = cpus.length;
      const loadAvg = os.loadavg(); // [1min, 5min, 15min]

      // CPU usage % (snapshot via /proc/stat or fallback to loadavg)
      let cpuPercent = null;
      try {
        // Quick estimate: sum idle vs total across all cores from a snapshot
        const c1 = os.cpus();
        await new Promise(r => setTimeout(r, 200));
        const c2 = os.cpus();
        let idleDiff = 0, totalDiff = 0;
        for (let i = 0; i < c2.length; i++) {
          const t1 = c1[i].times, t2 = c2[i].times;
          const total1 = t1.user + t1.nice + t1.sys + t1.idle + t1.irq;
          const total2 = t2.user + t2.nice + t2.sys + t2.idle + t2.irq;
          idleDiff += (t2.idle - t1.idle);
          totalDiff += (total2 - total1);
        }
        cpuPercent = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
      } catch (_) {}

      // Disk usage (best-effort, works on macOS/Linux)
      let diskTotal = 0, diskUsed = 0, diskFree = 0;
      try {
        const dfOut = execSync('df -k ' + JSON.stringify(OPENCLAW_DIR), { encoding: 'utf8', timeout: 3000 });
        const dfLines = dfOut.trim().split('\\n');
        if (dfLines.length >= 2) {
          const parts = dfLines[1].split(/\\s+/);
          diskTotal = parseInt(parts[1] || 0) * 1024;
          diskUsed  = parseInt(parts[2] || 0) * 1024;
          diskFree  = parseInt(parts[3] || 0) * 1024;
        }
      } catch (_) {}

      // OpenClaw dir size (best-effort)
      let dirSize = 0;
      try {
        const duOut = execSync('du -sk ' + JSON.stringify(OPENCLAW_DIR), { encoding: 'utf8', timeout: 5000 });
        dirSize = parseInt(duOut.split(/\\s/)[0] || 0) * 1024;
      } catch (_) {}

      // Gateway process detection
      let gatewayRunning = 'unknown';
      let gatewayPid = null;
      try {
        const psOut = execSync("ps aux 2>/dev/null | grep -i 'openclaw.*gateway' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim();
        if (psOut) {
          gatewayRunning = 'running';
          const psParts = psOut.split(/\\s+/);
          gatewayPid = psParts[1] || null;
        } else {
          gatewayRunning = 'stopped';
        }
      } catch (_) { gatewayRunning = 'stopped'; }

      // Gateway port (from config or default 3000)
      let gatewayPort = null;
      try {
        if (cfg && cfg.channels && cfg.channels.telegram) {
          gatewayPort = cfg.channels.telegram.port || null;
        }
        if (!gatewayPort) gatewayPort = 3000;
      } catch (_) {}

      // Telegram routing/bot counts
      let bindingCount = 0, accountCount = 0, groupCount = 0, allowFromCount = 0, configAgentCount = 0;
      try {
        bindingCount = (cfg?.bindings || []).length;
        const accounts = cfg?.channels?.telegram?.accounts || {};
        accountCount = Object.keys(accounts).length;
        groupCount = Object.keys(cfg?.channels?.telegram?.groups || {}).length;
        if (!accountCount && cfg?.channels?.telegram?.botToken) accountCount = 1; // legacy single-token config
        allowFromCount = (cfg?.channels?.telegram?.allowFrom || []).length;
        configAgentCount = (cfg?.agents?.list || []).length;
      } catch (_) {}

      // Agent count (main vs sub) & last activity
      let agentCount = 0, mainAgentCount = 0, subAgentCount = 0;
      let lastActivity = null;
      try {
        // Count main vs sub from config
        if (cfg && cfg.agents && cfg.agents.list && cfg.bindings) {
          const bindings = cfg.bindings || [];
          const accounts = cfg.channels?.telegram?.accounts || {};
          cfg.agents.list.forEach(a => {
            const isMain = a.id === 'main';
            const botBinding = bindings.find(b => b.agentId === a.id && b.match?.accountId && !b.match?.peer);
            if (isMain || botBinding) mainAgentCount++; else subAgentCount++;
          });
        }
      } catch (_) {}
      try {
        const sessionsBase = path.join(OPENCLAW_DIR, 'agents');
        const agentDirs = await fsp.readdir(sessionsBase);
        agentCount = agentDirs.length;
        for (const ad of agentDirs) {
          const sessDir = path.join(sessionsBase, ad, 'sessions');
          try {
            const sessFiles = await fsp.readdir(sessDir);
            for (const sf of sessFiles) {
              if (sf.endsWith('.jsonl')) {
                const st = await fsp.stat(path.join(sessDir, sf));
                if (!lastActivity || st.mtime > lastActivity) lastActivity = st.mtime;
              }
            }
          } catch (_) {}
        }
      } catch (_) {}

      // Brisbane time for display
      const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', hour12: false });

      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        system: { hostname, platform, nodeVer, cpuModel, cpuCores, uptime: sysUptime, totalMem, freeMem, diskTotal, diskUsed, diskFree, dirSize, cpuPercent, loadAvg },
        gateway: { status: gatewayRunning, pid: gatewayPid, port: gatewayPort, host: HOST, accountCount, groupCount, bindingCount, allowFromCount },
        agents: { count: agentCount, configCount: configAgentCount, mainCount: mainAgentCount, subCount: subAgentCount, lastActivity: lastActivity ? lastActivity.toISOString() : null },
        ocmVersion: APP_VERSION,
        serverTime: now,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/gateway/doctor
  if (method === 'POST' && pathname === '/api/gateway/doctor') {
    try {
      const out = await runOpenclawCmd('doctor');
      res.writeHead(200); res.end(JSON.stringify({ ok: true, output: out }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/folder/open
  if (method === 'POST' && pathname === '/api/folder/open') {
    openFolder(OPENCLAW_DIR);
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/cli/stream?cmd=... — SSE 实时流式执行命令
  if (method === 'GET' && pathname === '/api/cli/stream') {
    const qCmd = (new URL('http://x' + req.url)).searchParams.get('cmd') || '';
    if (!qCmd.trim()) { res.writeHead(400); res.end('Missing cmd'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (ev, data) => {
      try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch(_) {}
    };
    send('start', { cmd: qCmd, time: new Date().toLocaleTimeString('zh-CN') });
    const cenv = { ...process.env, NO_COLOR: '1', TERM: 'dumb', FORCE_COLOR: '0' };
    const child = spawn('sh', ['-c', qCmd], { env: cenv, stdio: ['ignore','pipe','pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      send('out', { text: '\n⏱ 命令执行超时（60s），已终止\n' });
    }, 60000);
    child.stdout.on('data', d => send('out', { text: stripAnsi(d.toString()) }));
    child.stderr.on('data', d => send('out', { text: stripAnsi(d.toString()) }));
    child.on('close', code => { clearTimeout(timer); send('done', { code }); try { res.end(); } catch(_) {} });
    child.on('error', err => { clearTimeout(timer); send('error', { message: err.message }); try { res.end(); } catch(_) {} });
    req.on('close', () => { clearTimeout(timer); try { child.kill(); } catch(_) {} });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Unknown API path: ' + pathname }));
}

// ── 安装向导 HTML ──────────────────────────────────────────────
const SETUP_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>OpenClaw Manager - Setup</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{background:#1a1d27;border:1px solid #2d3148;border-radius:16px;padding:40px;width:520px;max-width:95vw;}
  h1{font-size:22px;margin-bottom:8px;color:#6c63ff}
  p{font-size:14px;color:#6b7280;margin-bottom:24px;line-height:1.6}
  label{font-size:13px;font-weight:500;display:block;margin-bottom:6px}
  input{background:#0f1117;border:1px solid #2d3148;color:#e2e8f0;border-radius:6px;padding:10px 12px;font-size:14px;width:100%;margin-bottom:8px}
  input:focus{outline:none;border-color:#6c63ff}
  button{background:#6c63ff;color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:14px;font-weight:500;cursor:pointer;width:100%;margin-top:8px}
  button:hover{background:#7c74ff}
  .err{color:#ef4444;font-size:13px;margin-top:6px;display:none}
  .hint{font-size:12px;color:#6b7280;margin-bottom:16px}
  code{background:#0f1117;padding:2px 6px;border-radius:4px;font-size:12px;color:#a78bfa}
</style></head>
<body><div class="box">
  <h1>🦀 OpenClaw Manager</h1>
  <p>First time setup — please specify your OpenClaw data directory (the folder containing openclaw.json).</p>
  <label>OpenClaw Directory Path</label>
  <input id="dir" type="text" placeholder="e.g. /Users/yourname/.openclaw or ~/.openclaw">
  <div class="hint">Common locations:<br>macOS / Linux: <code>~/.openclaw</code><br>Windows: <code>C:\\Users\\yourname\\.openclaw</code></div>
  <div class="err" id="err"></div>
  <button onclick="save()">Confirm &amp; Enter</button>
</div>
<script>
async function save(){
  const dir=document.getElementById('dir').value.trim();
  const err=document.getElementById('err');
  if(!dir){err.textContent='Please enter a directory path';err.style.display='block';return;}
  try{
    const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir})});
    const d=await r.json();
    if(d.ok){location.reload();}else{err.textContent=d.error||'Invalid path';err.style.display='block';}
  }catch(e){err.textContent='Request failed: '+e.message;err.style.display='block';}
}
document.getElementById('dir').addEventListener('keydown',e=>{if(e.key==='Enter')save();});
</script></body></html>`;

// ── 主 HTML 前端 ──────────────────────────────────────────────
const MAIN_HTML_CSS = String.raw`*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f1117; --surface: #1a1d27; --border: #2d3148;
  --accent: #6c63ff; --accent-h: #7c74ff;
  --danger: #ef4444; --success: #22c55e; --warn: #f59e0b;
  --text: #e2e8f0; --muted: #6b7280; --card: #1e2235;
}
body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; min-height:100vh; }


/* ── Toolbar ── */
header { background:var(--surface); border-bottom:1px solid var(--border); padding:0 20px; display:flex; align-items:center; gap:12px; height:52px; position:sticky; top:0; z-index:50; }
.logo { font-size:17px; font-weight:700; color:var(--accent); cursor:pointer; }
.logo:hover { opacity:.8; }
.ver  { font-size:11px; color:var(--muted); background:var(--border); padding:2px 8px; border-radius:20px; }
.spacer { flex:1; }
.status-row { display:flex; align-items:center; gap:6px; }
.dot { width:7px; height:7px; border-radius:50%; background:var(--muted); }
.dot.ok { background:var(--success); box-shadow:0 0 5px var(--success); }
.dot.err{ background:var(--danger);  box-shadow:0 0 5px var(--danger); }
.status-txt { font-size:12px; color:var(--muted); }
.lang-toggle { background:var(--border); border:none; color:var(--muted); border-radius:6px; padding:5px 10px; font-size:12px; cursor:pointer; }
.lang-toggle:hover { background:#3a3f5c; color:var(--text); }

/* centered version badge */
.top-version{ position:absolute; left:50%; transform:translateX(-50%); font-size:12px; font-weight:800; letter-spacing:.3px; color:var(--text); background:rgba(108,99,255,.18); border:1px solid rgba(108,99,255,.45); padding:4px 12px; border-radius:999px; box-shadow:0 6px 18px rgba(0,0,0,.25); }
.ver-old{ display:none; }

/* dropdown menu */
.menu-wrap { position:relative; }
.menu-btn { background:var(--border); border:none; color:var(--text); border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px; }
.menu-btn:hover { background:#3a3f5c; }
.menu-dropdown { position:absolute; right:0; top:calc(100% + 6px); background:var(--surface); border:1px solid var(--border); border-radius:10px; min-width:220px; z-index:200; box-shadow:0 8px 24px rgba(0,0,0,.4); overflow:hidden; display:none; }
.menu-dropdown.open { display:block; }
.menu-item { padding:10px 16px; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:10px; transition:background .1s; }
.menu-item:hover { background:var(--border); }
.menu-sep { border-top:1px solid var(--border); margin:4px 0; }

/* ── Tabs ── */
nav { background:var(--surface); border-bottom:1px solid var(--border); display:flex; padding:0 20px; gap:2px; overflow-x:auto; }
.tab { padding:11px 16px; font-size:13px; cursor:pointer; border-bottom:2px solid transparent; color:var(--muted); transition:all .15s; white-space:nowrap; }
.tab:hover { color:var(--text); }
.tab.active { color:var(--accent); border-bottom-color:var(--accent); }

/* ── Main ── */
main { padding:20px; max-width:1280px; margin:0 auto; }
.panel { display:none; }
.panel.active { display:block; }
.sec-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.sec-hdr h2 { font-size:16px; font-weight:600; }

/* ── Cards ── */
.card-grid { display:grid; gap:12px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; }
.card-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.card-title { font-size:14px; font-weight:600; }
.badge { font-size:11px; padding:2px 8px; border-radius:20px; background:var(--border); color:var(--muted); }
.badge.main { background:rgba(108,99,255,.2); color:var(--accent); }
.badge.ok   { background:rgba(34,197,94,.15); color:var(--success); }
.badge.warn { background:rgba(245,158,11,.15); color:var(--warn); }
.card-meta { font-size:12px; color:var(--muted); margin-top:4px; }
.card-actions { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }

/* inline model selector */
.inline-sel { background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:5px 8px; font-size:12px; }
.inline-sel:focus { outline:none; border-color:var(--accent); }

/* Agents layout — buttons top, tree below */
.agents-top-btns { display:flex; gap:10px; justify-content:center; margin-bottom:18px; }
.agents-tree-wrap { max-width:900px; margin:0 auto; overflow-y:auto; }
.agents-roots { display:flex; gap:16px; flex-wrap:wrap; }
.agents-roots > .agent-tree-root { flex:1; min-width:320px; }

/* Add form */
.add-form { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:16px; }
.add-form h3 { font-size:15px; margin-bottom:12px; font-weight:600; }
.add-form .guide-box { background:rgba(108,99,255,.06); border:1px solid rgba(108,99,255,.2); border-radius:8px; padding:12px; margin-bottom:14px; font-size:12px; line-height:1.8; color:var(--muted); }
.add-form .guide-box summary { cursor:pointer; font-weight:600; color:var(--text); font-size:13px; margin-bottom:6px; }
.add-form .guide-box ol { margin:6px 0 0 18px; padding:0; }
.add-form .guide-box li { margin-bottom:4px; }
.add-form .guide-box code { background:rgba(255,255,255,.08); padding:1px 5px; border-radius:3px; font-size:11px; }

/* Agent tree */
.agent-tree-root { margin-bottom:16px; }
.agent-tree-root .tree-main { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; cursor:pointer; }
.agent-tree-root .tree-main:hover { border-color:var(--accent); }
.agent-tree-root .tree-main .tree-title { font-size:14px; font-weight:600; display:flex; align-items:center; gap:8px; }
.agent-tree-root .tree-main .tree-meta { font-size:11px; color:var(--muted); margin-top:4px; }
.tree-children-wrap { position:relative; margin-left:20px; padding-left:14px; margin-top:6px; }
.tree-children-wrap::before { content:''; position:absolute; left:0; top:0; bottom:8px; width:2px; background:var(--border); }
.tree-toggle { position:absolute; left:-8px; top:-4px; width:18px; height:18px; border-radius:50%; background:var(--surface); border:1.5px solid var(--border); color:var(--muted); font-size:12px; line-height:15px; text-align:center; cursor:pointer; z-index:2; padding:0; }
.tree-toggle:hover { border-color:var(--accent); color:var(--accent); }
.tree-children { }
.tree-children.collapsed { display:none; }
.tree-child { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
.tree-child:hover { border-color:var(--accent); }
.tree-child .tree-title { font-size:13px; font-weight:600; display:flex; align-items:center; gap:6px; }
.tree-child .tree-meta { font-size:11px; color:var(--muted); margin-top:3px; }
.tree-actions { display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap; }
.tree-actions select { font-size:12px; padding:4px 8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); }
.tree-actions button { font-size:11px; padding:4px 10px; }

/* ── Buttons ── */
button { cursor:pointer; font-size:13px; font-weight:500; border:none; border-radius:6px; padding:6px 13px; transition:all .15s; }
.btn-primary  { background:var(--accent); color:#fff; }
.btn-primary:hover { background:var(--accent-h); }
.btn-danger   { background:rgba(239,68,68,.12); color:var(--danger); border:1px solid rgba(239,68,68,.3); }
.btn-danger:hover { background:rgba(239,68,68,.22); }
.btn-secondary{ background:var(--border); color:var(--text); }
.btn-secondary:hover { background:#3a3f5c; }
.btn-ghost    { background:transparent; color:var(--muted); border:1px solid var(--border); }
.btn-ghost:hover { background:var(--surface); color:var(--text); }
.btn-warn     { background:rgba(245,158,11,.12); color:var(--warn); border:1px solid rgba(245,158,11,.3); }
.btn-warn:hover { background:rgba(245,158,11,.22); }
.btn-success  { background:rgba(34,197,94,.12); color:var(--success); border:1px solid rgba(34,197,94,.3); }
.btn-success:hover { background:rgba(34,197,94,.22); }
button:disabled { opacity:.4; cursor:not-allowed; }

/* ── Forms ── */
.form-group { display:flex; flex-direction:column; gap:5px; margin-bottom:14px; }
label { font-size:13px; font-weight:500; }
.hint-text { font-size:11px; color:var(--muted); }
input,select,textarea { background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px 11px; font-size:13px; width:100%; transition:border-color .15s; }
input:focus,select:focus,textarea:focus { outline:none; border-color:var(--accent); }
input::placeholder,textarea::placeholder { color:var(--muted); }
textarea { resize:vertical; min-height:72px; }
select option { background:var(--surface); }
.form-row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.field-err { font-size:11px; color:var(--danger); }
.input-pw-wrap { position:relative; }
.input-pw-wrap input { padding-right:36px; }
.pw-toggle { position:absolute; right:10px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--muted); cursor:pointer; font-size:14px; padding:0; }

/* ── Dashboard ── */
.dash-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
.dash-header h2 { font-size:18px; font-weight:600; color:var(--text); margin:0; }
.dash-auto-refresh { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); }
.dash-auto-refresh label { cursor:pointer; display:flex; align-items:center; gap:6px; }
.dash-toggle { position:relative; width:36px; height:20px; }
.dash-toggle input { opacity:0; width:0; height:0; }
.dash-toggle .slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:var(--border); border-radius:10px; transition:.3s; }
.dash-toggle .slider:before { position:absolute; content:""; height:14px; width:14px; left:3px; bottom:3px; background:#999; border-radius:50%; transition:.3s; }
.dash-toggle input:checked + .slider { background:var(--accent); }
.dash-toggle input:checked + .slider:before { transform:translateX(16px); background:#fff; }
.dash-gauges { display:flex; gap:20px; justify-content:center; flex-wrap:wrap; margin-bottom:24px; }
.dash-gauge-card { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:20px 24px; display:flex; flex-direction:column; align-items:center; min-width:140px; }
.dash-gauge-svg { width:110px; height:110px; }
.dash-gauge-label { font-size:12px; color:var(--muted); margin-top:8px; font-weight:500; }
.dash-sections { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
.dash-card { padding:20px; }
.dash-card-wide { grid-column:span 2; }
.dash-card h3 { font-size:14px; font-weight:600; margin-bottom:14px; color:var(--text); }
.dash-notice { margin-top:18px; padding:16px 18px; }
.dash-notice h3 { font-size:14px; margin-bottom:10px; }
.dash-note-list { margin-left:16px; color:var(--muted); font-size:12px; line-height:1.7; }
.dash-note-list li { margin-bottom:4px; }
.dash-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:12px; }
.dash-row:last-child { border-bottom:none; }
.dash-label { color:var(--muted); }
.dash-val { color:var(--text); font-weight:500; font-family:monospace; font-size:11px; }
.dash-indicator { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
.dash-indicator.running { background:#22c55e; box-shadow:0 0 6px rgba(34,197,94,.5); }
.dash-indicator.stopped { background:#ef4444; box-shadow:0 0 6px rgba(239,68,68,.5); }
.dash-indicator.unknown { background:#f59e0b; }
@media (max-width: 980px) {
  .dash-card-wide { grid-column:span 1; }
}

/* ── Modal ── */
.backdrop { position:fixed; inset:0; background:rgba(0,0,0,.72); z-index:100; display:none; align-items:center; justify-content:center; }
.backdrop.open { display:flex; }
.modal { background:var(--surface); border:1px solid var(--border); border-radius:14px; width:580px; max-width:95vw; max-height:90vh; overflow-y:auto; }
.modal.wide { width:740px; }
.m-hdr { padding:18px 22px 0; display:flex; align-items:center; justify-content:space-between; }
.m-hdr h3 { font-size:15px; font-weight:600; }
.m-close { background:transparent; border:none; color:var(--muted); font-size:18px; cursor:pointer; padding:4px; line-height:1; }
.m-close:hover { color:var(--text); }
.m-body { padding:18px 22px; }
.m-foot { padding:0 22px 18px; display:flex; gap:8px; justify-content:flex-end; }

/* ── Steps ── */
.steps { display:flex; margin-bottom:20px; }
.step { flex:1; text-align:center; padding:7px 3px; font-size:11px; color:var(--muted); border-bottom:2px solid var(--border); }
.step.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:600; }
.step.done   { color:var(--success); border-bottom-color:var(--success); }
.step-page { display:none; }
.step-page.active { display:block; }

/* ── Log viewer ── */
.log-box { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; font-family:monospace; font-size:11px; line-height:1.5; max-height:380px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; color:#94a3b8; }

/* ── Misc ── */
.notes { background:rgba(108,99,255,.07); border:1px solid rgba(108,99,255,.2); border-radius:8px; padding:12px 14px; font-size:13px; line-height:1.7; }
.notes li { margin-left:16px; }
.notes code { font-size:11px; background:rgba(0,0,0,.3); padding:1px 5px; border-radius:3px; }
.warn-box { background:rgba(245,158,11,.07); border:1px solid rgba(245,158,11,.25); border-radius:8px; padding:12px 14px; font-size:13px; color:var(--warn); }
.success-box { background:rgba(34,197,94,.07); border:1px solid rgba(34,197,94,.25); border-radius:8px; padding:12px 14px; font-size:13px; color:var(--success); }
.empty { text-align:center; color:var(--muted); padding:40px 0; font-size:14px; }
.tag { font-size:11px; padding:3px 9px; border-radius:20px; background:var(--border); color:var(--muted); display:inline-block; }
.tag-row { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.tag-del { cursor:pointer; margin-left:4px; opacity:.6; }
.tag-del:hover { opacity:1; color:var(--danger); }
hr { border:none; border-top:1px solid var(--border); margin:14px 0; }
code { font-size:12px; background:rgba(0,0,0,.3); padding:2px 6px; border-radius:4px; color:#a78bfa; }

/* Restart Banner */
.restart-banner { display:none; background:rgba(245,158,11,.1); border:1px solid rgba(245,158,11,.3); border-radius:8px; padding:10px 16px; margin-bottom:16px; font-size:13px; color:var(--warn); align-items:center; gap:10px; flex-wrap:wrap; }
.restart-banner.show { display:flex; }

/* Floating Restart Button */
#pendingRestartBtn { display:none; position:fixed; bottom:24px; left:24px; z-index:400; }
#pendingRestartBtn button { padding:10px 20px; font-size:13px; border-radius:22px; box-shadow:0 4px 16px rgba(245,158,11,.45); }

/* Auth page */
.auth-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px; margin-bottom:12px; }
.auth-prov-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; margin-bottom:16px; }
.auth-prov-btn { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:12px 14px; cursor:pointer; text-align:left; transition:all .15s; }
.auth-prov-btn:hover { border-color:var(--accent); background:rgba(108,99,255,.06); }
.auth-prov-btn.selected { border-color:var(--accent); background:rgba(108,99,255,.1); }
.auth-prov-btn.configured { border-color:var(--success); }
.auth-prov-btn.configured .apb-name { color:var(--success); }
.auth-prov-btn .apb-name { font-size:13px; font-weight:600; margin-bottom:2px; }
.auth-prov-btn .apb-mode { font-size:11px; color:var(--muted); }
.copy-cmd-btn { background:var(--border); border:none; color:var(--text); border-radius:5px; padding:4px 10px; font-size:11px; cursor:pointer; margin-left:8px; }
.copy-cmd-btn:hover { background:#3a3f5c; }

/* Channels */
.ch-badge { font-size:11px; padding:2px 7px; border-radius:12px; }
.ch-tg  { background:rgba(51,144,236,.15); color:#33a0ec; }
.ch-any { background:var(--border); color:var(--muted); }
.channels-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.channels-filter-label { font-size:12px; color:var(--muted); }
.channels-filter { min-width:180px; max-width:260px; font-size:12px; padding:6px 10px; }
.routing-group { background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.routing-group-hdr { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; background:rgba(255,255,255,.02); border-bottom:1px solid var(--border); }
.routing-group-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
.routing-group-name { font-size:13px; font-weight:600; color:var(--text); }
.routing-group-count { font-size:11px; color:var(--muted); }
.routing-toggle { font-size:11px; padding:4px 10px; }
.routing-list { display:flex; flex-direction:column; }
.routing-list.collapsed { display:none; }
.routing-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border-bottom:1px solid var(--border); }
.routing-row:last-child { border-bottom:none; }
.routing-row-main { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px; min-width:0; }
.routing-row-sub { font-size:11px; color:var(--muted); }

/* NAS backup */
.nas-step { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:12px; }
.nas-step-title { font-size:13px; font-weight:600; margin-bottom:10px; color:var(--accent); }

/* ── CLI 终端面板 ── */
#cliPanel { position:fixed; bottom:0; left:0; right:0; z-index:90; background:var(--surface); border-top:2px solid var(--border); display:none; flex-direction:column; box-shadow:0 -4px 24px rgba(0,0,0,.35); }
#cliPanel.open { display:flex; }
.cli-hdr { display:flex; align-items:center; gap:8px; padding:6px 14px; cursor:pointer; border-bottom:1px solid var(--border); user-select:none; background:var(--bg); }
.cli-hdr-title { font-size:13px; font-weight:600; flex:1; color:var(--text); }
.cli-hdr-actions { display:flex; gap:6px; }
.cli-output { font-family:'SF Mono',Menlo,Consolas,monospace; font-size:12px; line-height:1.65; background:#0d1117; color:#c9d1d9; padding:10px 14px; height:220px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; }
.cli-output .cli-cmd-line  { color:#58a6ff; font-weight:600; }
.cli-output .cli-done-ok   { color:#3fb950; }
.cli-output .cli-done-err  { color:#f85149; }
.cli-input-row { display:flex; gap:6px; padding:7px 10px; align-items:center; background:var(--surface); }
.cli-input-row select { font-size:12px; padding:5px 8px; max-width:190px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); }
.cli-input-row input  { flex:1; font-family:'SF Mono',Menlo,Consolas,monospace; font-size:12px; background:var(--bg); }
.cli-resize-handle { height:4px; background:var(--border); cursor:ns-resize; }
/* Health / security badge */
#healthBadge { display:none; align-items:center; gap:5px; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:600; cursor:default; position:relative; }
#healthBadge.warn  { background:rgba(234,179,8,.15); border:1px solid rgba(234,179,8,.4); color:#eab308; }
#healthBadge.error { background:rgba(248,81,73,.15); border:1px solid rgba(248,81,73,.4); color:#f85149; }
#healthBadge.ok    { background:rgba(63,185,80,.1);  border:1px solid rgba(63,185,80,.3);  color:#3fb950; display:flex; }
.health-tooltip { display:none; position:absolute; top:calc(100% + 8px); right:0; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; min-width:320px; max-width:480px; z-index:300; box-shadow:0 8px 24px rgba(0,0,0,.5); font-size:12px; line-height:1.7; white-space:pre-wrap; word-break:break-word; color:var(--text); }
#healthBadge:hover .health-tooltip { display:block; }

/* CLI nav tab button */
.cli-nav-btn { margin-left:auto; padding:6px 16px; font-size:12px; font-weight:600; background:rgba(108,99,255,.15); border:1px solid rgba(108,99,255,.4); color:var(--accent); border-radius:6px; cursor:pointer; white-space:nowrap; transition:all .15s; }
.cli-nav-btn:hover,.cli-nav-btn.active { background:rgba(108,99,255,.32); border-color:var(--accent); }
/* Stop button */
.btn-stop { background:rgba(248,81,73,.15); border:1px solid rgba(248,81,73,.4); color:#f85149; border-radius:6px; padding:6px 12px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; }
.btn-stop:hover { background:rgba(248,81,73,.3); }
/* Manage favs modal list */
.fav-manage-row { display:flex; align-items:center; gap:6px; padding:7px 0; border-bottom:1px solid var(--border); }
.fav-manage-label { flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fav-manage-cmd { font-size:11px; color:var(--muted); font-family:monospace; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }`;

const MAIN_HTML_BODY = String.raw`
<!-- ═══════════════════════════════════════════════════════════ -->
<!-- MAIN APP -->
<!-- ═══════════════════════════════════════════════════════════ -->
<div id="mainApp">

<!-- Header / Toolbar -->
<header>
  <span class="logo" title="OpenClaw Manager">🦀 OpenClaw</span>
  <div class="top-version" id="topVersion">v--</div>
  <span class="ver" id="versionBadge">v--</span>
  <span class="ver ver-old" id="ocmVersionBadge">ocm v--</span>
  <div class="spacer"></div>
  <div id="healthBadge" title="">
    <span id="healthIcon">⚠️</span>
    <span id="healthCount"></span>
    <div class="health-tooltip" id="healthTooltip"></div>
  </div>
  <div class="status-row">
    <div class="dot" id="dot"></div>
    <span class="status-txt" id="statusTxt"></span>
  </div>
  <button class="lang-toggle" onclick="toggleLang()" id="langToggleBtn">EN</button>
  <div class="menu-wrap">
    <button class="menu-btn" onclick="toggleMenu()">⚡ <span data-i18n="menu.ops">操作</span> ▾</button>
    <div class="menu-dropdown" id="mainMenu">
      <div class="menu-item" onclick="doRestart()">🔄 <span data-i18n="menu.restart">重启 Gateway</span></div>
      <div class="menu-item" onclick="openLogs()">📋 <span data-i18n="menu.logs">实时日志</span></div>
      <div class="menu-sep"></div>
      <div class="menu-item" onclick="manualBackup()">💾 <span data-i18n="menu.backup">手动备份配置</span></div>
      <div class="menu-item" onclick="openRollback()">📦 <span data-i18n="menu.rollback">查看备份 / 回滚</span></div>
      <div class="menu-item" onclick="openNasModal()">🌐 <span data-i18n="menu.nas">NAS 备份设置</span></div>
      <div class="menu-sep"></div>
      <div class="menu-item" onclick="doDoctor()">🏥 <span data-i18n="menu.doctor">健康检查</span></div>
      <div class="menu-item" onclick="openConfigDir()">📂 <span data-i18n="menu.opendir">打开配置目录</span></div>
      <div class="menu-sep"></div>
      <div class="menu-item" onclick="openSetupModal()">⚙️ <span data-i18n="menu.switchdir">切换 OpenClaw 目录</span></div>
    </div>
  </div>
</header>

<!-- Tabs -->
<nav>
  <div class="tab active" data-tab="dashboard"><span data-i18n="tab.dashboard">🏠 Dashboard</span></div>
  <div class="tab" data-tab="agents"><span data-i18n="tab.agents">🤖 Agents</span></div>
  <div class="tab" data-tab="channels"><span data-i18n="tab.channels">🧭 Routing</span></div>
  <div class="tab" data-tab="models"><span data-i18n="tab.models">🧠 模型与认证</span></div>
  <div class="tab" data-tab="stats"><span data-i18n="tab.stats">📊 Stats</span></div>
  <div class="tab" data-tab="cron"><span data-i18n="tab.cron">⏰ Cron</span></div>
  <button class="cli-nav-btn" id="cliToggleBtn" onclick="toggleCliPanel()"><span data-i18n="cli.open">⌨️ 终端</span></button>
</nav>

<main>
  <!-- 重启提示横幅 -->
  <div class="restart-banner" id="restartBanner">
    ⚠️ <span data-i18n="banner.modified">配置已修改，建议重启 Gateway 以确保生效。</span>
    <button class="btn-warn" onclick="doRestart()" style="margin-left:auto" data-i18n="banner.restart">立即重启</button>
    <button class="btn-ghost" onclick="deferRestart()" style="font-size:11px" data-i18n="banner.later">稍后</button>
    <button class="btn-ghost" onclick="dismissBanner()" style="font-size:11px" data-i18n="banner.dismiss">忽略</button>
  </div>

  <!-- ══ Dashboard ════════════════════════════════════════════ -->
  <div class="panel active" id="panel-dashboard">
    <div class="dash-header">
      <h2>Dashboard</h2>
      <div class="dash-auto-refresh">
        <label class="dash-toggle"><input type="checkbox" id="dashAutoRefresh" onchange="toggleDashRefresh(this.checked)"><span class="slider"></span></label>
        <span>Auto-refresh</span>
      </div>
    </div>
    <div class="dash-gauges" id="dashGauges"><div class="empty">Loading...</div></div>
    <div class="card dash-notice">
      <h3 data-i18n="dash.firstRunTitle">🚀 First-run checklist</h3>
      <ul class="dash-note-list">
        <li data-i18n="dash.firstRun1">Confirm OCM is pointed at the correct OpenClaw directory.</li>
        <li data-i18n="dash.firstRun2">Check this Dashboard first: make sure Gateway is running and the system looks healthy.</li>
        <li data-i18n="dash.firstRun3">Open Agents / Routing and confirm the bindings you expect are actually there.</li>
        <li data-i18n="dash.firstRun4">Use the built-in Terminal to run <code>openclaw doctor</code> once so you catch environment/auth issues early.</li>
        <li data-i18n="dash.firstRun5">Before bigger edits, make a backup or check rollback so recovery is nearby if something goes wrong.</li>
      </ul>
    </div>
    <div class="dash-sections">
      <div class="card dash-card" id="dashSystem">
        <h3>🖥️ System Info</h3>
        <div class="dash-items" id="dashSysItems"><div class="empty">Loading...</div></div>
      </div>
      <div class="card dash-card dash-card-wide" id="dashAgents">
        <h3>🤖 Agents</h3>
        <div class="dash-items" id="dashAgentItems"><div class="empty">Loading...</div></div>
      </div>
      <div class="card dash-card dash-card-wide" id="dashGateway">
        <h3>🦀 Gateway</h3>
        <div class="dash-items" id="dashGwItems"><div class="empty">Loading...</div></div>
      </div>
      <div class="card dash-card" id="dashStorage">
        <h3>💾 Storage</h3>
        <div class="dash-items" id="dashStorageItems"><div class="empty">Loading...</div></div>
      </div>
    </div>
    <div class="card dash-notice">
      <h3 data-i18n="dash.noticeTitle">📌 Telegram 使用说明（重要）</h3>
      <ul class="dash-note-list">
        <li data-i18n="dash.notice1">OCM 主要面向 Telegram 场景：通过群组绑定 Agent，让每个 Agent 拥有独立 Workspace / SOUL.md / MEMORY.md。</li>
        <li data-i18n="dash.notice2">使用前请确保你已具备基本 OpenClaw 操作经验；OCM 主要负责可视化更新 openclaw.json，方便增删主 Agent 与 Sub-Agent，并支持多条 Agent 树。</li>
        <li data-i18n="dash.notice3">BotFather 中请确认 Allow Groups = ON 且 Group Privacy = OFF，否则 Sub-Agent 可能无法入组或无法响应。</li>
      </ul>
      <div class="warn-box" style="margin-top:10px" data-i18n="dash.noticeWarn">⚠️ 强烈建议：每个 Agent 群组只保留你自己和该 Agent（或其 Sub-Agent）。不要邀请其他人，把每个组当作私聊空间。</div>
    </div>
  </div>

  <!-- ══ Agents ════════════════════════════════════════════════ -->
  <div class="panel" id="panel-agents">
    <div class="agents-top-btns">
      <button class="btn-primary" onclick="showAddForm('agent')" data-i18n="agents.addAgent">＋ Add Agent</button>
      <button class="btn-primary" onclick="showAddForm('sub')" data-i18n="agents.addSub">＋ Add Sub-Agent</button>
    </div>
    <div id="addFormArea"></div>
    <p class="hint-text" style="margin:10px 0 14px" data-i18n="agents.hint">
      <b>Add Agent</b>: create a top-level agent (a long-lived role). Use this for a new domain like ops/travel/finance, or when you want fully isolated workflows.
      <br><b>Add Sub-Agent</b>: create a child agent under a parent. Sub-agents use the parent agent’s Telegram bot, but each sub-agent has its own workspace, SOUL.md (persona), and MEMORY.md (memory) — preventing context mixing, improving focus, and saving tokens.
    </p>
    <div class="agents-tree-wrap">
      <div id="agentTree"><div class="empty" data-i18n="agents.empty">No Agents</div></div>
    </div>
  </div>

  <!-- ══ Channels ══════════════════════════════════════════════ -->
  <div class="panel" id="panel-channels">
    <div class="sec-hdr">
      <h2 data-i18n="channels.title">Routing Bindings</h2>
      <div class="channels-toolbar">
        <span class="channels-filter-label" data-i18n="channels.filterLabel">Agent</span>
        <select id="channelsAgentFilter" class="channels-filter" onchange="onChannelFilterChange(this.value)"></select>
        <button class="btn-primary" onclick="openAddChannel()" data-i18n="channels.add">＋ Add Binding</button>
      </div>
    </div>
    <p class="hint-text" style="margin-bottom:14px" data-i18n="channels.hint">Advanced routing rules for agent-channel/group bindings and priority order. Use Agents page for daily add/remove workflows.</p>
    <p class="hint-text" style="margin-top:-8px;margin-bottom:14px" data-i18n="channels.removeHint">When to use <b>Remove binding</b>: if you bound the wrong agent/chat, the group was recreated/migrated (new peer id), you have duplicates/conflicts, you want to decommission a project sub-agent, or you need to temporarily disconnect routing for safety.</p>
    <div class="card-grid" id="channelList"><div class="empty">加载中...</div></div>
  </div>

  <!-- ══ 模型 ════════════════════════════════════════════════ -->
  <div class="panel" id="panel-models">
    <div class="sec-hdr"><h2 data-i18n="models.title">模型管理</h2></div>
    <p class="hint-text" style="margin-bottom:14px" data-i18n="models.hint">模型由 openclaw onboard 注册，此处管理主模型和 Fallback 链。</p>
    <p class="hint-text" style="margin-top:-8px;margin-bottom:12px" data-i18n="models.onlyCliHint">模型下拉仅显示 openclaw models list 返回的模型。</p>
    <div id="modelListWarn" class="warn-box" style="display:none;margin-bottom:10px"></div>
    <div id="primaryModelWarn" class="warn-box" style="display:none;margin-bottom:10px"></div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-row"><span style="font-size:13px;font-weight:600" data-i18n="models.primary">默认主模型</span><span class="badge main">primary</span></div>
      <div class="card-actions" style="margin-top:10px">
        <select id="primaryModelSel" class="inline-sel" style="flex:1;font-size:13px;padding:7px 10px"></select>
        <input id="primaryModelCustom" type="text" placeholder="或直接输入 provider/model-id（如：anthropic/claude-sonnet-4-5）" style="flex:1;font-size:13px">
        <button class="btn-primary" onclick="savePrimaryModel()" data-i18n="btn.save">保存</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-row" style="justify-content:space-between">
        <span style="font-size:13px;font-weight:600" data-i18n="models.fallback">Fallback 链</span>
        <button class="btn-secondary" style="font-size:12px" onclick="openAddFallback()">＋ 添加</button>
      </div>
      <div id="fallbackList" class="tag-row" style="margin-top:10px"></div>
    </div>
    <hr>
    <div class="sec-hdr"><h2 style="font-size:14px" data-i18n="auth.title">认证配置</h2></div>
    <p class="hint-text" style="margin-bottom:14px" data-i18n="auth.guide">点击 Provider 查看认证步骤。认证需在终端完成，或使用下方 CLI 终端。</p>
    <div class="auth-prov-grid" id="authProvGrid" style="margin-bottom:16px"></div>
    <div class="card" id="authActionCard" style="display:none;margin-bottom:16px">
      <div id="authActionContent"></div>
    </div>
    <div class="sec-hdr"><h2 style="font-size:14px" data-i18n="auth.configured">已配置认证</h2></div>
    <div class="card-grid" id="authList"><div class="empty">加载中...</div></div>
  </div>

  <!-- ══ Stats ════════════════════════════════════════════════ -->
  <div class="panel" id="panel-stats">
    <div class="sec-hdr">
      <h2 data-i18n="stats.title">使用统计</h2>
      <select id="statsDaysFilter" onchange="loadStats()" style="padding:6px 10px;font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text)">
        <option value="1" selected>1 day</option>
        <option value="7">7 days</option>
        <option value="30">30 days</option>
        <option value="90">90 days</option>
      </select>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px">
      <div class="card" style="padding:16px"><div style="font-size:12px;color:var(--muted)" data-i18n="stats.input">Input Tokens</div><div style="font-size:22px;font-weight:700;margin-top:8px" id="statsTotalInput">--</div></div>
      <div class="card" style="padding:16px"><div style="font-size:12px;color:var(--muted)" data-i18n="stats.output">Output Tokens</div><div style="font-size:22px;font-weight:700;margin-top:8px" id="statsTotalOutput">--</div></div>
      <div class="card" style="padding:16px"><div style="font-size:12px;color:var(--muted)">Cache Read</div><div style="font-size:22px;font-weight:700;margin-top:8px" id="statsCacheRead">--</div></div>
      <div class="card" style="padding:16px"><div style="font-size:12px;color:var(--muted)" data-i18n="stats.cost">Estimated Cost</div><div style="font-size:22px;font-weight:700;margin-top:8px;color:var(--accent)" id="statsTotalCost">--</div></div>
      <div class="card" style="padding:16px"><div style="font-size:12px;color:var(--muted)" data-i18n="stats.requests">Requests</div><div style="font-size:22px;font-weight:700;margin-top:8px" id="statsTotalReqs">--</div></div>
    </div>
    <h3 style="margin:16px 0 10px;font-size:14px;font-weight:600" data-i18n="stats.byDay">By Day</h3>
    <div class="card" style="padding:16px;margin-bottom:16px"><div id="statsChart" style="display:flex;align-items:flex-end;gap:2px;height:100px;overflow-x:auto"></div></div>
    <h3 style="margin:16px 0 10px;font-size:14px;font-weight:600" data-i18n="stats.byModel">By Model</h3>
    <div class="card-grid" id="statsByModel"><div class="empty" data-i18n="stats.noData">No data</div></div>
    <h3 style="margin:16px 0 10px;font-size:14px;font-weight:600">By Agent</h3>
    <div class="card-grid" id="statsByAgent"><div class="empty">No data</div></div>
  </div>

  <!-- ══ Cron ═════════════════════════════════════════════════ -->
  <div class="panel" id="panel-cron">
    <div class="sec-hdr">
      <h2 data-i18n="cron.title">计划任务</h2>
      <button class="btn-primary" onclick="openAddCron()" data-i18n="cron.add">＋ 添加任务</button>
    </div>
    <p class="hint-text" style="margin-bottom:14px" data-i18n="cron.hint">管理与 OpenClaw 相关的 crontab 计划任务。</p>
    <div class="card-grid" id="cronList"><div class="empty">加载中...</div></div>
  </div>

</main>

<!-- Floating Restart Button -->
<div id="pendingRestartBtn">
  <button class="btn-warn" onclick="doRestart()">🔄 <span data-i18n="floating.restart">重启 Gateway</span></button>
</div>

<!-- ══ CLI 终端面板 ════════════════════════════════════════════ -->
<div id="cliPanel">
  <div class="cli-resize-handle" id="cliResizeHandle"></div>
  <div class="cli-hdr" onclick="toggleCliPanel()">
    <span class="cli-hdr-title" data-i18n="cli.title">⌨️ CLI 终端</span>
    <div class="cli-hdr-actions" onclick="event.stopPropagation()">
      <select id="cliPreset" onchange="onCliPresetSelect()" style="font-size:11px;padding:3px 6px;max-width:180px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text)">
        <option value="" data-i18n="cli.presets">── 常用命令 ──</option>
      </select>
      <button class="btn-secondary" style="font-size:11px;padding:3px 10px" onclick="copyCliCommand()" data-i18n="cli.copy">复制命令</button>
      <button class="btn-secondary" style="font-size:11px;padding:3px 10px" onclick="clearCliOutput()" data-i18n="cli.clear">清空</button>
      <button class="btn-secondary" style="font-size:11px;padding:3px 10px" onclick="toggleCliPanel()" data-i18n="cli.collapse">▼ 收起</button>
    </div>
  </div>
  <div class="cli-output" id="cliOutput"><span style="color:#555" id="cliReadyMsg">── 终端就绪，等待命令 ──</span></div>
  <div class="cli-input-row">
    <input id="cliInput" type="text" placeholder="输入命令（如 openclaw doctor）"
           onkeydown="onCliKey(event)" autocomplete="off" spellcheck="false">
    <button class="btn-primary" style="white-space:nowrap;font-size:12px;padding:7px 14px" onclick="runCli()" data-i18n="cli.run">▶ 执行</button>
    <button class="btn-stop" id="cliStopBtn" style="display:none" onclick="killCli()" data-i18n="cli.stop">■ 停止</button>
    <button class="btn-secondary" style="font-size:12px;padding:7px 10px" onclick="addCliToFavorites()" title="⭐" data-i18n="cli.star">⭐</button>
    <button class="btn-secondary" style="font-size:12px;padding:7px 10px" onclick="openCliManage()" data-i18n="cli.manage">管理</button>
  </div>
</div>

</div><!-- end mainApp -->

<!-- ══ CLI 管理收藏弹窗 ═══════════════════════════════════════ -->
<div class="backdrop" id="cliManageModal">
<div class="modal" style="max-width:480px">
  <div class="m-hdr"><h3 data-i18n="cli.manage.title">管理收藏命令</h3><button class="m-close" onclick="closeModal('cliManageModal')">✕</button></div>
  <div class="m-body">
    <div id="cliManageList" style="max-height:360px;overflow-y:auto;padding-bottom:8px"></div>
  </div>
</div>
</div>

<!-- ══ 添加 Channel 绑定 ══════════════════════════════════════ -->
<div class="backdrop" id="addChannelModal">
<div class="modal">
  <div class="m-hdr"><h3 data-i18n="ch.title">添加 Channel 绑定</h3><button class="m-close" onclick="closeModal('addChannelModal')">✕</button></div>
  <div class="m-body">
    <div class="form-group">
      <label data-i18n="ch.agent">Agent</label>
      <select id="ch-agent"></select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label data-i18n="ch.channelType">频道类型</label>
        <select id="ch-channel">
          <option value="telegram" data-i18n="ch.telegram">Telegram</option>
          <option value="" data-i18n="ch.anyChannel">任意（不限频道）</option>
        </select>
      </div>
      <div class="form-group">
        <label data-i18n="ch.peerKind">Peer 类型</label>
        <select id="ch-peerKind">
          <option value="group" data-i18n="ch.group">群组 (group)</option>
          <option value="private" data-i18n="ch.private">私聊 (private)</option>
          <option value="" data-i18n="ch.any">任意</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label><span data-i18n="ch.peerId">Peer ID</span> <span style="color:var(--muted);font-weight:400" data-i18n="ch.peerIdHint">（群组 ID 或用户 ID）</span></label>
      <input id="ch-peerId" placeholder="-100XXXXXXXXXX">
      <span class="hint-text" data-i18n="ch.peerIdTip">留空则匹配所有对应类型的 Peer</span>
    </div>
  </div>
  <div class="m-foot">
    <button class="btn-secondary" onclick="closeModal('addChannelModal')" data-i18n="btn.cancel">取消</button>
    <button class="btn-primary" onclick="submitAddChannel()" data-i18n="ch.submit">添加绑定</button>
  </div>
</div></div>

<!-- ══ 添加 Cron 任务 ═══════════════════════════════════════ -->
<div class="backdrop" id="addCronModal">
<div class="modal">
  <div class="m-hdr"><h3 data-i18n="cron.addTitle">添加计划任务</h3><button class="m-close" onclick="closeModal('addCronModal')">✕</button></div>
  <div class="m-body">
    <div class="form-group"><label data-i18n="cron.schedule">Cron 表达式</label>
      <input id="cron-schedule" placeholder="0 3 * * * (每天凌晨3点)">
      <div class="hint-text" style="margin-top:4px;font-size:11px">格式: minute hour day month weekday</div></div>
    <div class="form-group"><label data-i18n="cron.command">命令</label>
      <input id="cron-command" placeholder="openclaw backup create"></div>
    <div class="form-group"><label data-i18n="cron.label">标签（选填）</label>
      <input id="cron-label" placeholder="openclaw-backup"></div>
  </div>
  <div class="m-foot">
    <button class="btn-secondary" onclick="closeModal('addCronModal')" data-i18n="btn.cancel">取消</button>
    <button class="btn-primary" onclick="submitAddCron()" data-i18n="btn.add">添加</button>
  </div>
</div></div>

<!-- ══ 添加 Fallback ════════════════════════════════════════ -->
<div class="backdrop" id="addFallbackModal">
<div class="modal">
  <div class="m-hdr"><h3>添加 Fallback 模型</h3><button class="m-close" onclick="closeModal('addFallbackModal')">✕</button></div>
  <div class="m-body">
    <div id="fb-current-list" style="margin-bottom:10px;font-size:12px;color:var(--muted)"></div>
    <div class="form-group">
      <label>直接输入 Model ID <span style="color:var(--muted);font-weight:normal">（推荐，格式：provider/model-id）</span></label>
      <input id="fb-custom" placeholder="例：deepseek/deepseek-v3 或 anthropic/claude-sonnet-4-5" oninput="onFbCustomInput()">
      <div style="font-size:11px;color:var(--muted);margin-top:4px">运行 <code>openclaw models list</code> 查看可用模型 ID</div>
    </div>
    <div class="form-group"><label>或从内置列表选择</label>
      <select id="fb-sel" onchange="onFbSelChange()"></select></div>
  </div>
  <div class="m-foot">
    <button class="btn-secondary" onclick="closeModal('addFallbackModal')">取消</button>
    <button class="btn-primary" onclick="addFallback()">添加</button>
  </div>
</div></div>

<!-- ══ 日志查看 ══════════════════════════════════════════════ -->
<div class="backdrop" id="logModal">
<div class="modal wide">
  <div class="m-hdr"><h3 data-i18n="actions.logsTitle">📋 Gateway 日志</h3><button class="m-close" onclick="closeLogs()">✕</button></div>
  <div class="m-body">
    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
      <button class="btn-secondary" onclick="refreshLogs()" data-i18n="actions.refresh">🔄 刷新</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
        <input type="checkbox" id="autoRefresh" onchange="toggleAutoRefresh()" style="width:auto"> <span data-i18n="actions.autoRefresh">自动刷新（2s）</span>
      </label>
      <span style="margin-left:auto;font-size:11px;color:var(--muted)" id="logPath"></span>
    </div>
    <div class="log-box" id="logContent" data-i18n="common.loading">加载中...</div>
  </div>
  <div class="m-foot"><button class="btn-secondary" onclick="closeLogs()" data-i18n="common.close">关闭</button></div>
</div></div>

<!-- ══ 回滚 ════════════════════════════════════════════════ -->
<div class="backdrop" id="rollbackModal">
<div class="modal">
  <div class="m-hdr"><h3 data-i18n="actions.rollbackTitle">📦 备份 / 回滚</h3><button class="m-close" onclick="closeModal('rollbackModal')">✕</button></div>
  <div class="m-body">
    <p class="hint-text" style="margin-bottom:12px" data-i18n="actions.rollbackHint">选择一个备份文件恢复。恢复前会自动保存当前配置。</p>
    <div class="card-grid" id="backupList"><div class="empty" data-i18n="common.loading">加载中...</div></div>
  </div>
  <div class="m-foot"><button class="btn-secondary" onclick="closeModal('rollbackModal')" data-i18n="common.close">关闭</button></div>
</div></div>

<!-- ══ NAS 备份设置 ════════════════════════════════════════ -->
<div class="backdrop" id="nasModal">
<div class="modal" style="max-width:520px">
  <div class="m-hdr"><h3 data-i18n="nas.title">🌐 远端备份</h3><button class="m-close" onclick="closeModal('nasModal')">✕</button></div>
  <div class="m-body">
    <div class="form-group">
      <label data-i18n="nas.host">主机 / IP</label>
      <div style="display:flex;gap:8px">
        <input id="nas-host" placeholder="192.168.1.100" style="flex:1">
        <input id="nas-port" placeholder="22" style="width:64px">
      </div>
    </div>
    <div class="form-group">
      <label data-i18n="nas.user">用户名</label>
      <input id="nas-user" placeholder="admin">
    </div>
    <div class="form-group">
      <label data-i18n="nas.authLabel">认证方式</label>
      <div style="display:flex;gap:16px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="nasAuthType" value="password" id="nas-auth-pw" checked onchange="nasAuthChange()"> <span data-i18n="nas.authPw">密码</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="nasAuthType" value="key" id="nas-auth-key" onchange="nasAuthChange()"> SSH Key
        </label>
      </div>
    </div>
    <div id="nas-pw-section" class="form-group">
      <label data-i18n="nas.pwLabel">密码</label>
      <input id="nas-password" type="password" data-i18n-placeholder="nas.pwHint" placeholder="不存储，仅用于本次操作">
    </div>
    <div id="nas-key-section" class="form-group" style="display:none">
      <label data-i18n="nas.keyLabel">SSH Key 路径</label>
      <div style="display:flex;gap:6px">
        <input id="nas-sshkey" style="flex:1" placeholder="~/.ssh/ocm_nas_rsa">
        <button class="btn-secondary" style="white-space:nowrap;font-size:12px" onclick="nasGenKey()" data-i18n="nas.genKey">生成 Key</button>
      </div>
      <div id="nas-pubkey-box" class="log-box" style="display:none;margin-top:8px;font-size:11px"></div>
    </div>
    <div class="form-group">
      <label data-i18n="nas.remotePath">远端备份路径</label>
      <input id="nas-path" placeholder="/volume1/OpenClaw/backups">
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="nas-legacy">
        <span data-i18n="nas.compat">兼容模式（添加旧版 SSH 加密方案，适用于旧款 NAS / 旧服务器）</span>
      </label>
    </div>
    <div class="form-group">
      <label data-i18n="nas.content">备份内容</label>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="nasBackupType" value="full" id="nas-bk-full" checked> <span data-i18n="nas.full">全量（整个 .openclaw）</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="nasBackupType" value="essential" id="nas-bk-ess"> <span data-i18n="nas.essential">仅重要数据（配置+Key+记忆，无日志/历史）</span>
        </label>
      </div>
    </div>
    <div id="nas-result" class="log-box" style="display:none;margin-top:4px;max-height:140px;font-size:11px"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn-secondary" onclick="nasTest()" data-i18n="nas.btnTest">🔌 测试连接</button>
      <button class="btn-primary"   onclick="nasBackupNow()" data-i18n="nas.btnNow">💾 立即备份</button>
      <button class="btn-secondary" onclick="openNasCron()" data-i18n="nas.btnCron">⏰ 定时备份</button>
      <button class="btn-secondary" style="margin-left:auto" onclick="closeModal('nasModal')" data-i18n="nas.btnClose">关闭</button>
    </div>
    <div id="nas-cron-section" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <div class="form-group">
        <label data-i18n="nas.cronTime">每日备份时间</label>
        <input id="nas-cron-time" type="time" value="03:00" style="width:120px">
      </div>
      <button class="btn-primary" onclick="nasSetCron()" data-i18n="nas.btnSaveCron">💾 保存定时计划</button>
    </div>
  </div>
</div>
</div>


<!-- ══ 目录设置 ════════════════════════════════════════════ -->
<div class="backdrop" id="setupModal">
<div class="modal">
  <div class="m-hdr"><h3 data-i18n="actions.setupTitle">⚙️ 切换 OpenClaw 目录</h3><button class="m-close" onclick="closeModal('setupModal')">✕</button></div>
  <div class="m-body">
    <div class="form-group"><label data-i18n="actions.setupLabel">OpenClaw 数据目录路径</label>
      <input id="setup-dir" data-i18n-placeholder="actions.setupPlaceholder" placeholder="~/.openclaw 或绝对路径"></div>
    <div class="field-err" id="setup-err"></div>
    <p class="hint-text" style="margin-top:6px" data-i18n="actions.setupHint">需要包含 openclaw.json 的文件夹。更换后页面自动刷新。</p>
  </div>
  <div class="m-foot">
    <button class="btn-secondary" onclick="closeModal('setupModal')" data-i18n="btn.cancel">取消</button>
    <button class="btn-primary" onclick="submitSetup()" data-i18n="actions.setupConfirm">确认切换</button>
  </div>
</div></div>

<!-- ══ 命令输出 ════════════════════════════════════════════ -->
<div class="backdrop" id="cmdModal">
<div class="modal">
  <div class="m-hdr"><h3 id="cmdTitle" data-i18n="actions.outputTitle">输出</h3><button class="m-close" onclick="closeModal('cmdModal')">✕</button></div>
  <div class="m-body">
    <div class="log-box" id="cmdOutput" style="max-height:260px">...</div>
  </div>
  <div class="m-foot"><button class="btn-secondary" onclick="closeModal('cmdModal')" data-i18n="common.close">关闭</button></div>
</div></div>

<!-- Workspace 文件浏览器 -->
<div class="backdrop" id="wsModal">
<div class="modal wide" style="max-width:780px">
  <div class="m-hdr"><h3 data-i18n="ws.title">📂 Workspace 文件</h3><button class="m-close" onclick="closeModal('wsModal')">✕</button></div>
  <div class="m-body" id="wsContent" style="max-height:70vh;overflow-y:auto"></div>
  <div class="m-foot"><button class="btn-secondary" onclick="closeModal('wsModal')" data-i18n="common.close">关闭</button></div>
</div></div>

<!-- Toast -->
<div id="toast" style="position:fixed;bottom:20px;right:20px;z-index:999;display:flex;flex-direction:column;gap:8px"></div>`;

const MAIN_HTML_SCRIPT = `// ── i18n ──────────────────────────────────────────────────────
const I18N = {
  zh: {
    'tab.dashboard':'🏠 Dashboard',
    'tab.agents':'🤖 Agents','tab.channels':'🧭 路由','tab.models':'🧠 模型与认证','tab.auth':'🔑 认证',
    'tab.stats':'📊 Stats','tab.cron':'⏰ Cron',
    'agents.title':'Agents','agents.new':'＋ 新建 Subagent',
    'channels.title':'路由绑定','channels.add':'＋ 添加绑定','channels.hint':'用于高级路由管理：维护 Agent 与频道/群组绑定及优先级顺序。日常增减 Agent 请在 Agents 页面操作。',
    'channels.removeHint':'如果需要更换 Telegram 群或 Discord thread：请先在本页删除旧绑定，然后用新的 ID 重新绑定。也可用于修正绑定错误、群重建（ID 变化）、重复/冲突或临时断开路由。',
    'channels.filterLabel':'Agent','channels.filterAll':'全部 Agent','channels.emptyFiltered':'当前 Agent 下暂无绑定',
    'channels.countSuffix':'条绑定','channels.collapse':'折叠','channels.expand':'展开',
    'models.title':'模型管理','models.primary':'默认主模型','models.fallback':'Fallback 链',
    'models.hint':'模型由 openclaw onboard 注册，此处管理主模型和 Fallback 链。',
    'models.onlyCliHint':'模型下拉仅显示 openclaw models list 返回的模型。',
    'models.modelListErr':'读取 openclaw models list 失败：',
    'models.modelListEmpty':'未从 openclaw models list 解析到模型。请先运行 openclaw onboard 并确认模型可用。',
    'dash.firstRunTitle':'🚀 首次使用检查清单',
    'dash.firstRun1':'先确认 OCM 指向的是正确的 OpenClaw 数据目录。',
    'dash.firstRun2':'先看 Dashboard：确认 Gateway 正在运行，系统状态看起来正常。',
    'dash.firstRun3':'打开 Agents / Routing，确认你期望的绑定确实已经存在。',
    'dash.firstRun4':'用内置终端先运行一次 <code>openclaw doctor</code>，尽早发现环境或认证问题。',
    'dash.firstRun5':'在做较大改动前，先做一次备份或确认回滚入口，出问题时更容易恢复。',
    'dash.noticeTitle':'📌 Telegram 使用说明（重要）',
    'dash.notice1':'OCM 主要面向 Telegram：通过群组绑定 Agent，让每个 Agent 拥有独立 Workspace / SOUL.md / MEMORY.md。',
    'dash.notice2':'请确保你已有基本 OpenClaw 操作经验。OCM 主要负责可视化更新 openclaw.json，方便增删主 Agent 与 Sub-Agent，并支持多条 Agent 树。',
    'dash.notice3':'BotFather 中请确认 Allow Groups = ON 且 Group Privacy = OFF，否则 Sub-Agent 可能无法入组或无法响应。',
    'dash.noticeWarn':'⚠️ 强烈建议：每个 Agent 群组只保留你自己和该 Agent（或其 Sub-Agent）。不要邀请其他人，把每个组当作私聊空间。',
    'auth.title':'认证配置','auth.configured':'已配置认证',
    'auth.guide':'点击 Provider 查看认证步骤。认证需在终端完成，或使用下方 CLI 终端。',
    'auth.step1':'1. 获取 API Key','auth.step2':'2. 在终端运行以下命令','auth.step3':'3. 按提示粘贴 API Key 并回车',
    'auth.onboard':'完成认证后，运行 openclaw onboard 注册可用模型',
    'stats.title':'使用统计','stats.input':'输入 Token','stats.output':'输出 Token',
    'stats.cost':'估计成本','stats.requests':'请求数','stats.byModel':'按模型','stats.byDay':'按日期','stats.noData':'暂无数据（未找到会话记录）',
    'cron.title':'计划任务','cron.add':'＋ 添加任务','cron.hint':'管理与 OpenClaw 相关的 crontab 计划任务。',
    'cron.addTitle':'添加计划任务','cron.schedule':'Cron 表达式','cron.command':'命令','cron.label':'标签',
    'cron.enabled':'启用','cron.disabled':'已禁用','cron.run':'▶ 运行','cron.edit':'编辑','cron.empty':'暂无 OpenClaw 相关的计划任务',
    'ws.title':'📂 Workspace 文件','ws.edit':'✏️ 编辑','ws.save':'💾 保存','ws.cancel':'取消编辑','ws.saved':'文件已保存','ws.large':'（文件过大，无法预览）',
    'menu.ops':'操作','menu.restart':'重启 Gateway','menu.logs':'实时日志','menu.backup':'手动备份配置',
    'menu.rollback':'查看备份 / 回滚','menu.nas':'NAS 备份设置','menu.doctor':'健康检查',
    'menu.opendir':'打开配置目录','menu.switchdir':'切换 OpenClaw 目录',
    'actions.logsTitle':'📋 Gateway 日志','actions.refresh':'🔄 刷新','actions.autoRefresh':'自动刷新（2s）',
    'actions.outputTitle':'输出','actions.rollbackTitle':'📦 备份 / 回滚','actions.rollbackHint':'选择一个备份文件恢复。恢复前会自动保存当前配置。',
    'actions.restoreThis':'⏪ 恢复此备份','actions.setupTitle':'⚙️ 切换 OpenClaw 目录','actions.setupLabel':'OpenClaw 数据目录路径',
    'actions.setupPlaceholder':'~/.openclaw 或绝对路径','actions.setupHint':'需要包含 openclaw.json 的文件夹。更换后页面自动刷新。','actions.setupConfirm':'确认切换',
    'actions.restartTitle':'重启 Gateway','actions.doctorTitle':'健康检查 (doctor)','actions.running':'执行中...','actions.noOutput':'（无输出）',
    'actions.restartSent':'重启命令已发送。','actions.restartOk':'Gateway 已重启','actions.restartFail':'重启失败: ',
    'actions.restartManualHint':'请在终端手动运行:\\nopenclaw gateway restart',
    'actions.backupSaved':'备份已保存: ','actions.backupFail':'备份失败: ',
    'actions.logEmpty':'（空）','actions.logLoadFail':'加载失败: ',
    'actions.noBackups':'暂无备份文件','actions.loadFailed':'加载失败',
    'actions.restoreConfirm':'确认将配置恢复为：\\n{filename}\\n\\n当前配置将先被自动备份。继续？',
    'actions.restored':'已恢复 ','actions.restoreFail':'恢复失败: ',
    'actions.setupEmpty':'请填写路径','actions.setupSwitching':'目录已切换，正在刷新...','actions.setupInvalid':'路径无效','actions.setupReqFail':'请求失败: ',
    'common.loading':'加载中...','common.close':'关闭','status.connecting':'连接中...','status.configReadError':'无法读取配置',
    'btn.save':'保存','btn.delete':'删除','btn.cancel':'取消','btn.add':'添加','btn.remove':'移除',
    'agents.addAgent':'＋ Add Agent','agents.addSub':'＋ Add Sub-Agent','agents.hint':'Add Agent: create a top-level agent (a long-lived role) for a new domain. Add Sub-Agent: create a child under a parent; sub-agents use the parent Telegram bot but have their own workspace + SOUL.md + MEMORY.md, preventing context mixing, improving focus, and saving tokens.',
    'agents.addAgentTitle':'Add Agent (Main Bot)','agents.addSubTitle':'Add Sub-Agent',
    'agents.botToken':'Bot Token','agents.botName':'Bot Name','agents.botNamePh':'My Bot',
    'agents.addAgentSubmit':'Create Agent','agents.addSubSubmit':'Create Sub-Agent',
    'agents.errToken':'Please enter Bot Token','agents.errName':'Please enter Bot name',
    'agents.agentCreated':'✅ Agent created',
    'guide.title':'📖 Setup Guide','guide.agent.s1':'Open Telegram, search for <code>@BotFather</code>',
    'guide.agent.s2':'Send <code>/newbot</code> and follow prompts to name your Bot',
    'guide.agent.s3':'Copy the <code>Bot Token</code> from BotFather and paste below',
    'guide.agent.s4':'In BotFather: <code>/mybots</code> → select your bot → <b>Bot Settings</b> → <b>Allow Groups</b> → <b>Turn on</b> (allow the bot to join groups)',
    'guide.agent.s5':'Send <code>/setprivacy</code> → select your Bot → click <code>Disable</code> (allow Bot to read group messages)',
    'guide.sub.s1':'在 BotFather 发送 <code>/newbot</code> 创建新 Bot，获取 Bot Token',
    'guide.sub.s2':'在 BotFather 发送 <code>/mybots</code> → 选择 Bot → <b>Bot Settings</b> → <b>Group Privacy</b> → <b>Turn off</b>',
    'guide.sub.s3':'在 Telegram 创建新群组，将 Bot 加入群组（<b>不要加其他人</b>）',
    'guide.sub.s4':'在群内发一条消息，从 gateway 日志中找到 <code>peer.id</code>（负数）',
    'guide.sub.s5':'填写下方表单创建 Sub-Agent',
    'guide.sub.warn':'⚠️ 安全提示：请勿将其他人加入此群组，只有你和 Bot 应在群内。否则其他人也能与 Bot 对话并产生 API 费用。',
    'guide.agent.discord.s1':'Discord 主 Agent：创建/选择一个专用 <b>Channel</b>（建议私密频道）。',
    'guide.agent.discord.s2':'右键该 Channel → <b>Copy Link</b>，粘贴到表单里（OCM 自动解析 <code>channelId</code>，可选 <code>guildId</code>）。',
    'guide.agent.discord.s3':'建议：一个 Channel 只绑定一个主 Agent，避免上下文串台。',
    'guide.sub.discord.s1':'Discord Sub-Agent：在对应主 Channel 下新建一个 <b>Thread</b>（强烈推荐每个任务一个 thread）。',
    'guide.sub.discord.s2':'如果是 Private Thread：需要把 Bot/Agent 拉进该 thread（否则读不到消息）。',
    'guide.sub.discord.s3':'右键该 Thread → <b>Copy Link</b>，粘贴到表单里（OCM 自动解析 <code>threadId</code>）。',
    'guide.sub.discord.warn':'⚠️ 约定：主 Agent 绑定 Channel；Sub-Agent 绑定 Thread。不要把 Sub-Agent 绑到普通 Channel。',
    'wiz.telegramId':'你的 Telegram User ID','wiz.telegramIdHint':'💡 可通过 @userinfobot 获取，填写后自动配置 allowFrom 白名单','wiz.telegramIdPh':'例如: 123456789',
    'wiz.channel':'渠道',
    'wiz.discordChannel':'Discord 频道链接/ID',
    'wiz.discordChannelHint':'建议：右键频道 → Copy Link，粘贴后自动解析 channelId（可选 guildId）。',
    'wiz.discordThread':'Discord Thread 链接/ID（仅 Thread）',
    'wiz.discordThreadHint':'建议：在主频道内创建 thread → 右键 thread → Copy Link，粘贴后自动解析 threadId。',
    'agents.empty':'暂无 Agent','agents.main':'主 Agent','agents.bound':'已绑群',
    'agents.saveModel':'保存模型','agents.viewFiles':'查看文件',
    'agents.defaultModel':'使用全局默认','agents.custom':'自定义','agents.noModel':'默认',
    'channels.empty':'暂无绑定配置','channels.matchAll':'📡 匹配所有',
    'channels.bindIdx':'绑定索引: #','channels.delBinding':'删除绑定',
    'banner.modified':'配置已修改，建议重启 Gateway 以确保生效。',
    'banner.restart':'立即重启','banner.later':'稍后','banner.dismiss':'忽略',
    'floating.restart':'重启 Gateway',
    'wiz.title':'新建 Subagent',
    'wiz.s1':'1 基本信息','wiz.s2':'2 模型','wiz.s3':'3 性格&记忆','wiz.s4':'4 确认',
    'wiz.groupId':'Telegram 群组 ID','wiz.groupHint':'💡 在群内发一条消息，在网关终端日志里找 peer.id（负数）',
    'wiz.agentId':'Agent ID','wiz.agentIdHint':'（纯英文）','wiz.agentIdPh':'my_bot',
    'wiz.displayName':'显示名称','wiz.displayNamePh':'我的助手',
    'wiz.workspace':'Workspace 文件夹','wiz.workspaceHint':'（留空=Agent ID）','wiz.workspacePh':'自动',
    'wiz.purpose':'Agent 用途描述','wiz.purposePh':'例如：专注于 Linux 和网络运维，帮助群成员快速解决技术故障。',
    'wiz.model':'选择模型','wiz.modelHint':'（不选则沿用全局默认）',
    'wiz.soul':'性格关键词','wiz.soulHint':'（逗号分隔，选填）','wiz.soulPh':'幽默、直接、有条理...',
    'wiz.soulTip':'留空则使用默认成长型提示词（推荐）',
    'wiz.memory':'初始记忆','wiz.memoryHint':'（MEMORY.md，选填）','wiz.memoryPh':'例如：群组主要用中文交流。用户偏好简洁回复。',
    'wiz.preview':'即将创建：','wiz.group':'群组','wiz.modelLabel':'模型','wiz.globalDefault':'全局默认',
    'wiz.soulYes':'含性格关键词','wiz.soulDefault':'默认成长型提示词（推荐）',
    'wiz.autoBackup':'自动备份当前 openclaw.json ✓',
    'wiz.back':'← 上一步','wiz.next':'下一步 →','wiz.confirm':'✅ 确认创建','wiz.creating':'创建中...',
    'wiz.created':'✅ 已创建',
    'wiz.errGroupId':'请填写群组 ID','wiz.errAgentId':'请填写 Agent ID',
    'wiz.errIdFormat':'只能含英文/数字/_ /-','wiz.errIdReserved':'"main" 是保留 ID','wiz.errIdDup':'该 ID 已存在',
    'ch.title':'添加 Channel 绑定','ch.agent':'Agent','ch.channelType':'频道类型',
    'ch.telegram':'Telegram','ch.anyChannel':'任意（不限频道）',
    'ch.peerKind':'Peer 类型','ch.group':'群组 (group)','ch.private':'私聊 (private)','ch.any':'任意',
    'ch.peerId':'Peer ID','ch.peerIdHint':'（群组 ID 或用户 ID）','ch.peerIdTip':'留空则匹配所有对应类型的 Peer',
    'ch.submit':'添加绑定',
    'l.sub':'选择运行模式',
    'cli.open':'⌨️ 终端','cli.title':'⌨️ CLI 终端','cli.copy':'复制命令','cli.clear':'清空','cli.collapse':'▼ 收起',
    'cli.ready':'── 终端就绪，等待命令 ──','cli.cleared':'── 已清空 ──',
    'cli.presets':'── 常用命令 ──','cli.builtins':'内置命令','cli.favs':'我的收藏',
    'cli.run':'▶ 执行','cli.stop':'■ 停止','cli.star':'⭐','cli.manage':'管理',
    'cli.placeholder':'输入命令（如 openclaw doctor）',
    'cli.favprompt':'给这条命令起个名字（留空则使用命令本身）：',
    'cli.fav.dup':'该命令已在收藏里了','cli.fav.empty':'请先输入命令',
    'cli.fav.saved':'已收藏','cli.manage.title':'管理收藏命令',
    'nas.title':'🌐 远端备份',
    'nas.host':'主机 / IP','nas.user':'用户名','nas.authLabel':'认证方式',
    'nas.authPw':'密码','nas.pwLabel':'密码','nas.pwHint':'不存储，仅用于本次操作',
    'nas.keyLabel':'SSH Key 路径','nas.genKey':'生成 Key',
    'nas.pubkeyHint':'公钥（复制到 NAS 的 authorized_keys）:',
    'nas.remotePath':'远端备份路径',
    'nas.compat':'兼容模式（添加旧版 SSH 加密方案，适用于旧款 NAS / 旧服务器）',
    'nas.content':'备份内容','nas.full':'全量（整个 .openclaw）',
    'nas.essential':'仅重要数据（配置+Key+记忆，无日志/历史）',
    'nas.btnTest':'🔌 测试连接','nas.btnNow':'💾 立即备份',
    'nas.btnCron':'⏰ 定时备份','nas.btnClose':'关闭',
    'nas.cronTime':'每日备份时间','nas.btnSaveCron':'💾 保存定时计划',
    'nas.testing':'连接测试中...','nas.testOk':'✅ 连接成功','nas.testFail':'❌ 连接失败: ',
    'nas.backing':'备份中，请稍候...','nas.backupOk':'✅ 备份完成: ','nas.backupFail':'❌ 备份失败: ',
    'nas.keyGenOk':'SSH Key 已生成','nas.keyGenFail':'生成失败: ',
    'nas.cronOk':'✅ 定时备份已设置 ','nas.cronToast':'定时备份已配置',
    'nas.backupToast':'NAS 备份完成','nas.errNoHost':'请填写主机和用户名',
  },
  en: {
    'tab.dashboard':'🏠 Dashboard',
    'tab.agents':'🤖 Agents','tab.channels':'🧭 Routing','tab.models':'🧠 Models & Auth','tab.auth':'🔑 Auth',
    'tab.stats':'📊 Stats','tab.cron':'⏰ Cron',
    'agents.title':'Agents','agents.new':'＋ New Subagent',
    'channels.title':'Routing Bindings','channels.add':'＋ Add Binding','channels.hint':'Advanced routing rules for agent-channel/group bindings and priority order. Use Agents page for daily add/remove workflows.','channels.removeHint':'When to use Remove binding: if you need to switch to a new Telegram group / Discord thread, remove the old binding here, then add a new binding with the new ID. Also use this for wrong bindings, recreated groups (new id), duplicates/conflicts, decommissioning, or temporary disconnect.',
    'channels.filterLabel':'Agent','channels.filterAll':'All Agents','channels.emptyFiltered':'No bindings for selected agent',
    'channels.countSuffix':'bindings','channels.collapse':'Collapse','channels.expand':'Expand',
    'models.title':'Model Management','models.primary':'Default Primary Model','models.fallback':'Fallback Chain',
    'models.hint':'Models are registered via openclaw onboard. Manage primary model and fallback chain here.',
    'models.onlyCliHint':'Model dropdowns only show IDs returned by openclaw models list.',
    'models.modelListErr':'Failed to load openclaw models list: ',
    'models.modelListEmpty':'No model IDs were parsed from openclaw models list. Run openclaw onboard first.',
    'dash.firstRunTitle':'🚀 First-run checklist',
    'dash.firstRun1':'Confirm OCM is pointed at the correct OpenClaw directory.',
    'dash.firstRun2':'Check Dashboard first: make sure Gateway is running and the system looks healthy.',
    'dash.firstRun3':'Open Agents / Routing and confirm the bindings you expect are actually there.',
    'dash.firstRun4':'Use the built-in Terminal to run <code>openclaw doctor</code> once so you catch environment or auth issues early.',
    'dash.firstRun5':'Before bigger edits, make a backup or check rollback so recovery is nearby if something goes wrong.',
    'dash.noticeTitle':'📌 Telegram Usage Notes (Important)',
    'dash.notice1':'OCM is primarily for Telegram workflows: bind agents to groups so each agent has isolated Workspace / SOUL.md / MEMORY.md.',
    'dash.notice2':'Basic OpenClaw CLI experience is required. OCM focuses on visual openclaw.json updates for easier main-agent/sub-agent management and multiple agent trees.',
    'dash.notice3':'In BotFather, keep Allow Groups = ON and Group Privacy = OFF; otherwise sub-agents may fail to join or respond.',
    'dash.noticeWarn':'⚠️ Strong recommendation: each agent group should include only you and that agent (or its sub-agents). Treat each group like a private chat.',
    'auth.title':'Auth Config','auth.configured':'Configured Auth',
    'auth.guide':'Click a Provider for setup instructions. Auth is done in terminal or via the CLI panel below.',
    'auth.step1':'1. Get API Key','auth.step2':'2. Run the command below in terminal','auth.step3':'3. Paste your API Key when prompted',
    'auth.onboard':'After auth, run openclaw onboard to register available models',
    'stats.title':'Usage Stats','stats.input':'Input Tokens','stats.output':'Output Tokens',
    'stats.cost':'Estimated Cost','stats.requests':'Requests','stats.byModel':'By Model','stats.byDay':'By Day','stats.noData':'No data (no session records found)',
    'cron.title':'Scheduled Tasks','cron.add':'＋ Add Task','cron.hint':'Manage OpenClaw-related crontab scheduled tasks.',
    'cron.addTitle':'Add Scheduled Task','cron.schedule':'Cron Expression','cron.command':'Command','cron.label':'Label',
    'cron.enabled':'Enabled','cron.disabled':'Disabled','cron.run':'▶ Run','cron.edit':'Edit','cron.empty':'No OpenClaw-related cron tasks',
    'ws.title':'📂 Workspace Files','ws.edit':'✏️ Edit','ws.save':'💾 Save','ws.cancel':'Cancel Edit','ws.saved':'File saved','ws.large':'(File too large to preview)',
    'menu.ops':'Actions','menu.restart':'Restart Gateway','menu.logs':'Live Logs','menu.backup':'Manual Backup',
    'menu.rollback':'Backups / Rollback','menu.nas':'NAS Backup Setup','menu.doctor':'Health Check',
    'menu.opendir':'Open Config Dir','menu.switchdir':'Switch OpenClaw Dir',
    'actions.logsTitle':'📋 Gateway Logs','actions.refresh':'🔄 Refresh','actions.autoRefresh':'Auto refresh (2s)',
    'actions.outputTitle':'Output','actions.rollbackTitle':'📦 Backups / Rollback','actions.rollbackHint':'Select a backup file to restore. Current config will be auto-backed up first.',
    'actions.restoreThis':'⏪ Restore this backup','actions.setupTitle':'⚙️ Switch OpenClaw Dir','actions.setupLabel':'OpenClaw data directory path',
    'actions.setupPlaceholder':'~/.openclaw or absolute path','actions.setupHint':'Folder must contain openclaw.json. Page auto-refreshes after switching.','actions.setupConfirm':'Confirm Switch',
    'actions.restartTitle':'Restart Gateway','actions.doctorTitle':'Health Check (doctor)','actions.running':'Running...','actions.noOutput':'(no output)',
    'actions.restartSent':'Restart command sent.','actions.restartOk':'Gateway restarted','actions.restartFail':'Restart failed: ',
    'actions.restartManualHint':'Please run manually in terminal:\\nopenclaw gateway restart',
    'actions.backupSaved':'Backup saved: ','actions.backupFail':'Backup failed: ',
    'actions.logEmpty':'(empty)','actions.logLoadFail':'Load failed: ',
    'actions.noBackups':'No backup files','actions.loadFailed':'Load failed',
    'actions.restoreConfirm':'Restore config to:\\n{filename}\\n\\nCurrent config will be auto-backed up first. Continue?',
    'actions.restored':'Restored ','actions.restoreFail':'Restore failed: ',
    'actions.setupEmpty':'Please enter a path','actions.setupSwitching':'Directory switched, refreshing...','actions.setupInvalid':'Invalid path','actions.setupReqFail':'Request failed: ',
    'common.loading':'Loading...','common.close':'Close','status.connecting':'Connecting...','status.configReadError':'Unable to read config',
    'btn.save':'Save','btn.delete':'Delete','btn.cancel':'Cancel','btn.add':'Add','btn.remove':'Remove',
    'agents.addAgent':'＋ Add Agent','agents.addSub':'＋ Add Sub-Agent','agents.hint':'Add Agent: create a top-level agent (a long-lived role) for a new domain. Add Sub-Agent: create a child under a parent; sub-agents use the parent Telegram bot but have their own workspace + SOUL.md + MEMORY.md, preventing context mixing, improving focus, and saving tokens.',
    'agents.addAgentTitle':'Add Agent (Main Bot)','agents.addSubTitle':'Add Sub-Agent',
    'agents.botToken':'Bot Token','agents.botName':'Bot Name','agents.botNamePh':'My Bot',
    'agents.addAgentSubmit':'Create Agent','agents.addSubSubmit':'Create Sub-Agent',
    'agents.errToken':'Please enter Bot Token','agents.errName':'Please enter Bot name',
    'agents.agentCreated':'✅ Agent created',
    'guide.title':'📖 Setup Guide','guide.agent.s1':'Open Telegram, search for <code>@BotFather</code>',
    'guide.agent.s2':'Send <code>/newbot</code> and follow prompts to name your Bot',
    'guide.agent.s3':'Copy the <code>Bot Token</code> from BotFather and paste below',
    'guide.agent.s4':'In BotFather: <code>/mybots</code> → select your bot → <b>Bot Settings</b> → <b>Allow Groups</b> → <b>Turn on</b> (allow the bot to join groups)',
    'guide.agent.s5':'Send <code>/setprivacy</code> → select your Bot → click <code>Disable</code> (allow Bot to read group messages)',
    'guide.sub.s1':'Send <code>/newbot</code> to BotFather to create a new Bot and get the Bot Token',
    'guide.sub.s2':'Send <code>/mybots</code> to BotFather → select your Bot → <b>Bot Settings</b> → <b>Group Privacy</b> → <b>Turn off</b>',
    'guide.sub.s3':'Create a new Telegram group, add the Bot to the group (<b>do NOT add anyone else</b>)',
    'guide.sub.s4':'Send a message in the group, find <code>peer.id</code> (negative number) in gateway logs',
    'guide.sub.s5':'Fill in the form below to create the Sub-Agent',
    'guide.sub.warn':'⚠️ Security: Do NOT add other people to this group. Only you and the Bot should be in the group. Otherwise others can chat with the Bot and incur API costs.',
    'guide.agent.discord.s1':'Discord main agent: create/select a dedicated <b>channel</b> (private recommended).',
    'guide.agent.discord.s2':'Right-click the channel → <b>Copy Link</b>, paste it into the form (OCM auto-parses <code>channelId</code>; optional <code>guildId</code>).',
    'guide.agent.discord.s3':'Recommended: bind one main agent per channel to avoid context bleed.',
    'guide.sub.discord.s1':'Discord sub-agent: create a <b>thread</b> under the main channel (one thread per task recommended).',
    'guide.sub.discord.s2':'If it is a private thread, add the bot/agent to the thread (otherwise it cannot read messages).',
    'guide.sub.discord.s3':'Right-click the thread → <b>Copy Link</b>, paste into the form (OCM auto-parses the <code>threadId</code>).',
    'guide.sub.discord.warn':'Important: main agents bind to channels; sub-agents bind to threads. Do not bind sub-agents to normal channels.',
    'wiz.telegramId':'Your Telegram User ID','wiz.telegramIdHint':'💡 Get it from @userinfobot — auto-configures allowFrom whitelist','wiz.telegramIdPh':'e.g. 123456789',
    'wiz.channel':'Channel',
    'wiz.discordChannel':'Discord channel link/ID',
    'wiz.discordChannelHint':'Tip: right-click channel → Copy Link. Paste to auto-parse channelId (optional guildId).',
    'wiz.discordThread':'Discord thread link/ID (thread only)',
    'wiz.discordThreadHint':'Tip: create a thread under your main channel → Copy Link. Paste to auto-parse threadId.',

    'agents.empty':'No Agents','agents.main':'Main Agent','agents.bound':'Bound',
    'agents.saveModel':'Save Model','agents.viewFiles':'View Files',
    'agents.defaultModel':'Use Global Default','agents.custom':'custom','agents.noModel':'Default',
    'channels.empty':'No bindings configured','channels.matchAll':'📡 Match All',
    'channels.bindIdx':'Binding Index: #','channels.delBinding':'Remove Binding',
    'banner.modified':'Config modified. Restart Gateway to apply changes.',
    'banner.restart':'Restart Now','banner.later':'Later','banner.dismiss':'Dismiss',
    'floating.restart':'Restart Gateway',
    'wiz.title':'New Subagent',
    'wiz.s1':'1 Basic Info','wiz.s2':'2 Model','wiz.s3':'3 Personality & Memory','wiz.s4':'4 Confirm',
    'wiz.groupId':'Telegram Group ID','wiz.groupHint':'💡 Send a message in the group, find peer.id (negative number) in gateway logs',
    'wiz.agentId':'Agent ID','wiz.agentIdHint':'(English only)','wiz.agentIdPh':'my_bot',
    'wiz.displayName':'Display Name','wiz.displayNamePh':'My Assistant',
    'wiz.workspace':'Workspace Folder','wiz.workspaceHint':'(Leave blank = Agent ID)','wiz.workspacePh':'auto',
    'wiz.purpose':'Agent Purpose','wiz.purposePh':'e.g. Linux & networking ops, help group members troubleshoot quickly.',
    'wiz.model':'Select Model','wiz.modelHint':'(Leave blank for global default)',
    'wiz.soul':'Personality Keywords','wiz.soulHint':'(comma-separated, optional)','wiz.soulPh':'humorous, direct, organized...',
    'wiz.soulTip':'Leave blank for default growth prompt (recommended)',
    'wiz.memory':'Initial Memory','wiz.memoryHint':'(MEMORY.md, optional)','wiz.memoryPh':'e.g. Group mainly uses English. Users prefer concise replies.',
    'wiz.preview':'About to create:','wiz.group':'Group','wiz.modelLabel':'Model','wiz.globalDefault':'Global Default',
    'wiz.soulYes':'With personality keywords','wiz.soulDefault':'Default growth prompt (recommended)',
    'wiz.autoBackup':'Auto-backup current openclaw.json ✓',
    'wiz.back':'← Back','wiz.next':'Next →','wiz.confirm':'✅ Confirm','wiz.creating':'Creating...',
    'wiz.created':'✅ Created',
    'wiz.errGroupId':'Please enter Group ID','wiz.errAgentId':'Please enter Agent ID',
    'wiz.errIdFormat':'Only letters/numbers/_ /- allowed','wiz.errIdReserved':'"main" is a reserved ID','wiz.errIdDup':'This ID already exists',
    'ch.title':'Add Channel Binding','ch.agent':'Agent','ch.channelType':'Channel Type',
    'ch.telegram':'Telegram','ch.anyChannel':'Any (no restriction)',
    'ch.peerKind':'Peer Type','ch.group':'Group','ch.private':'Private','ch.any':'Any',
    'ch.peerId':'Peer ID','ch.peerIdHint':'(Group ID or User ID)','ch.peerIdTip':'Leave blank to match all peers of this type',
    'ch.submit':'Add Binding',
    'l.sub':'Select Mode',
    'cli.open':'⌨️ Terminal','cli.title':'⌨️ CLI Terminal','cli.copy':'Copy cmd','cli.clear':'Clear','cli.collapse':'▼ Collapse',
    'cli.ready':'── Terminal Ready ──','cli.cleared':'── Cleared ──',
    'cli.presets':'── Presets ──','cli.builtins':'Built-in','cli.favs':'My Favorites',
    'cli.run':'▶ Run','cli.stop':'■ Stop','cli.star':'⭐','cli.manage':'Manage',
    'cli.placeholder':'Enter command (e.g. openclaw doctor)',
    'cli.favprompt':'Name for this command (leave blank to use the command itself):',
    'cli.fav.dup':'Command already in favorites','cli.fav.empty':'Please enter a command first',
    'cli.fav.saved':'Saved','cli.manage.title':'Manage Saved Commands',
    'nas.title':'🌐 Remote Backup',
    'nas.host':'Host / IP','nas.user':'Username','nas.authLabel':'Auth Method',
    'nas.authPw':'Password','nas.pwLabel':'Password','nas.pwHint':'Not stored, used for this operation only',
    'nas.keyLabel':'SSH Key Path','nas.genKey':'Generate Key',
    'nas.pubkeyHint':'Public key (copy to NAS authorized_keys):',
    'nas.remotePath':'Remote Backup Path',
    'nas.compat':'Compatibility Mode (add legacy SSH ciphers — for old NAS / servers)',
    'nas.content':'Backup Content','nas.full':'Full (~entire .openclaw)',
    'nas.essential':'Essential (config+keys+memory, no logs/history)',
    'nas.btnTest':'🔌 Test Connection','nas.btnNow':'💾 Backup Now',
    'nas.btnCron':'⏰ Schedule','nas.btnClose':'Close',
    'nas.cronTime':'Daily Backup Time','nas.btnSaveCron':'💾 Save Schedule',
    'nas.testing':'Testing connection...','nas.testOk':'✅ Connected','nas.testFail':'❌ Connection failed: ',
    'nas.backing':'Backing up, please wait...','nas.backupOk':'✅ Backup complete: ','nas.backupFail':'❌ Backup failed: ',
    'nas.keyGenOk':'SSH key generated','nas.keyGenFail':'Key generation failed: ',
    'nas.cronOk':'✅ Schedule saved ','nas.cronToast':'Scheduled backup configured',
    'nas.backupToast':'NAS backup complete','nas.errNoHost':'Please enter host and username',
  },
};
// 安全 localStorage 工具（提前定义，防止隐私模式 / 存储禁用时整页崩溃）
const LS = {
  get(k, def='') { try { return localStorage.getItem(k) ?? def; } catch(e) { return def; } },
  set(k, v)      { try { localStorage.setItem(k, v); } catch(e) {} },
  del(k)         { try { localStorage.removeItem(k); } catch(e) {} },
};
// Default UI language. Users can toggle and we persist in localStorage.
// Prefer English by default for broader sharing/promotions.
let lang = LS.get('ocm_lang', 'en');
function t(k) { return I18N[lang][k] || I18N.zh[k] || k; }
function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  const st = document.getElementById('statusTxt');
  if(st && (!st.textContent || st.textContent === '连接中...' || st.textContent === 'Connecting...')) st.textContent = t('status.connecting');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  const ltb = document.getElementById('langToggleBtn');
  if(ltb) ltb.textContent = lang === 'zh' ? 'EN' : 'ZH';
  // Update CLI elements that need JS-side refresh
  const ci=document.getElementById('cliInput');
  if(ci) ci.placeholder=t('cli.placeholder');
  const rm=document.getElementById('cliReadyMsg');
  if(rm) rm.textContent=t('cli.ready');
  // Re-render model/auth cards so Remove button text updates
  try{ renderModels(); }catch(_){}
  try{ renderAuth(); }catch(_){}
  try{ renderChannels(); }catch(_){}
  // Rebuild presets dropdown if CLI is open
  if(document.getElementById('cliPanel')&&document.getElementById('cliPanel').classList.contains('open')){
    buildCliPresets();
  }
}
function toggleLang() {
  lang = lang === 'zh' ? 'en' : 'zh';
  LS.set('ocm_lang', lang);
  applyLang();
}

// ── Landing Page ──────────────────────────────────────────────
const LANDING_TEXT = {
  zh: {
    sub: '选择运行模式',
    activeBadge: '可用', soonBadge: '敬请期待',
    subTitle: 'Sub-agent 模式',
    subDesc: '通过主 Bot 账号绑定多个子 Agent 到不同群组，共用同一个 Token。',
    subReqs: '<strong>需要：</strong><br>• Telegram Bot Token（主账号）<br>• 各群组的 Group ID<br>• 已安装 OpenClaw',
    multiTitle: 'Multi-agent 模式',
    multiDesc: '为每个场景创建完全独立的 Bot，彻底隔离配置与对话历史。',
    multiReqs: '<strong>需要：</strong><br>• 每个 Bot 独立的 Token<br>• 独立的 OpenClaw 配置目录<br>• 独立的服务器进程',
    enterBtn: '进入 Sub-agent 模式 →',
  },
  en: {
    sub: 'Select Mode',
    activeBadge: 'Available', soonBadge: 'Coming Soon',
    subTitle: 'Sub-agent Mode',
    subDesc: 'Bind multiple sub-agents to different groups using one main Bot Token.',
    subReqs: '<strong>Requires:</strong><br>• Telegram Bot Token (main)<br>• Group IDs for each group<br>• OpenClaw installed',
    multiTitle: 'Multi-agent Mode',
    multiDesc: 'Create fully isolated bots for each scenario with separate configs.',
    multiReqs: '<strong>Requires:</strong><br>• Individual Token per bot<br>• Separate OpenClaw config dir<br>• Separate server process',
    enterBtn: 'Enter Sub-agent Mode →',
  },
};
// ── 全局状态 ────────────────────────────────────────────────
let S = { agents:[], channels:[], models:{}, authProfiles:{}, knownModels:[], modelListError:'', authProviders:[], primaryModel:'', fallbacks:[] };
let wizCur = 1;
let logTimer = null;
let selectedAuthProv = null;
let channelFilterAgent = '__all__';
let routingCollapsedByAgent = {};

// ── 初始化（enterApp 触发） ─────────────────────────────────
async function checkStatus(){
  try{
    const r = await api('GET','/api/status');
    if(r.needsSetup){ location.reload(); return; }
    setDot('ok');
    document.getElementById('statusTxt').textContent = r.dir.replace(/.*[/\\\\]/,'.../')+' · v'+r.version;
    const tv=document.getElementById('topVersion');
    if(tv) tv.textContent = 'OCM v'+(r.ocmVersion||'--');
    const vb=document.getElementById('versionBadge'); if(vb) vb.textContent = 'v'+r.version;
    const ov=document.getElementById('ocmVersionBadge'); if(ov) ov.textContent='ocm v'+(r.ocmVersion||'--');
  }catch{ setDot('err'); document.getElementById('statusTxt').textContent=t('status.configReadError'); }
}

async function loadAll(){
  await Promise.all([loadAgents(), loadModels(), loadChannels()]);
  try{ renderChannels(); }catch(_){}
}

// ── Dashboard ─────────────────────────────────────────────────
let dashLoaded=false;
let dashRefreshTimer=null;
function fmtBytes(b){if(!b||b<=0)return '—';const u=['B','KB','MB','GB','TB'];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++;}return b.toFixed(i>0?1:0)+' '+u[i];}
function fmtUptime(s){const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);const m=Math.floor((s%3600)/60);if(d>0)return d+'d '+h+'h '+m+'m';if(h>0)return h+'h '+m+'m';return m+'m';}
function dashRow(label,val){return '<div class="dash-row"><span class="dash-label">'+esc(label)+'</span><span class="dash-val">'+val+'</span></div>';}
function gaugeColor(pct){if(pct>90)return '#ef4444';if(pct>70)return '#f59e0b';return '#22c55e';}
function buildGaugeSVG(pct,label,sub,color){
  const r=46,cx=55,cy=55,sw=8;
  const circ=2*Math.PI*r;
  const gap=circ*0.25;
  const arc=circ-gap;
  const filled=arc*(Math.min(pct,100)/100);
  const rot=135;
  if(!color)color=gaugeColor(pct);
  return '<div class="dash-gauge-card">'+
    '<svg class="dash-gauge-svg" viewBox="0 0 110 110">'+
    '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="'+sw+'" stroke-dasharray="'+arc+' '+gap+'" stroke-linecap="round" transform="rotate('+rot+' '+cx+' '+cy+')"/>'+
    '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="'+sw+'" stroke-dasharray="'+filled+' '+(circ-filled)+'" stroke-linecap="round" transform="rotate('+rot+' '+cx+' '+cy+')" style="transition:stroke-dasharray .6s ease"/>'+
    '<text x="'+cx+'" y="'+cy+'" text-anchor="middle" dy="-2" fill="'+color+'" font-size="22" font-weight="700" font-family="-apple-system,sans-serif">'+Math.round(pct)+'%</text>'+
    '<text x="'+cx+'" y="'+(cy+14)+'" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-family="-apple-system,sans-serif">'+esc(sub)+'</text>'+
    '</svg>'+
    '<div class="dash-gauge-label">'+esc(label)+'</div></div>';
}
function toggleDashRefresh(on){
  if(dashRefreshTimer){clearInterval(dashRefreshTimer);dashRefreshTimer=null;}
  if(on){dashRefreshTimer=setInterval(loadDashboard,10000);}
}
async function loadDashboard(){
  try{
    const r=await api('GET','/api/dashboard');
    if(!r.ok)return;
    const s=r.system, g=r.gateway, a=r.agents;
    const memPct=s.totalMem?((s.totalMem-s.freeMem)/s.totalMem*100):0;
    const diskPct=s.diskTotal?(s.diskUsed/s.diskTotal*100):0;
    const cpuPct=(s.cpuPercent!==null&&s.cpuPercent!==undefined)?s.cpuPercent:0;
    // Gauges
    const memUsed=fmtBytes(s.totalMem-s.freeMem)+' / '+fmtBytes(s.totalMem);
    const diskUsed=fmtBytes(s.diskUsed)+' / '+fmtBytes(s.diskTotal);
    let gaugeHtml=buildGaugeSVG(cpuPct,'CPU',s.cpuCores+' cores');
    gaugeHtml+=buildGaugeSVG(memPct,'RAM',memUsed);
    gaugeHtml+=buildGaugeSVG(diskPct,'DISK',diskUsed);
    document.getElementById('dashGauges').innerHTML=gaugeHtml;
    // System info card
    const loadStr=s.loadAvg?s.loadAvg.map(function(v){return v.toFixed(2);}).join(' / '):'—';
    let sysHtml=dashRow('Hostname',esc(s.hostname));
    sysHtml+=dashRow('OS',esc(s.platform));
    sysHtml+=dashRow('Node.js',esc(s.nodeVer));
    sysHtml+=dashRow('CPU',esc(s.cpuModel));
    sysHtml+=dashRow('Cores',String(s.cpuCores));
    sysHtml+=dashRow('Uptime',fmtUptime(s.uptime));
    sysHtml+=dashRow('Load Avg (1/5/15m)',loadStr);
    document.getElementById('dashSysItems').innerHTML=sysHtml;
    // Gateway card
    const statusIcon='<span class="dash-indicator '+esc(g.status)+'"></span>';
    const statusLabel=g.status==='running'?'Running':g.status==='stopped'?'Stopped':'Unknown';
    let gwHtml=dashRow('Status',statusIcon+statusLabel);
    gwHtml+=dashRow('Bind Host',esc(g.host||'—'));
    gwHtml+=dashRow('Port',String(g.port||'—'));
    if(g.pid)gwHtml+=dashRow('PID',g.pid);
    gwHtml+=dashRow('Telegram Accounts',String(g.accountCount||0));
    gwHtml+=dashRow('Groups',String(g.groupCount||0));
    gwHtml+=dashRow('Bindings',String(g.bindingCount||0));
    gwHtml+=dashRow('allowFrom',String(g.allowFromCount||0));
    document.getElementById('dashGwItems').innerHTML=gwHtml;
    // Agents card
    let agHtml=dashRow('Configured Agents',String(a.configCount||0));
    agHtml+=dashRow('Runtime Agent Dirs',String(a.count||0));
    agHtml+=dashRow('Agent Trees',String(a.mainCount||0));
    agHtml+=dashRow('Sub-Agents',String(a.subCount||0));
    if(a.lastActivity){
      const d=new Date(a.lastActivity);
      agHtml+=dashRow('Last Activity',d.toLocaleString('en-AU',{timeZone:'Australia/Brisbane',hour12:false}));
    }else{
      agHtml+=dashRow('Last Activity','—');
    }
    agHtml+=dashRow('OCM Version','v'+esc(r.ocmVersion));
    agHtml+=dashRow('Server Time',esc(r.serverTime));
    document.getElementById('dashAgentItems').innerHTML=agHtml;
    // Storage card
    let stHtml=dashRow('OpenClaw Dir',fmtBytes(s.dirSize));
    stHtml+=dashRow('Disk Free',fmtBytes(s.diskFree));
    document.getElementById('dashStorageItems').innerHTML=stHtml;
    dashLoaded=true;
  }catch(e){console.error('Dashboard load error:',e);}
}

let healthTimer=null;
async function refreshHealth(){
  try{
    const r=await api('GET','/api/health');
    const badge=document.getElementById('healthBadge');
    const icon=document.getElementById('healthIcon');
    const cnt=document.getElementById('healthCount');
    const tip=document.getElementById('healthTooltip');
    if(!badge)return;
    if(!r.issues||r.issues.length===0){
      badge.className=''; badge.style.display='none'; return;
    }
    const errors=r.issues.filter(i=>i.level==='error').length;
    const warns=r.issues.filter(i=>i.level==='warn').length;
    badge.style.display='flex';
    badge.className=errors>0?'error':'warn';
    icon.textContent=errors>0?'🔴':'🟡';
    cnt.textContent=r.issues.length+(lang==='en'?' issue(s)':' 个问题');
    tip.textContent=r.issues.map(i=>(i.level==='error'?'❌ ':'⚠️ ')+i.text).join('\\n');
  }catch(_){}
}
function startHealthPolling(){
  refreshHealth();
  if(healthTimer) clearInterval(healthTimer);
  healthTimer=setInterval(refreshHealth,60000);
}


async function loadAgents(){
  try{ const r=await api('GET','/api/agents'); S.agents=r.agents||[]; renderAgents(); }
  catch(e){ toast('加载 Agent 失败: '+e.message,'error'); }
}

async function loadModels(){
  try{
    const r=await api('GET','/api/models');
    S.models=r.models||{}; S.authProfiles=r.authProfiles||{};
    S.knownModels=r.knownModels||[]; S.authProviders=r.authProviders||[];
    S.modelListError=r.modelListError||'';
    S.primaryModel=r.primaryModel||''; S.fallbacks=r.fallbacks||[];
    renderModels(); renderAuth(); buildModelDropdowns();
  }catch(e){ toast('加载模型失败: '+e.message,'error'); }
}

async function loadChannels(){
  try{ const r=await api('GET','/api/channels'); S.channels=r.channels||[]; renderChannels(); }
  catch(e){ toast('加载 Channel 失败: '+e.message,'error'); }
}

// ── 渲染 Agents ─────────────────────────────────────────────
// ── Show Add Form ─────────────────────────────────────────────
function clearAddForm() { document.getElementById('addFormArea').innerHTML = ''; }
function showAddForm(type) {
  const area = document.getElementById('addFormArea');
  if (type === 'agent') {
    area.innerHTML = buildAddAgentForm();
  } else {
    area.innerHTML = buildAddSubForm();
  }
  applyLang();
}

function buildAddAgentForm() {
  const modelOpts = buildModelOpts('__default__');
  return '<div class="add-form">' +
    '<h3>' + t('agents.addAgentTitle') + '</h3>' +
    '<div class="form-group"><label>' + t('wiz.channel') + '</label>' +
    '<select id="fa-channel" onchange="toggleAddAgentChannel(this.value)">' +
      '<option value="telegram">Telegram</option>' +
      '<option value="discord">Discord</option>' +
    '</select></div>' +

    '<details class="guide-box" open id="fa-guide-telegram"><summary>' + t('guide.title') + '</summary><ol>' +
      '<li>' + t('guide.agent.s1') + '</li>' +
      '<li>' + t('guide.agent.s2') + '</li>' +
      '<li>' + t('guide.agent.s3') + '</li>' +
      '<li>' + t('guide.agent.s4') + '</li>' +
      '<li>' + t('guide.agent.s5') + '</li>' +
    '</ol></details>' +

    '<details class="guide-box" open id="fa-guide-discord" style="display:none"><summary>' + t('guide.title') + '</summary><ol>' +
      '<li>' + t('guide.agent.discord.s1') + '</li>' +
      '<li>' + t('guide.agent.discord.s2') + '</li>' +
      '<li>' + t('guide.agent.discord.s3') + '</li>' +
    '</ol></details>' +

    '<div id="fa-sec-telegram">' +
      '<div class="form-group"><label>' + t('agents.botToken') + '</label>' +
      '<input id="fa-token" type="text" placeholder="123456:ABC-DEF...">' +
      '</div>' +
    '</div>' +

    '<div class="form-row">' +
      '<div class="form-group"><label>Agent ID</label>' +
      '<input id="fa-agentid" type="text" placeholder="research, travel_assistant, etc." pattern="[a-zA-Z0-9_-]+">' +
      '<span class="hint-text">Alphanumeric, underscore, or dash only</span></div>' +
      '<div class="form-group"><label>' + t('agents.botName') + '</label>' +
      '<input id="fa-name" type="text" placeholder="' + t('agents.botNamePh') + '">' +
      '</div>' +
    '</div>' +

    '<div class="form-group"><label>Workspace Folder</label>' +
    '<input id="fa-workspace" type="text" placeholder="(default = Agent ID)">' +
    '<span class="hint-text">Each agent must have its own workspace for isolated SOUL/MEMORY.</span></div>' +

    '<div id="fa-sec-discord" style="display:none">' +
      '<div class="form-group"><label>' + t('wiz.discordChannel') + '</label>' +
      '<input id="fa-discord-link" type="text" placeholder="https://discord.com/channels/<guildId>/<channelId> or <channelId>">' +
      '<span class="hint-text">' + t('wiz.discordChannelHint') + '</span></div>' +
    '</div>' +

    '<div class="form-group"><label>' + t('wiz.model') + '</label>' +
    '<select id="fa-model">' + modelOpts + '</select>' +
    '</div>' +
    '<div class="form-group"><label>' + t('wiz.purpose') + '</label>' +
    '<textarea id="fa-purpose" placeholder="' + t('wiz.purposePh') + '" rows="2"></textarea></div>' +
    '<div class="form-group"><label>' + t('wiz.soul') + ' <span style="color:var(--muted);font-weight:400">' + t('wiz.soulHint') + '</span></label>' +
    '<input id="fa-soul" placeholder="' + t('wiz.soulPh') + '">' +
    '<span class="hint-text">' + t('wiz.soulTip') + '</span></div>' +
    '<div style="display:flex;gap:8px;margin-top:14px">' +
    '<button class="btn-primary" onclick="submitAddAgent()">' + t('agents.addAgentSubmit') + '</button>' +
    '<button class="btn-ghost" onclick="clearAddForm()">' + t('btn.cancel') + '</button>' +
    '</div></div>';
}


function toggleAddAgentChannel(ch){
  const tg=document.getElementById('fa-sec-telegram');
  const dg=document.getElementById('fa-sec-discord');
  const gT=document.getElementById('fa-guide-telegram');
  const gD=document.getElementById('fa-guide-discord');
  if(tg) tg.style.display = (ch==='telegram')?'block':'none';
  if(dg) dg.style.display = (ch==='discord')?'block':'none';
  if(gT) gT.style.display = (ch==='telegram')?'block':'none';
  if(gD) gD.style.display = (ch==='discord')?'block':'none';
}
function buildAddSubForm() {
  const cfg = S.agents || [];
  // Parent agent dropdown (all agents as potential parent for grouping)
  let parentOpts = '';
  if (cfg.length === 0) parentOpts = '<option value="">No agents available</option>';
  else cfg.forEach(a=>{ parentOpts += '<option value="'+esc(a.id)+'">'+esc(a.name||a.id)+'</option>'; });

  const modelOpts = buildModelOpts('__default__');
  return '<div class="add-form">' +
    '<h3>' + t('agents.addSubTitle') + '</h3>' +
    '<div class="form-group"><label>' + t('wiz.channel') + '</label>' +
      '<select id="fs-channel" onchange="toggleAddSubChannel(this.value)">' +
        '<option value="telegram">Telegram</option>' +
        '<option value="discord">Discord (thread only)</option>' +
      '</select>' +
    '</div>' +

    '<details class="guide-box" open id="fs-guide-telegram"><summary>' + t('guide.title') + '</summary><ol>' +
      '<li>' + t('guide.sub.s1') + '</li>' +
      '<li>' + t('guide.sub.s2') + '</li>' +
      '<li>' + t('guide.sub.s3') + '</li>' +
      '<li>' + t('guide.sub.s4') + '</li>' +
      '<li>' + t('guide.sub.s5') + '</li>' +
    '</ol>' +
    '<div style="margin-top:10px;padding:10px 12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:13px;line-height:1.5">' + t('guide.sub.warn') + '</div>' +
    '</details>' +

    '<details class="guide-box" open id="fs-guide-discord" style="display:none"><summary>' + t('guide.title') + '</summary><ol>' +
      '<li>' + t('guide.sub.discord.s1') + '</li>' +
      '<li>' + t('guide.sub.discord.s2') + '</li>' +
      '<li>' + t('guide.sub.discord.s3') + '</li>' +
    '</ol>' +
    '<div style="margin-top:10px;padding:10px 12px;background:rgba(234,179,8,0.12);border:1px solid rgba(234,179,8,0.35);border-radius:8px;font-size:13px;line-height:1.5">' + t('guide.sub.discord.warn') + '</div>' +
    '</details>' +

    '<div class="form-group"><label>Parent Agent</label>' +
      '<select id="fs-parent">' + parentOpts + '</select>' +
      '<span class="hint-text">Used for grouping only (Discord sub-agents do not share bots).</span>' +
    '</div>' +

    '<div id="fs-sec-telegram">' +
      '<div class="form-group"><label>' + t('wiz.groupId') + '</label>' +
        '<input id="fs-gid" placeholder="-100XXXXXXXXXX">' +
        '<span class="hint-text">' + t('wiz.groupHint') + '</span>' +
      '</div>' +
      '<div class="form-group"><label>' + t('wiz.telegramId') + '</label>' +
        '<input id="fs-tgid" placeholder="' + t('wiz.telegramIdPh') + '">' +
        '<span class="hint-text">' + t('wiz.telegramIdHint') + '</span>' +
      '</div>' +
    '</div>' +

    '<div id="fs-sec-discord" style="display:none">' +
      '<div class="form-group"><label>' + t('wiz.discordThread') + '</label>' +
        '<input id="fs-discord-link" placeholder="https://discord.com/channels/<guildId>/<threadId> or <threadId>">' +
        '<span class="hint-text">' + t('wiz.discordThreadHint') + '</span>' +
      '</div>' +
    '</div>' +

    '<div class="form-row">' +
      '<div class="form-group"><label>' + t('wiz.agentId') + ' <span style="color:var(--muted);font-weight:400">' + t('wiz.agentIdHint') + '</span></label>' +
        '<input id="fs-aid" placeholder="' + t('wiz.agentIdPh') + '"></div>' +
      '<div class="form-group"><label>' + t('wiz.displayName') + '</label>' +
        '<input id="fs-name" placeholder="' + t('wiz.displayNamePh') + '"></div>' +
    '</div>' +

    '<div class="form-group"><label>Workspace Folder</label>' +
      '<input id="fs-workspace" placeholder="(default = Agent ID)">' +
      '<span class="hint-text">Each sub-agent must have its own workspace for isolated SOUL/MEMORY.</span>' +
    '</div>' +

    '<div class="form-group"><label>' + t('wiz.model') + '</label>' +
      '<select id="fs-model">' + modelOpts + '</select></div>' +
    '<div class="form-group"><label>' + t('wiz.purpose') + '</label>' +
      '<textarea id="fs-purpose" placeholder="' + t('wiz.purposePh') + '" rows="2"></textarea></div>' +
    '<div class="form-group"><label>' + t('wiz.soul') + ' <span style="color:var(--muted);font-weight:400">' + t('wiz.soulHint') + '</span></label>' +
      '<input id="fs-soul" placeholder="' + t('wiz.soulPh') + '"></div>' +
    '<div class="form-group"><label>' + t('wiz.memory') + ' <span style="color:var(--muted);font-weight:400">' + t('wiz.memoryHint') + '</span></label>' +
      '<textarea id="fs-mem" placeholder="' + t('wiz.memoryPh') + '" rows="2"></textarea></div>' +

    '<div style="display:flex;gap:8px;margin-top:14px">' +
      '<button class="btn-primary" onclick="submitAddSub()">' + t('agents.addSubSubmit') + '</button>' +
      '<button class="btn-ghost" onclick="clearAddForm()">' + t('btn.cancel') + '</button>' +
    '</div></div>';
}

function toggleAddSubChannel(ch){
  const tg=document.getElementById('fs-sec-telegram');
  const dg=document.getElementById('fs-sec-discord');
  const gT=document.getElementById('fs-guide-telegram');
  const gD=document.getElementById('fs-guide-discord');
  if(tg) tg.style.display = (ch==='telegram')?'block':'none';
  if(dg) dg.style.display = (ch==='discord')?'block':'none';
  if(gT) gT.style.display = (ch==='telegram')?'block':'none';
  if(gD) gD.style.display = (ch==='discord')?'block':'none';
}

// ── Submit Add Agent (with own bot) ──────────────────────────
async function submitAddAgent() {
  const channel = (document.getElementById('fa-channel')?.value||'telegram').trim();
  const agentId = document.getElementById('fa-agentid').value.trim();
  const name = document.getElementById('fa-name').value.trim();
  const workspace = (document.getElementById('fa-workspace').value.trim() || agentId);
  const model = document.getElementById('fa-model').value;
  const purpose = (document.getElementById('fa-purpose')?.value||'').trim();
  const personality = (document.getElementById('fa-soul')?.value||'').trim();

  if (!agentId) { toast('Agent ID is required', 'err'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) { toast('Agent ID must contain only alphanumeric characters, underscores, or dashes', 'err'); return; }
  if (!name) { toast(t('agents.errName'), 'err'); return; }
  if (!workspace) { toast('Workspace folder is required', 'err'); return; }

  try {
    if (channel === 'telegram') {
      const token = document.getElementById('fa-token').value.trim();
      if (!token) { toast(t('agents.errToken'), 'err'); return; }
      const payload = { botToken: token, agentId, name, workspace, model: model === '__default__' ? '' : model, purpose, personality };
      await api('POST', '/api/agents/bot', payload);
    } else {
      const link = (document.getElementById('fa-discord-link')?.value||'').trim();
      const parsed = parseDiscordLinkOrId(link);
      if (!parsed) { toast('Discord channel link/ID is required', 'err'); return; }
      const payload = { agentId, name, workspaceFolder: workspace, model: model === '__default__' ? '' : model, purpose, personality,
        guildId: parsed.guildId, channelId: parsed.channelId };
      await api('POST', '/api/agents/discord', payload);
    }
    toast('Agent created successfully', 'ok');
    clearAddForm();
    showRestartBanner();
    await loadAll();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ── Submit Add Sub-Agent ────────────────────────────────────
async function submitAddSub() {
  const channel = (document.getElementById('fs-channel')?.value||'telegram').trim();
  const parentAgentId = document.getElementById('fs-parent').value.trim();
  const agentId = document.getElementById('fs-aid').value.trim();
  const displayName = document.getElementById('fs-name').value.trim();
  const workspaceFolder = (document.getElementById('fs-workspace')?.value||'').trim() || agentId;
  const model = document.getElementById('fs-model').value;
  const purpose = document.getElementById('fs-purpose').value.trim();
  const personality = document.getElementById('fs-soul').value.trim();
  const initialMemory = document.getElementById('fs-mem').value.trim();

  if (!parentAgentId) { toast('Parent Agent is required', 'err'); return; }
  if (!agentId) { toast(t('wiz.errAgentId'), 'err'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) { toast(t('wiz.errIdFormat'), 'err'); return; }
  if (!workspaceFolder) { toast('Workspace folder is required', 'err'); return; }

  try {
    if (channel === 'telegram') {
      const groupId = document.getElementById('fs-gid').value.trim();
      const telegramUserId = (document.getElementById('fs-tgid')?.value||'').trim();
      if (!groupId) { toast(t('wiz.errGroupId'), 'err'); return; }
      if (telegramUserId && !/^\d+$/.test(telegramUserId)) { toast('Telegram User ID must be a number', 'err'); return; }
      await api('POST', '/api/agents', { parentAgentId, agentId, displayName: displayName || agentId, groupId,
        workspaceFolder, model: model === '__default__' ? '' : model, purpose, personality, initialMemory, telegramUserId });
    } else {
      const link = (document.getElementById('fs-discord-link')?.value||'').trim();
      const parsed = parseDiscordLinkOrId(link);
      if (!parsed) { toast('Discord thread link/ID is required', 'err'); return; }
      await api('POST', '/api/agents/discord-sub', { parentAgentId, agentId, displayName: displayName || agentId,
        workspaceFolder, model: model === '__default__' ? '' : model, purpose, personality, initialMemory,
        guildId: parsed.guildId, threadId: parsed.channelId });
    }
    toast(t('wiz.created'), 'ok');
    clearAddForm();
    showRestartBanner();
    await loadAll();
  } catch (e) { toast(e.message, 'err'); }
}

// ── Render Agent Tree ──────────────────────────────────────
function renderAgents() {
  const el = document.getElementById('agentTree');
  if (!S.agents.length) { el.innerHTML = '<div class="empty">' + t('agents.empty') + '</div>'; return; }

  // Build grouping: prefer explicit parentAgentId; fallback to telegram bot-root grouping.
  const byId = {}; (S.agents||[]).forEach(a=>{ byId[a.id]=a; });

  // infer parentAgentId for sub-agents if missing
  const accountToRootId = {};
  (S.agents||[]).forEach(a=>{ if(a.hasOwnBot && a.accountId) accountToRootId[a.accountId]=a.id; });
  (S.agents||[]).forEach(a=>{
    if(a.parentAgentId || a.hasOwnBot || a.id === 'main') return; // already resolved or is a root
    // Case 1: legacy telegram sub-agent with parentAccountId
    if(a.parentAccountId && accountToRootId[a.parentAccountId]){
      a._inferParentAgentId = accountToRootId[a.parentAccountId];
      return;
    }
    // Case 2: orphan agent (no own bot, no parentAgentId, no binding-based inference)
    // These are likely dynamically created sub-agents — default to 'main'
    if(byId['main']){
      a._inferParentAgentId = 'main';
    }
  });

  const roots=[]; const childrenByRoot={};
  (S.agents||[]).forEach(a=>{
    const pid = a.parentAgentId || a._inferParentAgentId || '';
    if(pid && byId[pid]){
      (childrenByRoot[pid] ||= []).push(a);
    } else {
      roots.push(a);
    }
  });

  function fmtBinding(b){
    const ch = (b.channel||'').toLowerCase();
    const peer = b.peerId ? String(b.peerId) : '';
    const acct = b.accountId ? String(b.accountId) : '';
    if(ch==='telegram'){
      if(peer) return '<span class="badge ok ch-badge ch-tg">TG</span> <span class="badge ok">'+esc(peer)+'</span>';
      if(acct) return '<span class="badge ok ch-badge ch-tg">TG Bot</span> <span class="badge">'+esc(acct)+'</span>';
    }
    if(ch==='discord'){
      if(peer) return '<span class="badge ok ch-badge ch-any">Discord</span> <span class="badge">'+esc(peer)+'</span>';
    }
    return '<span class="badge">'+esc(ch||'bind')+'</span>';
  }

  function bindingsLine(a){
    const arr = (a.bindings||[]).filter(x=>x.peerId||x.accountId);
    if(!arr.length) return '';
    return '<div class="tree-meta">🔗 '+arr.map(fmtBinding).join(' · ')+'</div>';
  }

  function agentCard(a, isRoot) {
    let h = '';
    const icon = isRoot ? '🤖' : '🧩';
    const cls  = isRoot ? 'tree-main' : 'tree-child';
    h += '<div class="' + cls + '">';
    h += '<div class="tree-title">' + icon + ' ' + esc(a.name || a.id);
    if (a.id === 'main') h += ' <span class="badge main">' + t('agents.main') + '</span>';
    h += '</div>';
    h += '<div class="tree-meta">🧠 ' + esc(a.effectiveModel) + '</div>';
    if (a.workspace) h += '<div class="tree-meta">📁 ' + esc(a.workspace) + '</div>';
    h += bindingsLine(a);
    h += '<div class="tree-actions">';
    h += '<select class="inline-sel" id="msel-' + a.id + '">' + buildModelOpts(a.effectiveModel !== t('agents.noModel') ? a.effectiveModel : '__default__') + '</select>';
    h += '<button class="btn-secondary" data-action="saveModel" data-id="' + esc(a.id) + '">' + t('agents.saveModel') + '</button>';
    h += '<button class="btn-secondary" data-action="viewWs" data-id="' + esc(a.id) + '">' + t('agents.viewFiles') + '</button>';
    if (a.id !== 'main') h += '<button class="btn-danger" data-action="delAgent" data-id="' + esc(a.id) + '" data-name="' + esc(a.name || a.id) + '">' + t('btn.delete') + '</button>';
    h += '</div></div>';
    return h;
  }

  let html = '<div class="agents-roots">';
  roots.forEach(root => {
    const children = childrenByRoot[root.id] || [];
    html += '<div class="agent-tree-root">';
    html += agentCard(root, true);
    if (children.length) {
      const treeId = 'tree-' + root.id;
      html += '<div class="tree-children-wrap">';
      html += '<button class="tree-toggle" data-tree="' + treeId + '" title="Expand / Collapse">−</button>';
      html += '<div class="tree-children" id="' + treeId + '">';
      children.forEach(c => { html += agentCard(c, false); });
      html += '</div></div>';
    }
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;

  el.onclick = function(ev) {
    const tbtn = ev.target.closest('.tree-toggle');
    if (tbtn && tbtn.dataset.tree) { toggleTree(tbtn.dataset.tree, tbtn); return; }

    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === 'saveModel') saveAgentModel(id);
    else if (action === 'viewWs') viewWorkspace(id);
    else if (action === 'delAgent') deleteAgent(id, btn.dataset.name);
  };
}

function toggleTree(treeId, btn) {
  const el = document.getElementById(treeId);
  if (!el) return;
  el.classList.toggle('collapsed');
  btn.textContent = el.classList.contains('collapsed') ? '+' : '−';
}

function buildModelOpts(selected){
  let opts=\`<option value="__default__"\${selected==='__default__'?' selected':''}>\${t('agents.defaultModel')}</option>\`;
  let lastGroup='';
  S.knownModels.filter(m=>m.id!=='__default__').forEach(m=>{
    if(m.group && m.group!==lastGroup){
      if(lastGroup) opts+=\`</optgroup>\`;
      opts+=\`<optgroup label="\${m.group}">\`;
      lastGroup=m.group;
    }
    opts+=\`<option value="\${m.id}"\${selected===m.id?' selected':''}>\${m.label}</option>\`;
  });
  if(lastGroup) opts+=\`</optgroup>\`;
  return opts;
}

async function saveAgentModel(agentId){
  const sel=document.getElementById('msel-'+agentId);
  if(!sel)return;
  const model=sel.value;
  try{
    await api('PUT','/api/agents/'+encodeURIComponent(agentId),{model});
    document.getElementById('eml-'+agentId).textContent=model==='__default__'?t('agents.noModel')+' ('+S.primaryModel+')':model;
    toast('模型已更新','success'); showRestartBanner();
  }catch(e){toast('保存失败: '+e.message,'error');}
}

// ── 渲染 Channels ────────────────────────────────────────────
function getChannelAgentChoices(){
  const byId={};
  (S.agents||[]).forEach(a=>{
    if(a&&a.id) byId[a.id]=a.name||a.id;
  });
  (S.channels||[]).forEach(ch=>{
    if(ch&&ch.agentId&&!byId[ch.agentId]) byId[ch.agentId]=ch.agentName||ch.agentId;
  });
  return Object.keys(byId).sort((a,b)=>a.localeCompare(b)).map(id=>({id,name:byId[id]}));
}

function renderChannelFilter(){
  const sel=document.getElementById('channelsAgentFilter');
  if(!sel) return;
  const choices=getChannelAgentChoices();
  if(channelFilterAgent!=='__all__' && !choices.some(c=>c.id===channelFilterAgent)){
    channelFilterAgent='__all__';
  }
  let html=\`<option value="__all__"\${channelFilterAgent==='__all__'?' selected':''}>\${esc(t('channels.filterAll'))}</option>\`;
  html+=choices.map(c=>\`<option value="\${esc(c.id)}"\${channelFilterAgent===c.id?' selected':''}>\${esc(c.name)} (\${esc(c.id)})</option>\`).join('');
  sel.innerHTML=html;
}

function onChannelFilterChange(v){
  channelFilterAgent=v||'__all__';
  renderChannels();
}

function toggleRoutingGroup(agentId){
  routingCollapsedByAgent[agentId]=!routingCollapsedByAgent[agentId];
  renderChannels();
}

function renderChannels(){
  const el=document.getElementById('channelList');
  renderChannelFilter();
  if(!S.channels.length){el.innerHTML='<div class="empty">'+t('channels.empty')+'</div>';return;}
  const rows=channelFilterAgent==='__all__'
    ? S.channels
    : S.channels.filter(ch=>ch.agentId===channelFilterAgent);
  if(!rows.length){el.innerHTML='<div class="empty">'+t('channels.emptyFiltered')+'</div>';return;}
  const groups={};
  rows.forEach(ch=>{
    const key=ch.agentId||'unknown';
    if(!groups[key]) groups[key]={ agentId:key, agentName:ch.agentName||key, rows:[] };
    groups[key].rows.push(ch);
  });
  const sortedGroups=Object.values(groups).sort((a,b)=>(a.agentName||a.agentId).localeCompare(b.agentName||b.agentId));
  el.innerHTML=sortedGroups.map(g=>{
    const collapsed=!!routingCollapsedByAgent[g.agentId];
    const listCls=collapsed?'routing-list collapsed':'routing-list';
    const toggleText=collapsed?t('channels.expand'):t('channels.collapse');
    const rowsHtml=g.rows
      .sort((a,b)=>(a.idx||0)-(b.idx||0))
      .map(ch=>{
        const chClass=ch.channel==='telegram'?'ch-tg':'ch-any';
        const peerMeta=ch.peerId
          ? \`📱 Peer ID: <code>\${esc(ch.peerId)}</code>\`
          : t('channels.matchAll');
        return \`<div class="routing-row">
          <div style="min-width:0;flex:1">
            <div class="routing-row-main">
              <span class="badge">#\${ch.idx}</span>
              \${ch.channel?\`<span class="ch-badge \${chClass}">\${esc(ch.channel)}</span>\`:'<span class="ch-badge ch-any">any</span>'}
              \${ch.peerKind?\`<span class="badge">\${esc(ch.peerKind)}</span>\`:''}
              <span class="routing-row-sub">\${peerMeta}</span>
            </div>
          </div>
          <button class="btn-danger" onclick="deleteChannel(\${ch.idx},'#\${ch.idx} \${esc(ch.agentId)}')">\${t('channels.delBinding')}</button>
        </div>\`;
      }).join('');
    return \`<div class="routing-group">
      <div class="routing-group-hdr">
        <div class="routing-group-title">
          <span class="routing-group-name">\${esc(g.agentName)}</span>
          <span class="badge">agent: \${esc(g.agentId)}</span>
          <span class="routing-group-count">\${g.rows.length} \${esc(t('channels.countSuffix'))}</span>
        </div>
        <button class="btn-secondary routing-toggle" onclick="toggleRoutingGroup(decodeURIComponent('\${encodeURIComponent(g.agentId)}'))">\${esc(toggleText)}</button>
      </div>
      <div class="\${listCls}">
        \${rowsHtml}
      </div>
    </div>\`;
  }).join('');
}

function openAddChannel(){
  const sel=document.getElementById('ch-agent');
  sel.innerHTML=''; S.agents.forEach(a=>{ sel.innerHTML+=\`<option value="\${a.id}">\${esc(a.name||a.id)}</option>\`; });
  document.getElementById('ch-peerId').value='';
  openModal('addChannelModal'); applyLang();
}

async function submitAddChannel(){
  const agentId=document.getElementById('ch-agent').value;
  const channel=document.getElementById('ch-channel').value;
  const peerKind=document.getElementById('ch-peerKind').value;
  const peerId=document.getElementById('ch-peerId').value.trim();
  if(!agentId){toast('请选择 Agent','error');return;}
  try{
    await api('POST','/api/channels',{agentId,channel,peerKind,peerId});
    toast('绑定已添加','success'); closeModal('addChannelModal'); await loadChannels(); showRestartBanner();
  }catch(e){toast('失败: '+e.message,'error');}
}

async function deleteChannel(idx,label){
  if(!confirm(\`确定要删除绑定 "\${label}"？\`))return;
  try{
    await api('DELETE','/api/channels/'+idx);
    toast('绑定已删除','success'); await loadChannels(); showRestartBanner();
  }catch(e){toast('失败: '+e.message,'error');}
}

// ── 渲染模型 ─────────────────────────────────────────────────
function renderModels(){
  const listWarn=document.getElementById('modelListWarn');
  if(listWarn){
    if(S.modelListError){
      listWarn.style.display='';
      listWarn.textContent=t('models.modelListErr')+S.modelListError;
    }else if(!S.knownModels.length){
      listWarn.style.display='';
      listWarn.textContent=t('models.modelListEmpty');
    }else{
      listWarn.style.display='none';
      listWarn.textContent='';
    }
  }
  // 检测 primary model 是否是 API Key（显示修复警告）
  const primWarn=document.getElementById('primaryModelWarn');
  if(primWarn){
    const bad = S.primaryModel && !isValidModelId(S.primaryModel);
    primWarn.style.display = bad ? '' : 'none';
    if(bad){
      const masked = S.primaryModel.length > 16
        ? S.primaryModel.slice(0,8)+'...'+ S.primaryModel.slice(-4)
        : S.primaryModel;
      primWarn.innerHTML=\`⚠️ <strong>当前主模型设置异常</strong>：检测到 <code>\${esc(masked)}</code> 像是 API Key 而非模型 ID。
        请从下拉选择正确的模型并保存，或点击下方按钮重置。<br>
        <span style="font-size:11px;color:var(--muted)">提示：模型 ID 格式为 provider/model-name，例如 anthropic/claude-sonnet-4-5</span><br>
        <button class="btn-danger" style="margin-top:8px;font-size:12px" onclick="fixBadPrimaryModel()">🔧 一键重置主模型</button>\`;
    }
  }
  const pSel=document.getElementById('primaryModelSel');
  pSel.innerHTML='<option value="">'+(lang==='en'?'(no models loaded)':'（未加载到模型）')+'</option>';
  S.knownModels.filter(m=>m.id!=='__default__').forEach(m=>{
    pSel.innerHTML+=\`<option value="\${m.id}"\${S.primaryModel===m.id?' selected':''}>\${m.label}</option>\`;
  });
  const fl=document.getElementById('fallbackList');
  fl.innerHTML=S.fallbacks.length
    ? S.fallbacks.map((f,i)=>\`<span class="tag">\${esc(f)} <span class="tag-del" onclick="removeFallback(\${i})">✕</span></span>\`).join('')
    : '<span style="font-size:12px;color:var(--muted)">'+(lang==='en'?'(empty)':'（空）')+'</span>';
}

function isValidModelId(id) {
  // Must be in format provider/model-id, no spaces, not an API key
  if (!id) return false;
  if (!id.includes('/')) return false;
  if (id.length > 120) return false;
  // Reject obvious API keys (long alphanumeric strings, or starts with sk-, gsk_, etc.)
  if (/^(sk-|gsk_|pplx-|sess-|ghp_|github_pat_)/.test(id)) return false;
  // Must only contain provider/model valid chars
  if (!/^[a-zA-Z0-9_./-]+$/.test(id)) return false;
  return true;
}
async function savePrimaryModel(){
  const custom=document.getElementById('primaryModelCustom').value.trim();
  const sel   =document.getElementById('primaryModelSel').value;
  const model = custom || sel;
  if(!model){toast('请选择或填写模型','error');return;}
  if(custom && !isValidModelId(custom)){
    toast('格式错误：模型 ID 应为 provider/model-id（例：anthropic/claude-sonnet-4-5），请勿在此粘贴 API Key。','error');
    return;
  }
  try{
    await api('PUT','/api/models/settings',{primaryModel:model, fallbacks:S.fallbacks});
    S.primaryModel=model; toast('主模型已保存','success'); showRestartBanner();
    document.getElementById('primaryModelCustom').value='';
    renderModels();
  }catch(e){toast('失败: '+e.message,'error');}
}

// 修复被错误设置为 API Key 的主模型 → 重置为第一个已注册模型或留空
async function fixBadPrimaryModel(){
  // 尝试从已注册模型中取第一个可用 ID
  const firstModel = (S.knownModels||[]).map(m=>m.id).find(k => isValidModelId(k));
  const resetTo = firstModel || '';
  if(!confirm(\`将主模型重置为"\${resetTo||'（清空，使用全局默认）'}"？\`)) return;
  try{
    await api('PUT','/api/models/settings',{primaryModel:resetTo, fallbacks:S.fallbacks});
    S.primaryModel=resetTo;
    toast(\`主模型已重置\${resetTo?' 为 '+resetTo:''}\`,'success');
    showRestartBanner(); renderModels();
  }catch(e){toast('重置失败: '+e.message,'error');}
}

function openAddFallback(){
  buildFbDropdown();
  // 显示当前 fallback 列表
  const curEl=document.getElementById('fb-current-list');
  if(curEl){
    if(S.fallbacks.length){
      curEl.innerHTML='当前 Fallback 链：'+S.fallbacks.map((f,i)=>\`<code style="margin-right:4px">\${i+1}. \${esc(f)}</code>\`).join('');
    }else{
      curEl.innerHTML='当前尚未配置 Fallback';
    }
  }
  document.getElementById('fb-custom').value='';
  document.getElementById('fb-sel').value='';
  openModal('addFallbackModal');
}
function buildFbDropdown(){
  const sel=document.getElementById('fb-sel');
  sel.innerHTML='<option value="">── 从内置列表选择 ──</option>';
  // 按 group 分组显示
  const groups={};
  S.knownModels.filter(m=>m.id!=='__default__'&&!S.fallbacks.includes(m.id)).forEach(m=>{
    const g=m.group||'其他';
    if(!groups[g]) groups[g]=[];
    groups[g].push(m);
  });
  Object.entries(groups).forEach(([g,items])=>{
    const og=document.createElement('optgroup');
    og.label=g;
    items.forEach(m=>{ const o=document.createElement('option'); o.value=m.id; o.textContent=m.label; og.appendChild(o); });
    sel.appendChild(og);
  });
}
function onFbSelChange(){ const v=document.getElementById('fb-sel').value; if(v) document.getElementById('fb-custom').value=''; }
function onFbCustomInput(){ const v=document.getElementById('fb-custom').value.trim(); if(v) document.getElementById('fb-sel').value=''; }
async function addFallback(){
  const custom=document.getElementById('fb-custom').value.trim();
  const sel   =document.getElementById('fb-sel').value;
  const model = custom || sel;
  if(!model){toast('请输入或选择模型 ID','error');return;}
  if(!isValidModelId(model)){
    toast('格式错误：模型 ID 应为 provider/model-id（例：deepseek/deepseek-v3），请勿粘贴 API Key。','error');
    return;
  }
  if(S.fallbacks.includes(model)){toast('该模型已在 Fallback 链中','error');return;}
  S.fallbacks.push(model);
  try{
    await api('PUT','/api/models/settings',{primaryModel:S.primaryModel, fallbacks:S.fallbacks});
    closeModal('addFallbackModal'); renderModels(); showRestartBanner();
  }catch(e){ S.fallbacks.pop(); toast('失败: '+e.message,'error'); }
}
async function removeFallback(i){
  const removed=S.fallbacks.splice(i,1);
  try{
    await api('PUT','/api/models/settings',{primaryModel:S.primaryModel, fallbacks:S.fallbacks});
    renderModels(); showRestartBanner();
  }catch(e){ S.fallbacks.splice(i,0,...removed); toast('失败: '+e.message,'error'); }
}

// ── 渲染认证（引导模式）─────────────────────────────────────
function renderAuth(){
  const grid=document.getElementById('authProvGrid');
  // 标记已配置的 provider
  const configured=new Set(Object.keys(S.authProfiles||{}).map(k=>k.toLowerCase()));
  grid.innerHTML=S.authProviders.map(p=>{
    const done=configured.has(p.id);
    return \`<button class="auth-prov-btn\${selectedAuthProv===p.id?' selected':''}\${done?' configured':''}" onclick="selectAuthProv('\${p.id}')">
      <div class="apb-name">\${done?'✅ ':''}\${esc(p.label)}</div>
      <div class="apb-mode">\${p.mode==='oauth'?'OAuth':p.mode==='device'?'Device Flow':'API Token'}</div>
    </button>\`;
  }).join('');
  // Configured list
  const el=document.getElementById('authList');
  const entries=Object.entries(S.authProfiles);
  if(!entries.length){el.innerHTML='<div class="empty">'+(lang==='en'?'No auth configured':'暂无认证配置')+'</div>';return;}
  el.innerHTML=entries.map(([key,p])=>\`<div class="card">
    <div class="card-row">
      <span class="card-title">\${esc(key)}</span>
      <span class="badge">\${p.mode||'token'}</span>
    </div>
    \${p.email?\`<div class="card-meta">📧 \${esc(p.email)}</div>\`:''}
    <div class="card-actions">
      <button class="btn-danger" onclick="deleteAuth('\${esc(key)}')">\${t('btn.remove')}</button>
    </div>
  </div>\`).join('');
}

function selectAuthProv(pid){
  selectedAuthProv=pid;
  const provider=S.authProviders.find(p=>p.id===pid);
  if(!provider)return;
  renderAuth();
  const card=document.getElementById('authActionCard');
  const content=document.getElementById('authActionContent');
  card.style.display='';
  if(provider.mode==='oauth'){
    content.innerHTML=\`
      <p style="font-size:13px;font-weight:600;margin-bottom:10px">\${esc(provider.label)} — OAuth</p>
      <div class="notes">
        <strong>\${t('auth.step1')}</strong><br>
        \${lang==='en'?'This provider uses browser-based OAuth.':'此 Provider 使用浏览器 OAuth 授权。'}<br><br>
        <strong>\${t('auth.step2')}</strong><br>
        <code>\${esc(provider.cliCmd)}</code>
        <button class="copy-cmd-btn" onclick="copyText('\${esc(provider.cliCmd)}')">复制</button><br><br>
        <strong>\${t('auth.onboard')}</strong><br>
        <code>openclaw onboard</code>
        <button class="copy-cmd-btn" onclick="copyText('openclaw onboard')">复制</button>
      </div>\`;
  } else if(provider.mode==='device'){
    content.innerHTML=\`
      <p style="font-size:13px;font-weight:600;margin-bottom:10px">\${esc(provider.label)} — Device Flow</p>
      <div class="notes">
        <strong>\${t('auth.step1')}</strong><br>
        1. \${lang==='en'?'Run in terminal':'在终端运行'}：<code>\${esc(provider.cliCmd)}</code>
        <button class="copy-cmd-btn" onclick="copyText('\${esc(provider.cliCmd)}')">复制</button><br>
        2. \${lang==='en'?'Copy the 8-digit device code':'复制终端显示的 8 位设备码'}<br>
        3. \${lang==='en'?'Open':'打开'}：<a href="https://github.com/login/device" target="_blank" style="color:var(--accent)">github.com/login/device</a><br>
        4. \${lang==='en'?'Paste the code and authorize':'粘贴设备码并授权'}<br><br>
        <strong>\${t('auth.onboard')}</strong><br>
        <code>openclaw onboard</code>
        <button class="copy-cmd-btn" onclick="copyText('openclaw onboard')">复制</button>
      </div>\`;
  } else {
    content.innerHTML=\`
      <p style="font-size:13px;font-weight:600;margin-bottom:10px">\${esc(provider.label)} — API Key</p>
      <div class="notes">
        <strong>\${t('auth.step1')}</strong><br>
        \${esc(provider.hint||'')}<br><br>
        <strong>\${t('auth.step2')}</strong><br>
        <code>\${esc(provider.cliCmd)}</code>
        <button class="copy-cmd-btn" onclick="copyText('\${esc(provider.cliCmd)}')">复制</button><br><br>
        <strong>\${t('auth.step3')}</strong><br>
        \${lang==='en'?'The key is stored securely by OpenClaw, not in config files.':'Key 由 OpenClaw 安全存储，不写入配置文件。'}<br><br>
        <strong>\${t('auth.onboard')}</strong><br>
        <code>openclaw onboard</code>
        <button class="copy-cmd-btn" onclick="copyText('openclaw onboard')">复制</button>
      </div>\`;
  }
}

async function refreshAuthOnly(){
  try{
    const r=await api('GET','/api/models');
    S.authProfiles=r.authProfiles||{};
    S.models=r.models||{}; S.knownModels=r.knownModels||[]; S.modelListError=r.modelListError||'';
    renderAuth(); buildModelDropdowns();
  }catch(e){ toast((lang==='en'?'Refresh failed: ':'刷新失败: ')+e.message,'error'); }
}

async function deleteAuth(key){
  if(!confirm((lang==='en'?'Remove auth "':'移除认证配置 "')+key+'"？'))return;
  try{await api('DELETE','/api/auth/'+encodeURIComponent(key)); toast(lang==='en'?'Removed':'已移除','success'); await refreshAuthOnly();}
  catch(e){toast((lang==='en'?'Failed: ':'失败: ')+e.message,'error');}
}

function copyText(txt){
  navigator.clipboard.writeText(txt).then(()=>toast(lang==='en'?'Copied':'已复制','success')).catch(()=>toast(lang==='en'?'Copy failed':'复制失败','error'));
}

function copyCliCommand(){
  const inp=document.getElementById('cliInput');
  const cmd=(inp&&inp.value?inp.value:'').trim();
  if(!cmd){ toast(lang==='en'?'Nothing to copy (CLI input is empty)':'没有可复制的命令（输入框为空）','error'); return; }
  copyText(cmd);
}


async function deleteAgent(agentId, name){
  if(!confirm(\`确定要删除 Agent "\${name}"？\\n\\n• 将从 openclaw.json 移除（自动备份）\\n• Workspace 目录不删除\\n• 可通过"回滚"功能恢复配置\\n\\n继续？\`))return;
  try{
    const r=await api('DELETE','/api/agents/'+encodeURIComponent(agentId));
    toast('已删除 '+agentId,'success');
    await loadAgents(); await loadChannels(); showRestartBanner();
  }catch(e){toast('删除失败: '+e.message,'error');}
}

let wsCurrentAgent='';
async function viewWorkspace(agentId){
  wsCurrentAgent=agentId;
  const el=document.getElementById('wsContent');
  el.innerHTML='<div class="empty">'+(lang==='en'?'Loading...':'加载中...')+'</div>'; openModal('wsModal');
  try{
    const r=await api('GET','/api/workspace/'+encodeURIComponent(agentId));
    const fileNames=Object.keys(r.files);
    if(!fileNames.length){ el.innerHTML='<div class="empty">'+(lang==='en'?'No files':'暂无文件')+'</div>'; return; }
    el.innerHTML='<p class="hint-text" style="margin-bottom:14px">📁 '+esc(r.workspacePath)+'</p>'
      +fileNames.map(name=>{
        const content=r.files[name];
        const st=r.fileStats&&r.fileStats[name]?r.fileStats[name]:{};
        const sizeStr=st.size!=null?(st.size<1024?st.size+' B':(st.size/1024).toFixed(1)+' KB'):'';
        const mtimeStr=st.mtime?new Date(st.mtime).toLocaleString():'';
        const fid='wsf-'+name.replace(/[^a-zA-Z0-9]/g,'_');
        return \`<div style="margin-bottom:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <div style="display:flex;align-items:center;padding:10px 14px;background:var(--bg);border-bottom:1px solid var(--border)">
            <span style="font-size:13px;font-weight:600;color:var(--accent);flex:1">\${esc(name)}</span>
            <span style="font-size:11px;color:var(--muted);margin-right:10px">\${esc(sizeStr)}\${mtimeStr?' · '+esc(mtimeStr):''}</span>
            \${content!==null?\`<button class="btn-secondary" style="font-size:11px;padding:3px 10px" onclick="wsToggleEdit('\${esc(agentId)}','\${esc(name)}','\${fid}')" id="wsbtn-\${fid}">\${t('ws.edit')}</button>\`:''}
          </div>
          \${content!==null
            ?\`<pre id="pre-\${fid}" style="margin:0;padding:12px 14px;font-size:11px;line-height:1.6;overflow:auto;white-space:pre-wrap;max-height:240px;background:var(--card);color:var(--text)">\${esc(content)}</pre>
              <textarea id="ta-\${fid}" style="display:none;width:100%;box-sizing:border-box;border:none;padding:12px 14px;font-family:monospace;font-size:11px;line-height:1.6;height:240px;resize:vertical;background:var(--card);color:var(--text)">\${esc(content)}</textarea>
              <div id="acts-\${fid}" style="display:none;padding:8px 14px;background:var(--bg);border-top:1px solid var(--border);display:none;gap:8px">
                <button class="btn-primary" style="font-size:12px" onclick="wsSaveFile('\${esc(agentId)}','\${esc(name)}','\${fid}')">\${t('ws.save')}</button>
                <button class="btn-secondary" style="font-size:12px" onclick="wsCancelEdit('\${fid}')">\${t('ws.cancel')}</button>
              </div>\`
            :\`<div style="padding:12px 14px;font-size:12px;color:var(--muted)">\${content===null&&st.size>512*1024?t('ws.large'):(lang==='en'?'(file not found)':'（文件不存在）')}</div>\`}
        </div>\`;
      }).join('');
  }catch(e){el.innerHTML='<div class="empty">'+(lang==='en'?'Failed: ':'加载失败: ')+e.message+'</div>';}
}
function wsToggleEdit(agentId,fname,fid){
  const pre=document.getElementById('pre-'+fid);
  const ta=document.getElementById('ta-'+fid);
  const acts=document.getElementById('acts-'+fid);
  const btn=document.getElementById('wsbtn-'+fid);
  if(ta.style.display==='none'){
    ta.style.display=''; pre.style.display='none'; acts.style.display='flex';
    btn.textContent=t('ws.cancel'); ta.focus();
  } else { wsCancelEdit(fid); }
}
function wsCancelEdit(fid){
  const pre=document.getElementById('pre-'+fid);
  const ta=document.getElementById('ta-'+fid);
  const acts=document.getElementById('acts-'+fid);
  const btn=document.getElementById('wsbtn-'+fid);
  ta.style.display='none'; pre.style.display=''; acts.style.display='none';
  if(btn) btn.textContent=t('ws.edit');
  // revert textarea to pre content
  ta.value=pre.textContent;
}
async function wsSaveFile(agentId,fname,fid){
  const ta=document.getElementById('ta-'+fid);
  try{
    await api('PUT','/api/workspace/'+encodeURIComponent(agentId)+'/'+encodeURIComponent(fname),{content:ta.value});
    toast(t('ws.saved'),'success');
    // update pre with new content
    const pre=document.getElementById('pre-'+fid);
    pre.textContent=ta.value;
    wsCancelEdit(fid);
  }catch(e){toast((lang==='en'?'Save failed: ':'保存失败: ')+e.message,'error');}
}

function buildModelDropdowns(){
  S.agents.forEach(a=>{
    const sel=document.getElementById('msel-'+a.id);
    if(!sel) return;
    const current=a.effectiveModel!=='默认'?a.effectiveModel:'__default__';
    sel.innerHTML=buildModelOpts(current);
  });
}

// ── CLI 终端 ─────────────────────────────────────────────────
const CLI_DEFAULTS = [
  { label: 'openclaw doctor',              cmd: 'openclaw doctor' },
  { label: 'openclaw --version',           cmd: 'openclaw --version' },
  { label: 'openclaw gateway status',      cmd: 'openclaw gateway status' },
  { label: 'openclaw gateway restart',     cmd: 'openclaw gateway restart' },
  { label: 'openclaw gateway start',       cmd: 'openclaw gateway start' },
  { label: 'openclaw gateway stop',        cmd: 'openclaw gateway stop' },
  { label: 'openclaw gateway logs',        cmd: 'openclaw gateway logs' },
  { label: 'openclaw models list',         cmd: 'openclaw models list' },
  { label: 'openclaw models auth list',    cmd: 'openclaw models auth list' },
  { label: 'openclaw agents list',         cmd: 'openclaw agents list' },
  { label: 'openclaw agents sync',         cmd: 'openclaw agents sync' },
  { label: 'openclaw backup create',       cmd: 'openclaw backup create' },
  { label: 'openclaw backup list',         cmd: 'openclaw backup list' },
  { label: 'openclaw config validate',     cmd: 'openclaw config validate' },
  { label: 'openclaw update',              cmd: 'openclaw update' },
];
let cliHistory=[], cliHistIdx=-1, cliEvt=null;

function buildCliPresets(){
  const sel=document.getElementById('cliPreset');
  const favs=JSON.parse(LS.get('ocm_cli_favs','[]'));
  sel.innerHTML='<option value="">'+t('cli.presets')+'</option>';
  const og1=document.createElement('optgroup'); og1.label=t('cli.builtins');
  CLI_DEFAULTS.forEach(c=>{ const o=document.createElement('option'); o.value=c.cmd; o.textContent=c.label; og1.appendChild(o); });
  sel.appendChild(og1);
  if(favs.length){
    const og2=document.createElement('optgroup'); og2.label=t('cli.favs');
    favs.forEach(c=>{ const o=document.createElement('option'); o.value=c.cmd; o.textContent=(c.label||c.cmd); og2.appendChild(o); });
    sel.appendChild(og2);
  }
}

function toggleCliPanel(){
  const p=document.getElementById('cliPanel');
  const open=p.classList.toggle('open');
  const btn=document.getElementById('cliToggleBtn');
  if(btn) btn.classList.toggle('active', open);
  const prb=document.getElementById('pendingRestartBtn');
  if(prb) prb.style.bottom=open?'292px':'24px';
  // Adjust main content padding so content behind panel remains reachable via scroll
  const mainEl=document.querySelector('main');
  if(mainEl) mainEl.style.paddingBottom = open ? (p.offsetHeight+24)+'px' : '';
  if(open){ buildCliPresets(); setTimeout(()=>document.getElementById('cliInput').focus(),100); scrollCliToBottom(); }
}

function onCliPresetSelect(){
  const v=document.getElementById('cliPreset').value;
  if(v){ document.getElementById('cliInput').value=v; document.getElementById('cliInput').focus(); }
  document.getElementById('cliPreset').value='';
}

function addCliToFavorites(){
  const cmd=document.getElementById('cliInput').value.trim();
  if(!cmd){ toast(t('cli.fav.empty'),'error'); return; }
  const favs=JSON.parse(LS.get('ocm_cli_favs','[]'));
  if(favs.find(f=>f.cmd===cmd)){ toast(t('cli.fav.dup'),'error'); return; }
  const label=prompt(t('cli.favprompt'),cmd.slice(0,50));
  if(label===null) return;
  favs.push({label:label||cmd, cmd});
  LS.set('ocm_cli_favs',JSON.stringify(favs));
  buildCliPresets();
  toast(t('cli.fav.saved')+': '+(label||cmd),'success');
}

function openCliManage(){
  const favs=JSON.parse(LS.get('ocm_cli_favs','[]'));
  const list=document.getElementById('cliManageList');
  if(!favs.length){
    list.innerHTML='<div class="empty" style="padding:20px;text-align:center">'+
      (lang==='en'?'No saved commands yet.':'暂无收藏命令')+'</div>';
  } else {
    list.innerHTML=favs.map((f,i)=>'<div class="fav-manage-row">'+
      '<div style="flex:1;overflow:hidden">'+
        '<div class="fav-manage-label">'+esc(f.label||f.cmd)+'</div>'+
        '<div class="fav-manage-cmd">'+esc(f.cmd)+'</div>'+
      '</div>'+
      '<button class="btn-secondary" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="editCliFav('+i+')">✏️</button>'+
      '<button class="btn-danger" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="deleteCliFav('+i+')">✕</button>'+
    '</div>').join('');
  }
  document.getElementById('cliManageModal').classList.add('open');
}

function deleteCliFav(i){
  const favs=JSON.parse(LS.get('ocm_cli_favs','[]'));
  favs.splice(i,1);
  LS.set('ocm_cli_favs',JSON.stringify(favs));
  buildCliPresets();
  openCliManage();
}

function editCliFav(i){
  const favs=JSON.parse(LS.get('ocm_cli_favs','[]'));
  const f=favs[i];
  const newLabel=prompt((lang==='en'?'Edit name:':'修改名称：'),f.label||f.cmd);
  if(newLabel===null) return;
  const newCmd=prompt((lang==='en'?'Edit command:':'修改命令：'),f.cmd);
  if(newCmd===null||!newCmd.trim()) return;
  favs[i]={label:newLabel||newCmd.trim(), cmd:newCmd.trim()};
  LS.set('ocm_cli_favs',JSON.stringify(favs));
  buildCliPresets();
  openCliManage();
}

function cliAppend(text,cls){
  const out=document.getElementById('cliOutput');
  const span=document.createElement('span');
  if(cls) span.className=cls;
  span.textContent=text;
  out.appendChild(span);
  scrollCliToBottom();
}

function scrollCliToBottom(){ const o=document.getElementById('cliOutput'); if(o) o.scrollTop=o.scrollHeight; }

function clearCliOutput(){ document.getElementById('cliOutput').innerHTML='<span style="color:#555">'+t('cli.cleared')+'</span>'; }

function setCliRunning(running){
  const sb=document.getElementById('cliStopBtn');
  if(sb) sb.style.display=running?'':'none';
}

function killCli(){
  if(cliEvt){ try{cliEvt.close();}catch(_){} cliEvt=null; }
  setCliRunning(false);
  cliAppend('\\n⏹ 已中止\\n','cli-done-err');
}

function runCli(){
  const inp=document.getElementById('cliInput');
  const cmd=inp.value.trim();
  if(!cmd){ toast('请输入命令','error'); return; }
  if(!cliHistory.length||cliHistory[0]!==cmd) cliHistory.unshift(cmd);
  if(cliHistory.length>50) cliHistory.pop();
  cliHistIdx=-1; inp.value='';
  if(cliEvt){ try{cliEvt.close();}catch(_){} cliEvt=null; }
  const out=document.getElementById('cliOutput');
  // Clear ready/cleared placeholder
  if(out.children.length===1 && out.children[0].id==='cliReadyMsg') out.innerHTML='';
  if(out.textContent===t('cli.cleared')) out.innerHTML='';
  cliAppend('\\n$ '+cmd+'\\n','cli-cmd-line');
  setCliRunning(true);
  const es=new EventSource('/api/cli/stream?cmd='+encodeURIComponent(cmd));
  cliEvt=es;
  es.addEventListener('out',e=>{
    try{ cliAppend(JSON.parse(e.data).text); }catch(_){}
  });
  es.addEventListener('done',e=>{
    try{
      const d=JSON.parse(e.data);
      if(d.code===0) cliAppend('\\n✅ Done (exit 0)\\n','cli-done-ok');
      else cliAppend('\\n❌ Exit code '+d.code+'\\n','cli-done-err');
    }catch(_){}
    es.close(); cliEvt=null; setCliRunning(false);
  });
  es.addEventListener('error',e=>{
    try{ cliAppend('\\n⚠ '+(JSON.parse(e.data).message||'命令执行出错')+'\\n','cli-done-err'); }catch(_){}
    es.close(); cliEvt=null; setCliRunning(false);
  });
  es.onerror=()=>{ if(es.readyState===EventSource.CLOSED){ cliEvt=null; setCliRunning(false); } };
}

function onCliKey(e){
  if(e.key==='Tab'){ e.preventDefault(); cliTabComplete(e.target); return; }
  if(e.key==='Escape'){ cliCloseAC(); return; }
  if(e.key==='Enter'){ cliCloseAC(); runCli(); return; }
  if(e.key==='ArrowUp'){
    e.preventDefault();
    if(cliHistIdx<cliHistory.length-1){ cliHistIdx++; e.target.value=cliHistory[cliHistIdx]; }
  } else if(e.key==='ArrowDown'){
    e.preventDefault();
    if(cliHistIdx>0){ cliHistIdx--; e.target.value=cliHistory[cliHistIdx]; }
    else if(cliHistIdx===0){ cliHistIdx=-1; e.target.value=''; }
  }
  // 其他键关闭补全菜单
  if(e.key!=='Tab'&&e.key!=='ArrowUp'&&e.key!=='ArrowDown') cliCloseAC();
}

// ── CLI Tab 补全 ─────────────────────────────────────────────
const CLI_SUBCOMMANDS=['openclaw','doctor','gateway','models','agents','backup','config','auth',
  'restart','start','stop','status','logs','list','create','validate','update','onboard','sync',
  'paste-token','--provider','--version','--dir','--port','--host'];

function cliTabComplete(input){
  const val=input.value;
  const words=val.split(/\\s+/);
  const lastWord=words[words.length-1]||'';
  if(!lastWord){ return; }
  // 收集候选: subcommands + preset commands + history
  const candidates=new Set();
  CLI_SUBCOMMANDS.forEach(c=>candidates.add(c));
  CLI_DEFAULTS.forEach(c=>candidates.add(c.cmd));
  cliHistory.forEach(c=>candidates.add(c));
  // 过滤: 如果是完整命令行匹配（words.length>1 时只匹配最后一个词）
  let matches=[];
  if(words.length===1){
    // 匹配完整命令或第一个词
    matches=[...candidates].filter(c=>c.toLowerCase().startsWith(lastWord.toLowerCase()));
  } else {
    // 匹配子命令词
    matches=[...CLI_SUBCOMMANDS,...CLI_DEFAULTS.map(c=>c.cmd.split(/\\s+/).pop())]
      .filter(c=>c.toLowerCase().startsWith(lastWord.toLowerCase()));
    matches=[...new Set(matches)];
  }
  if(matches.length===0) return;
  if(matches.length===1){
    // 单一匹配：直接补全
    if(words.length===1){ input.value=matches[0]; }
    else { words[words.length-1]=matches[0]; input.value=words.join(' '); }
    cliCloseAC();
  } else {
    // 多个匹配：找公共前缀先补全，同时显示候选列表
    const prefix=commonPrefix(matches);
    if(prefix.length>lastWord.length){
      if(words.length===1){ input.value=prefix; }
      else { words[words.length-1]=prefix; input.value=words.join(' '); }
    }
    cliShowAC(matches.slice(0,12),input);
  }
}
function commonPrefix(arr){
  if(!arr.length) return '';
  let p=arr[0];
  for(let i=1;i<arr.length;i++){
    while(!arr[i].toLowerCase().startsWith(p.toLowerCase())&&p.length>0) p=p.slice(0,-1);
  }
  return p;
}
function cliShowAC(items,input){
  cliCloseAC();
  const box=document.createElement('div');
  box.id='cliACBox';
  box.style.cssText='position:absolute;bottom:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border);border-radius:6px;max-height:180px;overflow-y:auto;z-index:200;box-shadow:0 -4px 12px rgba(0,0,0,.3)';
  items.forEach(item=>{
    const d=document.createElement('div');
    d.textContent=item;
    d.style.cssText='padding:6px 12px;font-size:12px;font-family:monospace;cursor:pointer;color:var(--text);border-bottom:1px solid var(--border)';
    d.onmouseover=()=>{d.style.background='rgba(108,99,255,.15)';};
    d.onmouseout=()=>{d.style.background='';};
    d.onclick=()=>{ input.value=item; input.focus(); cliCloseAC(); };
    box.appendChild(d);
  });
  const row=input.closest('.cli-input-row');
  if(row){ row.style.position='relative'; row.appendChild(box); }
}
function cliCloseAC(){ const b=document.getElementById('cliACBox'); if(b) b.remove(); }

// ── 工具栏操作 ───────────────────────────────────────────────

// 拖拽调整 CLI 面板高度
(function(){
  const handle=document.getElementById('cliResizeHandle');
  if(!handle) return;
  let sy=0, sh=0;
  handle.addEventListener('mousedown',function(e){
    sy=e.clientY; sh=document.getElementById('cliOutput').offsetHeight;
    e.preventDefault();
    document.addEventListener('mousemove',onDrag);
    document.addEventListener('mouseup',function(){ document.removeEventListener('mousemove',onDrag); },{once:true});
  });
  function onDrag(e){
    const newH=Math.max(80,Math.min(600,sh+(sy-e.clientY)));
    document.getElementById('cliOutput').style.height=newH+'px';
    const prb=document.getElementById('pendingRestartBtn');
    if(prb) prb.style.bottom=(newH+72)+'px';
  }
})();

// ── Stats (Usage Statistics) ────────────────────────────────
async function loadStats(){
  try{
    const days=document.getElementById('statsDaysFilter')?.value||1;
    const r=await api('GET','/api/stats?days='+days);
    const s=r.summary||{};
    document.getElementById('statsTotalInput').textContent=fmtNum(s.totalInputTokens||0);
    document.getElementById('statsTotalOutput').textContent=fmtNum(s.totalOutputTokens||0);
    document.getElementById('statsCacheRead').textContent=fmtNum(s.totalCacheRead||0);
    document.getElementById('statsTotalCost').textContent=s.estimatedCost||'$0';
    const totalReqs=Object.values(r.byModel||{}).reduce((a,b)=>a+(b.requestCount||0),0);
    document.getElementById('statsTotalReqs').textContent=fmtNum(totalReqs);
    // by model
    const bmEl=document.getElementById('statsByModel');
    const bmEntries=Object.entries(r.byModel||{}).sort((a,b)=>(b[1].requestCount||0)-(a[1].requestCount||0));
    bmEl.innerHTML=bmEntries.length?bmEntries.map(([m,d])=>'<div class="card" style="padding:12px">' +
      '<div style="font-size:13px;font-weight:600;margin-bottom:6px">' + esc(m) + '</div>' +
      '<div style="font-size:12px;color:var(--muted);line-height:1.8">In: ' + fmtNum(d.inputTokens) + ' · Out: ' + fmtNum(d.outputTokens) + ' · Cache: ' + fmtNum(d.cacheRead||0) + ' · ' + d.requestCount + ' reqs · $' + d.cost + '</div>' +
    '</div>').join(''):'<div class="empty" style="padding:20px">'+t('stats.noData')+'</div>';
    // by agent
    const baEl=document.getElementById('statsByAgent');
    const baEntries=Object.entries(r.byAgent||{}).sort((a,b)=>(b[1].requestCount||0)-(a[1].requestCount||0));
    baEl.innerHTML=baEntries.length?baEntries.map(([a,d])=>'<div class="card" style="padding:12px">' +
      '<div style="font-size:13px;font-weight:600;margin-bottom:6px">' + esc(a) + '</div>' +
      '<div style="font-size:12px;color:var(--muted);line-height:1.8">In: ' + fmtNum(d.inputTokens) + ' · Out: ' + fmtNum(d.outputTokens) + ' · ' + d.requestCount + ' reqs · $' + d.cost + '</div>' +
    '</div>').join(''):'<div class="empty" style="padding:20px">No data</div>';
    // by day chart
    const chartEl=document.getElementById('statsChart');
    const dayEntries=Object.entries(r.byDay||{}).sort((a,b)=>a[0].localeCompare(b[0]));
    if(!dayEntries.length){ chartEl.innerHTML='<div class="empty" style="width:100%;text-align:center">'+t('stats.noData')+'</div>'; return; }
    const maxTk=Math.max(...dayEntries.map(([,d])=>(d.inputTokens||0)+(d.outputTokens||0)),1);
    chartEl.innerHTML=dayEntries.map(([day,d])=>{
      const total=(d.inputTokens||0)+(d.outputTokens||0);
      const pct=Math.max(2,total/maxTk*100);
      return '<div style="flex:1;min-width:12px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%" title="' + day + ': ' + fmtNum(total) + ' tokens · $' + d.cost + '">' +
        '<div style="width:100%;max-width:28px;background:var(--accent);height:' + pct + '%;border-radius:3px 3px 0 0;opacity:.8;min-height:2px"></div>' +
        '<div style="font-size:8px;color:var(--muted);margin-top:3px;writing-mode:vertical-rl;transform:rotate(180deg)">' + day.slice(5) + '</div>' +
      '</div>';
    }).join('');
  }catch(e){ toast('Stats load failed: '+e.message,'error'); }
}
function fmtNum(n){ if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'K'; return String(n); }

// ── Cron（计划任务）──────────────────────────────────────────
async function loadCrons(){
  try{
    const r=await api('GET','/api/cron');
    const el=document.getElementById('cronList');
    if(!r.crons||!r.crons.length){ el.innerHTML='<div class="empty">'+t('cron.empty')+'</div>'; return; }
    el.innerHTML=r.crons.map(c=>\`<div class="card" style="padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
        <div style="flex:1;overflow:hidden">
          <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(c.command)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">⏰ \${esc(c.schedule)}\${c.label?' · '+esc(c.label):''}</div>
        </div>
        <span class="badge \${c.enabled?'ok':'warn'}" style="margin-left:8px">\${c.enabled?t('cron.enabled'):t('cron.disabled')}</span>
      </div>
      <div class="card-actions" style="gap:6px">
        <button class="btn-secondary" style="font-size:11px;padding:4px 10px" onclick="toggleCron(\${c.idx},\${c.enabled})">\${c.enabled?(lang==='en'?'Disable':'禁用'):(lang==='en'?'Enable':'启用')}</button>
        <button class="btn-secondary" style="font-size:11px;padding:4px 10px" onclick="runCronNow(\${c.idx})">\${t('cron.run')}</button>
        <button class="btn-danger" style="font-size:11px;padding:4px 10px" onclick="deleteCron(\${c.idx})">\${t('btn.delete')}</button>
      </div>
    </div>\`).join('');
  }catch(e){ toast((lang==='en'?'Cron load failed: ':'任务加载失败: ')+e.message,'error'); }
}
function openAddCron(){
  document.getElementById('cron-schedule').value='';
  document.getElementById('cron-command').value='';
  document.getElementById('cron-label').value='';
  openModal('addCronModal');
}
async function submitAddCron(){
  const schedule=document.getElementById('cron-schedule').value.trim();
  const command=document.getElementById('cron-command').value.trim();
  const label=document.getElementById('cron-label').value.trim();
  if(!schedule||!command){toast(lang==='en'?'Fill in expression and command':'请填写表达式和命令','error');return;}
  try{
    await api('POST','/api/cron',{schedule,command,label:label||'openclaw-manager'});
    toast(lang==='en'?'Task added':'任务已添加','success');
    closeModal('addCronModal'); await loadCrons();
  }catch(e){toast((lang==='en'?'Failed: ':'失败: ')+e.message,'error');}
}
async function toggleCron(idx,currentEnabled){
  try{
    await api('PUT','/api/cron/'+idx,{enabled:!currentEnabled});
    await loadCrons();
  }catch(e){toast((lang==='en'?'Failed: ':'失败: ')+e.message,'error');}
}
async function runCronNow(idx){
  toast(lang==='en'?'Running...':'执行中...','info');
  try{
    const r=await api('POST','/api/cron/'+idx+'/run');
    toast(lang==='en'?'Done':'完成','success');
  }catch(e){toast((lang==='en'?'Failed: ':'失败: ')+e.message,'error');}
}
async function deleteCron(idx){
  if(!confirm(lang==='en'?'Delete this task?':'删除此任务？'))return;
  try{ await api('DELETE','/api/cron/'+idx); toast(lang==='en'?'Deleted':'已删除','success'); await loadCrons(); }
  catch(e){toast((lang==='en'?'Failed: ':'失败: ')+e.message,'error');}
}

// ── 工具栏操作 ───────────────────────────────────────────────
function toggleMenu(){document.getElementById('mainMenu').classList.toggle('open');}
document.addEventListener('click',e=>{
  const app=document.getElementById('mainApp');
  if(app&&!e.target.closest('.menu-wrap'))document.getElementById('mainMenu').classList.remove('open');
});

async function doRestart(){
  closeMenu(); dismissBanner(); hidePendingRestart();
  document.getElementById('cmdTitle').textContent=t('actions.restartTitle');
  document.getElementById('cmdOutput').textContent=t('actions.running'); openModal('cmdModal');
  try{
    const r=await api('POST','/api/gateway/restart');
    document.getElementById('cmdOutput').textContent=r.output||t('actions.restartSent');
    toast(t('actions.restartOk'),'success');
  }catch(e){
    document.getElementById('cmdOutput').textContent='❌ '+e.message+'\\n\\n'+t('actions.restartManualHint');
    toast(t('actions.restartFail')+e.message,'error');
  }
}
async function doDoctor(){
  closeMenu();
  document.getElementById('cmdTitle').textContent=t('actions.doctorTitle');
  document.getElementById('cmdOutput').textContent=t('actions.running'); openModal('cmdModal');
  try{
    const r=await api('POST','/api/gateway/doctor');
    document.getElementById('cmdOutput').textContent=r.output||t('actions.noOutput');
  }catch(e){document.getElementById('cmdOutput').textContent='❌ '+e.message;}
}
async function manualBackup(){
  closeMenu();
  try{const r=await api('POST','/api/config/backup'); toast(t('actions.backupSaved')+r.bakPath.split('/').pop(),'success');}
  catch(e){toast(t('actions.backupFail')+e.message,'error');}
}
function openConfigDir(){ closeMenu(); api('POST','/api/folder/open').catch(()=>{}); }
function closeMenu(){ document.getElementById('mainMenu').classList.remove('open'); }

// ── 日志 ─────────────────────────────────────────────────────
async function openLogs(){ closeMenu(); openModal('logModal'); await refreshLogs(); }
async function refreshLogs(){
  try{
    const r=await api('GET','/api/logs?n=300');
    document.getElementById('logContent').textContent=r.content||t('actions.logEmpty');
    document.getElementById('logPath').textContent=r.path||'';
    const lb=document.getElementById('logContent'); lb.scrollTop=lb.scrollHeight;
  }catch(e){document.getElementById('logContent').textContent=t('actions.logLoadFail')+e.message;}
}
function toggleAutoRefresh(){
  const cb=document.getElementById('autoRefresh');
  if(cb.checked){ logTimer=setInterval(refreshLogs,2000); }
  else{ clearInterval(logTimer); logTimer=null; }
}
function closeLogs(){ clearInterval(logTimer); logTimer=null; document.getElementById('autoRefresh').checked=false; closeModal('logModal'); }

// ── 回滚 ─────────────────────────────────────────────────────
async function openRollback(){
  closeMenu(); openModal('rollbackModal');
  const el=document.getElementById('backupList');
  el.innerHTML='<div class="empty">'+t('common.loading')+'</div>';
  try{
    const r=await api('GET','/api/backups');
    if(!r.backups.length){el.innerHTML='<div class="empty">'+t('actions.noBackups')+'</div>';return;}
    el.innerHTML=r.backups.map(f=>\`<div class="card">
      <div class="card-row"><span class="card-title" style="font-size:13px">\${esc(f)}</span></div>
      <div class="card-actions"><button class="btn-warn" onclick="doRestore('\${esc(f)}')">\${t('actions.restoreThis')}</button></div>
    </div>\`).join('');
  }catch(e){el.innerHTML='<div class="empty">'+t('actions.loadFailed')+'</div>';}
}
async function doRestore(filename){
  const confirmMsg=t('actions.restoreConfirm').replace('{filename}',filename);
  if(!confirm(confirmMsg))return;
  try{
    await api('POST','/api/backups/restore',{filename});
    toast(t('actions.restored')+filename,'success');
    closeModal('rollbackModal'); await loadAll(); showRestartBanner();
  }catch(e){toast(t('actions.restoreFail')+e.message,'error');}
}

// ── NAS 备份 ─────────────────────────────────────────────────
async function openNasModal(){
  closeMenu();
  const cfg=await api('GET','/api/backup/nas-config');
  document.getElementById('nas-host').value=cfg.nasHost||'';
  document.getElementById('nas-port').value=cfg.nasPort||'22';
  document.getElementById('nas-user').value=cfg.nasUser||'';
  document.getElementById('nas-sshkey').value=cfg.nasSshKey||'';
  document.getElementById('nas-path').value=cfg.nasPath||'/volume1/OpenClaw/backups';
  document.getElementById('nas-legacy').checked=!!cfg.nasLegacyCipher;
  document.getElementById('nas-password').value='';
  document.getElementById('nas-result').style.display='none';
  document.getElementById('nas-cron-section').style.display='none';
  document.getElementById('nas-pubkey-box').style.display='none';
  const authType=cfg.nasAuth||'password';
  document.getElementById(authType==='key'?'nas-auth-key':'nas-auth-pw').checked=true;
  nasAuthChange();
  const bkType=cfg.nasBackupType||'full';
  document.getElementById(bkType==='essential'?'nas-bk-ess':'nas-bk-full').checked=true;
  openModal('nasModal');
}
function nasAuthChange(){
  const isKey=document.getElementById('nas-auth-key').checked;
  document.getElementById('nas-pw-section').style.display=isKey?'none':'';
  document.getElementById('nas-key-section').style.display=isKey?'':'none';
}
function nasGetConfig(){
  return {
    nasHost:       document.getElementById('nas-host').value.trim(),
    nasPort:       document.getElementById('nas-port').value.trim()||'22',
    nasUser:       document.getElementById('nas-user').value.trim(),
    nasAuth:       document.getElementById('nas-auth-key').checked?'key':'password',
    nasSshKey:     document.getElementById('nas-sshkey').value.trim(),
    nasPath:       document.getElementById('nas-path').value.trim(),
    nasLegacyCipher: document.getElementById('nas-legacy').checked,
    nasBackupType: document.getElementById('nas-bk-ess').checked?'essential':'full',
  };
}
function nasShowResult(text,ok){
  const el=document.getElementById('nas-result');
  el.style.display=''; el.style.color=ok?'var(--success)':'#f85149';
  el.textContent=text;
}
async function nasGenKey(){
  const cfg=nasGetConfig();
  await api('PUT','/api/backup/nas-config',{...cfg,nasEnabled:true});
  try{const r=await api('POST','/api/backup/nas-keygen');
    document.getElementById('nas-sshkey').value=r.keyPath;
    const box=document.getElementById('nas-pubkey-box');
    box.style.display=''; box.textContent=t('nas.pubkeyHint')+'\\n'+r.pubKey;
    nasShowResult(t('nas.keyGenOk'),true);
  }catch(e){nasShowResult(t('nas.keyGenFail')+e.message,false);}
}
async function nasTest(){
  const cfg=nasGetConfig();
  if(!cfg.nasHost||!cfg.nasUser){nasShowResult(t('nas.errNoHost'),false);return;}
  await api('PUT','/api/backup/nas-config',{...cfg,nasEnabled:true});
  nasShowResult(t('nas.testing'),true);
  try{
    const pwd=cfg.nasAuth==='password'?document.getElementById('nas-password').value:'';
    const r=await api('POST','/api/backup/nas-test',{password:pwd});
    nasShowResult(r.ok?t('nas.testOk'):t('nas.testFail')+(r.error||r.output),r.ok);
  }catch(e){nasShowResult('❌ '+e.message,false);}
}
async function nasBackupNow(){
  const cfg=nasGetConfig();
  if(!cfg.nasHost||!cfg.nasUser){nasShowResult(t('nas.errNoHost'),false);return;}
  await api('PUT','/api/backup/nas-config',{...cfg,nasEnabled:true});
  nasShowResult(t('nas.backing'),true);
  try{
    const pwd=cfg.nasAuth==='password'?document.getElementById('nas-password').value:'';
    const r=await api('POST','/api/backup/nas-now',{password:pwd});
    nasShowResult(t('nas.backupOk')+r.tarName,true);
    toast(t('nas.backupToast'),'success');
  }catch(e){nasShowResult(t('nas.backupFail')+e.message,false);}
}
function openNasCron(){
  const sec=document.getElementById('nas-cron-section');
  sec.style.display=sec.style.display==='none'?'':'none';
}
async function nasSetCron(){
  const cfg=nasGetConfig();
  if(!cfg.nasHost||!cfg.nasUser){nasShowResult(t('nas.errNoHost'),false);return;}
  await api('PUT','/api/backup/nas-config',{...cfg,nasEnabled:true});
  try{
    const pwd=cfg.nasAuth==='password'?document.getElementById('nas-password').value:'';
    const cronTime=document.getElementById('nas-cron-time').value||'03:00';
    const r=await api('POST','/api/backup/nas-cron',{password:pwd,cronTime});
    nasShowResult(t('nas.cronOk')+'('+cronTime+')',true);
    toast(t('nas.cronToast'),'success');
  }catch(e){nasShowResult('❌ '+e.message,false);}
}


// ── 目录设置 ─────────────────────────────────────────────────
function openSetupModal(){ closeMenu(); openModal('setupModal'); }
async function submitSetup(){
  const dir=document.getElementById('setup-dir').value.trim();
  const err=document.getElementById('setup-err');
  if(!dir){err.textContent=t('actions.setupEmpty');return;}
  try{
    const r=await api('POST','/api/setup',{dir});
    if(r.ok){ toast(t('actions.setupSwitching'),'success'); setTimeout(()=>location.reload(),800); }
    else err.textContent=r.error||t('actions.setupInvalid');
  }catch(e){err.textContent=t('actions.setupReqFail')+e.message;}
}

// ── 重启横幅 ─────────────────────────────────────────────────
function showRestartBanner(){ document.getElementById('restartBanner').classList.add('show'); }
function dismissBanner(){ document.getElementById('restartBanner').classList.remove('show'); }
function deferRestart(){
  dismissBanner();
  document.getElementById('pendingRestartBtn').style.display='block';
}
function hidePendingRestart(){
  document.getElementById('pendingRestartBtn').style.display='none';
}

// ── 密码显示切换 ─────────────────────────────────────────────
function togglePwd(inputId,btn){
  const el=document.getElementById(inputId);
  if(!el)return;
  if(el.type==='password'){el.type='text';btn.textContent='🙈';}
  else{el.type='password';btn.textContent='👁';}
}

// ── 工具 ─────────────────────────────────────────────────────
const OCM_CLIENT_VERSION='${APP_VERSION}';
async function api(method,path,body){
  const opts={method,headers:{'Content-Type':'application/json'}};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(path,opts);
  const sv=r.headers.get('X-OCM-Version');
  if(sv&&sv!==OCM_CLIENT_VERSION&&!window._ocmVersionWarn){window._ocmVersionWarn=true;toast('Server updated to v'+sv+'. Refresh page for latest version.','info');}
  const d=await r.json();
  if(!r.ok){ const e=new Error(d.error||r.status); e.data=d; e.status=r.status; throw e; }
  return d;
}
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
function setDot(s){const el=document.getElementById('dot');if(el)el.className='dot '+s;}
function toast(msg,type='info'){
  const c=document.getElementById('toast');
  const el=document.createElement('div');
  el.style.cssText='background:var(--card);border:1px solid var(--border);border-radius:8px;padding:11px 15px;font-size:13px;max-width:340px;animation:fadeIn .2s';
  if(type==='success') el.style.borderColor='var(--success)';
  if(type==='error')   el.style.borderColor='var(--danger)';
  el.textContent=msg;
  c.appendChild(el);
  setTimeout(()=>el.remove(),4500);
}
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Tabs ─────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('panel-'+t.dataset.tab).classList.add('active');
    // lazy-load
    if(t.dataset.tab==='dashboard'&&!dashLoaded) loadDashboard();
    if(t.dataset.tab==='stats') loadStats();
    if(t.dataset.tab==='cron') loadCrons();
  });
});

// ── On load: initialize app ──────────────────────────────────
(function() {
  LS.del('ocm_mode');
  applyLang();
  checkStatus().then(() => { loadAll(); setTimeout(() => loadDashboard(), 0); }).catch(e => console.error('Init error:', e));
  startHealthPolling();
})();`;

const MAIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw Manager</title>
<style>

${MAIN_HTML_CSS}
</style>
</head>
<body>
${MAIN_HTML_BODY}
<script>
${MAIN_HTML_SCRIPT}
</script>
</body></html>`;

function assertBrowserScriptSyntax(name, scriptText) {
  const tmpFile = path.join(os.tmpdir(), `ocm-${name}-${process.pid}.js`);
  fs.writeFileSync(tmpFile, scriptText, 'utf8');
  const r = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8', timeout: 5000 });
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || 'unknown syntax error').trim();
    throw new Error(
      `${name} syntax check failed.\n${detail}\nHint: in MAIN_HTML_SCRIPT strings, write "\\\\n" instead of "\\n".`
    );
  }
}


function parseDiscordLinkOrId(input){
  const raw=(input||'').trim();
  if(!raw) return null;
  // URL form: https://discord.com/channels/<guildId>/<channelId>
  const m = raw.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)/i);
  if(m) return { guildId: m[1], channelId: m[2] };
  // Accept plain numeric id
  if(/^\d+$/.test(raw)) return { guildId: '', channelId: raw };
  // Accept channel:<id>
  const m2 = raw.match(/^channel:(\d+)$/i);
  if(m2) return { guildId: '', channelId: m2[1] };
  return null;
}
assertBrowserScriptSyntax('main-html-script', MAIN_HTML_SCRIPT);

// ── HTTP 服务器 ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-OCM-Version', APP_VERSION);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (urlObj.pathname.startsWith('/api/')) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await parseBody(req) : {};
      await handleApi(req, res, urlObj, body);
    } else {
      const needsSetup = !(await configExists());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'ETag': '"ocm-' + APP_VERSION + '"' });
      res.end(needsSetup ? SETUP_HTML : MAIN_HTML);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://localhost:${PORT}`;
  console.log('');
  console.log(`🦀 OpenClaw Manager v${APP_VERSION}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📂 Dir:   ' + OPENCLAW_DIR);
  console.log('🌐 Local: ' + localUrl);
  if (HOST === '0.0.0.0') {
    const lanIp = getLanIP();
    if (lanIp) console.log('🌐 LAN:   ' + `http://${lanIp}:${PORT}`);
  }
  console.log('💡 Switch dir: node openclaw-manager.js --dir /path/to/.openclaw');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Ctrl+C to stop');
  if (!process.env.ELECTRON) openBrowser(localUrl);
  // Notify Electron main process that server is ready
  if (process.send) process.send({ type: 'server-ready', port: PORT });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE')
    console.error(`❌ Port ${PORT} is already in use. Close the other process or use --port to specify a different port.`);
  else
    console.error('❌ Failed to start:', err.message);
  process.exit(1);
});

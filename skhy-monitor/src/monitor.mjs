import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = {
  targetNotionalUsd: 6000,
  adrRatio: 10,
  pollIntervalMs: 5000,
  confirmations: 2,
  rearmBufferPct: 0.3,
  maxNotionalImbalancePct: 1,
  entryTiers: [
    { id: 1, entryPct: 39.5, takeProfitPct: 37 },
    { id: 2, entryPct: 40.5, takeProfitPct: 38 },
    { id: 3, entryPct: 41.5, takeProfitPct: 39 },
  ],
};

const KRAKEN_BOOK_URL = 'https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=PF_SKHYUSD';
const KRAKEN_INSTRUMENT_URL = 'https://futures.kraken.com/derivatives/api/v3/instruments';
const GATE_BOOK_URL = 'https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=SKHYNIX_USDT&limit=50';
const GATE_CONTRACT_URL = 'https://api.gateio.ws/api/v4/futures/usdt/contracts/SKHYNIX_USDT';
const TELEGRAM_API = 'https://api.telegram.org/bot';
const EPSILON = 1e-12;

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}`);
  return parsed;
}

function roundDown(value, step) {
  return Math.floor((value + EPSILON) / step) * step;
}

function roundTo(value, decimals) {
  return Number(value.toFixed(decimals));
}

function sortLevels(levels, direction) {
  return [...levels].sort((left, right) => direction === 'desc'
    ? right.price - left.price
    : left.price - right.price);
}

export function normalizeKrakenBook(payload) {
  if (payload?.result !== 'success' || !payload.orderBook) throw new Error('Kraken order book unavailable');
  const normalize = (rows) => rows.map((row) => ({
    price: number(row[0], 'Kraken price'),
    size: number(row[1], 'Kraken size'),
  })).filter((row) => row.price > 0 && row.size > 0);
  return {
    bids: sortLevels(normalize(payload.orderBook.bids ?? []), 'desc'),
    asks: sortLevels(normalize(payload.orderBook.asks ?? []), 'asc'),
  };
}

export function normalizeGateBook(payload) {
  if (!payload || !Array.isArray(payload.bids) || !Array.isArray(payload.asks)) {
    throw new Error('Gate order book unavailable');
  }
  const normalize = (rows) => rows.map((row) => ({
    price: number(row.p, 'Gate price'),
    size: number(row.s, 'Gate size'),
  })).filter((row) => row.price > 0 && row.size > 0);
  return {
    bids: sortLevels(normalize(payload.bids), 'desc'),
    asks: sortLevels(normalize(payload.asks), 'asc'),
    update: payload.update ? number(payload.update, 'Gate update time') * 1000 : null,
  };
}

export function fillBaseQuantity(levels, quantity) {
  let remaining = quantity;
  let filled = 0;
  let notional = 0;
  for (const level of levels) {
    if (remaining <= EPSILON) break;
    const take = Math.min(remaining, level.size);
    filled += take;
    notional += take * level.price;
    remaining -= take;
  }
  return {
    requested: quantity,
    filled,
    notional,
    vwap: filled > EPSILON ? notional / filled : null,
    complete: remaining <= Math.max(EPSILON, quantity * 1e-9),
  };
}

export function fillGateContracts(levels, contracts, multiplier) {
  let remaining = contracts;
  let filledContracts = 0;
  let notional = 0;
  for (const level of levels) {
    if (remaining <= EPSILON) break;
    const take = Math.min(remaining, level.size);
    filledContracts += take;
    notional += take * multiplier * level.price;
    remaining -= take;
  }
  const assetQuantity = filledContracts * multiplier;
  return {
    requestedContracts: contracts,
    filledContracts,
    assetQuantity,
    notional,
    vwap: assetQuantity > EPSILON ? notional / assetQuantity : null,
    complete: remaining <= Math.max(EPSILON, contracts * 1e-9),
  };
}

function candidateGateContracts(notional, gateLevels, multiplier, minimumContracts) {
  const bestPrice = gateLevels[0]?.price;
  if (!bestPrice) return [];
  const ideal = notional / bestPrice / multiplier;
  const floorValue = Math.floor(ideal);
  const candidates = new Set([
    Math.max(minimumContracts, floorValue),
    Math.max(minimumContracts, floorValue + 1),
  ]);
  return [...candidates].filter((value) => Number.isFinite(value) && value >= minimumContracts);
}

function quoteForQuantity({ quantity, krakenLevels, gateLevels, gateMultiplier, minimumGateContracts, adrRatio }) {
  const kraken = fillBaseQuantity(krakenLevels, quantity);
  if (!kraken.complete || !kraken.vwap) return null;
  const gateCandidates = candidateGateContracts(
    kraken.notional,
    gateLevels,
    gateMultiplier,
    minimumGateContracts,
  );
  const choices = gateCandidates.map((contracts) => {
    const gate = fillGateContracts(gateLevels, contracts, gateMultiplier);
    if (!gate.complete || !gate.vwap) return null;
    const imbalancePct = Math.abs(kraken.notional - gate.notional) / kraken.notional * 100;
    return {
      quantity,
      kraken,
      gate,
      imbalancePct,
      premiumPct: (kraken.vwap * adrRatio / gate.vwap - 1) * 100,
    };
  }).filter(Boolean);
  return choices.sort((left, right) => left.imbalancePct - right.imbalancePct)[0] ?? null;
}

export function calculateSuggestedQuote({
  targetNotionalUsd,
  adrRatio,
  krakenLevels,
  gateLevels,
  gateMultiplier,
  minimumGateContracts = 1,
  quantityStep = 0.01,
}) {
  if (!krakenLevels.length || !gateLevels.length) throw new Error('Order book is empty');
  const centerPrice = krakenLevels[0].price;
  const centerQuantity = targetNotionalUsd / centerPrice;
  const centerStep = Math.max(1, Math.round(centerQuantity / quantityStep));
  const radius = 25;
  const choices = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    const units = centerStep + offset;
    if (units <= 0) continue;
    const quantity = roundTo(units * quantityStep, 8);
    const quote = quoteForQuantity({
      quantity,
      krakenLevels,
      gateLevels,
      gateMultiplier,
      minimumGateContracts,
      adrRatio,
    });
    if (quote) choices.push(quote);
  }
  if (!choices.length) throw new Error('Insufficient order-book depth for target notional');
  return choices.sort((left, right) => {
    const leftDistance = Math.abs(left.kraken.notional - targetNotionalUsd) / targetNotionalUsd;
    const rightDistance = Math.abs(right.kraken.notional - targetNotionalUsd) / targetNotionalUsd;
    const leftScore = leftDistance + left.imbalancePct / 100 * 4;
    const rightScore = rightDistance + right.imbalancePct / 100 * 4;
    return leftScore - rightScore;
  })[0];
}

export function calculatePremium({ krakenPrice, gatePrice, adrRatio }) {
  return (krakenPrice * adrRatio / gatePrice - 1) * 100;
}

export function mergeConfig(input = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    entryTiers: input.entryTiers ?? DEFAULT_CONFIG.entryTiers,
  };
}

export function emptyState() {
  return {
    paused: false,
    entered: {},
    entryAlerted: {},
    exitAlerted: {},
    entryCounts: {},
    exitCounts: {},
    dataFailureCount: 0,
    dataFailureAlerted: false,
    lastQuote: null,
  };
}

export async function loadState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return { ...emptyState(), ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, statePath);
}

async function fetchJson(url, timeoutMs = 3500, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function telegramCall(token, method, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${TELEGRAM_API}${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram ${method} failed`);
  return payload.result;
}

export async function discoverTelegramChats(token, fetchImpl = fetch) {
  const updates = await telegramCall(token, 'getUpdates', {
    offset: 0,
    timeout: 0,
    allowed_updates: ['message'],
  }, fetchImpl);
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat;
    if (!chat?.id) continue;
    const threadId = update.message?.message_thread_id ?? null;
    const key = `${chat.id}:${threadId ?? 'general'}`;
    chats.set(key, {
      chatId: String(chat.id),
      threadId,
      type: chat.type,
      username: chat.username ?? null,
      name: [chat.title, chat.first_name, chat.last_name].filter(Boolean).join(' ') || null,
      topicMessage: update.message?.forum_topic_created?.name ?? null,
    });
  }
  return [...chats.values()];
}

export async function fetchPublicSnapshot({ fetchImpl = fetch, cachedContract = null } = {}) {
  const [krakenPayload, gatePayload, contractPayload] = await Promise.all([
    fetchJson(KRAKEN_BOOK_URL, 3500, fetchImpl),
    fetchJson(GATE_BOOK_URL, 3500, fetchImpl),
    cachedContract ? Promise.resolve(null) : fetchJson(GATE_CONTRACT_URL, 3500, fetchImpl),
  ]);
  const krakenBook = normalizeKrakenBook(krakenPayload);
  const gateBook = normalizeGateBook(gatePayload);
  const contract = cachedContract ?? {
    multiplier: number(contractPayload.quanto_multiplier, 'Gate contract multiplier'),
    minimumContracts: Math.max(1, Math.ceil(number(contractPayload.order_size_min, 'Gate minimum order size'))),
  };
  if (contract.multiplier <= 0 || !krakenBook.bids.length || !krakenBook.asks.length
    || !gateBook.bids.length || !gateBook.asks.length) {
    throw new Error('One or more official order books are empty');
  }
  return { krakenBook, gateBook, contract, checkedAt: new Date().toISOString() };
}

function beijingTime(iso = new Date().toISOString()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function format(value, digits = 2) {
  return Number(value).toFixed(digits);
}

export function formatEntryMessage({ tier, quote, config }) {
  const gateQty = quote.gate.assetQuantity;
  const gateContracts = Math.floor(quote.gate.filledContracts + EPSILON);
  return [
    `【第${tier.id}档开仓机会】`,
    `北京时间：${beijingTime()}`,
    `可成交开仓价差：${format(quote.premiumPct)}%（目标线 ≥${format(tier.entryPct, 1)}%）`,
    '方向：空 Kraken SKHY / 多 Gate SKHYNIX',
    '',
    'Gate CrossEx 填写：',
    `每笔订单数量：${format(quote.quantity)} SKHY`,
    `最大仓位：${format(quote.quantity)} SKHY`,
    '',
    `预计 Gate 对冲：${format(gateQty, 3)} SKHYNIX（${gateContracts} 张）`,
    `两边名义金额：${format(quote.kraken.notional)} U / ${format(quote.gate.notional)} U`,
    `名义金额偏差：${format(quote.imbalancePct)}%`,
    `数据时间：${beijingTime(config.checkedAt ?? new Date().toISOString())}`,
    '',
    '这是行情机会提醒，不代表已成交；下单前重新核对页面数量和盘口。',
  ].join('\n');
}

export function formatExitMessage({ tier, quote }) {
  return [
    `【第${tier.id}档止盈机会】`,
    `北京时间：${beijingTime()}`,
    `可成交平仓价差：${format(quote.premiumPct)}%（目标线 ≤${format(tier.takeProfitPct, 1)}%）`,
    '方向：买回 Kraken SKHY / 卖出 Gate SKHYNIX',
    '',
    `如果你已实际持有第${tier.id}档，可在 Gate CrossEx 手动止盈。`,
    `参考数量：${format(quote.quantity)} SKHY；Gate 约${format(quote.gate.assetQuantity, 3)} SKHYNIX（${Math.floor(quote.gate.filledContracts + EPSILON)} 张）`,
    '这不是已平仓确认；实际成交会受盘口、手续费和资金费影响。',
  ].join('\n');
}

class TelegramClient {
  constructor(token, chatId, threadId = null, fetchImpl = fetch) {
    this.token = token;
    this.chatId = String(chatId);
    this.threadId = threadId === undefined || threadId === null || threadId === ''
      ? null
      : Number(threadId);
    this.fetchImpl = fetchImpl;
    this.offset = 0;
  }

  async call(method, body) {
    return telegramCall(this.token, method, body, this.fetchImpl);
  }

  async send(text) {
    return this.call('sendMessage', {
      chat_id: this.chatId,
      ...(this.threadId ? { message_thread_id: this.threadId } : {}),
      text,
      disable_web_page_preview: true,
    });
  }

  async updates() {
    const updates = await this.call('getUpdates', { offset: this.offset, timeout: 0, allowed_updates: ['message'] });
    for (const update of updates) this.offset = Math.max(this.offset, update.update_id + 1);
    return updates.filter((update) => String(update.message?.chat?.id) === this.chatId);
  }
}

function parseCommand(text) {
  const match = String(text ?? '').trim().match(/^\/(\w+)(?:@\w+)?(?:\s+(\d+))?$/i);
  return match ? { name: match[1].toLowerCase(), tier: match[2] ? Number(match[2]) : null } : null;
}

export class Monitor {
  constructor({ config = DEFAULT_CONFIG, statePath = resolve('data/state.json'), fetchImpl = fetch, telegram = null, logger = console } = {}) {
    this.config = mergeConfig(config);
    this.statePath = statePath;
    this.fetchImpl = fetchImpl;
    this.telegram = telegram;
    this.logger = logger;
    this.state = emptyState();
    this.cachedContract = null;
  }

  async init() {
    this.state = await loadState(this.statePath);
  }

  async notify(text) {
    if (!this.telegram) return;
    await this.telegram.send(text);
  }

  async handleCommands() {
    if (!this.telegram) return;
    const updates = await this.telegram.updates();
    for (const update of updates) {
      const command = parseCommand(update.message?.text);
      if (!command) continue;
      if (command.name === 'entered' || command.name === 'enter') {
        if (![1, 2, 3].includes(command.tier)) continue;
        this.state.entered[command.tier] = true;
        this.state.exitAlerted[command.tier] = false;
        this.state.exitCounts[command.tier] = 0;
        await this.notify(`已记录：你手动开了第${command.tier}档；达到对应止盈线时提醒。`);
      } else if (command.name === 'closed' || command.name === 'close') {
        if (![1, 2, 3].includes(command.tier)) continue;
        delete this.state.entered[command.tier];
        this.state.exitAlerted[command.tier] = false;
        this.state.exitCounts[command.tier] = 0;
        await this.notify(`已记录：第${command.tier}档已手动平仓。`);
      } else if (command.name === 'pause') {
        this.state.paused = true;
        await this.notify('已暂停交易机会提醒；故障提醒仍保留。');
      } else if (command.name === 'resume') {
        this.state.paused = false;
        await this.notify('已恢复交易机会提醒。');
      } else if (command.name === 'status') {
        const entered = Object.keys(this.state.entered).filter((id) => this.state.entered[id]);
        await this.notify(`监控状态：${this.state.paused ? '已暂停' : '运行中'}\n已标记持仓档位：${entered.length ? entered.join('、') : '无'}\n最近价差：${this.state.lastQuote?.entryPremiumPct === undefined ? '暂无' : `${format(this.state.lastQuote.entryPremiumPct)}%`}`);
      }
    }
  }

  async checkOnce() {
    await this.handleCommands();
    let snapshot;
    try {
      snapshot = await fetchPublicSnapshot({ fetchImpl: this.fetchImpl, cachedContract: this.cachedContract });
      this.cachedContract = snapshot.contract;
      this.state.dataFailureCount = 0;
      if (this.state.dataFailureAlerted) {
        await this.notify('【监控恢复】Kraken 与 Gate 官方公开盘口已恢复，继续正常检查。');
        this.state.dataFailureAlerted = false;
      }
    } catch (error) {
      this.state.dataFailureCount += 1;
      if (this.state.dataFailureCount >= 3 && !this.state.dataFailureAlerted) {
        await this.notify(`【监控异常】连续${this.state.dataFailureCount}次无法取得两边官方盘口，已停止发送交易机会提醒。原因：${error.message}`);
        this.state.dataFailureAlerted = true;
      }
      await saveState(this.statePath, this.state);
      return { ok: false, error };
    }

    const entryQuote = calculateSuggestedQuote({
      targetNotionalUsd: this.config.targetNotionalUsd,
      adrRatio: this.config.adrRatio,
      krakenLevels: snapshot.krakenBook.bids,
      gateLevels: snapshot.gateBook.asks,
      gateMultiplier: snapshot.contract.multiplier,
      minimumGateContracts: snapshot.contract.minimumContracts,
    });
    const exitQuote = calculateSuggestedQuote({
      targetNotionalUsd: this.config.targetNotionalUsd,
      adrRatio: this.config.adrRatio,
      krakenLevels: snapshot.krakenBook.asks,
      gateLevels: snapshot.gateBook.bids,
      gateMultiplier: snapshot.contract.multiplier,
      minimumGateContracts: snapshot.contract.minimumContracts,
    });
    this.state.lastQuote = {
      checkedAt: snapshot.checkedAt,
      entryPremiumPct: entryQuote.premiumPct,
      exitPremiumPct: exitQuote.premiumPct,
      entryQuantity: entryQuote.quantity,
      exitQuantity: exitQuote.quantity,
    };

    for (const tier of this.config.entryTiers) {
      const entryUsable = entryQuote.imbalancePct <= this.config.maxNotionalImbalancePct;
      const entryTriggered = entryUsable && entryQuote.premiumPct >= tier.entryPct;
      this.state.entryCounts[tier.id] = entryTriggered ? (this.state.entryCounts[tier.id] ?? 0) + 1 : 0;
      if (!this.state.paused && entryTriggered
        && this.state.entryCounts[tier.id] >= this.config.confirmations
        && !this.state.entryAlerted[tier.id]) {
        await this.notify(formatEntryMessage({ tier, quote: entryQuote, config: this.state.lastQuote }));
        this.state.entryAlerted[tier.id] = true;
      }
      if (entryQuote.premiumPct < tier.entryPct - this.config.rearmBufferPct) {
        this.state.entryAlerted[tier.id] = false;
        this.state.entryCounts[tier.id] = 0;
      }

      const exitUsable = exitQuote.imbalancePct <= this.config.maxNotionalImbalancePct;
      const exitTriggered = Boolean(this.state.entered[tier.id])
        && exitUsable && exitQuote.premiumPct <= tier.takeProfitPct;
      this.state.exitCounts[tier.id] = exitTriggered ? (this.state.exitCounts[tier.id] ?? 0) + 1 : 0;
      if (!this.state.paused && exitTriggered
        && this.state.exitCounts[tier.id] >= this.config.confirmations
        && !this.state.exitAlerted[tier.id]) {
        await this.notify(formatExitMessage({ tier, quote: exitQuote }));
        this.state.exitAlerted[tier.id] = true;
      }
      if (exitQuote.premiumPct > tier.takeProfitPct + this.config.rearmBufferPct) {
        this.state.exitAlerted[tier.id] = false;
        this.state.exitCounts[tier.id] = 0;
      }
    }
    await saveState(this.statePath, this.state);
    return { ok: true, entryQuote, exitQuote, snapshot };
  }

  async run() {
    await this.init();
    this.logger.info(`SKHY monitor started; polling every ${this.config.pollIntervalMs}ms`);
    while (true) {
      try {
        await this.checkOnce();
      } catch (error) {
        this.logger.error(error);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.config.pollIntervalMs));
    }
  }
}

async function loadConfig() {
  const configPath = process.env.MONITOR_CONFIG;
  if (!configPath) return DEFAULT_CONFIG;
  return JSON.parse(await readFile(configPath, 'utf8'));
}

async function main() {
  const config = await loadConfig();
  const statePath = process.env.MONITOR_STATE_PATH ?? resolve('data/state.json');
  const once = process.argv.includes('--once');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (process.argv.includes('--telegram-check')) {
    if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in .env first');
    const bot = await telegramCall(token, 'getMe', {});
    console.log(`Telegram 连接成功：@${bot.username}`);
    return;
  }
  if (process.argv.includes('--chat-id')) {
    if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in .env first');
    const chats = await discoverTelegramChats(token);
    if (!chats.length) {
      console.log('还没有收到消息。请先在 Telegram 打开你的机器人并点击 Start，然后再运行 npm run chat-id。');
      return;
    }
    console.log(JSON.stringify(chats, null, 2));
    return;
  }
  if (once) {
    const result = await fetchPublicSnapshot();
    const entryQuote = calculateSuggestedQuote({
      targetNotionalUsd: config.targetNotionalUsd ?? 6000,
      adrRatio: config.adrRatio ?? 10,
      krakenLevels: result.krakenBook.bids,
      gateLevels: result.gateBook.asks,
      gateMultiplier: result.contract.multiplier,
      minimumGateContracts: result.contract.minimumContracts,
    });
    console.log(JSON.stringify({ checkedAt: result.checkedAt, entryQuote }, null, 2));
    return;
  }
  if (!token || !process.env.TELEGRAM_CHAT_ID) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID before starting');
  }
  const telegram = new TelegramClient(
    token,
    process.env.TELEGRAM_CHAT_ID,
    process.env.TELEGRAM_THREAD_ID,
  );
  await new Monitor({
    config,
    statePath,
    telegram,
  }).run();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

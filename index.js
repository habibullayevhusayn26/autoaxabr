require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const input = require('input');
const { Telegraf, Markup } = require('telegraf');
const { TelegramClient, utils } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const botToken = process.env.BOT_TOKEN;
const ownerId = Number(process.env.OWNER_ID);
const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const groupsFile = path.join(__dirname, '.data', 'groups.json');
const autoPostsFile = path.join(__dirname, '.data', 'auto-posts.json');
const sessionFile = path.join(__dirname, '.data', 'user-session.txt');

if (!botToken) {
  throw new Error('BOT_TOKEN .env faylida sozlanishi kerak.');
}

if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
  throw new Error('OWNER_ID .env faylida haqiqiy Telegram ID sifatida sozlanishi kerak.');
}

if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
  throw new Error('API_ID va API_HASH .env faylida sozlanishi kerak.');
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath} faylini o‘qib bo‘lmadi. JSON formatini tekshiring.`, { cause: error });
  }
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadGroups() {
  const groups = loadJson(groupsFile, []);
  if (!Array.isArray(groups) || groups.some((group) =>
    !group || !Number.isSafeInteger(group.id) || typeof group.title !== 'string'
  )) {
    throw new Error('.data/groups.json faylining formati noto‘g‘ri.');
  }

  return groups;
}

function saveGroups(groups) {
  saveJson(groupsFile, groups);
}

function loadAutoPosts() {
  const posts = loadJson(autoPostsFile, {});
  if (!posts || typeof posts !== 'object' || Array.isArray(posts)) {
    throw new Error('.data/auto-posts.json faylining formati noto‘g‘ri.');
  }

  for (const [groupId, post] of Object.entries(posts)) {
    if (
      !Number.isSafeInteger(Number(groupId)) ||
      !post ||
      typeof post.message !== 'string' ||
      !(Number.isInteger(post.intervalSeconds) && post.intervalSeconds >= 1) &&
        !(Number.isInteger(post.intervalMinutes) && post.intervalMinutes >= 1 && post.intervalMinutes <= 10080) ||
      typeof post.enabled !== 'boolean'
    ) {
      throw new Error(`.data/auto-posts.json faylida noto‘g‘ri sozlama bor (${groupId}).`);
    }

    if (!post.intervalSeconds) {
      post.intervalSeconds = post.intervalMinutes * 60;
      delete post.intervalMinutes;
    }
  }

  return posts;
}

function saveAutoPosts(posts) {
  saveJson(autoPostsFile, posts);
}

function isOwner(ctx) {
  return ctx.from && ctx.from.id === ownerId;
}

function isPrivateChat(ctx) {
  return ctx.chat && ctx.chat.type === 'private';
}

function getGroupTitle(groupId) {
  const group = groups.find((item) => item.id === Number(groupId));
  return group ? group.title : String(groupId);
}

async function refreshAccountGroups() {
  const dialogs = await userClient.getDialogs({});
  groups = dialogs
    .filter((dialog) => dialog.isGroup && dialog.entity)
    .map((dialog) => ({
      id: Number(utils.getPeerId(dialog.entity)),
      title: dialog.title || String(dialog.id),
    }))
    .filter((group) => Number.isSafeInteger(group.id));
  saveGroups(groups);
}

function buildGroupKeyboard(page = 0) {
  const pageSize = 80;
  const pageCount = Math.ceil(groups.length / pageSize);
  const pageGroups = groups.slice(page * pageSize, (page + 1) * pageSize);
  const buttons = [];

  for (let index = 0; index < pageGroups.length; index += 2) {
    buttons.push(pageGroups.slice(index, index + 2).map((group) =>
      Markup.button.callback(group.title.slice(0, 64), `select_group:${group.id}`)
    ));
  }

  if (pageCount > 1) {
    const navigation = [];
    if (page > 0) {
      navigation.push(Markup.button.callback('⬅️ Oldingi', `group_page:${page - 1}`));
    }
    if (page < pageCount - 1) {
      navigation.push(Markup.button.callback('Keyingi ➡️', `group_page:${page + 1}`));
    }
    buttons.push(navigation);
  }

  return Markup.inlineKeyboard(buttons);
}

const bot = new Telegraf(botToken);
let groups = loadGroups();
const autoPosts = loadAutoPosts();
const autoPostTimers = new Map();
const pendingConfig = new Map();
let userClient;

function clearAutoTimer(groupId) {
  const timer = autoPostTimers.get(groupId);
  if (timer) {
    timer.stopped = true;
    clearTimeout(timer.timeout);
    autoPostTimers.delete(groupId);
  }
}

function persistAutoPost(groupId, data) {
  autoPosts[groupId] = data;
  saveAutoPosts(autoPosts);
}

function stopAutoPost(groupId) {
  clearAutoTimer(groupId);
  delete autoPosts[groupId];
  saveAutoPosts(autoPosts);
}

async function sendMessageToGroup(groupId, message) {
  if (!userClient) {
    throw new Error('Telegram user client hali tayyor emas.');
  }

  const normalizedId = Number(groupId);
  const dialogs = await userClient.getDialogs({});
  const dialog = dialogs.find(({ entity }) => Number(utils.getPeerId(entity)) === normalizedId);

  if (!dialog) {
    throw new Error(`Shaxsiy akkaunt ${normalizedId} guruhida yo‘q`);
  }

  await userClient.sendMessage(dialog.entity, { message });
}

function parseInterval(text) {
  const match = text.trim().toLowerCase().match(/^(\d+)\s*([a-z]+)?$/u);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2] || 'min';
  const secondsByUnit = {
    s: 1,
    sec: 1,
    second: 1,
    seconds: 1,
    soniya: 1,
    son: 1,
    m: 60,
    min: 60,
    minute: 60,
    minutes: 60,
    daqiqa: 60,
    daq: 60,
    h: 3600,
    hr: 3600,
    hour: 3600,
    hours: 3600,
    soat: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
    kun: 86400,
  };
  const unitSeconds = secondsByUnit[unit];
  if (!Number.isSafeInteger(amount) || amount <= 0 || !unitSeconds) {
    return null;
  }

  const intervalSeconds = amount * unitSeconds;
  return Number.isSafeInteger(intervalSeconds) && intervalSeconds <= 30 * 86400
    ? intervalSeconds
    : null;
}

function formatInterval(intervalSeconds) {
  if (intervalSeconds % 86400 === 0) {
    const days = intervalSeconds / 86400;
    return `${days} kun`;
  }
  if (intervalSeconds % 3600 === 0) {
    const hours = intervalSeconds / 3600;
    return `${hours} soat`;
  }
  if (intervalSeconds % 60 === 0) {
    const minutes = intervalSeconds / 60;
    return `${minutes} daqiqa`;
  }

  return `${intervalSeconds} soniya`;
}

function registerAutoPost(groupId, message, intervalSeconds) {
  const normalizedGroupId = Number(groupId);
  const validSeconds = Number(intervalSeconds);

  if (!Number.isSafeInteger(validSeconds) || validSeconds < 1 || validSeconds > 30 * 86400) {
    throw new Error('Takrorlash oralig‘i 1 soniyadan 30 kungacha bo‘lishi kerak.');
  }

  clearAutoTimer(normalizedGroupId);
  persistAutoPost(normalizedGroupId, {
    groupId: normalizedGroupId,
    message,
    intervalSeconds: validSeconds,
    enabled: true,
    lastSentAt: null,
  });

  const timer = { stopped: false, timeout: null };
  autoPostTimers.set(normalizedGroupId, timer);
  const intervalMs = validSeconds * 1000;
  const maxTimeoutMs = 2147483647;
  let nextSendAt = Date.now() + intervalMs;

  const scheduleNext = () => {
    if (timer.stopped) {
      return;
    }

    timer.timeout = setTimeout(async () => {
      if (timer.stopped) {
        return;
      }
      const remainingMs = nextSendAt - Date.now();
      if (remainingMs > 0) {
        scheduleNext();
        return;
      }

      try {
        const post = autoPosts[normalizedGroupId];
        if (!post || !post.enabled) {
          return;
        }

        await sendMessageToGroup(normalizedGroupId, post.message);
        post.lastSentAt = Date.now();
        saveAutoPosts(autoPosts);
      } catch (error) {
        console.error(`Avto-xabar yuborilmadi (${normalizedGroupId}):`, error);
      }

      nextSendAt = Date.now() + intervalMs;
      scheduleNext();
    }, Math.min(Math.max(1, nextSendAt - Date.now()), maxTimeoutMs));
  };

  scheduleNext();
}

function restoreAutoPosts() {
  Object.entries(autoPosts).forEach(([groupId, post]) => {
    if (post && post.enabled && post.message && (post.intervalSeconds || post.intervalMinutes)) {
      registerAutoPost(groupId, post.message, post.intervalSeconds || post.intervalMinutes * 60);
    }
  });
}

bot.start(async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply('Guruhlar ro‘yxatini olish uchun botga shaxsiy chatda /start yuboring.');
  }

  try {
    await refreshAccountGroups();
  } catch (error) {
    console.error('Akkaunt guruhlarini olishda xatolik:', error);
    return ctx.reply('Akkauntdagi guruhlar ro‘yxatini olib bo‘lmadi. Telegram akkaunti ulanganini tekshiring.');
  }

  if (groups.length === 0) {
    return ctx.reply('Akkauntingizda guruh topilmadi. Kerakli guruhga avval shaxsiy akkauntingiz bilan qo‘shiling.');
  }

  return ctx.reply(
    `Akkauntingiz a’zo bo‘lgan ${groups.length} ta guruh topildi. Avto-xabar o‘rnatish uchun guruhni tanlang:`,
    buildGroupKeyboard()
  );
});

bot.action(/group_page:(\d+)/, async (ctx) => {
  if (!isOwner(ctx) || !isPrivateChat(ctx)) {
    return ctx.answerCbQuery('Bu bot faqat egasi uchun.');
  }

  const page = Number(ctx.match[1]);
  const pageCount = Math.ceil(groups.length / 80);
  if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
    return ctx.answerCbQuery('Sahifa topilmadi.');
  }

  await ctx.answerCbQuery();
  return ctx.editMessageReplyMarkup(buildGroupKeyboard(page).reply_markup);
});

bot.help(async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }

  return ctx.reply(
    'Shaxsiy chatda:\n' +
    '/start yoki /groups — akkauntingizdagi guruhlarni ko‘rish va tanlash\n' +
    '/send xabar matni — barcha ulangan guruhlarga akkauntingiz nomidan yuborish\n' +
    '/auto off ID — guruhdagi avtomatik xabarni to‘xtatish\n' +
    '/status — avtomatik xabar holati'
  );
});

bot.command('status', async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }

  if (Object.keys(autoPosts).length === 0) {
    return ctx.reply('Hozircha avtomatik xabar rejalari yo‘q.');
  }

  const lines = Object.values(autoPosts).map((post) =>
    `• ${getGroupTitle(post.groupId)} — ${post.message.slice(0, 32)}${post.message.length > 32 ? '...' : ''} (${formatInterval(post.intervalSeconds || post.intervalMinutes * 60)})`
  );

  return ctx.reply(`Avtomatik xabarlar:\n${lines.join('\n')}`);
});

bot.command('auto', async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }

  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args[0] === 'off') {
    const targetGroup = args[1] ? Number(args[1]) : null;
    if (!Number.isSafeInteger(targetGroup)) {
      return ctx.reply('Foydalanish: /auto off 123456789');
    }

    if (!autoPosts[targetGroup]) {
      return ctx.reply('Bu guruhda faol avtomatik xabar topilmadi.');
    }

    stopAutoPost(targetGroup);
    return ctx.reply(`Guruh uchun avtomatik xabar to‘xtatildi: ${getGroupTitle(targetGroup)}`);
  }

  return ctx.reply('Foydalanish: /auto off 123456789');
});

bot.command('addgroup', async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }
  if (isPrivateChat(ctx)) {
    return ctx.reply('Guruhni ulash uchun bu buyruqni guruh ichida yuboring.');
  }

  const group = {
    id: ctx.chat.id,
    title: ctx.chat.title || String(ctx.chat.id),
  };
  const existingIndex = groups.findIndex((savedGroup) => savedGroup.id === group.id);

  if (existingIndex === -1) {
    groups.push(group);
  } else {
    groups[existingIndex] = group;
  }

  saveGroups(groups);
  return ctx.reply(`Guruh ulandi: ${group.title}`);
});

bot.command('groups', async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply('Guruhlar ro‘yxatini shaxsiy chatda ko‘ring.');
  }

  try {
    await refreshAccountGroups();
  } catch (error) {
    console.error('Akkaunt guruhlarini olishda xatolik:', error);
    return ctx.reply('Akkauntdagi guruhlar ro‘yxatini olib bo‘lmadi.');
  }

  if (groups.length === 0) {
    return ctx.reply('Akkauntingizda guruh topilmadi.');
  }

  return ctx.reply(
    `Akkauntingizdagi guruhlar (${groups.length}). Avto-xabar sozlash uchun guruhni tanlang:`,
    buildGroupKeyboard()
  );
});

bot.command('removegroup', async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply('Guruhni o‘chirish uchun shaxsiy chatda /removegroup ID yuboring.');
  }

  const chatIdText = ctx.message.text.trim().split(/\s+/, 2)[1];
  const chatId = Number(chatIdText);
  if (!chatIdText || !Number.isSafeInteger(chatId)) {
    return ctx.reply('Foydalanish: /removegroup ID');
  }

  const updatedGroups = groups.filter((group) => group.id !== chatId);
  if (updatedGroups.length === groups.length) {
    return ctx.reply('Bu ID bilan ulangan guruh topilmadi.');
  }

  groups = updatedGroups;
  saveGroups(groups);
  stopAutoPost(chatId);
  return ctx.reply('Guruh ro‘yxatdan o‘chirildi.');
});

bot.command('send', async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply('Bu bot faqat egasi uchun.');
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply('Xabar yuborishni faqat bot bilan shaxsiy chatda boshlang.');
  }

  try {
    await refreshAccountGroups();
  } catch (error) {
    console.error('Akkaunt guruhlarini olishda xatolik:', error);
    return ctx.reply('Akkauntdagi guruhlar ro‘yxatini olib bo‘lmadi.');
  }

  const message = ctx.message.text.replace(/^\/send(?:@\w+)?(?:\s+|$)/, '').trim();
  if (!message) {
    return ctx.reply('Xabar matnini kiriting: /send Sizning xabaringiz');
  }
  if (message.length > 4096) {
    return ctx.reply('Xabar 4096 belgidan oshmasligi kerak.');
  }
  if (groups.length === 0) {
    return ctx.reply('Akkauntingizda xabar yuborish mumkin bo‘lgan guruh topilmadi.');
  }

  const results = [];
  for (const group of groups) {
    try {
      await sendMessageToGroup(group.id, message);
      results.push(`✅ ${group.title}`);
    } catch (error) {
      console.error(`Guruhga xabar yuborilmadi (${group.id}):`, error);
      results.push(`❌ ${group.title} (akkaunt a’zoligi va yozish ruxsatini tekshiring)`);
    }
  }

  return ctx.reply(`Yuborish natijasi:\n${results.join('\n')}`);
});

bot.action(/select_group:(-?\d+)/, async (ctx) => {
  if (!isOwner(ctx) || !isPrivateChat(ctx)) {
    return ctx.answerCbQuery('Bu bot faqat egasi uchun.');
  }

  const groupId = Number(ctx.match[1]);
  const group = groups.find((item) => item.id === groupId);
  if (!group) {
    return ctx.answerCbQuery('Bunday guruh topilmadi.');
  }

  pendingConfig.set(ownerId, { groupId, step: 'message' });
  await ctx.answerCbQuery(`Tanlandi: ${group.title}`);
  return ctx.reply(`Tanlangan guruh: ${group.title}\nAvto-xabar matnini yozing.`);
});

bot.on('text', async (ctx) => {
  if (!isOwner(ctx)) {
    return;
  }

  const pending = pendingConfig.get(ownerId);
  if (!pending || !isPrivateChat(ctx)) {
    return;
  }

  const text = ctx.message.text.trim();
  if (pending.step === 'message') {
    if (!text || text.length > 4096) {
      return ctx.reply('Xabar matni 1 dan 4096 belgigacha bo‘lishi kerak.');
    }

    pending.message = text;
    pending.step = 'interval';
    return ctx.reply(
      'Qancha vaqtda bir marta yuborilsin? Masalan: 30 soniya, 15 daqiqa, 2 soat yoki 1 kun (eng ko‘pi 30 kun).'
    );
  }

  if (pending.step === 'interval') {
    const intervalSeconds = parseInterval(text);
    if (!intervalSeconds) {
      return ctx.reply('Vaqtni masalan “30 soniya”, “15 daqiqa”, “2 soat” yoki “1 kun” shaklida kiriting (eng ko‘pi 30 kun).');
    }

    try {
      await sendMessageToGroup(pending.groupId, pending.message);
      registerAutoPost(pending.groupId, pending.message, intervalSeconds);
      pendingConfig.delete(ownerId);
      return ctx.reply(
        `Xabar ${getGroupTitle(pending.groupId)} guruhiga yuborildi. Keyin har ${formatInterval(intervalSeconds)} takrorlanadi.`
      );
    } catch (error) {
      console.error('Avto-xabarni saqlash xatosi:', error);
      return ctx.reply('Xabarni yuborish yoki avto-xabarni saqlashda xatolik yuz berdi. Terminaldagi xatoni tekshiring.');
    }
  }
});

bot.catch((error) => {
  console.error('Bot ishlashida xatolik:', error);
});

async function start() {
  const savedSession = process.env.TELEGRAM_SESSION ||
    (fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : '');
  if (!savedSession && !process.stdin.isTTY) {
    throw new Error(
      'Telegram login kodi uchun terminal interaktiv emas. Avval lokal kompyuterda npm start bilan login qiling, ' +
      'so‘ng .data/user-session.txt ichidagi sessiyani Render TELEGRAM_SESSION secretiga kiriting.'
    );
  }

  userClient = new TelegramClient(new StringSession(savedSession), apiId, apiHash, {
    connectionRetries: 5,
  });

  await userClient.start({
    phoneNumber: () => input.text('Telegram telefon raqamingizni kiriting:'),
    phoneCode: () => input.text('Telegram yuborgan tasdiqlash kodini kiriting:'),
    password: () => input.password('Ikki bosqichli parolni kiriting:'),
    onError: (error) => console.error('Telegram akkauntiga ulanish xatoligi:', error),
  });

  if (!process.env.TELEGRAM_SESSION) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, userClient.session.save(), { encoding: 'utf8', mode: 0o600 });
  }
  console.log('Shaxsiy Telegram akkaunti ulandi.');

  restoreAutoPosts();
  await bot.launch();
  console.log('Boshqaruv boti ishga tushdi.');
}

start().catch((error) => {
  console.error('Botni ishga tushirib bo‘lmadi:', error);
  process.exitCode = 1;
});

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  if (userClient) userClient.disconnect();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  if (userClient) userClient.disconnect();
});

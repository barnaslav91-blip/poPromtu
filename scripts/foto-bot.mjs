#!/usr/bin/env node
// Забирает фото, присланные боту в телеграм, и кладёт их на страницу покоса.
// Запускается по расписанию из .github/workflows/foto-bot.yml — своего сервера не нужно.
//
// Как это выглядит для человека: отправил боту два фото одним сообщением
// (первое «до», второе «после»), подписал — через несколько минут они на сайте.

import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = (process.env.TELEGRAM_ALLOWED_CHATS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ROOT       = process.cwd();
const FOTO_DIR   = path.join(ROOT, "docs/gazon/foto");
const FOTO_JS    = path.join(ROOT, "docs/gazon/foto.js");
const STATE_FILE = path.join(ROOT, ".foto-bot-state.json");

const MAX_PAIRS = 8;      // столько показываем на странице, лишнее удаляем
const WIDTH     = 1200;   // ширина готового снимка
const QUALITY   = 80;

const log = (...a) => console.log(...a);

// ---------- телеграм ----------
async function api(method, params){
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params || {})
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok){
    const e = new Error(`${method}: ${j.description || r.status}`);
    e.code = j.error_code || r.status;
    throw e;
  }
  return j.result;
}
async function say(chatId, text){
  try{ await api("sendMessage", { chat_id: chatId, text }); }
  catch(e){ log("не удалось ответить:", e.message); }
}
async function download(fileId){
  const f = await api("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error("файл не скачался: " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- состояние ----------
async function loadState(){
  try{ return JSON.parse(await readFile(STATE_FILE, "utf8")); }
  catch{ return { offset: 0, seq: 0, pending: null }; }
}
const saveState = s => writeFile(STATE_FILE, JSON.stringify(s, null, 2) + "\n");

// ---------- список фото на странице ----------
async function loadPhotos(){
  try{
    const src = await readFile(FOTO_JS, "utf8");
    const m = src.match(/window\.PHOTOS\s*=\s*(\[[\s\S]*?\]);/);
    return m ? JSON.parse(m[1]) : [];
  }catch{ return []; }
}
async function savePhotos(list){
  const body = "// Файл собирается ботом из телеграма, править руками не нужно.\n" +
               "// Порядок: свежее сверху. Подпись ru показывается на русской версии,\n" +
               "// ro — на румынской; если ro нет, фото покажется без подписи.\n" +
               "window.PHOTOS = " + JSON.stringify(list, null, 2) + ";\n";
  await writeFile(FOTO_JS, body);
}

// Подпись: «до»/«после» — служебные слова, остальное показываем клиенту.
// Границу слова через \b брать нельзя: она считает словом только латиницу,
// поэтому на «до» и «после» не срабатывает. Смотрим, что дальше не буква.
const NOT_LETTER = "(?![a-zа-яёăâîșț])";
const RE_BEFORE = new RegExp(`^(до|было|inainte|înainte|before)${NOT_LETTER}[\\s:,-]*`, "i");
const RE_AFTER  = new RegExp(`^(после|стало|dupa|după|after)${NOT_LETTER}[\\s:,-]*`, "i");
const cleanCaption = c => String(c || "").replace(RE_BEFORE, "").replace(RE_AFTER, "").trim();

async function saveShot(buf, name){
  await mkdir(FOTO_DIR, { recursive: true });
  const file = path.join(FOTO_DIR, name);
  await sharp(buf).rotate().resize({ width: WIDTH, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true }).toFile(file);
  return "foto/" + name;
}

async function main(){
  if (!TOKEN){
    log("TELEGRAM_BOT_TOKEN не задан — бот не настроен, выходим без ошибки.");
    return;
  }

  const state = await loadState();
  let updates;
  try{
    updates = await api("getUpdates", { offset: state.offset, timeout: 0, allowed_updates: ["message"] });
  }catch(e){
    if (e.code === 401){ console.error("Токен бота неверный:", e.message); process.exit(1); }
    log("телеграм недоступен, попробуем в следующий раз:", e.message);
    return;
  }
  if (!updates.length){ log("новых сообщений нет"); return; }

  let photos = await loadPhotos();
  const groups = new Map();   // media_group_id -> [сообщения]
  const singles = [];
  const greeted = new Set();
  let removed = 0;

  for (const u of updates){
    state.offset = u.update_id + 1;
    const msg = u.message;
    if (!msg) continue;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim().toLowerCase();

    // чужим ничего не публикуем, но подсказываем их id — так владельца проще прописать
    if (!ALLOWED.includes(chatId)){
      if (!greeted.has(chatId)){
        greeted.add(chatId);
        await say(chatId, ALLOWED.length
          ? "Этот бот публикует фото только для владельца сайта."
          : `Бот ещё не привязан к владельцу. Ваш ID: ${chatId} — впишите его в секрет TELEGRAM_ALLOWED_CHATS.`);
      }
      continue;
    }

    if (text === "/start" || text === "/help" || text === "помощь"){
      await say(chatId,
        "Отправь два фото одним сообщением: первое «до», второе «после».\n" +
        "Подпись к сообщению станет подписью под фото на сайте.\n\n" +
        "Одно фото тоже можно — оно займёт всю ширину.\n" +
        "Если снимки идут по одному, подпиши их словами «до» и «после».\n\n" +
        "«удалить» — убрать последнее опубликованное.\n" +
        "Сайт обновляется в течение 10–15 минут.");
      continue;
    }
    if (text === "удалить" || text === "/undo"){
      const gone = photos.shift();
      if (gone){
        removed++;
        for (const f of [gone.before, gone.after].filter(Boolean))
          await unlink(path.join(ROOT, "docs/gazon", f)).catch(() => {});
        await say(chatId, "Убрал последнее фото с сайта.");
      } else await say(chatId, "На сайте пока нечего удалять.");
      continue;
    }

    if (!msg.photo){
      if (msg.text) await say(chatId, "Жду фотографии. Напиши «помощь», если нужна подсказка.");
      continue;
    }

    const best = msg.photo[msg.photo.length - 1];   // последний размер — самый крупный
    const item = { chatId, fileId: best.file_id, caption: msg.caption || "" };
    if (msg.media_group_id){
      const g = groups.get(msg.media_group_id) || [];
      g.push(item);
      groups.set(msg.media_group_id, g);
    } else singles.push(item);
  }

  const added = [];
  let lastChat = null;

  // альбом: первое фото — «до», второе — «после»
  for (const [, g] of groups){
    const caption = cleanCaption(g.map(x => x.caption).find(Boolean));
    const entry = { ru: caption };
    state.seq++;
    const stamp = new Date().toISOString().slice(0, 10);
    lastChat = g[0]?.chatId || lastChat;
    if (g[0]) entry.before = await saveShot(await download(g[0].fileId), `${stamp}-${state.seq}-do.jpg`);
    if (g[1]) entry.after  = await saveShot(await download(g[1].fileId), `${stamp}-${state.seq}-posle.jpg`);
    if (!entry.before && !entry.after) continue;
    if (!entry.ru) delete entry.ru;
    added.push(entry);
  }

  // одиночные снимки: «до» ждёт свою пару до следующего запуска
  for (const it of singles){
    lastChat = it.chatId;
    const isBefore = RE_BEFORE.test(it.caption);
    const isAfter  = RE_AFTER.test(it.caption);
    const caption  = cleanCaption(it.caption);
    const stamp    = new Date().toISOString().slice(0, 10);

    if (isBefore){
      state.seq++;
      state.pending = { file: await saveShot(await download(it.fileId), `${stamp}-${state.seq}-do.jpg`), ru: caption };
      await say(it.chatId, "Принял «до». Пришли «после» — опубликую парой.");
      continue;
    }
    const entry = {};
    if (isAfter && state.pending){
      entry.before = state.pending.file;
      entry.ru = caption || state.pending.ru || "";
      state.pending = null;
    } else if (caption) entry.ru = caption;
    state.seq++;
    entry.after = await saveShot(await download(it.fileId), `${stamp}-${state.seq}-posle.jpg`);
    if (!entry.ru) delete entry.ru;
    added.push(entry);
  }

  if (!added.length && !removed){ await saveState(state); log("фотографий не было"); return; }

  photos = [...added.reverse(), ...photos];

  // лишнее убираем вместе с файлами, чтобы репозиторий не пух
  const extra = photos.slice(MAX_PAIRS);
  for (const e of extra)
    for (const f of [e.before, e.after].filter(Boolean))
      await unlink(path.join(ROOT, "docs/gazon", f)).catch(() => {});
  photos = photos.slice(0, MAX_PAIRS);

  await savePhotos(photos);
  await saveState(state);

  const who = lastChat || ALLOWED[0];
  if (added.length && who)
    await say(who, `Опубликовано: ${added.length}. На сайте появится в течение нескольких минут.`);

  log(`добавлено ${added.length}, удалено ${removed}, всего на странице ${photos.length}`);
}

main().catch(e => { console.error("сбой:", e); process.exit(1); });

/**
 * Cloudflare Worker — TinyAV1Bot
 * 功能丰富、体验无敌的 AV1 视频压缩 Bot
 *
 * 命令：
 * /start     欢迎语
 * /help      使用说明
 * /settings  设置菜单
 * /about     关于
 *
 * 设置项（Cloudflare KV，每用户独立）：
 * - keep_caption:    保留原始 #标签文字 (默认关)
 * - forward_photos:  转发图片 (默认关)
 * - forward_source:  转发者名字加 #tag (默认关)
 * - source_format:   源格式返回，除了视频被压缩其余完全一致 (默认关)
 *
 * 默认行为：只返回一个裸视频，不带任何附加内容
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("TinyAV1Bot ✅", { status: 200 });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        const msg = update.message || update.channel_post;
        const cb = update.callback_query;

        if (cb) {
          await handleCallback(env, cb);
          return ok();
        }

        if (!msg) return ok();

        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const text = msg.text || "";

        // ── 命令 ──
        if (text === "/start") {
          await sendText(env, chatId, messageId,
            "👋 你好！我是 TinyAV1Bot\n\n🎬 发视频给我，压缩后发回\n\n下面按钮可以直接使用 👇");
          return ok();
        }

        if (text === "/help") {
          await sendText(env, chatId, messageId,
            "📖 使用说明\n\n1️⃣ 发送或转发视频\n2️⃣ 等几分钟收到压缩结果\n\n⏱ 通常 5-10 分钟\n📦 最大 2GB\n\n⚙️ /settings 自定义功能开关");
          return ok();
        }

        if (text === "/about") {
          await sendText(env, chatId, messageId,
            "🎬 TinyAV1Bot\n\n将视频压缩到更小的体积，画质几乎不变。\n完全免费，无使用限制。\n\n⚙️ 后端: GitHub Actions\n📡 前端: Cloudflare Workers");
          return ok();
        }

        if (text === "/settings") {
          await sendSettings(env, chatId, messageId);
          return ok();
        }

        // ── 非视频处理 ──
        if (!msg.video && !msg.document && !msg.photo) {
          await sendText(env, chatId, messageId,
            "🎬 请发送视频文件\n\n💡 输入 / 查看可用命令");
          return ok();
        }

        if (msg.document && !msg.document.mime_type?.startsWith("video/")) {
          await sendText(env, chatId, messageId, "⚠️ 请发送视频文件");
          return ok();
        }

        // ── 媒体消息 ──
        const video = msg.video || (msg.document?.mime_type?.startsWith("video/") ? msg.document : null);
        const photos = msg.photo || null;
        const caption = msg.caption || "";
        const forwardName = extractForwardName(msg);
        const settings = await getSettings(env, chatId);

        // 只有图片没视频
        if (!video && photos) {
          if (settings.forward_photos || settings.source_format) {
            await copyMessage(env, chatId, messageId);
          } else {
            await sendText(env, chatId, messageId, "ℹ️ 只收到图片，请发送视频才会压缩");
          }
          return ok();
        }

        // ── 收到视频 ──
        if (!video) return ok();

        // source_format 模式：转发原图 + 转发原消息副本
        if (settings.source_format) {
          await copyMessage(env, chatId, messageId);
        } else if (photos && settings.forward_photos) {
          await copyMessage(env, chatId, messageId);
        }

        // 构造 caption
        let finalCaption = "";
        if (settings.keep_caption && caption) {
          finalCaption = caption;
        }
        if (settings.forward_source && forwardName) {
          finalCaption += (finalCaption ? "\n" : "") + `#${forwardName}`;
        }

        // 触发 GA
        const resp = await triggerWorkflow(env, chatId, messageId, finalCaption);
        const replyText = resp.ok
          ? "🚀 收到！正在压缩...\n⏱ 预计 5-10 分钟"
          : "❌ 排队失败，请稍后重试。";

        await sendText(env, chatId, messageId, replyText);
        return ok();
      } catch (e) {
        return ok();
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};


// ── 转发来源提取 ──
function extractForwardName(msg) {
  const origin = msg.forward_origin || msg.forward_from;
  if (!origin) return null;

  // 新 API: forward_origin
  if (origin.type === "user" && origin.sender_user) {
    return origin.sender_user.first_name || origin.sender_user.username || null;
  }
  if (origin.type === "chat" && origin.sender_chat) {
    return origin.sender_chat.title || origin.sender_chat.username || null;
  }
  if (origin.type === "channel" && origin.chat) {
    return origin.chat.title || origin.chat.username || null;
  }
  if (origin.type === "hidden_user") {
    return origin.sender_user_name || "匿名";
  }

  // 旧 API: forward_from
  if (origin.first_name) return origin.first_name;
  if (origin.title) return origin.title;

  return null;
}


// ── GitHub Actions 触发 ──
async function triggerWorkflow(env, chatId, messageId, caption) {
  return await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          chat_id: String(chatId),
          message_id: String(messageId),
          caption: caption || "",
        },
      }),
    }
  );
}


// ── 设置 ──
const DEFAULT_SETTINGS = {
  keep_caption: false,      // 默认关：不保留标签
  forward_photos: false,    // 默认关：不转发图片
  forward_source: false,   // 默认关：不加转发者名字
  source_format: false,    // 默认关：不原样返回
};

const SETTING_KEYS = {
  keep_caption:    { label: "保留标签文字",  desc: "视频带的 #标签等文字附在返回视频上" },
  forward_photos:  { label: "转发图片",     desc: "如果有图片，原样转发给你" },
  forward_source:  { label: "转发者标签",   desc: "转发来的视频，把转发者名字加 # 附在末尾" },
  source_format:   { label: "源格式返回",   desc: "除了视频被压缩，其余完全一致地转发回来" },
};

async function getSettings(env, chatId) {
  const raw = await env.SETTINGS?.get(`u:${chatId}`);
  if (raw) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {}
  }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(env, chatId, settings) {
  await env.SETTINGS?.put(`u:${chatId}`, JSON.stringify(settings));
}

async function sendSettings(env, chatId, messageId) {
  const s = await getSettings(env, chatId);
  const kb = buildSettingsKeyboard(s);

  let text = "⚙️ 设置\n\n默认：只返回裸视频\n点击按钮开关：\n";
  for (const [key, info] of Object.entries(SETTING_KEYS)) {
    const on = s[key] ? "✅" : "❌";
    text += `\n${on} ${info.label} — ${info.desc}`;
  }

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: messageId,
      reply_markup: { inline_keyboard: kb },
    }),
  });
}

function buildSettingsKeyboard(s) {
  return Object.entries(SETTING_KEYS).map(([key, info]) => [
    {
      text: `${s[key] ? "✅" : "❌"} ${info.label}`,
      callback_data: `toggle:${key}`,
    },
  ]);
}

async function handleCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!chatId) return;

  const s = await getSettings(env, chatId);

  if (cb.data?.startsWith("toggle:")) {
    const key = cb.data.slice(7);
    if (key in s) s[key] = !s[key];
  }

  await saveSettings(env, chatId, s);

  // 更新消息
  let text = "⚙️ 设置\n\n默认：只返回裸视频\n点击按钮开关：\n";
  for (const [key, info] of Object.entries(SETTING_KEYS)) {
    const on = s[key] ? "✅" : "❌";
    text += `\n${on} ${info.label} — ${info.desc}`;
  }

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: buildSettingsKeyboard(s) },
    }),
  });

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cb.id }),
  });
}


// ── 工具 ──
function ok() { return new Response("OK", { status: 200 }); }

async function sendText(env, chatId, replyTo, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyTo,
    }),
  });
}

async function copyMessage(env, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      from_chat_id: chatId,
      message_id: messageId,
    }),
  });
}

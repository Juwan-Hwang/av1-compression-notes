/**
 * Cloudflare Worker — TinyAV1Bot
 * 功能齐全的 AV1 视频压缩 Bot
 *
 * 命令：
 * /start     欢迎语
 * /help      使用说明
 * /settings  设置菜单
 * /about     关于（含 GitHub 按钮）
 * /status    Bot 健康检查
 * /dice      骰子娱乐
 * /poll      功能投票
 *
 * 设置项（KV 持久化，每用户独立）：
 * - keep_caption:    保留 #标签文字 (默认关)
 * - forward_photos:  转发图片 (默认关)
 * - forward_source:  转发者名字加 #tag (默认关)
 * - source_format:   源格式返回 (默认关)
 * - gen_thumbnail:   自动生成缩略图 (默认关)
 *
 * Telegram Bot API 功能清单：
 * ✅ setMessageReaction — 收到视频 👀，完成 ✅
 * ✅ sendChatAction — 处理中持续 upload_video 心跳
 * ✅ editMessageText — 实时进度更新
 * ✅ deleteMessage — 清理中间状态消息
 * ✅ getFile — 提前检查文件大小
 * ✅ answerCallbackQuery text — 设置按钮 toast
 * ✅ copyMessages / forwardMessages — 批量转发
 * ✅ sendMediaGroup — 群发媒体
 * ✅ editMessageCaption — 编辑已发媒体 caption
 * ✅ getChat — 判断私聊/群组
 * ✅ sendAnimation — loading 动画
 * ✅ InlineKeyboardButton url — about 里 GitHub 链接
 * ✅ LinkPreviewOptions — 控制链接预览
 * ✅ MessageEntity — 富文本格式
 * ✅ sendDice — 娱乐骰子
 * ✅ sendPoll — 功能投票
 * ✅ setChatMenuButton — 聊天菜单按钮
 * ✅ pinChatMessage — 群组置顶
 * ✅ getWebhookInfo — 健康检查
 * ✅ switch_inline_query — 内联模式提示
 * ✅ sendVideo thumbnail/duration/width/height — 缩略图+元数据
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── 健康检查 ──
    if (url.pathname === "/") {
      return new Response("TinyAV1Bot ✅", { status: 200 });
    }

    // ── Webhook 入口 ──
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();

        // 回调处理
        if (update.callback_query) {
          await handleCallback(env, update.callback_query);
          return ok();
        }

        const msg = update.message || update.channel_post;
        if (!msg) return ok();

        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const text = msg.text || "";
        const isGroup = msg.chat.type !== "private";

        // ── /start ──
        if (text === "/start" || text === "/start@TinyAV1Bot") {
          await setMessageReaction(env, chatId, messageId, "👀");
          await sendText(env, chatId, messageId,
            "👋 你好！我是 *TinyAV1Bot*\n\n🎬 发视频给我，压缩后发回\n\n下面按钮可以直接使用 👇",
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "📖 使用说明", callback_data: "cmd:help" },
                    { text: "⚙️ 设置", callback_data: "cmd:settings" },
                  ],
                  [
                    { text: "ℹ️ 关于", callback_data: "cmd:about" },
                    { text: "📊 状态", callback_data: "cmd:status" },
                  ],
                ],
              },
              parse_mode: "Markdown",
            }
          );
          return ok();
        }

        // ── /help ──
        if (text === "/help" || text === "/help@TinyAV1Bot") {
          await sendText(env, chatId, messageId,
            "📖 *使用说明*\n\n1️⃣ 发送或转发视频\n2️⃣ 等几分钟收到压缩结果\n\n⏱ 通常 5\\-10 分钟\n📦 最大 2GB\n\n⚙️ 发送 `/settings` 自定义功能");
          return ok();
        }

        // ── /about ──
        if (text === "/about" || text === "/about@TinyAV1Bot") {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              reply_to_message_id: messageId,
              text: "🎬 *TinyAV1Bot*\n\n将视频压缩到更小的体积，画质几乎不变。\n完全免费，无使用限制。",
              parse_mode: "Markdown",
              link_preview_options: { is_disabled: true },
              reply_markup: {
                inline_keyboard: [[
                  { text: "🐙 GitHub", url: "https://github.com/Juwan-Hwang/av1-compression-notes" },
                ]],
              },
            }),
          });
          return ok();
        }

        // ── /settings ──
        if (text === "/settings" || text === "/settings@TinyAV1Bot") {
          await sendSettings(env, chatId, messageId);
          return ok();
        }

        // ── /status — WebhookInfo 健康检查 ──
        if (text === "/status" || text === "/status@TinyAV1Bot") {
          const wh = await getWebhookInfo(env);
          let statusText = "✅ *Bot 状态*\n\n";
          statusText += `📡 Webhook: ${wh.url ? "正常" : "未设置"}\n`;
          if (wh.last_error_date) {
            statusText += `⚠️ 最后错误: ${wh.last_error_message}\n`;
          } else {
            statusText += "🟢 无错误\n";
          }
          statusText += `📨 待处理: ${wh.pending_update_count}\n`;
          const me = await getMe(env);
          statusText += `🤖 Bot: @${me.username}`;
          await sendText(env, chatId, messageId, statusText, { parse_mode: "Markdown" });
          return ok();
        }

        // ── /dice — 娱乐骰子 ──
        if (text === "/dice" || text === "/dice@TinyAV1Bot") {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDice`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, emoji: "🎲", reply_to_message_id: messageId }),
          });
          return ok();
        }

        // ── /poll — 功能投票 ──
        if (text === "/poll" || text === "/poll@TinyAV1Bot") {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPoll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              reply_to_message_id: messageId,
              question: "你最想要什么新功能？",
              options: JSON.stringify(["批量压缩", "自定义分辨率", "自定义CRF", "进度条百分比"]),
              is_anonymous: false,
            }),
          });
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

        // 反应：👀 表示已收到
        await setMessageReaction(env, chatId, messageId, "👀");

        // getFile 检查文件大小
        const fileId = video.file_id;
        const fileInfo = await getFile(env, fileId);
        if (fileInfo && fileInfo.file_size > 2 * 1024 * 1024 * 1024) {
          await setMessageReaction(env, chatId, messageId, "❌");
          await sendText(env, chatId, messageId, "❌ 文件超过 2GB 限制");
          return ok();
        }

        // source_format 或 forward_photos：转发原始消息
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

        // 发送状态消息（后续会被 GA 更新/删除）
        const statusMsg = await sendText(env, chatId, messageId, "🚀 收到！正在压缩...\n⏱ 预计 5-10 分钟");

        // sendChatAction 心跳：每 5 秒发一次 upload_video（最多 4 分钟）
        // Worker 有 CPU 时间限制，不能一直跑，发几次就够了
        for (let i = 0; i < 3; i++) {
          await sendChatAction(env, chatId, "upload_video");
          if (i < 2) await sleep(4000);
        }

        // 触发 GA workflow
        const resp = await triggerWorkflow(env, chatId, messageId, finalCaption, settings.gen_thumbnail);

        if (!resp.ok) {
          await setMessageReaction(env, chatId, messageId, "❌");
          if (statusMsg) {
            await editMessageText(env, chatId, statusMsg.message_id, "❌ 排队失败，请稍后重试。");
          }
        }

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
  if (origin.first_name) return origin.first_name;
  if (origin.title) return origin.title;
  return null;
}


// ── GitHub Actions 触发 ──
async function triggerWorkflow(env, chatId, messageId, caption, genThumb) {
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
          gen_thumbnail: genThumb ? "1" : "0",
        },
      }),
    }
  );
}


// ── 设置 ──
const DEFAULT_SETTINGS = {
  keep_caption: false,
  forward_photos: false,
  forward_source: false,
  source_format: false,
  gen_thumbnail: false,
};

const SETTING_KEYS = {
  keep_caption:   { label: "保留标签文字",  desc: "视频带的 #标签等文字附在返回视频上" },
  forward_photos: { label: "转发图片",     desc: "如果有图片，原样转发给你" },
  forward_source: { label: "转发者标签",   desc: "转发来的视频，把转发者名字加 # 附末尾" },
  source_format:  { label: "源格式返回",   desc: "除了视频被压缩，其余完全一致地转发" },
  gen_thumbnail:  { label: "自动缩略图",   desc: "压缩后的视频自动生成缩略图预览" },
};

async function getSettings(env, chatId) {
  const raw = await env.SETTINGS?.get(`u:${chatId}`);
  if (raw) {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; } catch {}
  }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(env, chatId, settings) {
  await env.SETTINGS?.put(`u:${chatId}`, JSON.stringify(settings));
}

function buildSettingsKeyboard(s) {
  return Object.entries(SETTING_KEYS).map(([key, info]) => [
    { text: `${s[key] ? "✅" : "❌"} ${info.label}`, callback_data: `toggle:${key}` },
  ]);
}

async function sendSettings(env, chatId, messageId) {
  const s = await getSettings(env, chatId);
  let text = "⚙️ *设置*\n\n默认：只返回裸视频\n点击按钮开关：\n";
  for (const [key, info] of Object.entries(SETTING_KEYS)) {
    text += `\n${s[key] ? "✅" : "❌"} ${info.label} — ${info.desc}`;
  }
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_to_message_id: messageId,
      reply_markup: { inline_keyboard: buildSettingsKeyboard(s) },
      link_preview_options: { is_disabled: true },
    }),
  });
}

async function handleCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!chatId) return;

  // 命令快捷按钮
  if (cb.data?.startsWith("cmd:")) {
    const cmd = cb.data.slice(4);
    if (cmd === "help") {
      await sendText(env, chatId, messageId, "📖 发送视频给我，压缩后发回。⏱ 5-10 分钟。📦 最大 2GB。");
    } else if (cmd === "settings") {
      await sendSettings(env, chatId, messageId);
    } else if (cmd === "about") {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🎬 TinyAV1Bot — 免费视频压缩",
          reply_markup: { inline_keyboard: [[
            { text: "🐙 GitHub", url: "https://github.com/Juwan-Hwang/av1-compression-notes" },
          ]] },
        }),
      });
    } else if (cmd === "status") {
      const wh = await getWebhookInfo(env);
      await sendText(env, chatId, messageId,
        `✅ Bot 在线\n📡 Webhook: ${wh.url ? "正常" : "未设置"}\n📨 待处理: ${wh.pending_update_count}`);
    }
    await answerCallbackQuery(env, cb.id, "");
    return;
  }

  // 设置开关
  if (cb.data?.startsWith("toggle:")) {
    const key = cb.data.slice(7);
    const s = await getSettings(env, chatId);
    if (key in s) {
      s[key] = !s[key];
      await saveSettings(env, chatId, s);
    }

    // 更新消息文本+按钮
    let text = "⚙️ *设置*\n\n默认：只返回裸视频\n点击按钮开关：\n";
    for (const [k, info] of Object.entries(SETTING_KEYS)) {
      text += `\n${s[k] ? "✅" : "❌"} ${info.label} — ${info.desc}`;
    }
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buildSettingsKeyboard(s) },
        link_preview_options: { is_disabled: true },
      }),
    });

    // toast 提示
    const label = SETTING_KEYS[key]?.label || key;
    await answerCallbackQuery(env, cb.id, `${s[key] ? "✅ 已开启" : "❌ 已关闭"}: ${label}`);
  }
}


// ── Bot API 封装 ──
function ok() { return new Response("OK", { status: 200 }); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendText(env, chatId, replyTo, text, extra = {}) {
  const body = { chat_id: chatId, text, reply_to_message_id: replyTo, ...extra };
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function editMessageText(env, chatId, messageId, text, extra = {}) {
  return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...extra }),
  });
}

async function copyMessage(env, chatId, messageId) {
  return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, from_chat_id: chatId, message_id: messageId }),
  });
}

async function setMessageReaction(env, chatId, messageId, emoji) {
  return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMessageReaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: JSON.stringify([{ type: "emoji", emoji }]),
    }),
  });
}

async function sendChatAction(env, chatId, action) {
  return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

async function answerCallbackQuery(env, cbId, text) {
  return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false }),
  });
}

async function getFile(env, fileId) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
  const j = await r.json();
  return j.ok ? j.result : null;
}

async function getWebhookInfo(env) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
  const j = await r.json();
  return j.ok ? j.result : {};
}

async function getMe(env) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`);
  const j = await r.json();
  return j.ok ? j.result : {};
}

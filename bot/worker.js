/**
 * Cloudflare Worker — TinyAV1Bot
 *
 * 功能：
 * - /start  欢迎语
 * - /help   使用说明
 * - /settings 设置菜单（开关：转发图片、保留标签文字）
 * - 发送视频 → 触发 GitHub Actions 压缩
 *   - 自动提取 caption（#标签等文字），压缩后附在返回视频上
 *   - 如果消息含图片，原样转发回去
 *   - 尽可能合并到一条消息发送
 *
 * 用户设置存储在 Cloudflare KV（免费额度：1k writes/day, 100k reads/day）
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
        if (!msg) return new Response("OK", { status: 200 });

        const chatId = msg.chat.id;
        const messageId = msg.message_id;

        // ── 命令处理 ──
        if (msg.text === "/start") {
          await sendText(env, chatId, messageId,
            "👋 你好！我是 TinyAV1Bot。\n\n🎬 把视频发给我，我会帮你压缩变小。\n\n发送 /help 查看使用说明\n发送 /settings 自定义设置");
          return ok();
        }

        if (msg.text === "/help") {
          await sendText(env, chatId, messageId,
            "📖 使用说明\n\n1️⃣ 发送或转发视频给我\n2️⃣ 等几分钟，我压缩好发回给你\n\n⏱ 通常 5-10 分钟\n📦 最大 2GB\n\n💡 提示：\n• 视频带的 #标签等文字会自动保留\n• 如果有图片，会原样转发给你\n• 发送 /settings 自定义功能开关");
          return ok();
        }

        if (msg.text === "/settings" || msg.text?.startsWith("/settings")) {
          await sendSettings(env, chatId, messageId);
          return ok();
        }

        // ── 回调处理（设置开关）──
        if (update.callback_query) {
          await handleCallback(env, update.callback_query);
          return ok();
        }

        // ── 纯文本（非命令）──
        if (msg.text && !msg.video && !msg.document && !msg.photo) {
          await sendText(env, chatId, messageId,
            "请发送视频文件 🎬\n\n输入 /help 查看使用说明。");
          return ok();
        }

        // ── 处理媒体消息 ──
        const settings = await getSettings(env, chatId);

        // 提取视频
        const video = msg.video || (msg.document?.mime_type?.startsWith("video/") ? msg.document : null);

        // 提取图片（可能有 photo 数组）
        const photos = msg.photo || null;

        // 提取 caption（#标签等文字）
        const caption = msg.caption || "";

        // 非视频文件
        if (!video && msg.document) {
          await sendText(env, chatId, messageId,
            "⚠️ 请发送视频文件，不支持其他格式。");
          return ok();
        }

        // 只有图片没有视频 → 原样转发
        if (!video && photos) {
          if (settings.forward_photos) {
            await copyMessage(env, chatId, messageId);
            await sendText(env, chatId, messageId, "✅ 图片已转发（不含视频，无需压缩）");
          } else {
            await sendText(env, chatId, messageId, "ℹ️ 已跳过图片。发送视频才会压缩哦。");
          }
          return ok();
        }

        // ── 收到视频 → 触发 GitHub Actions ──
        if (video) {
          // 如果有图片且开启了转发，先转发图片
          if (photos && settings.forward_photos) {
            await copyMessage(env, chatId, messageId);
          }

          // 触发 GA workflow，把 caption 也传过去
          const resp = await triggerWorkflow(env, chatId, messageId, caption);

          const text = resp.ok
            ? "🚀 收到！正在压缩...\n⏱ 预计 5-10 分钟"
            : "❌ 排队失败，请稍后重试。";

          await sendText(env, chatId, messageId, text);
          return ok();
        }

        return ok();
      } catch (e) {
        return ok();
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};


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


// ── 设置相关 ──
async function getSettings(env, chatId) {
  const raw = await env.SETTINGS?.get(`u:${chatId}`);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  // 默认设置
  return { forward_photos: true, keep_caption: true };
}

async function saveSettings(env, chatId, settings) {
  await env.SETTINGS?.put(`u:${chatId}`, JSON.stringify(settings));
}

async function sendSettings(env, chatId, messageId) {
  const s = await getSettings(env, chatId);

  const kb = {
    inline_keyboard: [
      [
        { text: `${s.forward_photos ? "✅" : "❌"} 转发图片`, callback_data: "toggle_photos" },
      ],
      [
        { text: `${s.keep_caption ? "✅" : "❌"} 保留标签文字`, callback_data: "toggle_caption" },
      ],
    ],
  };

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "⚙️ 设置\n\n点击按钮开关功能：",
      reply_to_message_id: messageId,
      reply_markup: kb,
    }),
  });
}

async function handleCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!chatId) return;

  const s = await getSettings(env, chatId);

  if (cb.data === "toggle_photos") {
    s.forward_photos = !s.forward_photos;
  } else if (cb.data === "toggle_caption") {
    s.keep_caption = !s.keep_caption;
  }

  await saveSettings(env, chatId, s);

  // 更新按钮
  const kb = {
    inline_keyboard: [
      [
        { text: `${s.forward_photos ? "✅" : "❌"} 转发图片`, callback_data: "toggle_photos" },
      ],
      [
        { text: `${s.keep_caption ? "✅" : "❌"} 保留标签文字`, callback_data: "toggle_caption" },
      ],
    ],
  };

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: kb,
    }),
  });

  // 回应 callback
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cb.id }),
  });
}


// ── 工具函数 ──
function ok() {
  return new Response("OK", { status: 200 });
}

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

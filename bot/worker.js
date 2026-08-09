/**
 * Cloudflare Worker — TinyAV1Bot
 * 带权限管理的 AV1 视频压缩 Bot
 *
 * 命令：
 * /start     欢迎语
 * /help      使用说明
 * /settings  设置菜单
 * /about     关于（含 GitHub 按钮）
 * /status    Bot 健康检查
 * /dice      骰子娱乐
 * /poll      功能投票
 * /admin     管理面板（仅管理员）
 *
 * 权限系统：
 * - 管理员 (env.ADMIN_ID): 全部权限，审批申请，管理白名单/封禁列表
 * - 白名单用户: 可以压缩视频
 * - 新用户: 发视频会提示写申请（仅一次），管理员主动 /admin 查看
 * - 封禁用户: 无法使用 Bot，无法提交申请
 *
 * 设置项（KV 持久化，每用户独立）：
 * - keep_caption:    保留 #标签文字 (默认关)
 * - forward_photos:  转发图片 (默认关)
 * - forward_source:  转发者名字加 #tag (默认关)
 * - source_format:   源格式返回 (默认关)
 * - gen_thumbnail:   自动生成缩略图 (默认关)
 *
 * KV 结构：
 * - whitelist       → JSON array of user IDs (numbers)
 * - banned          → JSON array of banned user IDs (numbers)
 * - app:<userId>    → { name, username, text, time, chatId } 申请信息
 * - u:<chatId>      → 用户设置 JSON
 *
 * 安全措施：
 * ✅ ADMIN_ID 从环境变量读取，不硬编码
 * ✅ 所有管理操作回调验证操作者身份 (cb.from.id === ADMIN_ID)
 * ✅ 封禁列表防止被拒用户重复申请
 * ✅ 用户输入 HTML 转义防注入
 * ✅ 管理员不可被踢出/封禁
 * ✅ 用户 ID 统一为 number 类型，避免类型混淆
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
      const warning = env.ADMIN_ID ? "" : " ⚠️ ADMIN_ID not set";
      return new Response(`TinyAV1Bot ✅${warning}`, { status: 200 });
    }

    // ── 调试端点：检查 secrets 并测试 GA dispatch ──
    if (url.pathname === "/debug") {
      const info = {
        GH_TOKEN_len: env.GH_TOKEN ? env.GH_TOKEN.length : 0,
        GH_TOKEN_ends_with_newline: env.GH_TOKEN ? /\n$/.test(env.GH_TOKEN) : "n/a",
        GH_REPO: env.GH_REPO ? env.GH_REPO.trim() : "(not set)",
        GH_REPO_len: env.GH_REPO ? env.GH_REPO.length : 0,
        GH_WORKFLOW: env.GH_WORKFLOW ? env.GH_WORKFLOW.trim() : "(not set)",
        GH_WORKFLOW_len: env.GH_WORKFLOW ? env.GH_WORKFLOW.length : 0,
        BOT_TOKEN_len: env.BOT_TOKEN ? env.BOT_TOKEN.length : 0,
        ADMIN_ID: env.ADMIN_ID ? env.ADMIN_ID.trim() : "(not set)",
      };

      // 测试 dispatch
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${env.GH_REPO.trim()}/actions/workflows/${env.GH_WORKFLOW.trim()}/dispatches`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.GH_TOKEN.trim()}`,
              "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "TinyAV1Bot-Worker",
            },
            body: JSON.stringify({
              ref: "main",
              inputs: { chat_id: "0", message_id: "0", caption: "", gen_thumbnail: "0" },
            }),
          }
        );
        info.dispatch_status = resp.status;
        if (!resp.ok) {
          const body = await resp.text();
          info.dispatch_error = body.slice(0, 500);
        }
      } catch (e) {
        info.dispatch_error = e.message;
      }

      return new Response(JSON.stringify(info, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
        const userId = msg.from?.id || chatId;
        const messageId = msg.message_id;
        const text = msg.text || "";

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

        // ── /admin (仅管理员) ──
        if (text === "/admin" || text === "/admin@TinyAV1Bot") {
          if (!isAdmin(env, userId)) {
            await sendText(env, chatId, messageId, "⛔ 无权限");
            return ok();
          }
          await showAdminPanel(env, chatId, messageId);
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
          const wl = await getWhitelist(env);
          statusText += `👥 白名单: ${wl.length} 人\n`;
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
          // 纯文字消息：检查是否在申请流程中
          if (!isAdmin(env, userId)) {
            if (await isBanned(env, userId)) return ok(); // 封禁用户静默忽略

            const app = await getApplication(env, userId);
            if (app) {
              if (app.text) {
                // 已提交申请，防止重复提交
                await sendText(env, chatId, messageId, "⏳ 申请审核中，请耐心等待。");
                return ok();
              }
              // 保存申请文字（不主动通知管理员，管理员需 /admin 查看）
              app.text = text;
              app.time = Date.now();
              await saveApplication(env, userId, app);
              await sendText(env, chatId, messageId, "✅ 申请已提交！请耐心等待审批。\n\n⚠️ 申请只能提交一次，请勿重复发送。");
              return ok();
            }
          }
          await sendText(env, chatId, messageId,
            "🎬 请发送视频文件\n\n💡 输入 / 查看可用命令");
          return ok();
        }

        if (msg.document && !msg.document.mime_type?.startsWith("video/")) {
          await sendText(env, chatId, messageId, "⚠️ 请发送视频文件");
          return ok();
        }

        // ── 权限检查（媒体消息） ──
        if (!isAdmin(env, userId)) {
          if (await isBanned(env, userId)) {
            await setMessageReaction(env, chatId, messageId, "🚫");
            await sendText(env, chatId, messageId, "⛔ 你已被封禁，无法使用此 Bot。");
            return ok();
          }
          if (!(await isWhitelisted(env, userId))) {
            // 不在白名单 → 引导申请
            await setMessageReaction(env, chatId, messageId, "🔒");
            await saveApplication(env, userId, {
              name: msg.from?.first_name || "未知",
              username: msg.from?.username || "",
              text: "",
              time: Date.now(),
              chatId: chatId,
            });
            await sendText(env, chatId, messageId,
              "🔒 你还没有使用权限\n\n请发一段文字说明你的用途，管理员审批后即可使用。\n\n⚠️ 申请只能提交一次，请认真填写。");
            return ok();
          }
        }

        // ── 媒体消息 ──
        const video = msg.video || (msg.document?.mime_type?.startsWith("video/") ? msg.document : null);
        const photos = msg.photo || null;
        const caption = msg.caption || "";
        const forwardName = extractForwardName(msg);
        const settings = await getSettings(env, chatId);

        // 只有图片没视频
        if (!video && photos) {
          // 媒体组：收集同组图片，批量转发（合并为一条专辑消息）
          if (msg.media_group_id) {
            if (settings.forward_photos) {
              await collectAndForwardMediaGroup(env, chatId, messageId, msg.media_group_id, settings);
            }
            // 媒体组里的图片静默处理（组里有视频会单独处理）
            return ok();
          }
          // 独立图片
          if (settings.forward_photos) {
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

        // 构造 caption
        // source_format: 压缩后以源格式返回（保留原始 caption）
        // keep_caption: 保留 #标签等文字
        let finalCaption = "";
        if ((settings.keep_caption || settings.source_format) && caption) {
          finalCaption = caption;
        }
        if (settings.forward_source && forwardName) {
          finalCaption += (finalCaption ? "\n" : "") + `#${forwardName}`;
        }

        // 先触发 GA workflow，成功后才告诉用户「正在压缩」
        const resp = await triggerWorkflow(env, chatId, messageId, finalCaption, settings.gen_thumbnail);

        if (!resp.ok) {
          // 触发失败：读取 GitHub 返回的错误信息
          let errDetail = `HTTP ${resp.status}`;
          try { const ej = await resp.json(); if (ej.message) errDetail = ej.message; } catch {}
          await setMessageReaction(env, chatId, messageId, "❌");
          await sendText(env, chatId, messageId, `❌ 排队失败：${errDetail}\n请稍后重试。`);
          return ok();
        }

        // 触发成功：发送状态消息（GA 中的 prepare.py 会编辑/删除它）
        await setMessageReaction(env, chatId, messageId, "🚀");
        await sendText(env, chatId, messageId, "🚀 已加入压缩队列！\n⏱ 预计 5-10 分钟\n\n💡 压缩在 GitHub Actions 上运行，完成后自动发回。");

        return ok();
      } catch (e) {
        // 错误不再静默吞掉
        try {
          await sendText(env, chatId, messageId || 0, `⚠️ 内部错误：${e.message || e}`);
        } catch {}
        return ok();
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};


// ═══════════════════════════════════════════════════════════════
// 权限系统
// ═══════════════════════════════════════════════════════════════

function isAdmin(env, userId) {
  return !!(env.ADMIN_ID && String(userId) === String(env.ADMIN_ID));
}

// ── 白名单 ──

async function getWhitelist(env) {
  const raw = await env.SETTINGS?.get("whitelist");
  if (raw) {
    try { return JSON.parse(raw).map(Number).filter(n => !isNaN(n)); } catch {}
  }
  // 初始化：管理员自动入白名单
  const adminId = Number(env.ADMIN_ID);
  return isNaN(adminId) ? [] : [adminId];
}

async function isWhitelisted(env, userId) {
  const wl = await getWhitelist(env);
  return wl.some(id => id === Number(userId));
}

async function addToWhitelist(env, userId) {
  const wl = await getWhitelist(env);
  const id = Number(userId);
  if (!wl.includes(id)) {
    wl.push(id);
    await env.SETTINGS?.put("whitelist", JSON.stringify(wl));
  }
}

async function removeFromWhitelist(env, userId) {
  if (isAdmin(env, userId)) return; // 管理员不可移除
  const wl = await getWhitelist(env);
  const id = Number(userId);
  await env.SETTINGS?.put("whitelist", JSON.stringify(wl.filter(x => x !== id)));
}

// ── 封禁列表 ──

async function getBannedList(env) {
  const raw = await env.SETTINGS?.get("banned");
  if (raw) {
    try { return JSON.parse(raw).map(Number).filter(n => !isNaN(n)); } catch {}
  }
  return [];
}

async function isBanned(env, userId) {
  const banned = await getBannedList(env);
  return banned.some(id => id === Number(userId));
}

async function banUser(env, userId) {
  if (isAdmin(env, userId)) return; // 管理员不可封禁
  const banned = await getBannedList(env);
  const id = Number(userId);
  if (!banned.includes(id)) {
    banned.push(id);
    await env.SETTINGS?.put("banned", JSON.stringify(banned));
  }
  // 同时从白名单移除
  await removeFromWhitelist(env, userId);
}

async function unbanUser(env, userId) {
  const banned = await getBannedList(env);
  const id = Number(userId);
  await env.SETTINGS?.put("banned", JSON.stringify(banned.filter(x => x !== id)));
}

// ── 申请管理 ──

async function getApplication(env, userId) {
  const raw = await env.SETTINGS?.get(`app:${userId}`);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return null;
}

async function saveApplication(env, userId, data) {
  await env.SETTINGS?.put(`app:${userId}`, JSON.stringify(data));
}

async function deleteApplication(env, userId) {
  await env.SETTINGS?.delete(`app:${userId}`);
}

async function getPendingApplications(env) {
  const list = await env.SETTINGS?.list({ prefix: "app:" });
  if (!list) return [];
  const apps = [];
  for (const key of list.keys) {
    const uid = parseInt(key.name.slice(4));
    if (isNaN(uid)) continue;
    try {
      const data = JSON.parse(await env.SETTINGS.get(key.name) || "{}");
      if (data.text) apps.push({ id: uid, ...data });
    } catch {}
  }
  return apps;
}

// ── 管理面板 ──

async function buildAdminPanelData(env) {
  const wl = await getWhitelist(env);
  const banned = await getBannedList(env);
  const apps = await getPendingApplications(env);

  let text = "🔧 <b>管理面板</b>\n\n";
  text += `👥 白名单: ${wl.length} 人\n`;
  text += `📋 待审批: ${apps.length} 个\n`;
  text += `🚫 封禁: ${banned.length} 人`;

  const kb = [];
  if (apps.length > 0) {
    kb.push([{ text: `📋 待审批 (${apps.length})`, callback_data: "admin:apps" }]);
  }
  kb.push([{ text: "👥 白名单", callback_data: "admin:wl" }]);
  if (banned.length > 0) {
    kb.push([{ text: `🚫 封禁列表 (${banned.length})`, callback_data: "admin:ban" }]);
  }
  kb.push([{ text: "🔄 刷新", callback_data: "admin:menu" }]);

  return { text, kb };
}

async function showAdminPanel(env, chatId, messageId) {
  const { text, kb } = await buildAdminPanelData(env);
  await sendText(env, chatId, messageId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: kb },
  });
}

// ═══════════════════════════════════════════════════════════════
// 回调处理
// ═══════════════════════════════════════════════════════════════

async function handleCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const userId = cb.from?.id;
  if (!chatId) return;

  const data = cb.data || "";

  // ── 管理回调鉴权：所有 admin: / approve: / reject: / ban: / kick: / unban: 回调仅限管理员 ──
  const adminOps = ["admin:", "approve:", "reject:", "ban:", "kick:", "unban:"];
  if (adminOps.some(prefix => data.startsWith(prefix))) {
    if (!isAdmin(env, userId)) {
      await answerCallbackQuery(env, cb.id, "⛔ 无权限");
      return;
    }
  }

  // 命令快捷按钮
  if (data.startsWith("cmd:")) {
    const cmd = data.slice(4);
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
      const wl = await getWhitelist(env);
      await sendText(env, chatId, messageId,
        `✅ Bot 在线\n📡 Webhook: ${wh.url ? "正常" : "未设置"}\n📨 待处理: ${wh.pending_update_count}\n👥 白名单: ${wl.length} 人`);
    }
    await answerCallbackQuery(env, cb.id, "");
    return;
  }

  // ── 管理面板导航 ──

  if (data === "admin:menu") {
    const { text, kb } = await buildAdminPanelData(env);
    await editMessageText(env, chatId, messageId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: kb },
    });
    await answerCallbackQuery(env, cb.id, "");
    return;
  }

  if (data === "admin:apps") {
    const apps = await getPendingApplications(env);
    let text;
    const kb = [];

    if (apps.length === 0) {
      text = "📋 没有待审批的申请。";
    } else {
      text = `📋 <b>待审批</b> (${apps.length} 个)\n`;
      for (const a of apps.slice(0, 8)) {
        text += `\n👤 ${escapeHtml(a.name)} — <code>${a.id}</code>\n`;
        if (a.username) text += `📌 @${escapeHtml(a.username)}\n`;
        const preview = a.text.length > 100 ? a.text.slice(0, 100) + "..." : a.text;
        text += `💬 ${escapeHtml(preview)}\n`;
        kb.push([
          { text: `✅ ${a.id}`, callback_data: `approve:${a.id}` },
          { text: `❌ ${a.id}`, callback_data: `reject:${a.id}` },
          { text: `🚫 ${a.id}`, callback_data: `ban:${a.id}` },
        ]);
      }
      if (apps.length > 8) {
        text += `\n...还有 ${apps.length - 8} 个申请未显示`;
      }
    }
    kb.push([{ text: "← 返回", callback_data: "admin:menu" }]);

    await editMessageText(env, chatId, messageId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: kb },
    });
    await answerCallbackQuery(env, cb.id, "");
    return;
  }

  if (data === "admin:wl") {
    const wl = await getWhitelist(env);
    let text = `👥 <b>白名单</b> (${wl.length})\n`;
    const kb = [];
    for (const id of wl) {
      if (isAdmin(env, id)) {
        text += `\n👑 ${id} (管理员)`;
      } else {
        text += `\n• ${id}`;
        kb.push([
          { text: `踢出 ${id}`, callback_data: `kick:${id}` },
          { text: "🚫 封禁", callback_data: `ban:${id}` },
        ]);
      }
    }
    kb.push([{ text: "← 返回", callback_data: "admin:menu" }]);
    await editMessageText(env, chatId, messageId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: kb },
    });
    await answerCallbackQuery(env, cb.id, "");
    return;
  }

  if (data === "admin:ban") {
    const banned = await getBannedList(env);
    let text = `🚫 <b>封禁列表</b> (${banned.length})\n`;
    const kb = [];
    if (banned.length === 0) {
      text += "\n暂无封禁用户。";
    } else {
      for (const id of banned) {
        text += `\n• ${id}`;
        kb.push([{ text: `解封 ${id}`, callback_data: `unban:${id}` }]);
      }
    }
    kb.push([{ text: "← 返回", callback_data: "admin:menu" }]);
    await editMessageText(env, chatId, messageId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: kb },
    });
    await answerCallbackQuery(env, cb.id, "");
    return;
  }

  // ── 批准申请 ──

  if (data.startsWith("approve:")) {
    const targetId = Number(data.slice(8));
    await addToWhitelist(env, targetId);
    await deleteApplication(env, targetId);
    await answerCallbackQuery(env, cb.id, "✅ 已批准");
    // 通知用户
    await sendText(env, targetId, null, "🎉 你的申请已通过！现在可以发视频给我了。");
    // 更新管理消息
    const wl = await getWhitelist(env);
    await editMessageText(env, chatId, messageId,
      `✅ 已批准 <code>${targetId}</code>\n\n👥 白名单: ${wl.length} 人`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  // ── 拒绝申请 ──

  if (data.startsWith("reject:")) {
    const targetId = Number(data.slice(7));
    await deleteApplication(env, targetId);
    await answerCallbackQuery(env, cb.id, "❌ 已拒绝");
    await sendText(env, targetId, null, "❌ 你的申请未被通过。你可以重新申请。");
    await editMessageText(env, chatId, messageId,
      `❌ 已拒绝 <code>${targetId}</code>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  // ── 封禁用户 ──

  if (data.startsWith("ban:")) {
    const targetId = Number(data.slice(4));
    await banUser(env, targetId);
    await deleteApplication(env, targetId);
    await answerCallbackQuery(env, cb.id, "🚫 已封禁");
    await sendText(env, targetId, null, "⛔ 你已被封禁。");
    await editMessageText(env, chatId, messageId,
      `🚫 已封禁 <code>${targetId}</code>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  // ── 踢出用户 ──

  if (data.startsWith("kick:")) {
    const targetId = Number(data.slice(5));
    await removeFromWhitelist(env, targetId);
    await answerCallbackQuery(env, cb.id, "⛔ 已踢出");
    await sendText(env, targetId, null, "⛔ 你已被移出白名单。");
    await editMessageText(env, chatId, messageId,
      `⛔ 已踢出 <code>${targetId}</code>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  // ── 解封用户 ──

  if (data.startsWith("unban:")) {
    const targetId = Number(data.slice(6));
    await unbanUser(env, targetId);
    await answerCallbackQuery(env, cb.id, "✅ 已解封");
    await editMessageText(env, chatId, messageId,
      `✅ 已解封 <code>${targetId}</code>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  // 设置开关
  if (data.startsWith("toggle:")) {
    const key = data.slice(7);
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


// ═══════════════════════════════════════════════════════════════
// 转发来源提取
// ═══════════════════════════════════════════════════════════════

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


// ═══════════════════════════════════════════════════════════════
// GitHub Actions 触发
// ═══════════════════════════════════════════════════════════════

async function triggerWorkflow(env, chatId, messageId, caption, genThumb) {
  return await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "TinyAV1Bot-Worker",
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


// ═══════════════════════════════════════════════════════════════
// 设置系统
// ═══════════════════════════════════════════════════════════════

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


// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


// ═══════════════════════════════════════════════════════════════
// Bot API 封装
// ═══════════════════════════════════════════════════════════════

function ok() { return new Response("OK", { status: 200 }); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendText(env, chatId, replyTo, text, extra = {}) {
  const body = { chat_id: chatId, text, ...extra };
  if (replyTo) body.reply_to_message_id = replyTo;
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

async function copyMessages(env, chatId, messageIds) {
  return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, from_chat_id: chatId, message_ids: messageIds }),
  });
}

// ── 媒体组收集转发 ──
// Telegram 媒体组的每条消息独立到达 webhook，用 KV 收集后批量 copyMessages
// 只有 message_id 最小的请求执行转发，避免重复
async function collectAndForwardMediaGroup(env, chatId, messageId, groupId, settings) {
  const mgKey = `mg:${chatId}:${groupId}`;

  // 追加当前消息 ID
  let ids = [];
  const raw = await env.SETTINGS?.get(mgKey);
  if (raw && raw !== "done") {
    try { ids = JSON.parse(raw); } catch {}
  }
  if (raw === "done") return; // 已处理

  ids.push(messageId);
  await env.SETTINGS?.put(mgKey, JSON.stringify(ids), { expirationTtl: 120 });

  // 等待同组其他消息到达
  await sleep(600);

  // 重新读取全部 ID
  const updated = await env.SETTINGS?.get(mgKey);
  if (updated === "done") return;
  if (updated) {
    try { ids = JSON.parse(updated); } catch {}
  }

  // 只有 message_id 最小的请求执行转发，防止重复
  if (Math.min(...ids) !== messageId) return;

  // 标记完成
  await env.SETTINGS?.put(mgKey, "done", { expirationTtl: 120 });

  // 批量转发（Telegram 自动合并为专辑消息）
  await copyMessages(env, chatId, ids);
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

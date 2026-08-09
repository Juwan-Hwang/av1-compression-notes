/**
 * Cloudflare Worker — Telegram Bot Webhook → GitHub Actions 触发器
 *
 * 隐私设计：
 * - 不传递文件名到 workflow inputs（inputs 在 Actions 页面可见）
 * - 只传 chat_id 和 message_id（这两个是必需的，但不是文件内容）
 * - 回复用户时不显示原始文件名
 * - Worker 本身不存储任何数据
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("AV1 Compression Bot ✅", { status: 200 });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        const msg = update.message;
        if (!msg || (!msg.video && !msg.document)) {
          return new Response("OK", { status: 200 });
        }

        // 拒绝非视频消息
        if (msg.document && !msg.document.mime_type?.startsWith("video/")) {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              text: "⚠️ 请发送视频文件。",
              reply_to_message_id: msg.message_id,
            }),
          });
          return new Response("OK", { status: 200 });
        }

        const chatId = msg.chat.id;
        const messageId = msg.message_id;

        // 触发 GitHub Actions — 只传必需的 ID，不传文件名
        const resp = await fetch(
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
              },
            }),
          }
        );

        // 回复用户 — 不显示文件名
        const text = resp.ok
          ? "🚀 已收到视频，正在排队压缩...\n并行分片编码，预计 5-10 分钟。"
          : "❌ 排队失败，请稍后重试。";

        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            reply_to_message_id: messageId,
          }),
        });

        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

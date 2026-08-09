#!/usr/bin/env python3
"""Phase 1: 下载视频，按时间切分成多段。

原理：ffmpeg -f segment -c copy 按指定时间间隔切分，
自动对齐到最近的关键帧，无损无绿屏。简单可靠。"""

import os, json, subprocess, tempfile, asyncio, logging, shutil
from pyrogram import Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("av1")

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
BOT_TOKEN = os.environ["BOT_TOKEN"]

MAX_SEG = 35      # 切最多 35 段，留 5 个 runner 给 finalize + 下个视频的 prepare
MIN_SEG_SEC = 5    # 每段最少 5 秒，短于此则减少段数


async def main():
    chat_id = int(os.environ["CHAT_ID"])
    message_id = int(os.environ["MESSAGE_ID"])

    app = Client("av1", api_id=API_ID, api_hash=API_HASH,
                 bot_token=BOT_TOKEN, workdir="/tmp")

    async with app:
        msg = await app.get_messages(chat_id, message_id)
        status = await app.send_message(chat_id, "⏳ 下载中...", reply_to_message_id=message_id)

        with tempfile.TemporaryDirectory(prefix="av1_") as tmp:
            inp = os.path.join(tmp, "input")

            # ── 下载 ──
            await app.download_media(msg, file_name=inp)
            log.info("Download complete")

            # ── 探测时长，固定切 20 段 ──
            r = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", inp],
                capture_output=True, text=True)
            duration = float(json.loads(r.stdout)["format"]["duration"])

            # 固定 20 段，但如果每段不足 5 秒就减少段数
            n = MAX_SEG
            while n > 1 and duration / n < MIN_SEG_SEC:
                n -= 1
            seg_time = duration / n

            await status.edit_text(f"✂️ 切分 {n} 段...")
            log.info(f"Splitting into {n} segments (~{seg_time:.0f}s each)")

            # ── 按时间切分 (stream copy, 自动对齐关键帧) ──
            seg_dir = os.path.join(tmp, "segs")
            os.makedirs(seg_dir)
            subprocess.run([
                "ffmpeg", "-y", "-i", inp,
                "-f", "segment",
                "-segment_time", f"{seg_time:.3f}",
                "-reset_timestamps", "1",
                "-c", "copy",
                "-map_metadata", "-1",   # 清元数据
                os.path.join(seg_dir, "seg_%03d.mp4")
            ], check=True, capture_output=True)

            # ── 记录原始文件大小 ──
            orig_size = os.path.getsize(inp)
            os.remove(inp)  # 删源文件

            # ── 拷贝到 workspace ──
            ws = os.environ.get("GITHUB_WORKSPACE", ".")
            out_dir = os.path.join(ws, "segments")
            os.makedirs(out_dir, exist_ok=True)
            segs = sorted(f for f in os.listdir(seg_dir) if f.endswith(".mp4"))
            for s in segs:
                shutil.copy(os.path.join(seg_dir, s), os.path.join(out_dir, s))

            # ── 输出 matrix ──
            indices = list(range(len(segs)))
            gho = os.environ.get("GITHUB_OUTPUT", "/dev/null")
            with open(gho, "a") as f:
                f.write(f"segments={json.dumps(indices)}\n")
                f.write(f"count={len(segs)}\n")

            with open(os.path.join(ws, "segments.json"), "w") as f:
                json.dump({"segments": indices, "count": len(segs), "orig_size": orig_size}, f)

            await status.edit_text(f"🚀 {len(segs)} 段并行编码中...")
            log.info(f"Ready: {len(segs)} segments")


if __name__ == "__main__":
    asyncio.run(main())

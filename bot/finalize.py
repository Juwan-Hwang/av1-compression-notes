#!/usr/bin/env python3
"""Phase 3: 合并所有已编码段，生成缩略图，上传到 Telegram。"""

import os, sys, json, subprocess, tempfile, asyncio, logging, shutil, glob
from pyrogram import Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("av1")

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
BOT_TOKEN = os.environ["BOT_TOKEN"]


async def main():
    chat_id = int(sys.argv[1])
    message_id = int(sys.argv[2])
    caption = sys.argv[3] if len(sys.argv) > 3 else ""
    gen_thumb = os.environ.get("GEN_THUMBNAIL", "0") == "1"

    app = Client("av1-finalize", api_id=API_ID, api_hash=API_HASH,
                 bot_token=BOT_TOKEN, workdir="/tmp")

    async with app:
        msg = await app.get_messages(chat_id, message_id)
        status = await app.send_message(chat_id, "⏳ 合并中...", reply_to_message_id=message_id)

        workspace = os.environ.get("GITHUB_WORKSPACE", ".")

        with open(os.path.join(workspace, "segments.json")) as f:
            meta = json.load(f)
        n_segs = meta["count"]

        with tempfile.TemporaryDirectory(prefix="av1_merge_") as tmp:
            enc_dir = os.path.join(tmp, "encoded")
            os.makedirs(enc_dir)

            encoded_files = sorted(glob.glob(os.path.join(workspace, "encoded", "*_enc.mp4")))
            for i, src in enumerate(encoded_files):
                shutil.copy(src, os.path.join(enc_dir, f"seg_{i:03d}.mp4"))

            list_path = os.path.join(tmp, "list.txt")
            with open(list_path, "w") as f:
                for i in range(len(encoded_files)):
                    f.write(f"file 'seg_{i:03d}.mp4'\n")

            out_path = os.path.join(tmp, "output.mp4")
            subprocess.run([
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0", "-i", list_path,
                "-c", "copy",
                "-map_metadata", "-1",
                "-movflags", "+faststart",
                out_path
            ], check=True, capture_output=True)

            # 获取视频元数据
            probe = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json",
                 "-show_streams", "-show_format", out_path],
                capture_output=True, text=True)
            info = json.loads(probe.stdout)
            vstream = next(s for s in info["streams"] if s["codec_type"] == "video")
            duration = int(float(vstream.get("duration", 0)))
            width = int(vstream.get("width", 1280))
            height = int(vstream.get("height", 720))

            # 生成缩略图（取视频中点帧）
            thumb_path = None
            if gen_thumb:
                thumb_path = os.path.join(tmp, "thumb.jpg")
                seek = max(1, duration // 2)
                subprocess.run([
                    "ffmpeg", "-y", "-ss", str(seek), "-i", out_path,
                    "-frames:v", "1", "-vf", "scale=320:-1",
                    "-q:v", "2", thumb_path
                ], capture_output=True)
                if not os.path.exists(thumb_path):
                    thumb_path = None
                else:
                    log.info("Thumbnail generated")

            log.info("Merge complete, uploading...")

            # 构造 caption
            final_caption = caption.strip() if caption.strip() else ""

            # 发送视频（带元数据 + 可选缩略图）
            await app.send_video(
                chat_id=chat_id,
                video=out_path,
                duration=duration,
                width=width,
                height=height,
                thumb=thumb_path if thumb_path else None,
                reply_to_message_id=message_id,
                caption=final_caption if final_caption else None,
                supports_streaming=True)

            await status.delete()
            log.info("Upload complete")


if __name__ == "__main__":
    asyncio.run(main())

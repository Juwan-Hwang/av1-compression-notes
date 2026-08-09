#!/usr/bin/env python3
"""Phase 3: 合并所有已编码段，上传到 Telegram。

隐私设计：日志不输出任何文件信息，合并后清理所有 artifact。"""

import os
import sys
import json
import subprocess
import tempfile
import asyncio
import logging
import shutil
import glob

from pyrogram import Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("av1-finalize")

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
BOT_TOKEN = os.environ["BOT_TOKEN"]


async def main():
    chat_id = int(sys.argv[1])
    message_id = int(sys.argv[2])

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

            # 拷贝所有已编码段
            encoded_files = sorted(glob.glob(os.path.join(workspace, "encoded", "*_enc.mp4")))
            for i, src in enumerate(encoded_files):
                shutil.copy(src, os.path.join(enc_dir, f"seg_{i:03d}.mp4"))

            # concat 列表
            list_path = os.path.join(tmp, "list.txt")
            with open(list_path, "w") as f:
                for i in range(len(encoded_files)):
                    f.write(f"file 'seg_{i:03d}.mp4'\n")

            # 合并 (stream copy + faststart + 清除元数据)
            out_path = os.path.join(tmp, "output.mp4")
            subprocess.run([
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0", "-i", list_path,
                "-c", "copy",
                "-map_metadata", "-1",
                "-movflags", "+faststart",
                out_path
            ], check=True, capture_output=True)

            log.info("Merge complete, uploading...")

            await app.send_video(
                chat_id=chat_id,
                video=out_path,
                reply_to_message_id=message_id,
                caption=f"🎬 AV1 压缩完成\n⚙️ preset 2 CRF 36 720p Opus 96k\n📦 {n_segs} 段并行编码"
            )
            await status.delete()
            log.info("Upload complete")


if __name__ == "__main__":
    asyncio.run(main())

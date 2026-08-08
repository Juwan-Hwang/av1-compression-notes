# AV1 极限视频压缩方案

## 概述

使用 SVT-AV1 编码器对 1080p H.264 测试片进行极限压缩，在保持客观画质指标的前提下实现约 **72:1** 的压缩比。

## 源片参数

| 参数 | 值 |
|------|-----|
| 分辨率 | 1920×1080 |
| 编码器 | H.264 (AVC) High Profile |
| 帧率 | 24 fps |
| 视频码率 | ~28 Mbps |
| 音频 | AAC LC 320 kbps |
| 时长 | 473.6 s (7分54秒) |
| 文件大小 | ~1.57 GB |

## 最优压缩命令

```bash
ffmpeg -i input.mp4 \
  -c:v libsvtav1 -preset 2 -crf 36 -pix_fmt yuv420p \
  -vf "scale=1280:720,setsar=1" \
  -c:a libopus -b:a 96k \
  -movflags +faststart \
  output.mp4
```

## 输出参数

| 参数 | 值 |
|------|-----|
| 编码器 | AV1 (SVT-AV1 / libsvtav1) |
| Preset | 2 |
| CRF | 36 |
| 像素格式 | yuv420p (8-bit) |
| 分辨率 | 1280×720 |
| 帧率 | 24 fps |
| 视频码率 | 307 kbps |
| 音频编码器 | Opus (VBR) |
| 音频码率 | ~75 kbps |
| 总码率 | 371 kbps |
| 文件大小 | 21.82 MB |
| 编码时间 | ~11 min (AMD Ryzen 7 8845H, 8C/16T) |

## 客观画质评估

### PSNR (峰值信噪比)

| 通道 | PSNR (dB) |
|------|-----------|
| Y (亮度) | 43.39 |
| U (色度) | 51.81 |
| V (色度) | 51.09 |
| **平均** | **44.83** |
| 最差帧 | 41.17 |

### SSIM (结构相似性)

| 通道 | SSIM |
|------|------|
| Y (亮度) | 0.9854 |
| U (色度) | 0.9958 |
| V (色度) | 0.9950 |
| **综合** | **0.9887** |

### VMAF (Netflix 感知画质)

| 指标 | 值 |
|------|-----|
| **VMAF** | **92.45** |

> 参考标准：100=无损，97+=视觉透明，90+=优秀，80+=良好。

> 评估方法：将 720p 输出放大至 1080p 后与源片逐帧对比，使用 ffmpeg psnr/ssim/libvmaf 滤镜。


## 关键技术要点

1. **Preset 2（极慢）**：SVT-AV1 的 preset 直接决定运动搜索深度。Preset 2 在同码率下比 Preset 4 效率高约 1 dB PSNR，比 Preset 6 高约 0.9 dB。更快的 preset 无法通过降低 CRF 弥补效率差距。

2. **Opus 音频替代 AAC**：Opus 75k VBR 的听感等同于或优于 AAC 128k CBR。音频节省的 ~3 MB 码率空间分配给视频，使视频码率提升至 307 kbps 而总文件仍更小。

3. **8-bit 编码**：在极低码率场景下，8-bit 与 10-bit 的 PSNR/SSIM 差异可忽略，但 8-bit 编码速度更快。

4. **CRF 36 的选择**：经过 CRF 36-52 的系统扫描，CRF 36 是在 Preset 2 下同时满足「PSNR > 44.80」和「文件 < 23 MB」的唯一 CRF 值。

## 环境要求

- FFmpeg >= 6.0（需编译 `--enable-libsvtav1 --enable-libopus`）
- SVT-AV1 编码器
- Opus 音频编码器
- VMAF 评估（可选，需编译 `--enable-libvmaf`）

## 速度优先方案

若编码速度优先，可使用 Preset 3（比 Preset 2 快约 22%），以更高码率换取相近画质：

```bash
ffmpeg -i input.mp4 \
  -c:v libsvtav1 -preset 3 -crf 34 -pix_fmt yuv420p \
  -vf "scale=1280:720,setsar=1" \
  -c:a libopus -b:a 96k \
  -movflags +faststart \
  output.mp4
```

| 指标 | Preset 2 CRF 36 (最优) | Preset 3 CRF 34 (速度优先) |
|------|----------------------|--------------------------|
| 编码时间 | ~11 min | **~8.6 min** |
| PSNR | **44.83** | 44.74 |
| SSIM | **0.9887** | 0.9885 |
| VMAF | **92.45** | 92.17 |
| 视频码率 | 307 kbps | 328 kbps |
| 文件大小 | **21.82 MB** | 23.44 MB |

## 多测试片验证

使用公开标准测试片验证方案泛化性，均采用相同参数（preset 2 CRF 36 8-bit + Opus 96k）。

### Sintel (Blender Foundation)

| 参数 | 源片 | 压缩后 |
|------|------|--------|
| 来源 | xiph.org | — |
| 分辨率 | 1920×1080 | 1280×720 |
| 帧率 | 24 fps | 24 fps |
| 格式 | Y4M 无损 (raw) | AV1 (SVT-AV1) |
| 音频 | 无 | 无 |
| 时长 | 52.2 s | 52.2 s |
| 文件大小 | 3.63 GB | **2.15 MB** |
| 视频码率 | ~558 Mbps | 345 kbps |
| 编码时间 | — | ~1.5 min |
| 压缩比 | — | **1726:1** |

| 指标 | 值 |
|------|-----|
| PSNR 平均 | 43.04 |
| PSNR 最差帧 | 37.47 |
| SSIM 综合 | 0.9889 |
| VMAF | 86.49 |

> Sintel 为 Blender 开源动画短片，细节密度高、边缘锐利，对编码器挑战较大。源片为无损 Y4M 格式（无压缩损失），VMAF 86.49 反映了动画内容在极低码率下的合理表现。

### Chimera (Netflix)

| 参数 | 源片 | 压缩后 |
|------|------|--------|
| 来源 | opencontent.netflix.com | — |
| 分辨率 | 4096×2160 (DCI 4K) | 1280×720 |
| 帧率 | 59.94 fps | 59.94 fps |
| 格式 | H.264 | AV1 (SVT-AV1) |
| 时长 | 1850.8 s | 1850.8 s |
| 文件大小 | 10.16 GB | 编码中... |
| 压缩比 | — | 待测 |

| 指标 | 值 |
|------|-----|
| PSNR | 编码中... |
| SSIM | 编码中... |
| VMAF | 编码中... |

> Chimera 为 Netflix 开源 4K HDR 测试片，包含大量实拍高动态范围场景。4K → 720p 的下采样提供了额外的压缩空间。

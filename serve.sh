#!/usr/bin/env bash
# 在 WSL 里启动 UI-TARS-1.5-7B (GPTQ 4bit) 的 OpenAI 兼容服务，Windows 侧访问 http://127.0.0.1:8000/v1
# 先运行一次 setup-wsl.sh。可用环境变量覆盖：TARS_HOME（默认 ~/tars-pilot）、PORT、GPU_UTIL
TARS_HOME="${TARS_HOME:-$HOME/tars-pilot}"
cd "$TARS_HOME" && . .venv/bin/activate
# WSL 里没有 nvcc，FlashInfer 采样器需要现场编译，关掉用 PyTorch 实现
export VLLM_USE_FLASHINFER_SAMPLER=0
# --limit-mm-per-prompt 里的宽高只影响启动时的显存预估，不影响实际图片处理（坐标换算不变）
# "video": 0：我们不用视频；不关的话启动时要按"最大尺寸视频"做显存预估，冷启动会卡好几分钟
exec vllm serve "$TARS_HOME/model" \
  --served-model-name ui-tars \
  --host 0.0.0.0 --port "${PORT:-8000}" \
  --max-model-len 32768 \
  --gpu-memory-utilization "${GPU_UTIL:-0.85}" \
  --limit-mm-per-prompt '{"image": {"count": 5, "width": 2560, "height": 1600}, "video": 0}' \
  --max-num-seqs 2

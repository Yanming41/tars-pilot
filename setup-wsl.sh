#!/usr/bin/env bash
# 在 WSL (Ubuntu) 里一次性安装：uv → Python 3.12 虚拟环境 → vLLM → 下载 UI-TARS-1.5-7B GPTQ 4bit 模型（约 6.5GB）
# 用法（在 PowerShell 里）: wsl -d Ubuntu --cd <本仓库目录> -- bash ./setup-wsl.sh
set -e
TARS_HOME="${TARS_HOME:-$HOME/tars-pilot}"
MODEL_REPO="${MODEL_REPO:-yujiepan/ui-tars-1.5-7B-GPTQ-W4A16g128}"

command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

mkdir -p "$TARS_HOME" && cd "$TARS_HOME"
# 用 uv 自带的 Python：Ubuntu 系统 Python 缺 Python.h（没有 sudo 装不了 python3-dev），
# 而 vLLM 的 Triton 启动时要现场编译 C 扩展
[ -d .venv ] || uv venv --managed-python --python 3.12 .venv
. .venv/bin/activate
uv pip install vllm huggingface_hub hf_transfer

HF_HUB_ENABLE_HF_TRANSFER=1 hf download "$MODEL_REPO" --local-dir "$TARS_HOME/model"
python -c "import vllm, torch; print('vllm', vllm.__version__, '| CUDA available:', torch.cuda.is_available())"
echo "完成。启动服务: powershell -File start-server.ps1"

# Start the local UI-TARS model server (WSL + vLLM). First load takes ~1-2 min; Ctrl+C to stop.
# Usage: powershell -File start-server.ps1 [-Distro Ubuntu]
param([string]$Distro = "Ubuntu")
wsl -d $Distro --cd "$PSScriptRoot" -- bash ./serve.sh

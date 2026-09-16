#requires -Version 7
<#
  一次性运维脚本：把两个从未推送的大提交拆成「小批次 commit + push」，
  规避低速率链路下 GitHub 的 HTTP 408 超时。
  只用显式 HTTPS 地址推送，不改动仓库的 remote 配置。
#>
$ErrorActionPreference = 'Continue'
Set-Location 'e:\ai\qoder\toeic'

$UP   = 'https://github.com/18005920002/ToeicKeyWords.git'
$BASE = (git rev-parse origin/main).Trim()
Write-Host "基准提交(origin/main) = $BASE"

# 1) 把未推送的两个提交打散：--soft 只移动 HEAD 指针，绝对不触碰工作区文件；
#    随后的 mixed reset 取消暂存，让所有文件回到「未跟踪/已修改」状态待分批添加。
git reset --soft $BASE
git reset | Out-Null
Write-Host "已回退到 $BASE 并取消暂存（文件内容未改动）"

function Push-One([string]$label) {
  git commit -m $label --quiet
  if ($LASTEXITCODE -ne 0) { Write-Host "  (无改动可提交，跳过) $label"; return $true }

  for ($i = 1; $i -le 3; $i++) {
    Write-Host (">>> [{0:HH:mm:ss}] 第 {1} 次尝试推送：{2}" -f (Get-Date), $i, $label)
    $out  = git push $UP main 2>&1
    $code = $LASTEXITCODE
    ($out | Select-Object -Last 6) | ForEach-Object { "      $_" }
    if ($code -eq 0) { Write-Host ("<<< [{0:HH:mm:ss}] 成功：{1}" -f (Get-Date), $label); return $true }
    Write-Host "      推送失败，8 秒后重试…"
    Start-Sleep -Seconds 8
  }
  Write-Host ("!!! 三次均失败，停在：{0}" -f $label)
  return $false
}

# 2) 第一批：代码 + Capacitor/android 原生工程 + CI 工作流（体积很小，先让 workflow 上云）
#    注意：docs/token.md 已加入 .gitignore，不会被 docs 这条路径带进去。
git add -- .gitignore package.json package-lock.json capacitor.config.json js tools docs android .github README.md
if (-not (Push-One 'package as Android APK via Capacitor + CI build')) { Write-Host 'ABORT'; exit 1 }

# 3) 音频按单元逐个提交并推送（每个单元 160 个 mp3，约 2.8MB）
for ($u = 16; $u -le 30; $u++) {
  git add -- "audio/unit-${u}__*"
  git add -- audio/jobs.json
  if (-not (Push-One "audio unit $u")) { Write-Host "ABORT at unit $u"; exit 1 }
}

Write-Host '================ 收尾核对 ================'
git status --short | Select-Object -First 10
$tracked = (git ls-files audio | Select-String '\.mp3$').Count
Write-Host "本地已跟踪 mp3 数：$tracked （期望 4800）"
$t = git ls-files docs/token.md
Write-Host ("docs/token.md 是否被跟踪：" + [bool]$t)
Write-Host 'DONE'

# 分批把 audio/ 的预生成发音推送到 GitHub。
# 单个大请求体（84MB）会被本机代理静默掐断，因此按单元分组、每批一次 push。
$ErrorActionPreference = 'Continue'
Set-Location 'e:\ai\qoder\toeic'

$proxy = 'http://127.0.0.1:7897'
$log = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'toeic-batch.log')

function Log([string]$m) {
    Add-Content -Path $log -Value ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m)
}

Set-Content -Path $log -Value 'START'

$batches = @(
    , @(1, 2, 3, 4, 5)
    , @(6, 7, 8, 9, 10)
    , @(11, 12, 13, 14, 15)
    , @(16, 17, 18, 19, 20)
    , @(21, 22, 23, 24, 25)
    , @(26, 27, 28, 29, 30)
)

for ($i = 0; $i -lt $batches.Count; $i++) {
    $b = $batches[$i]
    $paths = @($b | ForEach-Object { 'audio/unit-' + $_ + '__*' })
    # 最后一批顺手把生成任务清单也带上，免得它在本地悬着
    if ($i -eq $batches.Count - 1) { $paths += 'audio/jobs.json' }

    git add -- $paths 2>&1 | ForEach-Object { Log ('add: ' + $_) }
    if ($LASTEXITCODE -ne 0) { Log 'ADD FAILED, abort'; exit 1 }

    $msg = '预生成发音 unit ' + $b[0] + '-' + $b[-1] + '：单词朗读 + 例句朗读，美音/英音'
    git commit -q -m $msg 2>&1 | ForEach-Object { Log ('commit: ' + $_) }
    if ($LASTEXITCODE -ne 0) { Log 'COMMIT FAILED, abort'; exit 1 }

    git -c "http.proxy=$proxy" push origin main 2>&1 | ForEach-Object { Log ('push: ' + $_) }
    if ($LASTEXITCODE -ne 0) { Log ('PUSH FAILED exit=' + $LASTEXITCODE); exit 1 }

    $n = (git ls-tree -r --name-only HEAD -- audio | Measure-Object -Line).Lines
    Log ('BATCH OK unit ' + $b[0] + '-' + $b[-1] + '  累计入库音频文件: ' + $n)
}

Log 'ALL DONE'
exit 0

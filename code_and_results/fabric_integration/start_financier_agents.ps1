$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $RootDir "agent_state"
$QTableFile = if ($env:QTABLE_FILE) {
    $env:QTABLE_FILE
} else {
    Join-Path $RootDir "trained_q_tables\trained_q_tables_5000000_high_default.json"
}
$BasePort = if ($env:BASE_PORT) { [int]$env:BASE_PORT } else { 8101 }
$Capital = if ($env:CAPITAL) { [double]$env:CAPITAL } else { 5000000 }
$Python = if ($env:PYTHON) { $env:PYTHON } else { "C:\Python312\python.exe" }

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

$Financiers = @("User1", "User2", "User3")
$Agents = @()

for ($idx = 0; $idx -lt $Financiers.Count; $idx++) {
    $FinancierId = $Financiers[$idx]
    $Port = $BasePort + $idx
    $StateFile = Join-Path $StateDir "$FinancierId.json"
    $LogFile = Join-Path $StateDir "$FinancierId.log"
    $ErrFile = Join-Path $StateDir "$FinancierId.err.log"

    Write-Host "Starting RL+RL agent for $FinancierId on port $Port"
    $Arguments = @(
        (Join-Path $RootDir "rl_financier_service.py"),
        "--financier-id", $FinancierId,
        "--port", "$Port",
        "--capital", "$Capital",
        "--wallet", "$Capital",
        "--state-file", $StateFile,
        "--q-table-file", $QTableFile,
        "--model-version", "live-rl-rl-agent-v1",
        "--min-offer-apr", "6",
        "--max-offer-apr", "48"
    )
    Start-Process -FilePath $Python -ArgumentList $Arguments -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile -WindowStyle Hidden
    $Agents += [pscustomobject]@{
        financierId = $FinancierId
        userId = $FinancierId
        agentUrl = "http://127.0.0.1:$Port/quote"
    }
}

Write-Host "Started $($Financiers.Count) financier agents."
Write-Host "Example FINANCIER_RL_AGENTS value:"
$Agents | ConvertTo-Json

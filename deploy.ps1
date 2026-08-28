#Requires -RunAsAdministrator
param(
    [string]$Dir = "C:\LiveStream",
    [switch]$China
)
$ErrorActionPreference = "Stop"
function Info($m) { Write-Host "[INFO]  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[OK]    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[WARN]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[ERR]   $m" -ForegroundColor Red; exit 1 }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User") }

$GitRepoUrl = "https://github.com/ZhengHongyi100414/LiveStream-SinglePage.git"
if ($China) { $NodeMirror="https://npmmirror.com/mirrors/node"; $NpmRegistry="https://registry.npmmirror.com"; Info "China mirror mode" } else { $NodeMirror=$null; $NpmRegistry=$null }

function Ensure-Chocolatey {
    if (Get-Command choco -EA SilentlyContinue) { Ok "Chocolatey $(choco --version) installed"; return }
    Info "Installing Chocolatey..."
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    Refresh-Path
    if (-not (Get-Command choco -EA SilentlyContinue)) { Die "Chocolatey install failed" }
    Ok "Chocolatey installed"
}

function Install-Node {
    if (Get-Command node -EA SilentlyContinue) {
        $ver = [int](node -v).TrimStart('v').Split('.')[0]
        if ($ver -ge 16) { Ok "Node.js $(node -v) already installed"; if ($NpmRegistry) { npm config set registry $NpmRegistry 2>$null }; return }
        Warn "Node.js too old, upgrading..."
    }
    if ($China) {
        Info "Installing Node.js 18.x from npmmirror..."
        $version = $null
        try { $index = (New-Object Net.WebClient).DownloadString("$NodeMirror/index.tab"); $version = ($index -split "`n" | ? { $_ -match '^v18\.' } | select -First 1).Trim() } catch {}
        if (-not $version) { $version = "v18.20.4" }
        $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
        $url = "$NodeMirror/$version/node-$version-win-$arch.zip"
        Info "Downloading: $url"
        $tmp = Join-Path $env:TEMP "node-install"; if (Test-Path $tmp) { ri $tmp -Recurse -Force }; mkdir $tmp -Force | Out-Null
        (New-Object Net.WebClient).DownloadFile($url, "$tmp\node.zip")
        Expand-Archive "$tmp\node.zip" $tmp -Force
        $nd = ls $tmp -Dir | ? { $_.Name -like "node-*" } | select -First 1
        $tgt = "C:\nodejs"; if (Test-Path $tgt) { ri $tgt -Recurse -Force }; mv $nd.FullName $tgt
        $mp = [Environment]::GetEnvironmentVariable("Path","Machine")
        if ($mp -notlike "*$tgt*") { [Environment]::SetEnvironmentVariable("Path","$tgt;$mp","Machine"); $env:Path = "$tgt;$env:Path" }
        ri $tmp -Recurse -Force -EA SilentlyContinue
    } else {
        Info "Installing Node.js LTS via Chocolatey..."
        choco install nodejs-lts -y --no-progress
    }
    Refresh-Path
    if (-not (Get-Command node -EA SilentlyContinue)) { Die "Node.js install failed" }
    Ok "Node.js $(node -v) installed"
    if ($NpmRegistry) { npm config set registry $NpmRegistry; Info "npm registry -> $NpmRegistry" }
}

function Install-FFmpeg {
    if (Get-Command ffmpeg -EA SilentlyContinue) { Ok "FFmpeg already installed"; return }
    Info "Installing FFmpeg via Chocolatey..."
    choco install ffmpeg -y --no-progress; Refresh-Path
    if (-not (Get-Command ffmpeg -EA SilentlyContinue)) { Die "FFmpeg install failed" }
    Ok "FFmpeg installed"
}

function Install-PM2 {
    if (Get-Command pm2 -EA SilentlyContinue) { Ok "PM2 $(pm2 -v) already installed"; return }
    Info "Installing PM2..."
    npm install -g pm2; npm install -g pm2-windows-startup 2>$null
    Ok "PM2 $(pm2 -v) installed"
}

function Deploy-Project {
    if (Test-Path "$Dir\.git") { Info "Pulling latest..."; cd $Dir; git pull --ff-only 2>$null; if ($LASTEXITCODE -ne 0) { Warn "git pull failed" } }
    elseif (Test-Path "$Dir\package.json") { Info "Using existing dir"; cd $Dir }
    else { Info "Cloning to $Dir..."; git clone $GitRepoUrl $Dir; cd $Dir }
    Info "Installing npm deps..."
    npm install --unsafe-perm
    $ff = (Get-Command ffmpeg -EA SilentlyContinue).Source
    if ($ff) { $c = Get-Content "$Dir\config.js" -Raw; $c = $c -replace "/usr/bin/ffmpeg", $ff.Replace('\','/'); Set-Content "$Dir\config.js" $c -NoNewline; Info "Updated ffmpeg path -> $ff" }
    Ok "Project deployed -> $Dir"
}

function Start-LiveStream {
    cd $Dir; pm2 delete livestream 2>$null
    Info "Starting LiveStream..."
    pm2 start server.js --name livestream --max-memory-restart 512M; pm2 save
    try { pm2-startup install 2>$null; Ok "PM2 startup configured" } catch { Warn "PM2 startup failed" }
    Ok "Service started"
}

function Open-Firewall {
    Info "Configuring Windows Firewall..."
    @(@{N="LiveStream-API";P=3000},@{N="LiveStream-Media";P=8080},@{N="LiveStream-RTMP";P=1935}) | % {
        $ex = Get-NetFirewallRule -DisplayName $_.N -EA SilentlyContinue
        if ($ex) { Set-NetFirewallRule -DisplayName $_.N -Enabled True -Action Allow } else { New-NetFirewallRule -DisplayName $_.N -Direction Inbound -Protocol TCP -LocalPort $_.P -Action Allow -EA SilentlyContinue | Out-Null }
    }
    Ok "Firewall ports opened (3000/8080/1935)"
}

function Print-Summary {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 | ? { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } | select -First 1).IPAddress
    if (-not $ip) { $ip = "<SERVER_IP>" }
    Write-Host "`n==================================================" -ForegroundColor Green
    Write-Host "  LiveStream deployed successfully!" -ForegroundColor Green
    Write-Host "==================================================" -ForegroundColor Green
    Write-Host "`n  Web Player:  http://${ip}:3000" -ForegroundColor Cyan
    Write-Host "  Admin Panel: http://${ip}:3000/console" -ForegroundColor Cyan
    Write-Host "  RTMP Push:   rtmp://${ip}:1935/live/live" -ForegroundColor Cyan
    Write-Host "  FLV:         http://${ip}:8080/live/live.flv" -ForegroundColor Cyan
    Write-Host "  HLS:         http://${ip}:8080/live/live/index.m3u8" -ForegroundColor Cyan
    Write-Host "`n  OBS: Server=rtmp://${ip}:1935/live  Key=live"
    Write-Host "  Default login: admin / admin123 (change ASAP!)" -ForegroundColor Yellow
    Write-Host "`n  pm2 status | pm2 logs livestream | pm2 restart livestream"
    Write-Host "==================================================`n" -ForegroundColor Green
}

Write-Host "`n  LiveStream Deploy (Windows Server)`n" -ForegroundColor Cyan
Ensure-Chocolatey; Install-Node; Install-FFmpeg; Install-PM2; Deploy-Project; Start-LiveStream; Open-Firewall; Print-Summary
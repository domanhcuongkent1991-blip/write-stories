param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,
  [Parameter(Mandatory = $true)]
  [string]$StableProjectRoot,
  [Parameter(Mandatory = $true)]
  [string]$WebHost,
  [string]$AppRoot = 'D:\InkOS\write-stories-vi-1.8.0',
  [int]$WebPort = 4568,
  [int]$ApiPort = 4570
)

$ErrorActionPreference = 'Stop'

function Resolve-CanonicalDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label does not exist: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Normalize-CanonicalPath([string]$Path) {
  return $Path.TrimEnd('\', '/').ToLowerInvariant()
}

function Assert-PortAvailable([int]$Port, [string]$Label) {
  if ($Port -lt 1 -or $Port -gt 65535) {
    throw "$Label must be between 1 and 65535."
  }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    throw "$Label $Port is already listening."
  }
}

try {
  $resolvedAppRoot = Resolve-CanonicalDirectory $AppRoot 'AppRoot'
  $resolvedProjectRoot = Resolve-CanonicalDirectory $ProjectRoot 'ProjectRoot'
  $resolvedStableRoot = Resolve-CanonicalDirectory $StableProjectRoot 'StableProjectRoot'

  if ((Normalize-CanonicalPath $resolvedProjectRoot) -eq (Normalize-CanonicalPath $resolvedStableRoot)) {
    throw 'ProjectRoot must not be the stable project root.'
  }

  $inkosPath = Join-Path $resolvedProjectRoot 'inkos.json'
  $markerPath = Join-Path $resolvedProjectRoot '.inkos\vi-writing-v1.json'
  if (-not (Test-Path -LiteralPath $inkosPath -PathType Leaf)) {
    throw "ProjectConfig is missing: $inkosPath"
  }
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Vietnamese writing marker is missing: $markerPath"
  }

  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  if ($marker.schemaVersion -ne 1 -or $marker.contractVersion -ne 'vi-writing-v1' -or [string]::IsNullOrWhiteSpace([string]$marker.projectRoot)) {
    throw 'Vietnamese writing marker has an invalid schema or contract.'
  }
  $resolvedMarkerRoot = Resolve-CanonicalDirectory ([string]$marker.projectRoot) 'Marker projectRoot'
  if ((Normalize-CanonicalPath $resolvedMarkerRoot) -ne (Normalize-CanonicalPath $resolvedProjectRoot)) {
    throw 'Vietnamese writing marker projectRoot does not match ProjectRoot.'
  }

  [System.Net.IPAddress]$parsedIp = $null
  if (-not [System.Net.IPAddress]::TryParse($WebHost, [ref]$parsedIp)) {
    throw "WebHost must be an IPv4 address: $WebHost"
  }
  $webOctets = $WebHost.Split('.')
  $invalidOctets = @($webOctets | Where-Object { $_ -notmatch '^\d+$' -or [int]$_ -lt 0 -or [int]$_ -gt 255 })
  if ($parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $webOctets.Count -ne 4 -or $invalidOctets.Count -gt 0) {
    throw "WebHost must be an IPv4 address: $WebHost"
  }
  $private = ($webOctets[0] -eq '10') -or
    ($webOctets[0] -eq '192' -and $webOctets[1] -eq '168') -or
    ($webOctets[0] -eq '172' -and [int]$webOctets[1] -ge 16 -and [int]$webOctets[1] -le 31)
  if (-not $private) {
    throw "WebHost must be an RFC1918 private IPv4 address: $WebHost"
  }

  $address = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $WebHost -ErrorAction SilentlyContinue |
    Where-Object {
      $adapter = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
      $null -ne $adapter -and $adapter.Status -eq 'Up'
    }) | Select-Object -First 1
  if ($null -eq $address) {
    throw "WebHost is not assigned to an Up network interface: $WebHost"
  }
  $profile = Get-NetConnectionProfile -InterfaceIndex $address.InterfaceIndex -ErrorAction SilentlyContinue
  if ($null -eq $profile -or $profile.NetworkCategory -ne 'Private') {
    throw "The WebHost network profile must be Private: $WebHost"
  }

  if ($WebPort -eq $ApiPort) {
    throw 'WebPort and ApiPort must be different.'
  }
  Assert-PortAvailable $WebPort 'WebPort'
  Assert-PortAvailable $ApiPort 'ApiPort'

  $lanUrl = "http://$WebHost`:$WebPort"
  Write-Host "Source/AppRoot: $resolvedAppRoot"
  Write-Host "Experiment ProjectRoot: $resolvedProjectRoot"
  Write-Host "Stable ProjectRoot: $resolvedStableRoot"
  Write-Host "LAN URL: $lanUrl"
  Write-Host "WebPort: $WebPort | ApiPort: $ApiPort (API loopback-only)"
  Write-Host 'Lưu ý: chính sách Origin chỉ chống CSRF; đây không phải xác thực thiết bị.'
  $confirmation = Read-Host 'Tôi xác nhận mạng LAN và thiết bị đang dùng là đáng tin cậy. Đây không phải xác thực thiết bị. Khởi chạy? [y/N]'
  if ($confirmation -notin @('y', 'Y', 'yes', 'YES')) {
    Write-Host 'Đã hủy khởi chạy.'
    exit 0
  }

  $env:INKOS_PROJECT_ROOT = $resolvedProjectRoot
  $env:INKOS_EXPERIMENTAL_WRITING_VI = '1'
  $env:INKOS_STUDIO_ACCESS_MODE = 'trusted-lan'
  $env:INKOS_STUDIO_ALLOWED_ORIGINS = $lanUrl
  $env:INKOS_STUDIO_HOSTNAME = '127.0.0.1'
  $env:INKOS_STUDIO_PORT = [string]$ApiPort
  $env:INKOS_STUDIO_WEB_HOST = $WebHost
  $env:INKOS_STUDIO_WEB_PORT = [string]$WebPort

  $studioRoot = Join-Path $resolvedAppRoot 'packages\studio'
  $coreRoot = Join-Path $resolvedAppRoot 'packages\core'
  $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
  $coreTsc = Join-Path $coreRoot 'node_modules\.bin\tsc.cmd'
  $tsxLoader = './node_modules/tsx/dist/loader.mjs'
  $viteEntrypoint = './node_modules/vite/bin/vite.js'
  if (-not (Test-Path -LiteralPath $studioRoot -PathType Container) -or
      -not (Test-Path -LiteralPath $coreTsc -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $studioRoot 'node_modules\tsx\dist\loader.mjs') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $studioRoot 'node_modules\vite\bin\vite.js') -PathType Leaf)) {
    throw "Studio local entrypoints are missing under: $studioRoot"
  }

  # Build only this worktree's Core package. Avoid pnpm workspace traversal,
  # which can accidentally include a neighboring stable checkout.
  Push-Location $coreRoot
  try {
    & $coreTsc
    $coreBuildExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($coreBuildExitCode -ne 0) {
    throw "Core build failed with exit code $coreBuildExitCode."
  }

  $apiProcess = $null
  $webProcess = $null
  try {
    $apiProcess = Start-Process -FilePath $nodeExecutable -WorkingDirectory $studioRoot -ArgumentList @('--import', $tsxLoader, 'src/api/index.ts') -PassThru
    $webProcess = Start-Process -FilePath $nodeExecutable -WorkingDirectory $studioRoot -ArgumentList @($viteEntrypoint, '--host', $WebHost, '--port', [string]$WebPort) -PassThru

    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
      if (($apiProcess -and $apiProcess.HasExited) -or ($webProcess -and $webProcess.HasExited)) {
        throw 'Studio child process exited before health checks completed.'
      }
      try {
        $projectHealth = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/api/v1/project" -TimeoutSec 2
        $webHealth = Invoke-WebRequest -UseBasicParsing -Uri $lanUrl -TimeoutSec 2
        if ($projectHealth.StatusCode -eq 200 -and $webHealth.StatusCode -eq 200) {
          $ready = $true
          break
        }
      } catch {
        Start-Sleep -Seconds 1
      }
    }
    if (-not $ready) {
      throw 'Studio health checks did not become ready within 60 seconds.'
    }
    Write-Host "Studio is ready: $lanUrl"
    Write-Host 'Nhấn Ctrl+C để dừng hai tiến trình Studio.'
    while ($true) {
      if ($apiProcess.HasExited -or $webProcess.HasExited) { break }
      Start-Sleep -Seconds 1
    }
  } finally {
    foreach ($process in @($webProcess, $apiProcess)) {
      if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
      }
    }
  }
} catch {
  Write-Error $_
  exit 1
}

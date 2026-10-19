# ==============================================================================
# COREGATE release packager. Run on Windows with the .NET 9 SDK and a Dimraeth
# install that has BepInEx interop assemblies generated (needed by Coregate).
#   powershell -ExecutionPolicy Bypass -File .\build-release.ps1 -Version 1.0.0
# Output: dist\Coregate-v<Version>.zip and a matching .sha256 file
# ==============================================================================
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [string]$GameDir = "C:\Program Files (x86)\Steam\steamapps\common\Dimraeth"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$name = "Coregate-v$Version"
$stage = Join-Path $dist $name

function Invoke-Dotnet([string[]]$dotnetArgs) {
    & dotnet @dotnetArgs
    if ($LASTEXITCODE -ne 0) { throw "dotnet $($dotnetArgs -join ' ') failed with exit $LASTEXITCODE" }
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Host "[*] Building Coregate..." -ForegroundColor Cyan
Invoke-Dotnet @("build", (Join-Path $root "src\Gate\Gate.csproj"), "-c", "Release", "-nologo", "-p:GameDir=$GameDir\BepInEx")

Write-Host "[*] Publishing CoregatePatcher (self-contained win-x64)..." -ForegroundColor Cyan
$patcherOut = Join-Path $dist "patcher-publish"
Invoke-Dotnet @("publish", (Join-Path $root "src\Patcher\Patcher.csproj"), "-c", "Release", "-r", "win-x64", "--self-contained", "true",
    "-p:PublishSingleFile=true", "-p:EnableCompressionInSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=none", "-nologo", "-o", $patcherOut)

Write-Host "[*] Staging $name..." -ForegroundColor Cyan
foreach ($d in "plugins", "scripts", "docs") { New-Item -ItemType Directory -Path (Join-Path $stage $d) -Force | Out-Null }
Copy-Item (Join-Path $root "plugins\*") (Join-Path $stage "plugins")
Copy-Item (Join-Path $root "src\Configurator\CoregateManager.ps1") (Join-Path $stage "scripts")
foreach ($f in "install.bat", "install.ps1", "README.md", "LICENSE") {
    if (Test-Path (Join-Path $root $f)) { Copy-Item (Join-Path $root $f) $stage }
}
Copy-Item (Join-Path $root "docs\*") (Join-Path $stage "docs") -Recurse
Copy-Item (Join-Path $root "web") $stage -Recurse

$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# Entries are added one by one: .NET Framework's CreateFromDirectory writes backslash
# separators, which other platforms' unzip tools treat as part of the file name
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem $stage -Recurse -File | ForEach-Object {
        $entry = $name + "/" + $_.FullName.Substring($stage.Length + 1).Replace("\", "/")
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally {
    $archive.Dispose()
}

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText("$zip.sha256", "$hash  $name.zip`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "[OK] $zip" -ForegroundColor Green
Write-Host "     sha256 $hash" -ForegroundColor Gray

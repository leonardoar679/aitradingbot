<#
Imports the already-generated build/cert.pfx into this machine's Trusted Root
and Trusted Publisher stores, so the signed .exe runs without a SmartScreen
"Unknown Publisher" warning on THIS machine only.

Must be run in an elevated (Run as Administrator) PowerShell.

Usage:
  powershell -ExecutionPolicy Bypass -File scripts/trust-cert.ps1
#>

param(
    [string]$PfxPath = "$PSScriptRoot\..\build\cert.pfx",
    [string]$Password = $env:CSC_KEY_PASSWORD
)

if (-not (Test-Path $PfxPath)) {
    Write-Host "Certificate not found at $PfxPath. Run scripts/create-self-signed-cert.ps1 first." -ForegroundColor Red
    exit 1
}

if (-not $Password) {
    $securePrompt = Read-Host "Enter the cert password (from when it was created)" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePrompt)
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$securePwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
$cert = Import-PfxCertificate -FilePath $PfxPath -CertStoreLocation Cert:\LocalMachine\My -Password $securePwd

$rootStore = Get-Item Cert:\LocalMachine\Root
$rootStore.Open("ReadWrite")
$rootStore.Add($cert)
$rootStore.Close()

$publisherStore = Get-Item Cert:\LocalMachine\TrustedPublisher
$publisherStore.Open("ReadWrite")
$publisherStore.Add($cert)
$publisherStore.Close()

Write-Host "Certificate trusted on this machine."

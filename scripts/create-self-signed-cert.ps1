<#
Generates a self-signed code-signing certificate and exports it as build/cert.pfx.
Also imports it into the local machine's Trusted Root + Trusted Publishers stores
so the signed .exe runs on THIS machine without a SmartScreen "Unknown Publisher"
warning. On other machines it will still be untrusted (that's inherent to
self-signed certs - only a paid CA-issued cert avoids that everywhere).

Usage:
  powershell -ExecutionPolicy Bypass -File scripts/create-self-signed-cert.ps1
#>

param(
    [string]$Publisher = "CN=TraderSpider Dev",
    [string]$OutFile = "$PSScriptRoot\..\build\cert.pfx",
    [string]$PassFile = "$PSScriptRoot\..\build\cert.pass",
    [string]$Password = $(New-Guid).Guid
)

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Publisher `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -NotAfter (Get-Date).AddYears(5)

$securePwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $OutFile -Password $securePwd | Out-Null
Set-Content -Path $PassFile -Value $Password -NoNewline

# Trust it locally so double-clicking the built .exe on this machine doesn't warn.
# Requires an elevated (Run as Administrator) shell; skipped otherwise.
try {
    $rootStore = Get-Item Cert:\LocalMachine\Root
    $rootStore.Open("ReadWrite")
    $rootStore.Add($cert)
    $rootStore.Close()

    $publisherStore = Get-Item Cert:\LocalMachine\TrustedPublisher
    $publisherStore.Open("ReadWrite")
    $publisherStore.Add($cert)
    $publisherStore.Close()

    Write-Host "Certificate trusted on this machine (LocalMachine store)."
}
catch {
    Write-Host "Skipped trusting the cert in LocalMachine store (needs admin)." -ForegroundColor Yellow
    Write-Host "Re-run this script in an elevated PowerShell to remove the local warning, or run:"
    Write-Host "  scripts/trust-cert.ps1" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Certificate created: $OutFile"
Write-Host "Password saved to: $PassFile (gitignored)"
Write-Host ""
Write-Host "Just run 'npm run build:win' - it picks up the cert and password automatically."

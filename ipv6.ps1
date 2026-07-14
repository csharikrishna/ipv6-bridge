$ErrorActionPreference = "Stop"

$servers = @(
    "2606:4700:4700::1111",
    "2606:4700:4700::1001"
)

$template = "https://cloudflare-dns.com/dns-query"

foreach ($server in $servers) {

    $existing = Get-DnsClientDohServerAddress |
                Where-Object { $_.ServerAddress -eq $server }

    if ($existing) {
        Write-Host "Updating existing DoH entry for $server"
        Set-DnsClientDohServerAddress `
            -ServerAddress $server `
            -DohTemplate $template `
            -AllowFallbackToUdp $False `
            -AutoUpgrade $True
    }
    else {
        Write-Host "Adding new DoH entry for $server"
        Add-DnsClientDohServerAddress `
            -ServerAddress $server `
            -DohTemplate $template `
            -AllowFallbackToUdp $False `
            -AutoUpgrade $True
    }
}

Write-Host "Done."

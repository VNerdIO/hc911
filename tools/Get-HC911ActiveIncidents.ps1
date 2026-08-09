<#
.SYNOPSIS
    Retrieves current active incidents from the Hamilton County (TN) 911 dashboard.

.DESCRIPTION
    The "Active Incidents" table at https://www.hamiltontn911.gov/active-incidents.php
    is populated client-side by JavaScript from a public JSON API
    (https://hc911server.com/api/calls) rather than being present in the static HTML.
    This script calls that API directly and reshapes the response into PowerShell
    objects that mirror the columns shown on the page (Type, Status, Master Incident,
    Time Created, Agency, Event, Location, Area), plus Latitude/Longitude.

    "PERBURN" type entries are excluded, matching what the website itself displays.
    "Time Created" is converted from UTC to US Eastern local time using
    [System.TimeZoneInfo] (correct across DST transitions), while the raw UTC value
    is preserved as TimeCreatedUtc.

.PARAMETER TimeoutSec
    Network timeout, in seconds, for the API request. Defaults to 15.

.EXAMPLE
    .\Get-HC911ActiveIncidents.ps1 | Format-Table -AutoSize

.EXAMPLE
    $incidents = .\Get-HC911ActiveIncidents.ps1
    $incidents | Where-Object Agency -eq 'Chattanooga PD'
#>
[CmdletBinding()]
param(
    [int]$TimeoutSec = 15
)

$ApiUrl = 'https://hc911server.com/api/calls'
$FrontendAuth = if ($env:HC911_FRONTEND_AUTH) { $env:HC911_FRONTEND_AUTH } else { 'my-secure-token' }
$ApiHeaders = @{
    'Content-Type'    = 'application/json'
    'X-Frontend-Auth' = $FrontendAuth
    'Origin'          = 'https://www.hamiltontn911.gov'
}

# The API returns UTC timestamps for a Hamilton County, TN dashboard (Eastern time).
# Resolve the Eastern time zone using whichever ID this platform understands, so the
# script works on Windows PowerShell and cross-platform pwsh alike.
$EasternTimeZone = $null
foreach ($tzId in 'Eastern Standard Time', 'America/New_York') {
    try {
        $EasternTimeZone = [System.TimeZoneInfo]::FindSystemTimeZoneById($tzId)
        break
    } catch {
        continue
    }
}
if (-not $EasternTimeZone) {
    Write-Warning "Could not resolve an Eastern time zone on this system; TimeCreated will be left in UTC."
}

function Get-HC911ActiveIncidents {
    [CmdletBinding()]
    param(
        [int]$TimeoutSec = 15
    )

    # --- Fetch -------------------------------------------------------------
    try {
        $response = Invoke-RestMethod -Uri $ApiUrl -Headers $ApiHeaders -Method Get `
            -TimeoutSec $TimeoutSec -ErrorAction Stop
    } catch {
        Write-Error "Failed to reach HC911 calls API at '$ApiUrl': $($_.Exception.Message)"
        return
    }

    if ($null -eq $response -or $response.Count -eq 0) {
        Write-Warning 'HC911 calls API returned no data (there may simply be no active incidents right now).'
        return @()
    }

    # --- Transform -----------------------------------------------------------
    $incidents = foreach ($item in $response) {
        if ($item.type -eq 'PERBURN') {
            continue
        }

        try {
            $createdUtc = [DateTime]::Parse(
                $item.creation,
                [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor
                [System.Globalization.DateTimeStyles]::AssumeUniversal
            )

            $createdLocal = if ($EasternTimeZone) {
                [System.TimeZoneInfo]::ConvertTimeFromUtc($createdUtc, $EasternTimeZone)
            } else {
                $createdUtc
            }

            $latitude = $null
            $longitude = $null
            [double]::TryParse($item.latitude, [ref]$latitude) | Out-Null
            [double]::TryParse($item.longitude, [ref]$longitude) | Out-Null

            [PSCustomObject]@{
                Type           = $item.agency_type
                Status         = $item.status
                MasterIncident = "Incident # $($item.sequencenumber)"
                TimeCreated    = $createdLocal
                TimeCreatedUtc = $createdUtc
                Agency         = $item.jurisdiction
                Event          = $item.type
                Location       = $item.location
                Area           = $item.city
                Latitude       = $latitude
                Longitude      = $longitude
            }
        } catch {
            Write-Warning "Skipping incident (sequence '$($item.sequencenumber)') due to a parse error: $($_.Exception.Message)"
            continue
        }
    }

    return $incidents
}

Get-HC911ActiveIncidents -TimeoutSec $TimeoutSec

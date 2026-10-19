# Supports: SPEC-INT-011 (real Chrome permission dialog, confined to the fixture-owned process and loopback origin).
param([int]$BrowserProcess)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if ($BrowserProcess -lt 1) { throw 'Invalid fixture process.' }
$nativeCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $BrowserProcess)
$nativeDeadline = [DateTime]::UtcNow.AddSeconds(4)
while ([DateTime]::UtcNow -lt $nativeDeadline) {
  $nativeRoots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $nativeCondition)
  foreach ($nativeRoot in $nativeRoots) {
    $nativeElements = $nativeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $nativeNames = @($nativeElements | ForEach-Object { $_.Current.Name })
    $nativeAllow = @($nativeElements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Allow' -and $_.Current.ProcessId -eq $BrowserProcess })
    if (($nativeNames | Where-Object { $_ -like '*Native Browser Fixture*has requested additional permissions.*' }).Count -gt 0 -and $nativeNames -contains 'Read and change your data on 127.0.0.1' -and $nativeAllow.Count -eq 1) {
      $nativeAllow[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      ConvertTo-Json -Compress -InputObject @{ invoked = 'Allow'; process = $BrowserProcess; origin = '127.0.0.1' }
      exit 0
    }
  }
  Start-Sleep -Milliseconds 30
}
throw 'The fixture-owned loopback permission dialog was not found; no other button was invoked.'

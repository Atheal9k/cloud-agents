[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^[a-z0-9][a-z0-9-]{2,27}[a-z0-9]$")]
    [string]$NamePrefix,

    [ValidatePattern("^[a-z]{2}-[a-z]+-[0-9]+$")]
    [string]$Region = "us-west-1",

    [Parameter(Mandatory)]
    [switch]$ConfirmAwsChanges
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ConfirmAwsChanges) {
    throw "Pass -ConfirmAwsChanges to create and then destroy an isolated AWS sandbox."
}

$moduleDirectory = Split-Path -Parent $PSScriptRoot
$backendPath = Join-Path $moduleDirectory "backend.hcl"
$chdirArgument = "-chdir=$moduleDirectory"
$workspace = $NamePrefix
$planPath = Join-Path ([IO.Path]::GetTempPath()) "$NamePrefix.tfplan"
$markerPath = Join-Path ([IO.Path]::GetTempPath()) "$NamePrefix-retention-marker.txt"
$cleanupResponsePath = Join-Path ([IO.Path]::GetTempPath()) "$NamePrefix-cleanup-response.json"
$workerInstanceId = $null
$applied = $false

if (-not (Test-Path -LiteralPath $backendPath)) {
    throw "Initialize remote state first. $backendPath does not exist."
}

try {
    tofu $chdirArgument init -reconfigure "-input=false" "-backend-config=backend.hcl" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "tofu init failed." }

    $workspaces = @(
        tofu $chdirArgument workspace list |
            ForEach-Object { ($_ -replace "^[* ]+", "").Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($LASTEXITCODE -ne 0) { throw "Could not list OpenTofu workspaces." }

    if ($workspace -in $workspaces) {
        tofu $chdirArgument workspace select $workspace | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Could not select sandbox workspace $workspace." }
    }
    else {
        tofu $chdirArgument workspace new $workspace | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Could not create sandbox workspace $workspace." }
    }

    tofu $chdirArgument plan `
        "-input=false" `
        "-out=$planPath" `
        "-var=aws_region=$Region" `
        "-var=name_prefix=$NamePrefix" `
        "-var=controller_termination_protection=false" `
        "-var=allow_retained_data_destroy=true" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Sandbox plan failed." }

    tofu $chdirArgument apply "-input=false" -auto-approve $planPath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Sandbox apply failed." }
    $applied = $true

    $outputs = tofu $chdirArgument output -json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Could not read sandbox outputs." }

    $controllerInstanceId = [string]$outputs.controller.value.instance_id
    $artifactBucket = [string]$outputs.artifact_bucket_name.value
    $cleanupFunctionName = [string]$outputs.cleanup_backstop_function_name.value
    $launchTemplateId = [string]$outputs.worker.value.launch_templates."linux-web".id
    $launchTemplateVersion = [string]$outputs.worker.value.launch_templates."linux-web".version

    [IO.File]::WriteAllText(
        $markerPath,
        "CA-03 retention check for $NamePrefix",
        [Text.UTF8Encoding]::new($false)
    )
    aws s3api put-object `
        --bucket $artifactBucket `
        --key "sandbox/$workspace/retention-marker.txt" `
        --body $markerPath `
        --region $Region `
        --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not write the retained-record marker." }

    $worker = aws ec2 run-instances `
        --launch-template "LaunchTemplateId=$launchTemplateId,Version=$launchTemplateVersion" `
        --count 1 `
        --region $Region `
        --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Could not launch the sandbox worker." }
    $workerInstanceId = [string]$worker.Instances[0].InstanceId

    aws ec2 wait instance-running --instance-ids $workerInstanceId --region $Region
    if ($LASTEXITCODE -ne 0) { throw "Sandbox worker did not reach running state." }

    aws ec2 create-tags `
        --resources $workerInstanceId `
        --tags "Key=CloudAgentExpiresAtEpoch,Value=0" `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw "Could not expire the sandbox worker." }

    $cleanupInvocation = aws lambda invoke `
        --function-name $cleanupFunctionName `
        --cli-binary-format raw-in-base64-out `
        --payload "{}" `
        --region $Region `
        $cleanupResponsePath `
        --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "The independent cleanup backstop failed." }
    if ($null -ne $cleanupInvocation.FunctionError) {
        $cleanupError = Get-Content -Raw -LiteralPath $cleanupResponsePath
        throw "The independent cleanup backstop returned $($cleanupInvocation.FunctionError): $cleanupError"
    }

    aws ec2 wait instance-terminated --instance-ids $workerInstanceId --region $Region
    if ($LASTEXITCODE -ne 0) { throw "The cleanup backstop did not terminate the sandbox worker." }
    $workerInstanceId = $null

    $controllerState = aws ec2 describe-instances `
        --instance-ids $controllerInstanceId `
        --query "Reservations[0].Instances[0].State.Name" `
        --output text `
        --region $Region
    if ($LASTEXITCODE -ne 0 -or $controllerState -ne "running") {
        throw "Worker teardown changed the permanent controller state to '$controllerState'."
    }

    aws s3api head-object `
        --bucket $artifactBucket `
        --key "sandbox/$workspace/retention-marker.txt" `
        --region $Region `
        --output json | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Worker teardown removed the retained-record marker."
    }

    Write-Output "Worker teardown left controller $controllerInstanceId running and retained the artifact marker."
}
finally {
    if ($null -ne $workerInstanceId) {
        aws ec2 terminate-instances --instance-ids $workerInstanceId --region $Region --output json | Out-Null
    }

    if ($applied) {
        tofu $chdirArgument destroy `
            "-input=false" `
            -auto-approve `
            "-var=aws_region=$Region" `
            "-var=name_prefix=$NamePrefix" `
            "-var=controller_termination_protection=false" `
            "-var=allow_retained_data_destroy=true" | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Sandbox destroy failed. Inspect workspace $workspace before deleting it."
        }
        else {
            tofu $chdirArgument workspace select default | Out-Null
            tofu $chdirArgument workspace delete $workspace | Out-Host
        }
    }

    Remove-Item -LiteralPath $planPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $cleanupResponsePath -Force -ErrorAction SilentlyContinue
}

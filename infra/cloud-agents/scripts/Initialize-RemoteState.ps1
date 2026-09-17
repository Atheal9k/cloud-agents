[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")]
    [string]$BucketName,

    [ValidatePattern("^[a-z]{2}-[a-z]+-[0-9]+$")]
    [string]$Region = "us-west-1",

    [ValidatePattern("^[A-Za-z0-9][A-Za-z0-9._/-]+$")]
    [string]$StateKey = "cloud-agents/terraform.tfstate",

    [ValidatePattern("^[a-zA-Z][-a-zA-Z0-9]*$")]
    [string]$StackName = "t3-cloud-agents-state"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$moduleDirectory = Split-Path -Parent $PSScriptRoot
$templatePath = Join-Path $moduleDirectory "state-bootstrap.yaml"
$backendPath = Join-Path $moduleDirectory "backend.hcl"

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw "AWS CLI v2 was not found."
}

aws sts get-caller-identity --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "AWS authentication is missing or expired."
}

aws cloudformation deploy `
    --template-file $templatePath `
    --stack-name $StackName `
    --parameter-overrides "StateBucketName=$BucketName" `
    --no-fail-on-empty-changeset `
    --region $Region | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "CloudFormation failed to create or update the remote-state stack."
}

$resolvedBucket = aws cloudformation describe-stacks `
    --stack-name $StackName `
    --query "Stacks[0].Outputs[?OutputKey=='StateBucketName'].OutputValue | [0]" `
    --output text `
    --region $Region
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolvedBucket)) {
    throw "Could not read the remote-state bucket from CloudFormation."
}

$backendConfig = @"
bucket = "$resolvedBucket"
key    = "$StateKey"
region = "$Region"
"@
[IO.File]::WriteAllText($backendPath, $backendConfig, [Text.UTF8Encoding]::new($false))

Write-Output "Created $backendPath for encrypted S3 state with native S3 locking."
Write-Output "Run: tofu -chdir=$moduleDirectory init -reconfigure -backend-config=backend.hcl"

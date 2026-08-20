<#
.SYNOPSIS
  Provisions the S3 bucket for the dashboard app (Barni gestão), mirroring the
  REAL configuration of the existing `multipark-bucket` (read from AWS on
  2026-08-20), applied to `dashboard-multipark-bucket` the same day:

    - Objects publicly READABLE via plain https URL (bucket-policy statement
      `AllowPublicRead`: s3:GetObject to Principal "*")
    - Bucket listing NOT public (anonymous list => 403)
    - ACLs disabled (ObjectOwnership=BucketOwnerEnforced)
    - Public access block: all four flags FALSE (same as multipark-bucket;
      the public grant comes from the bucket policy)
    - App writes via dedicated IAM user `dashboard-s3-uploader` whose
      Put/Get/Delete rights are granted by the BUCKET policy statement
      `AllowAppUserS3Actions` — the user has NO identity policy at all
      (same pattern as `nextjs-s3-uploader`). It cannot list, cannot read
      bucket config, cannot touch other buckets.
    - CORS: origins "*", methods GET/HEAD/PUT/POST/DELETE, headers "*",
      expose ETag, max-age 3600 (mirror; "*" keeps Vercel preview URLs working)
    - Encryption: SSE-S3 (AES256), bucket key enabled, SSE-C blocked (mirror)
    - Lifecycle: abort incomplete multipart uploads after 7 days (NOT on the
      multipark bucket — added here because this bucket takes video uploads)

  Idempotent: safe to re-run to converge config. Requires an ADMIN identity
  (`aws login` first if the session expired). The uploader's access key is only
  created when the user has none — the secret is printed ONCE; it lives in
  dashboard/.env and the Vercel project env.

.EXAMPLE
  powershell -File scripts\provision-s3-bucket.ps1
#>
[CmdletBinding()]
param(
  [string]$AwsProfile = "default",
  [string]$BucketName = "dashboard-multipark-bucket",
  [string]$Region = "eu-west-1",
  [string]$UploaderUserName = "dashboard-s3-uploader",
  [switch]$SkipIam
)

$ErrorActionPreference = "Stop"
$tmp = Join-Path $env:TEMP "provision-s3-$BucketName"
New-Item -ItemType Directory -Force $tmp | Out-Null

function Invoke-Aws {
  param([string[]]$AwsArgs)
  & aws @AwsArgs --profile $AwsProfile
  if ($LASTEXITCODE -ne 0) { throw "aws $($AwsArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

# Probe helper: run an aws call whose failure is expected/meaningful without
# tripping $ErrorActionPreference=Stop on PS 5.1's NativeCommandError wrapping.
function Test-AwsSucceeds {
  param([string[]]$AwsArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  & aws @AwsArgs --profile $AwsProfile *> $null
  $ok = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prev
  return $ok
}

Write-Host "== Identity check ==" -ForegroundColor Cyan
Invoke-Aws @("sts", "get-caller-identity")
$accountId = (& aws sts get-caller-identity --profile $AwsProfile --query Account --output text)

# --- 1. IAM uploader user (FIRST: the bucket policy references its ARN) ------
if ($SkipIam) {
  Write-Host "== 1/8 IAM: skipped (-SkipIam) ==" -ForegroundColor Yellow
} else {
  Write-Host "== 1/8 IAM uploader user '$UploaderUserName' ==" -ForegroundColor Cyan
  if (Test-AwsSucceeds @("iam", "get-user", "--user-name", $UploaderUserName)) {
    Write-Host "IAM user '$UploaderUserName' already exists — skipping create."
  } else {
    Invoke-Aws @("iam", "create-user", "--user-name", $UploaderUserName,
      "--tags", "Key=app,Value=dashboard-multipark")
    Write-Host "Created IAM user '$UploaderUserName'. (No identity policy on purpose — rights come from the bucket policy.)"
  }

  $keys = (& aws iam list-access-keys --user-name $UploaderUserName --profile $AwsProfile `
      --query "AccessKeyMetadata[].AccessKeyId" --output json | ConvertFrom-Json)
  if (@($keys).Count -eq 0) {
    $keyJson = & aws iam create-access-key --user-name $UploaderUserName --profile $AwsProfile | ConvertFrom-Json
    Write-Host ""
    Write-Host "!!! SAVE THESE NOW — the secret is shown only once !!!" -ForegroundColor Yellow
    Write-Host ("AWS_S3_ACCESS_KEY=" + $keyJson.AccessKey.AccessKeyId)
    Write-Host ("AWS_S3_SECRET_ACCESS_KEY=" + $keyJson.AccessKey.SecretAccessKey)
  } else {
    Write-Host "Access key(s) already exist ($($keys -join ', ')) — not creating another."
  }
}

# --- 2. Bucket ---------------------------------------------------------------
Write-Host "== 2/8 Bucket ==" -ForegroundColor Cyan
if (Test-AwsSucceeds @("s3api", "head-bucket", "--bucket", $BucketName)) {
  Write-Host "Bucket '$BucketName' already exists — converging config."
} else {
  Invoke-Aws @("s3api", "create-bucket", "--bucket", $BucketName,
    "--region", $Region,
    "--create-bucket-configuration", "LocationConstraint=$Region")
  Write-Host "Created bucket '$BucketName' in $Region."
}

# --- 3. Ownership controls: ACLs disabled ------------------------------------
Write-Host "== 3/8 Ownership controls (BucketOwnerEnforced) ==" -ForegroundColor Cyan
Invoke-Aws @("s3api", "put-bucket-ownership-controls", "--bucket", $BucketName,
  "--ownership-controls", "Rules=[{ObjectOwnership=BucketOwnerEnforced}]")

# --- 4. Public access block: all off (mirror of multipark-bucket) ------------
Write-Host "== 4/8 Public access block (all false) ==" -ForegroundColor Cyan
Invoke-Aws @("s3api", "put-public-access-block", "--bucket", $BucketName,
  "--public-access-block-configuration",
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false")

# --- 5. Bucket policy: uploader RW + public read (mirror) --------------------
Write-Host "== 5/8 Bucket policy ==" -ForegroundColor Cyan
$policyFile = Join-Path $tmp "policy.json"
@"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAppUserS3Actions",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${accountId}:user/$UploaderUserName" },
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$BucketName/*"
    },
    {
      "Sid": "AllowPublicRead",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BucketName/*"
    }
  ]
}
"@ | Out-File -Encoding ascii $policyFile
Invoke-Aws @("s3api", "put-bucket-policy", "--bucket", $BucketName,
  "--policy", "file://$policyFile")

# --- 6. CORS (mirror: open origins — Vercel previews have changing URLs) -----
Write-Host "== 6/8 CORS ==" -ForegroundColor Cyan
$corsFile = Join-Path $tmp "cors.json"
@"
{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
"@ | Out-File -Encoding ascii $corsFile
Invoke-Aws @("s3api", "put-bucket-cors", "--bucket", $BucketName,
  "--cors-configuration", "file://$corsFile")

# --- 7. Default encryption (mirror: SSE-S3 + bucket key, SSE-C blocked) ------
Write-Host "== 7/8 Default encryption ==" -ForegroundColor Cyan
$encFile = Join-Path $tmp "enc.json"
@"
{
  "Rules": [
    {
      "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "AES256" },
      "BucketKeyEnabled": true,
      "BlockedEncryptionTypes": { "EncryptionType": ["SSE-C"] }
    }
  ]
}
"@ | Out-File -Encoding ascii $encFile
Invoke-Aws @("s3api", "put-bucket-encryption", "--bucket", $BucketName,
  "--server-side-encryption-configuration", "file://$encFile")

# --- 8. Lifecycle: abort stale multipart uploads (video uploads that die) ----
Write-Host "== 8/8 Lifecycle (abort incomplete multipart after 7 days) ==" -ForegroundColor Cyan
$lcFile = Join-Path $tmp "lifecycle.json"
@"
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
"@ | Out-File -Encoding ascii $lcFile
Invoke-Aws @("s3api", "put-bucket-lifecycle-configuration", "--bucket", $BucketName,
  "--lifecycle-configuration", "file://$lcFile")

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "== Done. Env block for dashboard (.env / Vercel project settings) ==" -ForegroundColor Green
Write-Host @"
AWS_S3_REGION=$Region
AWS_S3_BUCKET_NAME=$BucketName
AWS_S3_ACCESS_KEY=<uploader key id>
AWS_S3_SECRET_ACCESS_KEY=<uploader secret>

(Credentials carry the AWS_S3_ prefix because Vercel reserves AWS_ACCESS_KEY /
AWS_SECRET_ACCESS_KEY. storage.ts still falls back to the unprefixed names.)

Verify end-to-end with:  ./node_modules/.bin/tsx scripts/verify-s3-storage.ts
"@

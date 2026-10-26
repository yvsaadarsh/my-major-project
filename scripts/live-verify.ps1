<#
  ProjectOS — Live Gemini Verification (Windows PowerShell 5.1+)
  ==============================================================
  Runs docs/LIVE-AI-VERIFICATION.md on a machine that CAN reach
  generativelanguage.googleapis.com. From the repository root:

      powershell -ExecutionPolicy Bypass -File scripts/live-verify.ps1

  ISOLATION (safe to run):
  - Uses a DEDICATED database `projectos_liveverify_<guid>` that THIS run
    creates, uses, and drops. Your configured DATABASE_URL database is never
    migrated, seeded, written, or dropped — and is never a fallback.
  - Writes only after verifying the new DB was created BY THIS RUN and is
    pristine (0 tables). The drop is gated on a per-run "created" flag, not just
    the name pattern, so it can only remove the database this invocation made.
  - Local-only by default; a remote host requires explicit -AllowRemote (a
    hostname is never treated as proof a server is non-production).
  - Cleanup covers the whole lifecycle (including a failure during creation or
    pristine verification), stops only this run's server process tree, and
    restores the original DATABASE_URL / PGPASSWORD.

  EVIDENCE (provenance from route contracts, never from a missing log line):
  - interpret & parse-task have NO fallback (502 when the model is down) → a 200
    with the required fields proves a real response.
  - narrative / forecast / retrospective return 502 (no canned prose) on failure
    → 200 WITH prose proves a real response.
  - simulate has deterministic fallbacks for BOTH interpret and narrate → its
    diff is a deterministic PASS; its narration is UNVERIFIED (FALLBACK if the
    exact fallback intent string appears).
  - the notification body has no provenance marker → UNVERIFIED (shown for human
    comparison against the deterministic template).

  Never prints the API key, DB credentials, cookies, or connection URLs.
  NOT runtime-tested on Windows; contract-verified against the route handlers.
#>
#requires -Version 5.1
param(
  [int]$Port = 3123,
  [switch]$IncludeRetrospectiveWrite,  # set one seeded milestone MISSED (TEST db only) to exercise retrospective
  [switch]$SkipInstall,                # skip `npm ci` if node_modules already present
  [switch]$AllowRemote                 # permit a non-local DB host (reviewed, non-production only)
)
$ErrorActionPreference = "Stop"
$Base = "http://127.0.0.1:$Port"
$results = [ordered]@{}
function Note($m){ Write-Host "* $m" }
function Section($m){ Write-Host "`n=== $m ===" }

# Run a native command, stream+capture output, fail hard with a sanitized tail.
function Invoke-Checked([string]$label,[scriptblock]$cmd){
  & $cmd 2>&1 | Tee-Object -Variable captured | Out-Host
  if ($LASTEXITCODE -ne 0){
    Write-Host "----- $label failed; output tail -----"
    ($captured | Select-Object -Last 15) | ForEach-Object { Write-Host "  $_" }
    throw "$label failed (exit $LASTEXITCODE)."
  }
}

# --- lifecycle tracking + original env, initialized BEFORE any resource ------
$serverProc   = $null
$dbCreated    = $false
$dbRetainedForInvestigation = $false
$pgPwSet      = $false
$origDbUrl    = $env:DATABASE_URL
$origPgPw     = $env:PGPASSWORD
$testDb       = "projectos_liveverify_$([guid]::NewGuid().ToString('N'))"  # random v4 GUID (not a timestamp): collision between concurrent runs is practically negligible
$psqlBase     = $null

# ===========================================================================
# 1. Prerequisites
# ===========================================================================
Section "1. Prerequisites"
foreach ($cmd in "node","npm","npx","psql"){ if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)){ throw "Required command '$cmd' not found on PATH." } }
if (-not (Test-Path ".env")){ throw "Run from the repo root; .env not found." }
$envLines = Get-Content ".env"
if (-not ($envLines | Where-Object { $_ -match '^GEMINI_API_KEY=.+' })){ throw "GEMINI_API_KEY is not set in .env." }
if (-not ($envLines | Where-Object { $_ -match '^DATABASE_URL=.+' })){ throw "DATABASE_URL is not set in .env." }
Note "node $(node -v); npm $(npm -v); psql present; GEMINI_API_KEY present (not shown)"

# ===========================================================================
# 2a. Parse + gate (NO resources created yet — safe before the try)
# ===========================================================================
Section "2. Dedicated disposable database"
$connJson = node -e @"
const fs=require('fs'); const {URL}=require('url');
const l=fs.readFileSync('.env','utf8').split(/\r?\n/).find(x=>x.startsWith('DATABASE_URL='));
const v=l.slice(13).trim().replace(/^"|"$/g,''); const p=new URL(v);
const testDb='$testDb';
const origDb=p.pathname.replace(/^\//,'').split('?')[0];
const mk=(db)=>{const u=new URL(v); u.pathname='/'+db; return u.toString();};
console.log(JSON.stringify({
  show:{user:p.username,host:p.hostname,port:p.port||'5432',origDb},
  password:decodeURIComponent(p.password||''),
  host:p.hostname, port:p.port||'5432', user:p.username,
  testUrl:mk(testDb), origDb
}));
"@
if ($LASTEXITCODE -ne 0){ throw "could not parse DATABASE_URL from .env." }
$conn = $connJson | ConvertFrom-Json
Note "connection user=$($conn.show.user) host=$($conn.show.host) port=$($conn.show.port) (configured db=$($conn.show.origDb))"
if ($conn.origDb -eq $testDb){ throw "generated test db name collides with configured db — aborting." }
if ($conn.show.origDb -match '(?i)(prod|production|live)' -or $conn.show.host -match '(?i)(prod|production|live)'){
  throw "ABORT: configured host/db looks production-like ('$($conn.show.host)'/'$($conn.show.origDb)') — refusing to create even a transient database there."
}
$isLocal = @('localhost','127.0.0.1','::1') -contains $conn.host
if (-not $isLocal -and -not $AllowRemote){
  throw "ABORT: DATABASE_URL host '$($conn.host)' is not local. This script CREATES and DROPS a database; by default it only does so on a LOCAL PostgreSQL. Re-run with -AllowRemote only for a server you have reviewed as safe for create/drop (never production)."
}
$psqlBase = @("-h",$conn.host,"-p",$conn.port,"-U",$conn.user,"-w")

try {
  # =========================================================================
  # 2b. Create + verify the dedicated DB (inside try so cleanup always runs)
  # =========================================================================
  $env:PGPASSWORD = $conn.password; $pgPwSet = $true   # keep out of argv; restored in finally

  # Prove ownership: the uniquely-named DB must NOT exist before we create it.
  $before = (& psql @psqlBase -d postgres -tAc "select count(*) from pg_database where datname='$testDb';").Trim()
  if ($LASTEXITCODE -ne 0){ throw "ABORT: could not query the PostgreSQL server (connection/auth). Nothing was created." }
  if ($before -ne '0'){ throw "ABORT: database '$testDb' unexpectedly already exists — refusing to touch a database this run did not create." }

  # Attempt create. Even if psql does not report a clean exit (e.g. the client
  # connection drops after the server commits CREATE), re-check existence: a
  # fresh GUID name that was absent a moment ago and is present now is treated as
  # owned by this run (high confidence — not an absolute proof, since in theory
  # another actor could create the identical GUID between the two checks; a
  # random v4 GUID makes that collision practically negligible). The automatic
  # drop is gated on this flag AND a pristine-content check below, and DROP ...
  # IF EXISTS is a no-op if the DB is already gone — so cleanup stays conservative.
  & psql @psqlBase -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE `"$testDb`";" 2>&1 | Out-Null
  $createExit = $LASTEXITCODE
  $exists = (& psql @psqlBase -d postgres -tAc "select count(*) from pg_database where datname='$testDb';").Trim()
  $existsExit = $LASTEXITCODE
  if ($exists -eq '1' -and $existsExit -eq 0){ $dbCreated = $true }
  if (-not $dbCreated){
    if ($existsExit -ne 0){
      throw ("ABORT: create of '$testDb' returned exit $createExit and the ownership re-check could not reach the server, so ownership is AMBIGUOUS. This run will NOT drop any database. SAFE MANUAL RECOVERY: once the server is reachable, confirm the database belongs to THIS run before removing it — the name is a fresh v4 GUID ('$testDb') that was absent beforehand, and a database this run created would contain only the seeded demo org (one organization, the northwind-labs seed). Only if both hold, connect to the 'postgres' maintenance database as user $($conn.user) on $($conn.host):$($conn.port) and DROP DATABASE IF EXISTS for that exact name. Do not drop any other database.")
    }
    throw "ABORT: could not create isolated test database '$testDb' (exit $createExit); it does not exist, so nothing was created and your configured database was NOT touched. Prerequisite: a role that may CREATE DATABASE."
  }
  Note "created dedicated database: $testDb (treated as owned: GUID absent before, present after)"

  $preTables = (& psql @psqlBase -d $testDb -tAc "select count(*) from pg_tables where schemaname='public';").Trim()
  if ($LASTEXITCODE -ne 0){ throw "could not connect to the new test database." }
  if ($preTables -ne "0"){
    # A freshly created DB is empty; tables here mean its contents are NOT ours,
    # so ownership is uncertain. Disable the automatic drop and require manual
    # investigation — never auto-drop a database whose data we did not create.
    $dbRetainedForInvestigation = $true
    $dbCreated = $false
    throw "ABORT: '$testDb' exists but is NOT empty ($preTables tables). Ownership is now UNCERTAIN, so this run will NOT drop it. Investigate manually before removing anything: confirm whether this GUID-named database is a genuine stray from a prior run (it should contain only the seeded demo org) and not something that must be kept."
  }
  Note "verified pristine (0 tables), created by this run"

  # Inject the test DB for ALL child processes (dotenv does NOT override it).
  $env:DATABASE_URL = $conn.testUrl

  # =========================================================================
  # 3. Prepare schema + seed + build  (writes go ONLY to the test DB)
  # =========================================================================
  Section "3. Prepare test DB + build"
  if (-not $SkipInstall -and -not (Test-Path "node_modules")){ Invoke-Checked "npm ci" { npm ci } }
  Invoke-Checked "db:deploy" { npm run db:deploy }
  Invoke-Checked "db:seed"   { npm run db:seed }
  $seeded = (& psql @psqlBase -d $testDb -tAc "select count(*) from organizations;").Trim()
  if ($LASTEXITCODE -ne 0 -or [int]$seeded -lt 1){ throw "seed did not populate the test database — aborting before any AI calls." }
  Note "test DB migrated + seeded (organizations=$seeded)"
  Invoke-Checked "next build" { npm run build }

  # =========================================================================
  # 4. Start the server (track this run's process tree)
  # =========================================================================
  Section "4. Start next start on :$Port"
  $log = Join-Path $env:TEMP "projectos-live-$Port-$PID.out"; $errlog = "$log.err"
  foreach ($f in $log,$errlog){ if (Test-Path $f){ Remove-Item $f -Force } }
  # Start-Process returns the spawned (npx) process; taskkill /T later ends the
  # whole tree it creates (cmd -> node next-server) on Windows.
  $serverProc = Start-Process -FilePath "npx" -ArgumentList @("next","start","--port","$Port") -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError $errlog
  $up=$false; foreach ($i in 1..40){ Start-Sleep 1; if ($serverProc.HasExited){ break }; try { Invoke-WebRequest "$Base/" -UseBasicParsing -TimeoutSec 5 | Out-Null; $up=$true; break } catch {} }
  if (-not $up){ throw "server did not become ready on $Base (see $log)." }
  Note "server up (pid $($serverProc.Id))"

  # =========================================================================
  # 5. One bounded Gemini egress probe
  # =========================================================================
  Section "5. Gemini egress probe (one attempt, fail-closed)"
  # A single bounded TLS handshake to the real host:443 with DEFAULT certificate
  # validation. Only a completed TLS session whose cert chains to a trusted CA
  # for generativelanguage.googleapis.com counts as reachable. DNS failures, TLS
  # errors, and — crucially — proxy/gateway CONNECT-tunnel denials (403/407) all
  # throw here and are classified BLOCKED, so a proxy error is NEVER mistaken for
  # the endpoint being reachable. No HTTP request, no key, nothing printed.
  #
  # SCOPE: this probes DIRECT TCP egress; it deliberately does NOT route through
  # the Windows system HTTP proxy. That matches how the Node app reaches Gemini
  # by default (undici/fetch make direct TLS connections unless the process is
  # explicitly configured for a proxy). On a proxy-only network, direct TCP
  # fails and this probe reports BLOCKED by design (fail closed) and the live
  # checks are skipped — if you run behind a proxy, configure the Node app for
  # that proxy and verify reachability via `npm run test:ai:live` directly, which
  # self-skips safely when the model cannot be reached.
  $egress = "BLOCKED: not probed"
  $tcp=$null; $ssl=$null
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect("generativelanguage.googleapis.com",443,$null,$null)
    if (-not $iar.AsyncWaitHandle.WaitOne(8000,$false)){ throw "TCP connect timed out (possible proxy/firewall)" }
    $tcp.EndConnect($iar)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(),$false)
    $ssl.AuthenticateAsClient("generativelanguage.googleapis.com")  # default validation: proxy/MITM/DNS/CONNECT failures throw
    $egress = "reachable (trusted TLS session to Google)"
  } catch {
    $egress = "BLOCKED: $($_.Exception.Message)"   # fail closed on any ambiguity
  } finally {
    if ($ssl){ $ssl.Dispose() }
    if ($tcp){ $tcp.Close() }
  }
  Note "egress: $egress"

  if ($egress -like 'BLOCKED*'){
    Section "6-7. Live model checks SKIPPED — Gemini egress is unreachable"
    Note "Not sending requests known to be unable to reach the provider."
    foreach($k in "live-suite","1 Policy Studio","2a Simulation diff","2b Simulation narration","3 Task parse","4 Retrospective","5 Narrative","6 Forecast","7 Notification narrator"){ $results[$k]="BLOCKED (Gemini egress unreachable)" }
  } else {

  # =========================================================================
  # 6. Live suite — check EXIT CODE, not just text
  # =========================================================================
  Section "6. npm run test:ai:live"
  $liveOut = (npm run test:ai:live 2>&1 | Out-String)
  $liveExit = $LASTEXITCODE
  ($liveOut -split "`n" | Select-Object -Last 14) | ForEach-Object { Write-Host "  $_" }
  if ($liveExit -ne 0){
    $results["live-suite"] = "FAIL (harness exit $liveExit)"
  } elseif ($liveOut -match "NOT RUN"){
    $results["live-suite"] = "BLOCKED (preflight: see tail)"
  } elseif ($liveOut -match "\b0 failed\b" -and $liveOut -match "model calls used:\s*[1-9]"){
    $results["live-suite"] = "PASS (real: model calls billed, 0 failed)"
  } else {
    $results["live-suite"] = "REVIEW (exit 0 but no clear pass signature)"
  }

  # =========================================================================
  # 7. Per-feature checks (explicit Cookie header — pm_session is Secure in prod)
  # =========================================================================
  Section "7. Per-feature checks"
  $login = Invoke-WebRequest "$Base/api/v1/auth/login" -Method POST -ContentType "application/json" -Body (@{email="ada@northwind.test";password="Password123!"}|ConvertTo-Json) -UseBasicParsing
  $sc = ($login.Headers["Set-Cookie"] | Out-String)
  if ($sc -notmatch "pm_session=([^;]+)"){ throw "login did not return pm_session (test DB seeded?)." }
  $H = @{ Cookie = "pm_session=$($Matches[1])" }
  function Api($method,$path,$body){
    $a=@{Uri="$Base$path";Method=$method;Headers=$H;UseBasicParsing=$true;TimeoutSec=90}
    if ($null -ne $body){ $a.ContentType="application/json"; $a.Body=($body|ConvertTo-Json) }
    try { $r=Invoke-WebRequest @a; @{status=[int]$r.StatusCode; body=$r.Content} }
    catch {
      $code = 0; if ($_.Exception.Response){ $code=[int]$_.Exception.Response.StatusCode.value__ }
      @{status=$code; body=$_.ErrorDetails.Message}
    }
  }
  $projId = ((Api GET "/api/v1/projects" $null).body | ConvertFrom-Json).projects[0].id

  # F1 Policy Studio — no fallback: require valid draft fields, not just 200.
  $r = Api POST "/api/v1/automations/interpret" @{policy="When a high priority task becomes overdue, notify the manager"}
  if ($r.status -eq 200){
    $b=$r.body|ConvertFrom-Json
    $okTrig = @("TASK_OVERDUE","TASK_STATUS_CHANGED","PROJECT_HEALTH_CHANGED") -contains $b.draft.trigger
    $okAct  = @("NOTIFY_MANAGER","UPDATE_MILESTONE_PROGRESS","WRITE_AUDIT_EVENT") -contains $b.draft.action
    $results["1 Policy Studio"] = if ($okTrig -and $okAct){ "PASS (real: trigger=$($b.draft.trigger) action=$($b.draft.action))" } else { "FAIL (200 but draft fields invalid)" }
  } elseif ($r.status -in 501,502){ $results["1 Policy Studio"]="BLOCKED ($($r.status))" } else { $results["1 Policy Studio"]="FAIL ($($r.status))" }

  # F3 Task parse — no fallback: require a non-empty title.
  $r = Api POST "/api/v1/ai/parse-task" @{text="draft the launch checklist, high priority, due next Friday";projectId=$projId}
  if ($r.status -eq 200){ $t=($r.body|ConvertFrom-Json).title; $results["3 Task parse"]= if ($t){ "PASS (real: title parsed)" } else { "FAIL (200 no title)" } }
  elseif ($r.status -eq 422){ $results["3 Task parse"]="UNVERIFIED (model reached, no usable title)" }
  elseif ($r.status -in 501,502){ $results["3 Task parse"]="BLOCKED ($($r.status))" } else { $results["3 Task parse"]="FAIL ($($r.status))" }

  # F2 Simulation — diff deterministic (separate PASS); narration UNVERIFIED.
  $tasks = ((Api GET "/api/v1/projects/$projId/tasks" $null).body|ConvertFrom-Json).tasks
  $target = ($tasks | Where-Object { $_.status -ne "DONE" } | Select-Object -First 1); if (-not $target){ $target=$tasks[0] }
  $r = Api POST "/api/v1/intelligence/projects/$projId/simulate" @{scenario="mark this task as done";change=@{type="task_status";taskId=$target.id;status="DONE"}}
  if ($r.status -eq 200){
    $s=$r.body|ConvertFrom-Json
    $hasDelta = ($s.diff.PSObject.Properties.Name -contains 'healthDelta') -and ($null -ne ($s.diff.healthDelta -as [double]))
    $diffOk = $hasDelta -and (@("safe","watch","block") -contains $s.diff.verdict)
    $fallbackIntent = ($s.interpretedIntent -eq "Evaluate the impact of a task_status change.")
    $results["2a Simulation diff"] = if ($diffOk){ "PASS (deterministic: healthDelta + verdict present)" } else { "FAIL (diff malformed)" }
    $results["2b Simulation narration"] = if ($fallbackIntent){ "FALLBACK (deterministic intent — NOT real AI)" } else { "UNVERIFIED (has a fallback path; 200 cannot prove provenance)" }
  } elseif ($r.status -eq 501){ $results["2a Simulation diff"]="BLOCKED (no key)"; $results["2b Simulation narration"]="BLOCKED" } else { $results["2a Simulation diff"]="FAIL ($($r.status))"; $results["2b Simulation narration"]="FAIL" }

  # F5 Narrative — 502 on failure, so 200 + prose = real.
  $r = Api GET "/api/v1/intelligence/projects/$projId/narrative" $null
  $results["5 Narrative"] = if ($r.status -eq 200 -and $r.body.Trim().Length -ge 40){ "PASS (real: streamed prose)" } elseif ($r.status -eq 501){ "BLOCKED (no key)" } elseif ($r.status -eq 502){ "BLOCKED (model unreachable)" } else { "FAIL ($($r.status))" }

  # F6 Forecast — insufficient history is N/A, not failure.
  $r = Api GET "/api/v1/intelligence/projects/$projId/forecast" $null
  if ($r.status -eq 200 -and $r.body -match '"insufficient"\s*:\s*true'){ $results["6 Forecast"]="N/A (insufficient history)" }
  elseif ($r.status -eq 200 -and $r.body.Trim().Length -ge 40){ $results["6 Forecast"]="PASS (real: streamed prose)" }
  elseif ($r.status -eq 501){ $results["6 Forecast"]="BLOCKED (no key)" } elseif ($r.status -eq 502){ $results["6 Forecast"]="BLOCKED (model unreachable)" } else { $results["6 Forecast"]="FAIL ($($r.status))" }

  # F4 Retrospective — needs a CLOSED milestone; opt-in write to the TEST db only.
  $mid = ((Api GET "/api/v1/projects/$projId/milestones" $null).body|ConvertFrom-Json).milestones[0].id
  if ($IncludeRetrospectiveWrite -and $mid){
    & psql @psqlBase -d $testDb -v ON_ERROR_STOP=1 -c "UPDATE milestones SET status='MISSED' WHERE id='$mid';" | Out-Null
    if ($LASTEXITCODE -ne 0){ $results["4 Retrospective"]="FAIL (could not set milestone MISSED)" }
    else {
      $r = Api GET "/api/v1/projects/$projId/milestones/$mid/retrospective" $null
      $results["4 Retrospective"] = if ($r.status -eq 200 -and $r.body.Trim().Length -ge 40){ "PASS (real: streamed prose)" } elseif ($r.status -eq 501){ "BLOCKED (no key)" } elseif ($r.status -eq 502){ "BLOCKED (model unreachable)" } else { "FAIL ($($r.status))" }
    }
  } else { $results["4 Retrospective"]="SKIPPED (needs DONE|MISSED milestone; re-run with -IncludeRetrospectiveWrite)" }

  # F7 Notification narrator — the notifications list API returns only
  # id/type/title/body/href/createdAt (NO ruleId, NO dedupeKey), and the seeded
  # enabled rules also fire on the same run, so NO listed notification can be
  # reliably attributed to this test rule; the body also carries no provenance
  # marker. Therefore this is UNVERIFIED by design — we confirm the automation
  # path executed (rule created+enabled, run returned a summary) but never guess
  # a notification by type or title.
  $create = Api POST "/api/v1/automations" @{name="LiveVerify health rule";trigger="PROJECT_HEALTH_CHANGED";action="NOTIFY_MANAGER";condition="when project health drops below healthy"}
  if ($create.status -in 200,201){
    $rid=($create.body|ConvertFrom-Json).id
    $patch = Api PATCH "/api/v1/automations/$rid" @{enabled=$true}
    $run = Api POST "/api/v1/automations/run" @{}
    $fired = try { ($run.body|ConvertFrom-Json).summary.fired } catch { "?" }
    if ($patch.status -eq 200 -and $run.status -eq 200){
      $results["7 Notification narrator"]="UNVERIFIED (rule created+enabled, run executed [fired=$fired]; API exposes no ruleId/dedupeKey and other enabled rules also fire, so no notification body can be attributed to this rule or proven model-generated here)"
    } else { $results["7 Notification narrator"]="FAIL (enable=$($patch.status) run=$($run.status))" }
  } else { $results["7 Notification narrator"]="FAIL (rule create $($create.status))" }
  } # end: egress-reachable branch
}
finally {
  # =========================================================================
  # 8. Cleanup — stop ONLY this run's server tree; DROP ONLY the DB we created;
  #    restore original environment. Runs for every exit path after section 2a.
  # =========================================================================
  Section "8. Cleanup"
  if ($serverProc){
    try {
      if (-not $serverProc.HasExited){
        & taskkill /PID $serverProc.Id /T /F 2>&1 | Out-Null   # end the whole npx->node tree
        Start-Sleep 1
      }
      $serverProc.Refresh()
      if ($serverProc.HasExited){ Note "stopped server tree (pid $($serverProc.Id))" }
      else { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue; Write-Warning "taskkill did not confirm exit for pid $($serverProc.Id); forced Stop-Process." }
    } catch { Write-Warning "server teardown issue: $($_.Exception.Message)" }
  }

  if ($dbCreated -and ($testDb -match '^projectos_liveverify_[0-9a-f]{32}$') -and $psqlBase){
    try {
      & psql @psqlBase -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$testDb' AND pid<>pg_backend_pid();" 2>&1 | Out-Null
      $termExit = $LASTEXITCODE
      if ($termExit -ne 0){ Write-Warning "cleanup: terminating connections to '$testDb' returned exit $termExit (continuing to DROP)." }
      & psql @psqlBase -d postgres -c "DROP DATABASE IF EXISTS `"$testDb`";" 2>&1 | Out-Null
      $dropExit = $LASTEXITCODE
      if ($dropExit -eq 0){ Note "dropped test database $testDb (terminate exit $termExit, drop exit 0)" }
      else { Write-Warning ("CLEANUP FAILED: DROP DATABASE '$testDb' returned exit $dropExit (terminate exit $termExit). MANUAL RECOVERY: independently verify the identity first — confirm the name is exactly '$testDb' and that it is the throwaway this run created (it should contain only the seeded demo org) — then DROP DATABASE IF EXISTS for that exact name. Do not drop any other database.") }
    } catch { Write-Warning "CLEANUP ERROR dropping '$testDb': $($_.Exception.Message) — verify identity before any manual drop." }
  } elseif ($dbRetainedForInvestigation) {
    Write-Warning "RETAINED FOR INVESTIGATION: the database '$testDb' was intentionally NOT dropped because its contents made ownership uncertain. This run performed no automatic drop. Before deleting it manually, independently verify it belongs to this run (its name is this run's generated GUID AND it contains only the seeded demo org); if that cannot be confirmed, leave it in place."
  } elseif (-not $dbCreated) { Note "no database was created by this run; nothing to drop." }

  # Restore the original process environment (do not leave injected values).
  $env:DATABASE_URL = $origDbUrl
  if ($pgPwSet){ $env:PGPASSWORD = $origPgPw }
}

# ===========================================================================
# 9. Summary
# ===========================================================================
Section "RESULT — real Gemini responses required for PASS"
$results.GetEnumerator() | ForEach-Object { "{0,-26} {1}" -f $_.Key,$_.Value } | Write-Host
Write-Host "`nProvenance: PASS(real) only where the route has NO fallback (interpret, parse-task) or returns 502-not-prose on failure (narrative, forecast, retrospective). Simulation diff is deterministic; its narration and the notification body carry no provenance marker and are UNVERIFIED — judge them against the deterministic output, never by HTTP 200 alone."

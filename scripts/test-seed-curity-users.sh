#!/usr/bin/env bash
# Contract test for the Curity user seeding pair:
#   scripts/curity-users-init.sh  — runs in the Curity pod's init container: copies the
#                                   image's pristine HSQLDB, renders the persona rows as
#                                   SQL and applies them with the bundled hsqltool.
#   scripts/seed-curity-users.sh  — runs on the host (`make seed-users`): keeps the
#                                   gitignored .demo-users.env and publishes it as the
#                                   curity-demo-users Secret.
# The seeder's SQL must reproduce exactly the four rows a real registration + TOTP
# enrolment writes (accounts, credentials, devices, buckets), the usernames must stay
# pinned to add-roles.js, and a missing secret must fail closed before any SQL runs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
fail() { red "FAIL: $*"; exit 1; }

SEEDER="$REPO_ROOT/scripts/curity-users-init.sh"
HOST="$REPO_ROOT/scripts/seed-curity-users.sh"

# ── stubs for the two Curity binaries and kubectl ─────────────────────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/crypttools" <<'SH'
#!/usr/bin/env bash
# real: crypttools --password <pw>  →  $5$<salt>$<hash>
[[ "$1" == "--password" ]] || { echo "unexpected args: $*" >&2; exit 2; }
printf '$5$stub$%s\n' "$2"
SH
cat > "$TMP/bin/hsqltool" <<'SH'
#!/usr/bin/env bash
# real: hsqltool --inlineRc <rc> <sqlfile>
printf '%s\n' "$*" > "$HSQLTOOL_CAPTURE_ARGS"
cp "${@: -1}" "$HSQLTOOL_CAPTURE_SQL"
SH
cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$KUBECTL_CAPTURE"
if [[ "$*" == *"--dry-run=client"* ]]; then echo "kind: Secret"; fi
# `apply -f -` must DRAIN stdin like the real kubectl: exiting without reading makes the
# `--dry-run | apply` pipeline's writer die of SIGPIPE (141) under pipefail — a flaky
# "host script exited non-zero" that has nothing to do with the script under test.
if [[ "$*" == *" -f -"* ]]; then cat >/dev/null; fi
SH
chmod +x "$TMP/bin/"*

seed_env=(
  ALICE_PASSWORD=Password1 ALICE_TOTP_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  BOB_PASSWORD=Password1   BOB_TOTP_SECRET=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
  CAROL_PASSWORD=Secret2   CAROL_TOTP_SECRET=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
)

# ── 1. --render emits the four rows per persona, linked the way Curity links them ──
env "${seed_env[@]}" CRYPTTOOLS="$TMP/bin/crypttools" \
  bash "$SEEDER" --render > "$TMP/render.sql" || fail "--render exited non-zero"

[[ "$(grep -c 'INSERT INTO "accounts"' "$TMP/render.sql")" == 3 ]] || fail "expected 3 account rows"
for u in alice bob carol; do
  grep -q "INSERT INTO \"accounts\" VALUES('[0-9a-f-]*',NULL,'$u','$u@demo.curity.local',NULL," "$TMP/render.sql" \
    || fail "account row for $u missing or mis-shaped"
  grep -q "INSERT INTO \"credentials\" VALUES('[0-9a-f-]*',NULL,'$u','" "$TMP/render.sql" \
    || fail "credential row for $u missing"
  # usernames are the key add-roles.js assigns roles by — they must not drift
  grep -q "attributes.subject == '$u'" "$REPO_ROOT/k8s/curity/procedures/add-roles.js" \
    || fail "seeded username $u is not assigned a role in add-roles.js"
done
grep -q '"givenName":"Alice","familyName":"Andersson"' "$TMP/render.sql" || fail "alice display name"
grep -q '"givenName":"Bob","familyName":"Bergström"' "$TMP/render.sql" || fail "bob display name"
grep -q '"givenName":"Carol","familyName":"Carlsson"' "$TMP/render.sql" || fail "carol display name"
grep -q '"emails":\[{"value":"alice@demo.curity.local","primary":true}\]' "$TMP/render.sql" || fail "alice email attribute"
# every account is active (registration flips 0 → 1 after "verification"; no-verification here)
[[ "$(grep -c "INSERT INTO \"accounts\" VALUES(.*,1,[0-9]*,[0-9]*)" "$TMP/render.sql")" == 3 ]] \
  || fail "every account must be inserted active=1"

# the password reaches crypttools verbatim and the hash lands in the credentials row
grep -q "INSERT INTO \"credentials\" VALUES('[0-9a-f-]*',NULL,'carol','\$5\$stub\$Secret2','{}'," "$TMP/render.sql" \
  || fail "carol's credential does not carry crypttools' hash of her password"
grep -q "Secret2" <(grep -v credentials "$TMP/render.sql") && fail "a plaintext password leaked outside crypttools"

# devices ↔ accounts ↔ buckets linkage, as observed in a live db.log
alice_id="$(sed -n "s/^INSERT INTO \"accounts\" VALUES('\([0-9a-f-]*\)',NULL,'alice'.*/\1/p" "$TMP/render.sql")"
[[ -n "$alice_id" ]] || fail "could not extract alice's account id"
dev_line="$(grep "INSERT INTO \"devices\"" "$TMP/render.sql" | grep "'alice'" || true)"
[[ -n "$dev_line" ]] || fail "no device row aliased to alice"
[[ "$dev_line" == *"'$alice_id'"*"'idsvr-totp'"*"'$alice_id'"* ]] \
  || fail "alice's device must reference her account id as account_id and owner: $dev_line"
[[ "$dev_line" == *'{"schemas":["urn:se:curity:scim:2.0:Devices"]}'* ]] || fail "device attributes"
device_id="$(sed -n "s/^INSERT INTO \"devices\" VALUES('[0-9a-f-]*','\([0-9a-f-]*\)',NULL,'$alice_id'.*/\1/p" "$TMP/render.sql")"
[[ -n "$device_id" && "$device_id" != "$alice_id" ]] || fail "device_id must be its own uuid (got '$device_id')"
grep -q "INSERT INTO \"buckets\" VALUES('[0-9a-f-]*','$device_id','totp_key_store',NULL,'{\"totp_key\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}'," "$TMP/render.sql" \
  || fail "alice's TOTP bucket must be keyed by her device_id and carry her secret"
[[ "$(grep -c 'totp_key_store' "$TMP/render.sql")" == 3 ]] || fail "expected 3 TOTP buckets"
tail -n 1 "$TMP/render.sql" | grep -q '^SHUTDOWN;$' || fail "SQL must end with SHUTDOWN; so HSQLDB checkpoints cleanly"

# ── 2. a missing secret fails closed before anything is copied or run ─────────
mkdir -p "$TMP/src" "$TMP/dst"
echo pristine > "$TMP/src/db.script"
if env ALICE_PASSWORD=x ALICE_TOTP_SECRET=y BOB_PASSWORD=x CAROL_PASSWORD=x CAROL_TOTP_SECRET=y \
   CRYPTTOOLS="$TMP/bin/crypttools" HSQLTOOL="$TMP/bin/hsqltool" \
   HSQLTOOL_CAPTURE_ARGS="$TMP/args" HSQLTOOL_CAPTURE_SQL="$TMP/sql" \
   SEED_SRC_DB_DIR="$TMP/src" SEED_DST_DB_DIR="$TMP/dst" \
   bash "$SEEDER" >/dev/null 2>"$TMP/err"; then
  fail "BOB_TOTP_SECRET unset should be refused"
fi
grep -q "BOB_TOTP_SECRET" "$TMP/err" || fail "the refusal must name the missing variable"
[[ ! -e "$TMP/args" ]] || fail "hsqltool must not run when a secret is missing"
[[ ! -e "$TMP/dst/db.script" ]] || fail "nothing should be copied when a secret is missing"

# ── 3. the full run copies the pristine DB and applies the SQL to the copy ─────
env "${seed_env[@]}" CRYPTTOOLS="$TMP/bin/crypttools" HSQLTOOL="$TMP/bin/hsqltool" \
   HSQLTOOL_CAPTURE_ARGS="$TMP/args" HSQLTOOL_CAPTURE_SQL="$TMP/sql" \
   SEED_SRC_DB_DIR="$TMP/src" SEED_DST_DB_DIR="$TMP/dst" \
   bash "$SEEDER" >/dev/null || fail "full run exited non-zero"
[[ "$(cat "$TMP/dst/db.script")" == pristine ]] || fail "pristine db.script was not copied into the destination"
grep -q -- "--inlineRc url=jdbc:hsqldb:file:$TMP/dst/db,user=sa,password=" "$TMP/args" \
  || fail "hsqltool must open the COPY (file:<dst>/db), got: $(cat "$TMP/args")"
grep -q 'INSERT INTO "accounts"' "$TMP/sql" || fail "the rendered SQL was not handed to hsqltool"

# ── 4. host side: .demo-users.env is generated once, then reused verbatim ──────
ENVF="$TMP/.demo-users.env"
PATH="$TMP/bin:$PATH" KUBECTL_CAPTURE="$TMP/kubectl.log" DEMO_USERS_ENV_FILE="$ENVF" \
  bash "$HOST" > "$TMP/host.out" || fail "host script exited non-zero"
[[ -f "$ENVF" ]] || fail ".demo-users.env was not created"
for u in ALICE BOB CAROL; do
  grep -q "^${u}_PASSWORD=Password1$" "$ENVF" || fail "$u default password must be Password1"
  grep -Eq "^${u}_TOTP_SECRET=[A-Z2-7]{32}$" "$ENVF" || fail "$u TOTP secret must be 32 base32 chars (20 random bytes)"
done
[[ "$(sed -n 's/^.*_TOTP_SECRET=//p' "$ENVF" | sort -u | wc -l | tr -d ' ')" == 3 ]] || fail "TOTP secrets must differ per persona"
grep -q "create secret generic curity-demo-users" "$TMP/kubectl.log" || fail "Secret curity-demo-users not created"
grep -q -- "--from-env-file=$ENVF" "$TMP/kubectl.log" || fail "Secret must be built from the env file"
grep -q -- "-n curity " "$TMP/kubectl.log" || fail "Secret must land in the curity namespace"
# The seed path must NOT print the persona cards: `make demo` runs it inside
# seed-secrets and then ends with `make users`, so printing here showed the QR codes
# twice — once mid-install where they scroll away. It points at `make users` instead.
alice_secret="$(sed -n 's/^ALICE_TOTP_SECRET=//p' "$ENVF")"
! grep -q "otpauth://" "$TMP/host.out" || fail "the seed path must not print otpauth URIs (cards belong to 'make users' at the end of 'make demo')"
! grep -q "$alice_secret" "$TMP/host.out" || fail "the seed path must not print TOTP secrets"
grep -q "make users" "$TMP/host.out" || fail "the seed path must tell the presenter that 'make users' prints the cards"

cp "$ENVF" "$TMP/first.env"
printf 'CAROL_PASSWORD=Custom9\n' >> "$ENVF"; sed -i.bak '/^CAROL_PASSWORD=Password1$/d' "$ENVF"; rm -f "$ENVF.bak"
cp "$ENVF" "$TMP/edited.env"
PATH="$TMP/bin:$PATH" KUBECTL_CAPTURE="$TMP/kubectl2.log" DEMO_USERS_ENV_FILE="$ENVF" \
  bash "$HOST" >/dev/null || fail "second host run exited non-zero"
diff -q "$TMP/edited.env" "$ENVF" >/dev/null || fail "an existing .demo-users.env must be reused verbatim (secrets must survive rebuilds)"

# ── 5. --print re-shows the personas for the presenter WITHOUT seeding anything ──
# `make demo` ends with it (via `make users`) — the ONLY place the cards are printed:
# the presenter needs username + password + otpauth (QR) in one place, once, to enrol
# the authenticator app.
: > "$TMP/kubectl3.log"
PATH="$TMP/bin:$PATH" KUBECTL_CAPTURE="$TMP/kubectl3.log" DEMO_USERS_ENV_FILE="$ENVF" \
  bash "$HOST" --print > "$TMP/print.out" || fail "--print exited non-zero"
[[ ! -s "$TMP/kubectl3.log" ]] || fail "--print must not touch the cluster (kubectl was called)"
diff -q "$TMP/edited.env" "$ENVF" >/dev/null || fail "--print must not rewrite .demo-users.env"
for u in alice bob carol; do
  grep -q "^ *$u\b" "$TMP/print.out" || fail "--print must list $u"
  grep -q "otpauth://totp/.*$u.*secret=$(sed -n "s/^$(echo $u | tr a-z A-Z)_TOTP_SECRET=//p" "$ENVF")" "$TMP/print.out" \
    || fail "--print must show $u's otpauth URI with the secret from the env file"
done
grep -q "Password1" "$TMP/print.out" || fail "--print must show the passwords"
grep -q "Custom9" "$TMP/print.out" || fail "--print must show an EDITED password (carol), not the default"
# roles come from k8s/curity/procedures/add-roles.js — the card must agree with it
grep -Eq "alice.*sre" "$TMP/print.out" || fail "--print must show alice's role (sre)"
grep -Eq "carol.*oncall" "$TMP/print.out" || fail "--print must show carol's role (oncall)"
grep -Eq "bob.*developer" "$TMP/print.out" || fail "--print must show bob's role (developer)"
grep -q "$ENVF" "$TMP/print.out" || fail "--print must point the presenter at the env file"
grep -q "make seed-users" "$TMP/print.out" || fail "--print must say how to re-seed after editing the file"

# ── 6. --print with no env file fails closed and says how to create it ─────────
if PATH="$TMP/bin:$PATH" KUBECTL_CAPTURE="$TMP/kubectl4.log" DEMO_USERS_ENV_FILE="$TMP/missing.env" \
   bash "$HOST" --print > "$TMP/missing.out" 2>"$TMP/missing.err"; then
  fail "--print must fail when .demo-users.env does not exist"
fi
grep -q "make seed-users" "$TMP/missing.err" || fail "the missing-file error must point at 'make seed-users'"
[[ ! -e "$TMP/missing.env" ]] || fail "--print must never create the env file"

green "OK: curity-users-init renders the four linked rows per persona, fails closed, seeds the DB copy; seed-curity-users keeps stable TOTP secrets and --print re-shows the persona cards"

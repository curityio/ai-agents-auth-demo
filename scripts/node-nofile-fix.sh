#!/usr/bin/env bash
# Cap the KIND node's containerd `nofile` (RLIMIT_NOFILE) limit.
#
# Problem: the kindest/node containerd unit ships with `LimitNOFILE=infinity`
# (1073741816). Every pod inherits that. Curity's confd.smp is an Erlang/BEAM
# process, and BEAM sizes internal file-descriptor tables to the *soft* nofile
# limit — with a ~1-billion limit it allocates ~11GB RSS at boot and trips a
# node-wide OOM kill (confd.smp + the idsvr JVM both get killed). The surfaced
# symptom is misleading: Curity logs `failed to create fsnotify watcher: too
# many open files` then CrashLoopBackOffs (exitCode 137 / OOMKilled).
#
# Fix: lower containerd's LimitNOFILE to a sane ceiling and restart it so newly
# created pods inherit the cap. Idempotent — a no-op if already patched.
#
# Note: KIND's cluster.yaml / containerdConfigPatches only patch
# /etc/containerd/config.toml, NOT the systemd unit, so this must run as a
# post-create node mutation (like scripts/cluster-routing.sh).
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-ai-agents-demo}"
NODE="${NODE:-${CLUSTER_NAME}-control-plane}"
NOFILE_LIMIT="${NOFILE_LIMIT:-1048576}"
UNIT="/etc/systemd/system/containerd.service"

if ! docker ps --format '{{.Names}}' | grep -qx "$NODE"; then
  echo "node-nofile-fix: node container '$NODE' not running; skipping" >&2
  exit 0
fi

current="$(docker exec "$NODE" sh -c "grep -m1 '^LimitNOFILE=' $UNIT" 2>/dev/null || true)"
if [[ "$current" == "LimitNOFILE=${NOFILE_LIMIT}" ]]; then
  echo "node-nofile-fix: $NODE already capped at ${NOFILE_LIMIT}"
  exit 0
fi

echo "node-nofile-fix: capping containerd LimitNOFILE -> ${NOFILE_LIMIT} on $NODE"
docker exec "$NODE" sh -c "
  set -e
  sed -i 's/^LimitNOFILE=.*/LimitNOFILE=${NOFILE_LIMIT}/' ${UNIT}
  grep -q '^LimitNOFILE=${NOFILE_LIMIT}' ${UNIT} || echo 'LimitNOFILE=${NOFILE_LIMIT}' >> ${UNIT}
  systemctl daemon-reload
  systemctl restart containerd
"
echo "node-nofile-fix: done (pods on $NODE will restart and inherit the new limit)"

#!/usr/bin/env bash
# Verify the Docker daemon can WRITE to its own storage.
#
# `docker info` succeeds even when the Docker Desktop VM has remounted
# /var/lib/docker read-only, so reachability is not evidence of health. This
# probe mutates Docker's storage (a throwaway volume => mkdir under
# /var/lib/docker/volumes) because that is the property every teardown target
# actually depends on.
#
# Usage:
#   docker-writable.sh          # enforce: exit 1 with remediation if not writable
#   docker-writable.sh --report # audit:   print status, always exit 0
set -uo pipefail

mode="${1:---enforce}"

fail() {
  if [ "$mode" = "--report" ]; then
    return 0
  fi
  exit 1
}

if ! docker info >/dev/null 2>&1; then
  echo "Docker: UNREACHABLE - is Docker Desktop running?"
  fail
  exit 0
fi

probe="demo-writable-probe-$$"
if err="$(docker volume create "$probe" 2>&1)"; then
  docker volume rm "$probe" >/dev/null 2>&1 || true
  [ "$mode" = "--report" ] && echo "Docker storage: writable"
  exit 0
fi

echo ""
echo "ERROR: the Docker daemon cannot write to its own storage."
echo "  $err"
echo ""
case "$err" in
  *"read-only file system"*|*"read-only filesystem"*)
    echo "  The Docker Desktop VM has remounted /var/lib/docker READ-ONLY."
    echo "  No make target can recover from this - the VM must be restarted first:"
    echo ""
    echo "    docker desktop restart"
    echo ""
    echo "  Then re-run your command. If it is STILL read-only afterwards the ext4"
    echo "  journal is unrecoverable: Docker Desktop > Troubleshoot > 'Reset disk"
    echo "  image' (wipes all images/volumes; 'make images' rebuilds them)."
    ;;
  *"no space left"*)
    echo "  The Docker Desktop VM disk is full. Raise it in Docker Desktop >"
    echo "  Settings > Resources > Disk image size, or reclaim space with"
    echo "  'docker image prune -af' / 'docker volume prune -f'."
    ;;
esac
echo ""
fail

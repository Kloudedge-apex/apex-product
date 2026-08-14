#!/bin/bash -p
#
# deploy-prod.sh — canonical protected production deploy (audit B7).
#
# Meant to be run from the release branch (release/go-live-*) AFTER CI is
# green. It requires the exact local commit to be published on its release
# branch, builds the image once in ACR with a full-git-SHA traceability tag,
# resolves that tag to a content digest, pulls and verifies that exact registry
# artifact, then rolls BOTH Container Apps to the same immutable digest.
#
#   registry  ledgracr            ACR repo  apex-api
#   RG        Ledgr-prod          apps      apex-gtm-api, apex-gtm-worker
#
# Requires an `az` CLI session with AcrPush on ledgracr and Contributor on
# Ledgr-prod. DB schema changes are NOT applied here; the separately approved
# workflow must finish first and provide the sanitized receipt required below.
#
# Usage: scripts/deploy-prod.sh --migration-receipt <path> \
#          --migration-signature <path> --migration-allowed-signers <path> --yes
#   --migration-receipt          sanitized schema receipt kept outside repo
#   --migration-signature        detached SSH signature over the receipt bytes
#   --migration-allowed-signers  external trusted approver key list
#   --yes                        required noninteractive release acknowledgement

set -Eeuo pipefail

# Keep this bootstrap scrub list aligned with scripts/run-release-git.sh. The
# bootstrap cannot trust or execute that committed helper until after it has
# produced the exact-commit snapshot.
bootstrap_git() {
  /usr/bin/env \
    -u ALL_PROXY \
    -u CURL_CA_BUNDLE \
    -u DEBUG \
    -u GH_DEBUG \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    -u GIT_ASKPASS \
    -u GIT_ATTR_SOURCE \
    -u GIT_CEILING_DIRECTORIES \
    -u GIT_COMMON_DIR \
    -u GIT_CONFIG \
    -u GIT_CONFIG_PARAMETERS \
    -u GIT_CURL_VERBOSE \
    -u GIT_DIR \
    -u GIT_DISCOVERY_ACROSS_FILESYSTEM \
    -u GIT_EXEC_PATH \
    -u GIT_INDEX_FILE \
    -u GIT_NAMESPACE \
    -u GIT_OBJECT_DIRECTORY \
    -u GIT_PROXY_COMMAND \
    -u GIT_QUARANTINE_PATH \
    -u GIT_REPLACE_REF_BASE \
    -u GIT_SHALLOW_FILE \
    -u GIT_SSL_CAINFO \
    -u GIT_SSL_CAPATH \
    -u GIT_SSL_CERT \
    -u GIT_SSL_CERT_PASSWORD_PROTECTED \
    -u GIT_SSL_CIPHER_LIST \
    -u GIT_SSL_KEY \
    -u GIT_SSL_NO_VERIFY \
    -u GIT_SSL_VERSION \
    -u GIT_SSH \
    -u GIT_SSH_COMMAND \
    -u GIT_TRACE \
    -u GIT_TRACE2 \
    -u GIT_TRACE2_CONFIG_PARAMS \
    -u GIT_TRACE2_DST_DEBUG \
    -u GIT_TRACE2_ENV_VARS \
    -u GIT_TRACE2_EVENT \
    -u GIT_TRACE2_PERF \
    -u GIT_TRACE_CURL \
    -u GIT_TRACE_CURL_NO_DATA \
    -u GIT_TRACE_FSMONITOR \
    -u GIT_TRACE_PACKET \
    -u GIT_TRACE_PACKFILE \
    -u GIT_TRACE_PACK_ACCESS \
    -u GIT_TRACE_PERFORMANCE \
    -u GIT_TRACE_REFS \
    -u GIT_TRACE_SETUP \
    -u GIT_TRACE_SHALLOW \
    -u GIT_WORK_TREE \
    -u HTTPS_PROXY \
    -u HTTP_PROXY \
    -u SSL_CERT_DIR \
    -u SSL_CERT_FILE \
    -u SSH_ASKPASS \
    -u all_proxy \
    -u http_proxy \
    -u https_proxy \
    GIT_ATTR_NOSYSTEM=1 \
    GIT_CONFIG_COUNT=0 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_TRACE_REDACT=1 \
    git \
      -c core.attributesFile=/dev/null \
      -c http.sslVerify=true \
      "$@"
}

# The checked-out copy is only a bootstrap. Re-enter this controller from a
# private archive of the exact candidate commit before parsing release inputs
# or invoking any release helper. This keeps later working-tree edits (including
# ignored files) outside both the controller trust boundary and the ACR context.
umask 077
if [[ "${WORKFORCE_RELEASE_SNAPSHOT_ACTIVE:-}" != "true" ]]; then
  BOOTSTRAP_REPOSITORY="$(bootstrap_git rev-parse --show-toplevel)"
  BOOTSTRAP_REPOSITORY="$(cd "${BOOTSTRAP_REPOSITORY}" && pwd -P)"
  BOOTSTRAP_COMMIT="$(bootstrap_git -C "${BOOTSTRAP_REPOSITORY}" rev-parse HEAD)"
  BOOTSTRAP_COMMON_DIR="$(bootstrap_git -C "${BOOTSTRAP_REPOSITORY}" rev-parse --git-common-dir)"
  if [[ "${BOOTSTRAP_COMMON_DIR}" != /* ]]; then
    BOOTSTRAP_COMMON_DIR="${BOOTSTRAP_REPOSITORY}/${BOOTSTRAP_COMMON_DIR}"
  fi
  BOOTSTRAP_OBJECT_DIR="$(cd "${BOOTSTRAP_COMMON_DIR}/objects" && pwd -P)"
  BOOTSTRAP_SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/workforce-os-release.XXXXXX")"
  BOOTSTRAP_TOKEN_FILE=""
  BOOTSTRAP_GIT_STATE=""
  BOOTSTRAP_RUNTIME_STATE=""
  BOOTSTRAP_CHILD_PID=""
  BOOTSTRAP_CHILD_PGID=""
  BOOTSTRAP_CHILD_LAUNCHING="false"
  BOOTSTRAP_PENDING_SIGNAL=""
  BOOTSTRAP_PENDING_SIGNAL_STATUS=""
  cleanup_bootstrap_snapshot() {
    local status=$?
    trap - EXIT
    trap '' HUP INT TERM
    set +e
    if [[ -n "${BOOTSTRAP_CHILD_PID}" ]]; then
      # The process-group leader may have exited while a release subprocess is
      # still alive. Always target the recorded group, then reap the leader.
      kill -s TERM -- "-${BOOTSTRAP_CHILD_PGID}" >/dev/null 2>&1 ||
        kill -s TERM "${BOOTSTRAP_CHILD_PID}" >/dev/null 2>&1 || true
      wait "${BOOTSTRAP_CHILD_PID}" >/dev/null 2>&1
      BOOTSTRAP_CHILD_PID=""
    fi
    rm -rf -- "${BOOTSTRAP_SNAPSHOT}"
    if [[ -n "${BOOTSTRAP_TOKEN_FILE}" ]]; then
      rm -f -- "${BOOTSTRAP_TOKEN_FILE}"
    fi
    if [[ -n "${BOOTSTRAP_GIT_STATE}" && -d "${BOOTSTRAP_GIT_STATE}" ]]; then
      rm -rf -- "${BOOTSTRAP_GIT_STATE}"
    fi
    if [[ -n "${BOOTSTRAP_RUNTIME_STATE}" && -d "${BOOTSTRAP_RUNTIME_STATE}" ]]; then
      rm -rf -- "${BOOTSTRAP_RUNTIME_STATE}"
    fi
    exit "${status}"
  }
  trap cleanup_bootstrap_snapshot EXIT
  forward_bootstrap_signal() {
    local signal=$1
    local signal_status=$2
    local launched_pid=""
    if [[ -z "${BOOTSTRAP_CHILD_PID}" ]]; then
      if [[ "${BOOTSTRAP_CHILD_LAUNCHING}" == "true" ]]; then
        launched_pid="${!:-}"
        if [[ "${launched_pid}" =~ ^[1-9][0-9]*$ ]] &&
          kill -0 "${launched_pid}" >/dev/null 2>&1; then
          BOOTSTRAP_CHILD_PID="${launched_pid}"
          BOOTSTRAP_CHILD_PGID="${launched_pid}"
        fi
      fi
    fi
    if [[ -z "${BOOTSTRAP_CHILD_PID}" ]]; then
      if [[ -z "${BOOTSTRAP_PENDING_SIGNAL}" ]]; then
        BOOTSTRAP_PENDING_SIGNAL="${signal}"
        BOOTSTRAP_PENDING_SIGNAL_STATUS="${signal_status}"
      fi
      return
    fi
    trap '' HUP INT TERM
    set +e
    if [[ -n "${BOOTSTRAP_CHILD_PID}" ]]; then
      kill -s "${signal}" -- "-${BOOTSTRAP_CHILD_PGID}" >/dev/null 2>&1 ||
        kill -s "${signal}" "${BOOTSTRAP_CHILD_PID}" >/dev/null 2>&1 || true
      wait "${BOOTSTRAP_CHILD_PID}" >/dev/null 2>&1
      BOOTSTRAP_CHILD_PID=""
    fi
    exit "${signal_status}"
  }
  trap 'forward_bootstrap_signal HUP 129' HUP
  trap 'forward_bootstrap_signal INT 130' INT
  trap 'forward_bootstrap_signal TERM 143' TERM
  chmod 700 "${BOOTSTRAP_SNAPSHOT}"
  BOOTSTRAP_SNAPSHOT="$(cd "${BOOTSTRAP_SNAPSHOT}" && pwd -P)"
  BOOTSTRAP_RUNTIME_STATE="$(mktemp -d "${TMPDIR:-/tmp}/workforce-os-release-state.XXXXXX")"
  chmod 700 "${BOOTSTRAP_RUNTIME_STATE}"
  BOOTSTRAP_RUNTIME_STATE="$(cd "${BOOTSTRAP_RUNTIME_STATE}" && pwd -P)"
  BOOTSTRAP_TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/workforce-os-release-token.XXXXXX")"
  BOOTSTRAP_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  if [[ ! "${BOOTSTRAP_TOKEN}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: could not create the private release snapshot admission token" >&2
    exit 1
  fi
  printf '%s\n' "${BOOTSTRAP_TOKEN}" >"${BOOTSTRAP_TOKEN_FILE}"
  chmod 600 "${BOOTSTRAP_TOKEN_FILE}"
  BOOTSTRAP_GIT_STATE="$(mktemp -d "${TMPDIR:-/tmp}/workforce-os-bootstrap-git.XXXXXX")"
  mkdir "${BOOTSTRAP_GIT_STATE}/empty-template"
  bootstrap_git -c core.hooksPath=/dev/null \
    init --bare \
    --template="${BOOTSTRAP_GIT_STATE}/empty-template" \
    "${BOOTSTRAP_GIT_STATE}/repo.git" >/dev/null
  printf '%s\n' "${BOOTSTRAP_OBJECT_DIR}" \
    >"${BOOTSTRAP_GIT_STATE}/repo.git/objects/info/alternates"
  bootstrap_git --git-dir="${BOOTSTRAP_GIT_STATE}/repo.git" \
    cat-file -e "${BOOTSTRAP_COMMIT}^{commit}"
  bootstrap_git --git-dir="${BOOTSTRAP_GIT_STATE}/repo.git" \
    archive --format=tar "${BOOTSTRAP_COMMIT}" | \
    /usr/bin/env -u TAR_OPTIONS tar -xf - -C "${BOOTSTRAP_SNAPSHOT}"
  chmod 700 "${BOOTSTRAP_SNAPSHOT}"
  if [[ ! -d "${BOOTSTRAP_SNAPSHOT}/scripts" ||
    -L "${BOOTSTRAP_SNAPSHOT}/scripts" ||
    ! -f "${BOOTSTRAP_SNAPSHOT}/scripts/deploy-prod.sh" ||
    -L "${BOOTSTRAP_SNAPSHOT}/scripts/deploy-prod.sh" ||
    ! -x "${BOOTSTRAP_SNAPSHOT}/scripts/deploy-prod.sh" ]]; then
    echo "ERROR: exact-commit snapshot does not contain a regular executable release controller" >&2
    exit 1
  fi
  # Monitor mode gives the snapshot controller and its subprocesses a distinct
  # process group. The bootstrap can then forward termination to the entire
  # release execution boundary without signalling itself.
  if [[ -n "${BOOTSTRAP_PENDING_SIGNAL}" ]]; then
    exit "${BOOTSTRAP_PENDING_SIGNAL_STATUS}"
  fi
  # Keep this array nonempty: macOS Bash 3.2 treats an initialized-but-empty
  # array expansion as unbound under `set -u`.
  BOOTSTRAP_CHILD_ENV_UNSETS=(-u BASH_ENV)
  while IFS='=' read -r BOOTSTRAP_ENV_NAME _; do
    case "${BOOTSTRAP_ENV_NAME}" in
      BASH_FUNC_*%%)
        BOOTSTRAP_CHILD_ENV_UNSETS+=(
          -u "${BOOTSTRAP_ENV_NAME}"
        )
        ;;
    esac
  done < <(/usr/bin/env)
  set -m
  BOOTSTRAP_CHILD_LAUNCHING="true"
  /usr/bin/env \
    "${BOOTSTRAP_CHILD_ENV_UNSETS[@]}" \
    -u ALL_PROXY \
    -u BASHOPTS \
    -u BASH_COMPAT \
    -u BASH_XTRACEFD \
    -u CDPATH \
    -u CURL_CA_BUNDLE \
    -u DEBUG \
    -u ENV \
    -u GH_DEBUG \
    -u GLOBIGNORE \
    -u HTTPS_PROXY \
    -u HTTP_PROXY \
    -u POSIXLY_CORRECT \
    -u PS4 \
    -u SHELLOPTS \
    -u SSL_CERT_DIR \
    -u SSL_CERT_FILE \
    -u all_proxy \
    -u http_proxy \
    -u https_proxy \
    GH_HOST=github.com \
    WORKFORCE_RELEASE_SNAPSHOT_ACTIVE=true \
    WORKFORCE_RELEASE_SOURCE_REPOSITORY="${BOOTSTRAP_REPOSITORY}" \
    WORKFORCE_RELEASE_SOURCE_COMMIT="${BOOTSTRAP_COMMIT}" \
    WORKFORCE_RELEASE_SNAPSHOT_ROOT="${BOOTSTRAP_SNAPSHOT}" \
    WORKFORCE_RELEASE_SNAPSHOT_PARENT_PID="$$" \
    WORKFORCE_RELEASE_SNAPSHOT_TOKEN="${BOOTSTRAP_TOKEN}" \
    WORKFORCE_RELEASE_SNAPSHOT_TOKEN_FILE="${BOOTSTRAP_TOKEN_FILE}" \
    WORKFORCE_RELEASE_RUNTIME_STATE_DIR="${BOOTSTRAP_RUNTIME_STATE}" \
    "${BOOTSTRAP_SNAPSHOT}/scripts/deploy-prod.sh" "$@" </dev/null &
  BOOTSTRAP_CHILD_PID=$!
  BOOTSTRAP_CHILD_PGID="${BOOTSTRAP_CHILD_PID}"
  BOOTSTRAP_CHILD_LAUNCHING="false"
  set +m
  if [[ -n "${BOOTSTRAP_PENDING_SIGNAL}" ]]; then
    forward_bootstrap_signal \
      "${BOOTSTRAP_PENDING_SIGNAL}" \
      "${BOOTSTRAP_PENDING_SIGNAL_STATUS}"
  fi
  set +e
  wait "${BOOTSTRAP_CHILD_PID}"
  BOOTSTRAP_STATUS=$?
  set -e
  # Leave the recorded identity populated for EXIT cleanup. Even after the
  # group leader has been reaped, cleanup must terminate any surviving member.
  exit "${BOOTSTRAP_STATUS}"
fi

if [[ -z "${WORKFORCE_RELEASE_SOURCE_REPOSITORY:-}" ||
  -z "${WORKFORCE_RELEASE_SOURCE_COMMIT:-}" ||
  -z "${WORKFORCE_RELEASE_SNAPSHOT_ROOT:-}" ||
  -z "${WORKFORCE_RELEASE_SNAPSHOT_TOKEN:-}" ||
  -z "${WORKFORCE_RELEASE_SNAPSHOT_TOKEN_FILE:-}" ||
  -z "${WORKFORCE_RELEASE_RUNTIME_STATE_DIR:-}" ||
  "${WORKFORCE_RELEASE_SNAPSHOT_PARENT_PID:-}" != "${PPID}" ||
  ! -f "${WORKFORCE_RELEASE_SNAPSHOT_TOKEN_FILE}" ||
  -L "${WORKFORCE_RELEASE_SNAPSHOT_TOKEN_FILE}" ||
  ! -d "${WORKFORCE_RELEASE_RUNTIME_STATE_DIR}" ||
  -L "${WORKFORCE_RELEASE_RUNTIME_STATE_DIR}" ||
  "$(<"${WORKFORCE_RELEASE_SNAPSHOT_TOKEN_FILE}")" != "${WORKFORCE_RELEASE_SNAPSHOT_TOKEN}" ]]; then
  echo "ERROR: incomplete exact-commit release snapshot identity" >&2
  exit 1
fi

SOURCE_REPOSITORY="$(cd "${WORKFORCE_RELEASE_SOURCE_REPOSITORY}" && pwd -P)"
SNAPSHOT_COMMIT="${WORKFORCE_RELEASE_SOURCE_COMMIT}"
REPO_ROOT="$(cd "${WORKFORCE_RELEASE_SNAPSHOT_ROOT}" && pwd -P)"
RUNTIME_STATE_DIR="$(cd "${WORKFORCE_RELEASE_RUNTIME_STATE_DIR}" && pwd -P)"
if [[ "${RUNTIME_STATE_DIR}" == "${REPO_ROOT}" ||
  "${RUNTIME_STATE_DIR}" == "${REPO_ROOT}/"* ]]; then
  echo "ERROR: release runtime state must remain outside the exact-commit build snapshot" >&2
  exit 1
fi
SNAPSHOT_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
if [[ "${SNAPSHOT_SCRIPT}" != "${REPO_ROOT}/scripts/deploy-prod.sh" ]]; then
  echo "ERROR: release controller is not running from its private exact-commit snapshot" >&2
  exit 1
fi

require_snapshot_regular_file() {
  local relative_path=$1
  local executable=${2:-false}
  local remaining component current_path

  if [[ -z "${relative_path}" || "${relative_path}" == /* ||
    "${relative_path}" == */../* || "${relative_path}" == ../* ||
    "${relative_path}" == */.. || "${relative_path}" == *//* ]]; then
    echo "ERROR: invalid release snapshot helper path: ${relative_path:-<empty>}" >&2
    return 1
  fi

  current_path="${REPO_ROOT}"
  remaining="${relative_path}"
  while [[ "${remaining}" == */* ]]; do
    component="${remaining%%/*}"
    remaining="${remaining#*/}"
    if [[ -z "${component}" || "${component}" == "." || "${component}" == ".." ]]; then
      echo "ERROR: invalid release snapshot helper path: ${relative_path}" >&2
      return 1
    fi
    current_path="${current_path}/${component}"
    if [[ ! -d "${current_path}" || -L "${current_path}" ]]; then
      echo "ERROR: release snapshot helper has a non-directory or symlink component: ${relative_path}" >&2
      return 1
    fi
  done
  if [[ -z "${remaining}" || "${remaining}" == "." || "${remaining}" == ".." ]]; then
    echo "ERROR: invalid release snapshot helper path: ${relative_path}" >&2
    return 1
  fi
  current_path="${current_path}/${remaining}"
  if [[ ! -f "${current_path}" || -L "${current_path}" ]]; then
    echo "ERROR: release helper must be a regular non-symlink snapshot file: ${relative_path}" >&2
    return 1
  fi
  if [[ "${executable}" == "true" && ! -x "${current_path}" ]]; then
    echo "ERROR: release snapshot helper is not executable: ${relative_path}" >&2
    return 1
  fi
}

run_snapshot_helper() {
  local relative_path=$1
  shift
  require_snapshot_regular_file "${relative_path}" true || return 1
  if [[ "${relative_path}" == "scripts/verify-registry-api-image.sh" ]]; then
    require_snapshot_regular_file "scripts/verify-api-image.sh" true || return 1
  fi
  "${REPO_ROOT}/${relative_path}" "$@"
}

# Validate the complete helper closure before admission and validate each
# directly invoked helper again at its call site. Component-by-component checks
# prevent a committed symlink from escaping the private snapshot.
require_snapshot_regular_file "scripts/deploy-prod.sh" true
require_snapshot_regular_file "scripts/run-release-git.sh" true
require_snapshot_regular_file "scripts/verify-github-release-ci.sh" true
require_snapshot_regular_file "scripts/verify-migration-release-receipt.sh" true
require_snapshot_regular_file "scripts/verify-registry-api-image.sh" true
require_snapshot_regular_file "scripts/verify-api-image.sh" true
require_snapshot_regular_file "scripts/verify-containerapp-release-config.sh" true
require_snapshot_regular_file "docs/ops/production-clerk-auth.sha256" false

release_git_command() {
  require_snapshot_regular_file "scripts/run-release-git.sh" true || return 1
  bash "${REPO_ROOT}/scripts/run-release-git.sh" "$@"
}
release_gh_command() {
  /usr/bin/env \
    -u ALL_PROXY \
    -u CURL_CA_BUNDLE \
    -u DEBUG \
    -u GH_DEBUG \
    -u HTTPS_PROXY \
    -u HTTP_PROXY \
    -u SSL_CERT_DIR \
    -u SSL_CERT_FILE \
    -u all_proxy \
    -u http_proxy \
    -u https_proxy \
    gh "$@"
}

REGISTRY="ledgracr"
RESOURCE_GROUP="Ledgr-prod"
ACR_REPO="apex-api"
API_APP="apex-gtm-api"
WORKER_APP="apex-gtm-worker"
CONSOLE_APP="nikxius-web"
CONSOLE_ACR_REPO="workforceos-fe"
DOCKERFILE="apps/api/Dockerfile"

RELEASE_LOCK_REF="refs/heads/workforce-os-release-lock/production-gtm-platform"
RELEASE_REPOSITORY="Kloudedge-apex/apex-product"
RELEASE_REPOSITORY_URL="https://github.com/Kloudedge-apex/apex-product.git"
RELEASE_LOCK_ACQUIRED="false"
RELEASE_LOCK_SAFE_TO_RELEASE="true"
RELEASE_LOCK_COMMIT=""
RELEASE_LOCK_ATTEMPT_ID=""
LEASE_GIT_DIR=""
BUILD_CONTEXT="${REPO_ROOT}"

cleanup_release_resources() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "${RELEASE_LOCK_ACQUIRED:-false}" == "true" &&
    "${RELEASE_LOCK_SAFE_TO_RELEASE:-false}" == "true" ]]; then
    # Git's force-with-lease deletion is a server-side compare-and-delete. It
    # cannot remove a successor ref whose unique target differs from this
    # attempt, avoiding the read-then-DELETE race in the GitHub REST API.
    if ! lease_git push \
      "--force-with-lease=${RELEASE_LOCK_REF}:${RELEASE_LOCK_COMMIT}" \
      "${RELEASE_REPOSITORY_URL}" \
      ":${RELEASE_LOCK_REF}" >/dev/null 2>&1; then
      echo "ERROR: conditional release lease cleanup failed; remove it only after confirming no rollout is active" >&2
      if [[ ${status} -eq 0 ]]; then
        status=1
      fi
    fi
  elif [[ "${RELEASE_LOCK_ACQUIRED:-false}" == "true" ]]; then
    echo "ERROR: retaining the production release lease because rollout state is uncertain" >&2
    echo "       investigate Azure state before separately authorizing lease removal" >&2
  fi
  exit "${status}"
}
trap cleanup_release_resources EXIT

MIGRATION_RECEIPT=""
MIGRATION_SIGNATURE=""
MIGRATION_ALLOWED_SIGNERS=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --migration-receipt)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "ERROR: --migration-receipt requires a path" >&2
        exit 2
      fi
      MIGRATION_RECEIPT="$2"
      shift 2
      ;;
    --migration-signature)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "ERROR: --migration-signature requires a path" >&2
        exit 2
      fi
      MIGRATION_SIGNATURE="$2"
      shift 2
      ;;
    --migration-allowed-signers)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "ERROR: --migration-allowed-signers requires a path" >&2
        exit 2
      fi
      MIGRATION_ALLOWED_SIGNERS="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES="true"
      shift
      ;;
    *)
      echo "Usage: $0 --migration-receipt <path> --migration-signature <path> --migration-allowed-signers <path> --yes" >&2
      exit 2
      ;;
  esac
done
if [[ -z "${MIGRATION_RECEIPT}" || -z "${MIGRATION_SIGNATURE}" ||
  -z "${MIGRATION_ALLOWED_SIGNERS}" ]]; then
  echo "ERROR: a signed production migration receipt and allowed-signers trust root are required" >&2
  exit 2
fi
if [[ "${ASSUME_YES}" != "true" ]]; then
  echo "ERROR: protected release execution is noninteractive and requires --yes" >&2
  exit 2
fi
if [[ "${ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED:-}" != "true" ]]; then
  echo "ERROR: production Container Apps writes are fail-closed pending exclusive authority attestation" >&2
  echo "       see docs/ops/go-live-runbook.md before setting ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED=true" >&2
  exit 1
fi

# Git admission still reads the canonical repository metadata, but every
# executable release byte and the build context now come from REPO_ROOT, the
# private exact-commit snapshot established by the bootstrap above.
cd "${SOURCE_REPOSITORY}"

# --- Guard: production only ships an exact published release commit --------
BRANCH="$(release_git_command -C "${SOURCE_REPOSITORY}" rev-parse --abbrev-ref HEAD)"
if [[ "${BRANCH}" != release/go-live-* ]]; then
  echo "ERROR: current branch is '${BRANCH}', expected release/go-live-*." >&2
  exit 1
fi

COMMIT="$(release_git_command -C "${SOURCE_REPOSITORY}" rev-parse HEAD)"
if [[ ! "${COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: HEAD is not a full lowercase Git SHA: ${COMMIT:-<empty>}" >&2
  exit 1
fi
if [[ "${COMMIT}" != "${SNAPSHOT_COMMIT}" ]]; then
  echo "ERROR: repository HEAD changed while the exact-commit snapshot was being established" >&2
  echo "       snapshot: ${SNAPSHOT_COMMIT}" >&2
  echo "       current : ${COMMIT}" >&2
  exit 1
fi

for REQUIRED_COMMAND in az docker gh git jq od; do
  if ! command -v "${REQUIRED_COMMAND}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${REQUIRED_COMMAND}" >&2
    exit 1
  fi
done

REMOTE_COMMIT="$(release_gh_command api \
  --hostname github.com \
  "repos/${RELEASE_REPOSITORY}/git/ref/heads/${BRANCH}" \
  --jq '.object.sha')"
if [[ "${REMOTE_COMMIT}" != "${COMMIT}" ]]; then
  echo "ERROR: local HEAD ${COMMIT} is not the published GitHub ${BRANCH} head" >&2
  echo "       remote head: ${REMOTE_COMMIT:-<missing>}" >&2
  exit 1
fi

run_snapshot_helper "scripts/verify-github-release-ci.sh" "${COMMIT}"
# Freeze all externally supplied evidence into the private same-attempt runtime
# directory before the first verification. Every later forward and rollback
# check reuses these exact bytes; caller-controlled paths are never reread.
MIGRATION_RECEIPT_SOURCE="${MIGRATION_RECEIPT}"
MIGRATION_SIGNATURE_SOURCE="${MIGRATION_SIGNATURE}"
MIGRATION_ALLOWED_SIGNERS_SOURCE="${MIGRATION_ALLOWED_SIGNERS}"
MIGRATION_RECEIPT="${RUNTIME_STATE_DIR}/migration-receipt.json"
MIGRATION_SIGNATURE="${RUNTIME_STATE_DIR}/migration-receipt.sig"
MIGRATION_ALLOWED_SIGNERS="${RUNTIME_STATE_DIR}/migration-allowed-signers"
cp -- "${MIGRATION_RECEIPT_SOURCE}" "${MIGRATION_RECEIPT}"
cp -- "${MIGRATION_SIGNATURE_SOURCE}" "${MIGRATION_SIGNATURE}"
cp -- "${MIGRATION_ALLOWED_SIGNERS_SOURCE}" "${MIGRATION_ALLOWED_SIGNERS}"
chmod 600 "${MIGRATION_RECEIPT}" "${MIGRATION_SIGNATURE}" "${MIGRATION_ALLOWED_SIGNERS}"
run_snapshot_helper "scripts/verify-migration-release-receipt.sh" \
  "${MIGRATION_RECEIPT}" \
  "${MIGRATION_SIGNATURE}" \
  "${MIGRATION_ALLOWED_SIGNERS}" \
  "${COMMIT}"

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable; the exact registry artifact cannot be verified" >&2
  exit 1
fi

# Use an isolated bare repository with no inherited Git configuration or hooks
# for the lease protocol. The explicit GitHub URL and gh credential helper keep
# mutable source-repository remotes, credential helpers, and push hooks outside
# the release boundary.
LEASE_GIT_DIR="${RUNTIME_STATE_DIR}/lease.git"
LEASE_GIT_TEMPLATE="${RUNTIME_STATE_DIR}/empty-git-template"
mkdir "${LEASE_GIT_TEMPLATE}"
release_git_command -c core.hooksPath=/dev/null \
  init --bare --template="${LEASE_GIT_TEMPLATE}" "${LEASE_GIT_DIR}" >/dev/null
lease_git() {
  release_git_command \
    -c core.hooksPath=/dev/null \
    -c credential.helper= \
    -c 'credential.helper=!gh auth git-credential' \
    --git-dir="${LEASE_GIT_DIR}" \
    "$@"
}
lease_git fetch \
  --no-tags \
  --depth=1 \
  "${RELEASE_REPOSITORY_URL}" \
  "${COMMIT}" >/dev/null
LEASE_FETCHED_COMMIT="$(lease_git rev-parse FETCH_HEAD)"
if [[ "${LEASE_FETCHED_COMMIT}" != "${COMMIT}" ]]; then
  echo "ERROR: isolated lease repository did not fetch the exact release commit" >&2
  exit 1
fi

# The fixed ref provides atomic acquisition. Its target is a fresh Git commit
# with the exact source tree and a cryptographically random attempt nonce, so
# two attempts for the same source SHA never share a cleanup identity.
RELEASE_LOCK_ATTEMPT_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
if [[ ! "${RELEASE_LOCK_ATTEMPT_ID}" =~ ^[0-9a-f]{32}$ ]]; then
  echo "ERROR: could not generate a unique release lease attempt identity" >&2
  exit 1
fi
RELEASE_SOURCE_TREE="$(GIT_NO_REPLACE_OBJECTS=1 lease_git rev-parse "${COMMIT}^{tree}")"
if [[ ! "${RELEASE_SOURCE_TREE}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: Git returned an invalid source tree for the release lease" >&2
  exit 1
fi
RELEASE_LOCK_COMMIT="$(printf '%s\n' \
  "workforce-os production release lease ${RELEASE_LOCK_ATTEMPT_ID}" | \
  GIT_AUTHOR_NAME='Workforce OS Release Controller' \
  GIT_AUTHOR_EMAIL='release-controller@invalid' \
  GIT_COMMITTER_NAME='Workforce OS Release Controller' \
  GIT_COMMITTER_EMAIL='release-controller@invalid' \
  lease_git commit-tree "${RELEASE_SOURCE_TREE}" -p "${COMMIT}")"
if [[ ! "${RELEASE_LOCK_COMMIT}" =~ ^[0-9a-f]{40}$ ||
  "${RELEASE_LOCK_COMMIT}" == "${COMMIT}" ]]; then
  echo "ERROR: Git returned an invalid or non-unique release lease identity" >&2
  exit 1
fi
if ! lease_git push \
  "--force-with-lease=${RELEASE_LOCK_REF}:" \
  "${RELEASE_REPOSITORY_URL}" \
  "${RELEASE_LOCK_COMMIT}:${RELEASE_LOCK_REF}" >/dev/null; then
  echo "ERROR: production release lease is already held or could not be acquired" >&2
  echo "       inspect ${RELEASE_LOCK_REF} before any stale-lock removal" >&2
  exit 1
fi
RELEASE_LOCK_ACQUIRED="true"

capture_containerapp_state() {
  local app=$1
  local output_file=$2
  if ! az containerapp show \
    --name "${app}" \
    --resource-group "${RESOURCE_GROUP}" \
    --output json >"${output_file}"; then
    echo "ERROR: could not read Container App state for ${app}" >&2
    return 1
  fi
  jq -e --arg app "${app}" '
    (.id | type == "string" and
      (ascii_downcase | endswith("/providers/microsoft.app/containerapps/" + ($app | ascii_downcase))))
    and (.properties.template.containers | length == 1)
    and (.properties.template.containers[0].image | type == "string" and length > 0)
  ' "${output_file}" >/dev/null || {
    echo "ERROR: ${app} did not return the expected single-container resource identity" >&2
    return 1
  }
}

containerapp_state_value() {
  local state_file=$1
  local expression=$2
  jq -er "${expression}" "${state_file}"
}

containerapp_plain_env_value() {
  local state_file=$1
  local name=$2
  local count
  if ! count="$(jq -er --arg name "${name}" '
    [.properties.template.containers[0].env[]? | select(.name == $name)] | length
  ' "${state_file}")"; then
    echo "ERROR: could not inspect ${name} in captured Container App state" >&2
    return 1
  fi
  if [[ "${count}" == "0" ]]; then
    echo "__ABSENT__"
    return 0
  fi
  if [[ "${count}" != "1" ]]; then
    echo "ERROR: ${name} must appear at most once in captured Container App state" >&2
    return 1
  fi
  jq -er --arg name "${name}" '
    [.properties.template.containers[0].env[]? | select(.name == $name)][0]
    | select((.secretRef // "") == "" and (.value | type == "string"))
    | .value
  ' "${state_file}" || {
    echo "ERROR: ${name} must be a plain non-secret Container App value" >&2
    return 1
  }
}

bootstrap_guard_identity_from_state() {
  local state_file=$1
  local attempt generation
  attempt="$(containerapp_plain_env_value \
    "${state_file}" WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID)" || return 1
  generation="$(containerapp_plain_env_value \
    "${state_file}" WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION)" || return 1
  if [[ ! "${attempt}" =~ ^[0-9a-f]{32}$ ]]; then
    echo "ERROR: production bootstrap attempt guard is missing or malformed" >&2
    return 1
  fi
  if [[ ! "${generation}" =~ ^[1-9][0-9]*$ ]] ||
    (( ${#generation} > 16 )) ||
    { (( ${#generation} == 16 )) &&
      [[ "${generation}" > "9007199254740991" ]]; }; then
    echo "ERROR: production bootstrap minimum writer-fence generation is missing or unsafe" >&2
    return 1
  fi
  printf '%s:%s\n' "${attempt}" "${generation}"
}

require_containerapp_env_absent() {
  local state_file=$1
  local name=$2
  local count
  if ! count="$(jq -er --arg name "${name}" '[.properties.template.containers[0].env[]? | select(.name == $name)] | length' "${state_file}")"; then
    echo "ERROR: could not inspect ${name} in captured Container App state" >&2
    return 1
  fi
  if [[ "${count}" != "0" ]]; then
    echo "ERROR: ${name} must be absent from captured Container App state" >&2
    return 1
  fi
}

delivery_unknown_mode_from_state() {
  local state_file=$1
  local role=$2
  local mode ack epoch
  require_containerapp_env_absent \
    "${state_file}" OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED || return 1
  require_containerapp_env_absent \
    "${state_file}" OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK || return 1
  mode="$(containerapp_plain_env_value \
    "${state_file}" OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE)" || return 1
  ack="$(containerapp_plain_env_value \
    "${state_file}" OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK)" || return 1
  epoch="$(containerapp_plain_env_value \
    "${state_file}" OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH)" || return 1
  if [[ "${mode}" == "__ABSENT__" ]]; then
    mode="disabled"
  fi
  if [[ "${role}" == "api" ]]; then
    if [[ "${mode}" != "disabled" || "${ack}" != "__ABSENT__" ||
      "${epoch}" != "__ABSENT__" ]]; then
      echo "ERROR: the API must keep DELIVERY_UNKNOWN writes disabled without acknowledgement or epoch" >&2
      return 1
    fi
    printf '%s\n' "${mode}"
    return 0
  fi
  case "${mode}" in
    disabled)
      if [[ "${ack}" != "__ABSENT__" || "${epoch}" != "__ABSENT__" ]]; then
        echo "ERROR: disabled DELIVERY_UNKNOWN writes must not carry an acknowledgement or epoch" >&2
        return 1
      fi
      local live_send_allowlist
      live_send_allowlist="$(containerapp_plain_env_value \
        "${state_file}" OUTREACH_LIVE_FOR_ORGS)" || return 1
      if [[ "${live_send_allowlist}" != "__ABSENT__" && -n "${live_send_allowlist}" ]]; then
        echo "ERROR: disabled DELIVERY_UNKNOWN write mode requires an empty live-send allowlist" >&2
        return 1
      fi
      ;;
    first-class)
      if [[ "${ack}" != "readers-drained-rollback-baselines-verified-v1" ||
        "${epoch}" != "outreach-delivery-unknown-v1" ]]; then
        echo "ERROR: first-class DELIVERY_UNKNOWN writes lack the exact reader-drain acknowledgement" >&2
        return 1
      fi
      ;;
    *)
      echo "ERROR: DELIVERY_UNKNOWN write mode must be disabled or first-class" >&2
      return 1
      ;;
  esac
  printf '%s\n' "${mode}"
}

capture_active_revision_state() {
  local app=$1
  local output_file=$2
  local list_file="${output_file}.list"
  local active_revision
  if ! az containerapp revision list \
    --name "${app}" \
    --resource-group "${RESOURCE_GROUP}" \
    --output json >"${list_file}"; then
    echo "ERROR: could not list active revisions for ${app}" >&2
    return 1
  fi
  active_revision="$(jq -er '
    [.[] | select(.properties.active == true)]
    | if length == 1 and (.[0].name | type == "string" and length > 0)
      then .[0].name
      else error("expected exactly one active revision")
      end
  ' "${list_file}")" || {
    echo "ERROR: ${app} does not have exactly one active revision" >&2
    return 1
  }
  if ! az containerapp revision show \
    --name "${app}" \
    --resource-group "${RESOURCE_GROUP}" \
    --revision "${active_revision}" \
    --output json >"${output_file}"; then
    echo "ERROR: could not read active revision ${active_revision} for ${app}" >&2
    return 1
  fi
  jq -e --arg revision "${active_revision}" '
    .name == $revision
    and .properties.active == true
    and .properties.healthState == "Healthy"
    and .properties.provisioningState == "Provisioned"
    and (.properties.template.containers | length == 1)
    and (.properties.template.containers[0].image | type == "string" and length > 0)
  ' "${output_file}" >/dev/null || {
    echo "ERROR: ${app} active revision is not a single healthy provisioned container" >&2
    return 1
  }
}

assert_active_revision_identity() {
  local app=$1
  local expected_image=$2
  local expected_revision=$3
  local output_file=$4
  local actual_image actual_revision
  capture_active_revision_state "${app}" "${output_file}" || return 1
  actual_revision="$(containerapp_state_value "${output_file}" '.name')" || return 1
  actual_image="$(containerapp_state_value \
    "${output_file}" '.properties.template.containers[0].image')" || return 1
  if [[ "${actual_revision}" != "${expected_revision}" ||
    "${actual_image}" != "${expected_image}" ]]; then
    echo "ERROR: ${app} active revision/image changed outside this rollout" >&2
    return 1
  fi
}

assert_live_rollout_state() {
  local prefix=$1
  local expected_api_image=$2
  local expected_api_revision=$3
  local expected_worker_image=$4
  local expected_worker_revision=$5
  local expected_console_image=$6
  local expected_console_revision=$7
  local expected_mode=$8
  local allowed_guard_drift_role=${9:-none}
  local api_state="${RUNTIME_STATE_DIR}/${prefix}-api-active.json"
  local worker_state="${RUNTIME_STATE_DIR}/${prefix}-worker-active.json"
  local console_state="${RUNTIME_STATE_DIR}/${prefix}-console-active.json"
  local api_mode worker_mode api_guard worker_guard
  assert_active_revision_identity \
    "${API_APP}" "${expected_api_image}" "${expected_api_revision}" "${api_state}" || return 1
  assert_active_revision_identity \
    "${WORKER_APP}" "${expected_worker_image}" "${expected_worker_revision}" "${worker_state}" || return 1
  assert_active_revision_identity \
    "${CONSOLE_APP}" "${expected_console_image}" "${expected_console_revision}" "${console_state}" || return 1
  api_mode="$(delivery_unknown_mode_from_state "${api_state}" api)" || return 1
  worker_mode="$(delivery_unknown_mode_from_state "${worker_state}" worker)" || return 1
  if [[ "${api_mode}" != "disabled" || "${worker_mode}" != "${expected_mode}" ]]; then
    echo "ERROR: DELIVERY_UNKNOWN write mode changed outside this rollout" >&2
    return 1
  fi
  if ! api_guard="$(bootstrap_guard_identity_from_state "${api_state}")"; then
    [[ "${allowed_guard_drift_role}" == "api" ]] || return 1
    api_guard="__ROLLBACK_GUARD_DRIFT__"
  fi
  if ! worker_guard="$(bootstrap_guard_identity_from_state "${worker_state}")"; then
    [[ "${allowed_guard_drift_role}" == "worker" ]] || return 1
    worker_guard="__ROLLBACK_GUARD_DRIFT__"
  fi
  if [[ -z "${BOOTSTRAP_GUARD_IDENTITY:-}" ]] ||
    { [[ "${api_guard}" != "${BOOTSTRAP_GUARD_IDENTITY}" ]] &&
      [[ "${allowed_guard_drift_role}" != "api" ]]; } ||
    { [[ "${worker_guard}" != "${BOOTSTRAP_GUARD_IDENTITY}" ]] &&
      [[ "${allowed_guard_drift_role}" != "worker" ]]; }; then
    echo "ERROR: production bootstrap deployment guard changed outside this rollout" >&2
    return 1
  fi
}

wait_for_containerapp_image() {
  local app=$1
  local expected_image=$2
  local state_file=$3
  local attempt image provisioning latest ready
  for ((attempt = 1; attempt <= 180; attempt++)); do
    if capture_containerapp_state "${app}" "${state_file}"; then
      if ! image="$(containerapp_state_value \
        "${state_file}" '.properties.template.containers[0].image')" ||
        ! provisioning="$(containerapp_state_value \
          "${state_file}" '.properties.provisioningState // ""')" ||
        ! latest="$(containerapp_state_value \
          "${state_file}" '.properties.latestRevisionName // ""')" ||
        ! ready="$(containerapp_state_value \
          "${state_file}" '.properties.latestReadyRevisionName // ""')"; then
        continue
      fi
      if [[ "${provisioning}" == "Failed" || "${provisioning}" == "Canceled" ]]; then
        echo "ERROR: ${app} entered ${provisioning} while applying ${expected_image}" >&2
        return 1
      fi
      if [[ "${image}" == "${expected_image}" && "${provisioning}" == "Succeeded" &&
        -n "${latest}" && "${ready}" == "${latest}" ]]; then
        return 0
      fi
    fi
    sleep 5
  done
  echo "ERROR: timed out waiting for ${app} to converge on ${expected_image}" >&2
  return 1
}

require_inactive_revision_retention() {
  local state_file=$1
  local app=$2
  local retained
  if ! retained="$(containerapp_state_value \
    "${state_file}" '.properties.configuration.maxInactiveRevisions')"; then
    echo "ERROR: ${app} maxInactiveRevisions must be explicit" >&2
    return 1
  fi
  if [[ ! "${retained}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: ${app} maxInactiveRevisions must retain at least one rollback revision" >&2
    return 1
  fi
}

verify_retained_revision() {
  local app=$1
  local revision=$2
  local expected_image=$3
  local state_file=$4
  if ! az containerapp revision show \
    --name "${app}" \
    --resource-group "${RESOURCE_GROUP}" \
    --revision "${revision}" \
    --output json >"${state_file}"; then
    echo "ERROR: signed rollback revision ${revision} is no longer available" >&2
    return 1
  fi
  jq -e --arg revision "${revision}" --arg image "${expected_image}" '
    .name == $revision
    and .properties.active == false
    and (.properties.template.containers | length == 1)
    and .properties.template.containers[0].image == $image
  ' "${state_file}" >/dev/null || {
    echo "ERROR: signed rollback revision ${revision} was not retained exactly" >&2
    return 1
  }
}

require_exclusive_containerapp_mutation_authority() {
  if [[ "${ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED:-}" != "true" ]]; then
    echo "ERROR: Azure Container Apps mutation authority is not exclusively attested" >&2
    echo "       ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED=true is permitted only after" >&2
    echo "       an RBAC audit proves the protected CI OIDC principal is the exclusive" >&2
    echo "       Microsoft.App/containerApps/write authority across apex-gtm-api," >&2
    echo "       apex-gtm-worker, and nikxius-web, or all three share one coordinated" >&2
    echo "       mutation lease that excludes every other writer" >&2
    return 1
  fi
}

update_containerapp_image() {
  local app=$1
  local desired_image=$2
  local state_prefix=$3
  local expected_api_image=$4
  local expected_api_revision=$5
  local expected_worker_image=$6
  local expected_worker_revision=$7
  local expected_console_image=$8
  local expected_console_revision=$9
  local expected_mode=${10}
  local result_state_file=${11}

  # Immediately before the mutation, re-read all three active revisions and
  # compare exact revision, image, and compatibility mode identities. A
  # same-image configuration update creates a new revision and is rejected.
  assert_live_rollout_state \
    "${state_prefix}" \
    "${expected_api_image}" "${expected_api_revision}" \
    "${expected_worker_image}" "${expected_worker_revision}" \
    "${expected_console_image}" "${expected_console_revision}" \
    "${expected_mode}" || return 1

  # Identity reads can be slow. Reverify the frozen signed receipt only after
  # those reads so a receipt that expires during them cannot authorize a write.
  verify_signed_rollback_baseline_contract || return 1

  # The stable Container Apps REST specifications through 2026-01-01 expose
  # neither a resource ETag nor an If-Match update parameter. Do not imply CAS.
  # This write is admitted only when RBAC makes the protected CI OIDC principal
  # the exclusive writer; the fixed GitHub ref serializes that principal's
  # release attempts. Re-check the attestation immediately before every write.
  require_exclusive_containerapp_mutation_authority || return 1
  case "${app}" in
    "${API_APP}") API_UPDATE_ATTEMPTED="true" ;;
    "${WORKER_APP}") WORKER_UPDATE_ATTEMPTED="true" ;;
    *)
      echo "ERROR: unsupported Container App update target: ${app}" >&2
      return 1
      ;;
  esac
  if ! az containerapp update \
    --name "${app}" \
    --resource-group "${RESOURCE_GROUP}" \
    --image "${desired_image}" \
    --output none; then
    echo "ERROR: ${app} image update failed or its outcome is uncertain" >&2
    return 1
  fi
  wait_for_containerapp_image \
    "${app}" "${desired_image}" "${result_state_file}" || return 1
  local result_guard
  result_guard="$(bootstrap_guard_identity_from_state "${result_state_file}")" || return 1
  if [[ "${result_guard}" != "${BOOTSTRAP_GUARD_IDENTITY}" ]]; then
    echo "ERROR: ${app} image update dropped, changed, or downgraded the production bootstrap guard" >&2
    return 1
  fi
}

wait_for_exact_revision_activation() {
  local app=$1
  local expected_revision=$2
  local expected_image=$3
  local state_file=$4
  local attempt actual_revision actual_image
  for ((attempt = 1; attempt <= 180; attempt++)); do
    if capture_active_revision_state "${app}" "${state_file}"; then
      if ! actual_revision="$(containerapp_state_value "${state_file}" '.name')" ||
        ! actual_image="$(containerapp_state_value \
          "${state_file}" '.properties.template.containers[0].image')"; then
        continue
      fi
      if [[ "${actual_revision}" == "${expected_revision}" &&
        "${actual_image}" == "${expected_image}" ]]; then
        return 0
      fi
    fi
    sleep 5
  done
  echo "ERROR: timed out waiting for ${app} to reactivate exact revision ${expected_revision}" >&2
  return 1
}

verify_api_traffic_on_active_revision() {
  local expected_revision=$1
  local state_file=$2
  capture_containerapp_state "${API_APP}" "${state_file}" || return 1
  jq -e --arg revision "${expected_revision}" '
    .properties.configuration.activeRevisionsMode == "Single"
    and (.properties.configuration.ingress.external == true)
    and (.properties.configuration.ingress.traffic | type == "array" and length == 1)
    and (.properties.configuration.ingress.traffic[0].weight == 100)
    and .properties.configuration.ingress.traffic[0].revisionName == $revision
    and ((.properties.configuration.ingress.traffic[0].latestRevision // false) == false)
  ' "${state_file}" >/dev/null || {
    echo "ERROR: API traffic is not exclusively bound to the exact active rollback revision" >&2
    return 1
  }
}

set_api_traffic_to_exact_revision() {
  local revision=$1
  local expected_api_image=$2
  local expected_api_revision=$3
  local expected_worker_image=$4
  local expected_worker_revision=$5
  local expected_console_image=$6
  local expected_console_revision=$7
  local expected_mode=$8
  local result_state_file=$9

  assert_live_rollout_state \
    rollback-api-before-traffic \
    "${expected_api_image}" "${expected_api_revision}" \
    "${expected_worker_image}" "${expected_worker_revision}" \
    "${expected_console_image}" "${expected_console_revision}" \
    "${expected_mode}" || return 1
  require_exclusive_containerapp_mutation_authority || return 1
  if ! az containerapp ingress traffic set \
    --name "${API_APP}" \
    --resource-group "${RESOURCE_GROUP}" \
    --revision-weight "${revision}=100" \
    --output none; then
    echo "ERROR: API exact rollback traffic assignment failed or is uncertain" >&2
    return 1
  fi
  verify_api_traffic_on_active_revision \
    "${revision}" "${result_state_file}" || return 1
}

activate_containerapp_revision() {
  local app=$1
  local revision=$2
  local image=$3
  local state_prefix=$4
  local expected_api_image=$5
  local expected_api_revision=$6
  local expected_worker_image=$7
  local expected_worker_revision=$8
  local expected_console_image=$9
  local expected_console_revision=${10}
  local expected_mode=${11}
  local result_state_file=${12}
  local allowed_guard_drift_role=${13:-none}

  assert_live_rollout_state \
    "${state_prefix}" \
    "${expected_api_image}" "${expected_api_revision}" \
    "${expected_worker_image}" "${expected_worker_revision}" \
    "${expected_console_image}" "${expected_console_revision}" \
    "${expected_mode}" "${allowed_guard_drift_role}" || return 1
  verify_retained_revision \
    "${app}" "${revision}" "${image}" \
    "${RUNTIME_STATE_DIR}/${state_prefix}-target-retained.json" || return 1
  require_exclusive_containerapp_mutation_authority || return 1
  if ! az containerapp revision activate \
    --name "${app}" \
    --resource-group "${RESOURCE_GROUP}" \
    --revision "${revision}" \
    --output none; then
    echo "ERROR: ${app} exact revision activation failed or its outcome is uncertain" >&2
    return 1
  fi
  wait_for_exact_revision_activation \
    "${app}" "${revision}" "${image}" "${result_state_file}" || return 1
  local result_guard
  result_guard="$(bootstrap_guard_identity_from_state "${result_state_file}")" || return 1
  if [[ "${result_guard}" != "${BOOTSTRAP_GUARD_IDENTITY}" ]]; then
    echo "ERROR: ${app} rollback revision does not preserve the production bootstrap guard" >&2
    return 1
  fi
}

# Prove access to both targets before creating a registry artifact. Capturing
# the prior references also gives the operator an explicit partial-rollout
# recovery identity; the script never guesses a mutable rollback tag.
INITIAL_API_STATE="${RUNTIME_STATE_DIR}/initial-api.json"
INITIAL_WORKER_STATE="${RUNTIME_STATE_DIR}/initial-worker.json"
INITIAL_CONSOLE_STATE="${RUNTIME_STATE_DIR}/initial-console.json"
capture_containerapp_state "${API_APP}" "${INITIAL_API_STATE}"
capture_containerapp_state "${WORKER_APP}" "${INITIAL_WORKER_STATE}"
capture_containerapp_state "${CONSOLE_APP}" "${INITIAL_CONSOLE_STATE}"
require_inactive_revision_retention "${INITIAL_API_STATE}" "${API_APP}"
require_inactive_revision_retention "${INITIAL_WORKER_STATE}" "${WORKER_APP}"
PREVIOUS_API_IMAGE="$(containerapp_state_value \
  "${INITIAL_API_STATE}" '.properties.template.containers[0].image')"
PREVIOUS_WORKER_IMAGE="$(containerapp_state_value \
  "${INITIAL_WORKER_STATE}" '.properties.template.containers[0].image')"
PREVIOUS_CONSOLE_IMAGE="$(containerapp_state_value \
  "${INITIAL_CONSOLE_STATE}" '.properties.template.containers[0].image')"
PREVIOUS_API_REVISION="$(containerapp_state_value \
  "${INITIAL_API_STATE}" '.properties.latestReadyRevisionName // ""')"
PREVIOUS_WORKER_REVISION="$(containerapp_state_value \
  "${INITIAL_WORKER_STATE}" '.properties.latestReadyRevisionName // ""')"
PREVIOUS_CONSOLE_REVISION="$(containerapp_state_value \
  "${INITIAL_CONSOLE_STATE}" '.properties.latestReadyRevisionName // ""')"
LATEST_API_REVISION="$(containerapp_state_value \
  "${INITIAL_API_STATE}" '.properties.latestRevisionName // ""')"
LATEST_WORKER_REVISION="$(containerapp_state_value \
  "${INITIAL_WORKER_STATE}" '.properties.latestRevisionName // ""')"
LATEST_CONSOLE_REVISION="$(containerapp_state_value \
  "${INITIAL_CONSOLE_STATE}" '.properties.latestRevisionName // ""')"
if [[ -z "${PREVIOUS_API_IMAGE}" || -z "${PREVIOUS_WORKER_IMAGE}" ||
  -z "${PREVIOUS_CONSOLE_IMAGE}" ]]; then
  echo "ERROR: could not resolve all current Container App image references" >&2
  exit 1
fi
if [[ ! "${PREVIOUS_API_REVISION}" =~ ^${API_APP}--[a-z0-9][a-z0-9-]*$ ]] ||
  [[ ! "${PREVIOUS_WORKER_REVISION}" =~ ^${WORKER_APP}--[a-z0-9][a-z0-9-]*$ ]] ||
  [[ ! "${PREVIOUS_CONSOLE_REVISION}" =~ ^${CONSOLE_APP}--[a-z0-9][a-z0-9-]*$ ]] ||
  [[ "${LATEST_API_REVISION}" != "${PREVIOUS_API_REVISION}" ]] ||
  [[ "${LATEST_WORKER_REVISION}" != "${PREVIOUS_WORKER_REVISION}" ]] ||
  [[ "${LATEST_CONSOLE_REVISION}" != "${PREVIOUS_CONSOLE_REVISION}" ]]; then
  echo "ERROR: API, worker, and console baselines must be exact latest-ready production revisions" >&2
  exit 1
fi
if [[ ! "${PREVIOUS_API_IMAGE}" =~ ^${REGISTRY}\.azurecr\.io/${ACR_REPO}@sha256:[0-9a-f]{64}$ ]] ||
  [[ ! "${PREVIOUS_WORKER_IMAGE}" =~ ^${REGISTRY}\.azurecr\.io/${ACR_REPO}@sha256:[0-9a-f]{64}$ ]] ||
  [[ ! "${PREVIOUS_CONSOLE_IMAGE}" =~ ^${REGISTRY}\.azurecr\.io/${CONSOLE_ACR_REPO}@sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: API, worker, and console must already use immutable digest references for safe rollback" >&2
  exit 1
fi
INITIAL_API_ACTIVE_STATE="${RUNTIME_STATE_DIR}/initial-api-active.json"
INITIAL_WORKER_ACTIVE_STATE="${RUNTIME_STATE_DIR}/initial-worker-active.json"
INITIAL_CONSOLE_ACTIVE_STATE="${RUNTIME_STATE_DIR}/initial-console-active.json"
assert_active_revision_identity \
  "${API_APP}" "${PREVIOUS_API_IMAGE}" "${PREVIOUS_API_REVISION}" "${INITIAL_API_ACTIVE_STATE}"
assert_active_revision_identity \
  "${WORKER_APP}" "${PREVIOUS_WORKER_IMAGE}" "${PREVIOUS_WORKER_REVISION}" "${INITIAL_WORKER_ACTIVE_STATE}"
assert_active_revision_identity \
  "${CONSOLE_APP}" "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" "${INITIAL_CONSOLE_ACTIVE_STATE}"
INITIAL_API_BOOTSTRAP_GUARD="$(bootstrap_guard_identity_from_state \
  "${INITIAL_API_ACTIVE_STATE}")"
INITIAL_WORKER_BOOTSTRAP_GUARD="$(bootstrap_guard_identity_from_state \
  "${INITIAL_WORKER_ACTIVE_STATE}")"
if [[ "${INITIAL_API_BOOTSTRAP_GUARD}" != "${INITIAL_WORKER_BOOTSTRAP_GUARD}" ]]; then
  echo "ERROR: API and worker production bootstrap deployment guards do not match" >&2
  exit 1
fi
BOOTSTRAP_GUARD_IDENTITY="${INITIAL_API_BOOTSTRAP_GUARD}"
run_snapshot_helper "scripts/verify-containerapp-release-config.sh" \
  "${PREVIOUS_API_IMAGE}" \
  "${PREVIOUS_WORKER_IMAGE}"

API_DELIVERY_UNKNOWN_WRITE_MODE="$(delivery_unknown_mode_from_state \
  "${INITIAL_API_ACTIVE_STATE}" api)"
DELIVERY_UNKNOWN_RECEIPT_MODE="$(delivery_unknown_mode_from_state \
  "${INITIAL_WORKER_ACTIVE_STATE}" worker)"
if [[ "${API_DELIVERY_UNKNOWN_WRITE_MODE}" != "disabled" ]]; then
  echo "ERROR: API DELIVERY_UNKNOWN write mode is not disabled" >&2
  exit 1
fi

verify_signed_rollback_baseline_contract() {
  local freshness_mode="${1:-fresh}"
  if [[ "${freshness_mode}" == "same-attempt-rollback" ]]; then
    WORKFORCE_RELEASE_SAME_ATTEMPT_ROLLBACK=true \
      run_snapshot_helper "scripts/verify-migration-release-receipt.sh" \
        "${MIGRATION_RECEIPT}" \
        "${MIGRATION_SIGNATURE}" \
        "${MIGRATION_ALLOWED_SIGNERS}" \
        "${COMMIT}" \
        "${PREVIOUS_API_IMAGE}" \
        "${PREVIOUS_API_REVISION}" \
        "${PREVIOUS_WORKER_IMAGE}" \
        "${PREVIOUS_WORKER_REVISION}" \
        "${PREVIOUS_CONSOLE_IMAGE}" \
        "${PREVIOUS_CONSOLE_REVISION}" \
        "${DELIVERY_UNKNOWN_RECEIPT_MODE}" || return 1
    # A bare return here is not portable while this function runs from the ERR
    # trap: Linux Bash can preserve the triggering rollout failure status even
    # after the verifier succeeds. Make the successful verification explicit.
    return 0
  fi
  if [[ "${freshness_mode}" != "fresh" ]]; then
    echo "ERROR: unknown signed rollback baseline freshness mode" >&2
    return 1
  fi
  run_snapshot_helper "scripts/verify-migration-release-receipt.sh" \
    "${MIGRATION_RECEIPT}" \
    "${MIGRATION_SIGNATURE}" \
    "${MIGRATION_ALLOWED_SIGNERS}" \
    "${COMMIT}" \
    "${PREVIOUS_API_IMAGE}" \
    "${PREVIOUS_API_REVISION}" \
    "${PREVIOUS_WORKER_IMAGE}" \
    "${PREVIOUS_WORKER_REVISION}" \
    "${PREVIOUS_CONSOLE_IMAGE}" \
    "${PREVIOUS_CONSOLE_REVISION}" \
    "${DELIVERY_UNKNOWN_RECEIPT_MODE}"
}
verify_signed_rollback_baseline_contract

# Full-SHA traceability tag. Tags remain mutable registry aliases, so the
# deployment identity is resolved to a content digest after the build.
TAG="${COMMIT}"
TAGGED_IMAGE="${REGISTRY}.azurecr.io/${ACR_REPO}:${TAG}"

echo "Branch : ${BRANCH}"
echo "Commit : ${COMMIT}"
echo "Build tag: ${TAGGED_IMAGE}"
echo "Apps   : ${API_APP} + ${WORKER_APP} (rg ${RESOURCE_GROUP})"
echo "Current API image   : ${PREVIOUS_API_IMAGE}"
echo "Current worker image: ${PREVIOUS_WORKER_IMAGE}"
echo "Current console image: ${PREVIOUS_CONSOLE_IMAGE}"
echo "Rollback API revision   : ${PREVIOUS_API_REVISION}"
echo "Rollback worker revision: ${PREVIOUS_WORKER_REVISION}"
echo "Rollback console revision: ${PREVIOUS_CONSOLE_REVISION}"
echo "DELIVERY_UNKNOWN writes : ${DELIVERY_UNKNOWN_RECEIPT_MODE}"
echo

# --- Build once from the immutable tracked commit ---------------------------
# BUILD_CONTEXT is the private exact-commit snapshot that also runs this
# controller and every release helper. Runtime state lives in a separate
# private directory so no generated file can enter the ACR context.

# Tag with both the immutable build-run ID and the source SHA. The digest is
# read from the completed ACR run record, not by querying a mutable tag.
RUN_ID="$(az acr build \
  --registry "${REGISTRY}" \
  --image "${ACR_REPO}:{{.Run.ID}}" \
  --image "${ACR_REPO}:${TAG}" \
  --build-arg "VCS_REF=${COMMIT}" \
  --file "${DOCKERFILE}" \
  --platform linux/amd64 \
  --no-logs \
  --query runId \
  --output tsv \
  "${BUILD_CONTEXT}")"
if [[ ! "${RUN_ID}" =~ ^[a-z0-9]+$ ]]; then
  echo "ERROR: ACR returned an invalid build run ID: ${RUN_ID:-<empty>}" >&2
  exit 1
fi

RUN_STATUS="$(az acr task show-run \
  --registry "${REGISTRY}" \
  --run-id "${RUN_ID}" \
  --query status \
  --output tsv)"
if [[ "${RUN_STATUS}" != "Succeeded" ]]; then
  echo "ERROR: ACR build ${RUN_ID} status is ${RUN_STATUS:-<empty>}" >&2
  exit 1
fi

# Resolve from the completed run's outputImages. A tag lookup here would allow
# a retargeting race between build completion and resolution.
DIGEST="$(az acr task show-run \
  --registry "${REGISTRY}" \
  --run-id "${RUN_ID}" \
  --query "outputImages[?repository=='${ACR_REPO}' && tag=='${RUN_ID}'].digest | [0]" \
  --output tsv)"
if [[ ! "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: ACR run ${RUN_ID} returned an invalid manifest digest: ${DIGEST:-<empty>}" >&2
  exit 1
fi
COMMIT_TAG_DIGEST="$(az acr task show-run \
  --registry "${REGISTRY}" \
  --run-id "${RUN_ID}" \
  --query "outputImages[?repository=='${ACR_REPO}' && tag=='${TAG}'].digest | [0]" \
  --output tsv)"
if [[ "${COMMIT_TAG_DIGEST}" != "${DIGEST}" ]]; then
  echo "ERROR: ACR run ${RUN_ID} did not bind run and commit tags to one digest" >&2
  exit 1
fi
IMAGE="${REGISTRY}.azurecr.io/${ACR_REPO}@${DIGEST}"
echo "ACR run: ${RUN_ID}"
echo "Resolved run output: ${IMAGE}"

# Pull by immutable digest and verify the actual registry object before any
# Container App is changed. The OCI revision label binds it back to COMMIT.
run_snapshot_helper "scripts/verify-registry-api-image.sh" "${IMAGE}" "${COMMIT}"

# The registry build and pull can take long enough for a separate operator to
# change production after the initial snapshot. Re-read both deployment
# identities and their configuration immediately before the first mutation;
# never roll back over a release that appeared while this process was building.
CURRENT_REMOTE_COMMIT="$(release_gh_command api \
  --hostname github.com \
  "repos/${RELEASE_REPOSITORY}/git/ref/heads/${BRANCH}" \
  --jq '.object.sha')"
if [[ "${CURRENT_REMOTE_COMMIT}" != "${COMMIT}" ]]; then
  echo "ERROR: GitHub ${BRANCH} advanced while the artifact was building; refusing to deploy stale source" >&2
  exit 1
fi
PREFLIGHT_API_STATE="${RUNTIME_STATE_DIR}/preflight-api.json"
PREFLIGHT_WORKER_STATE="${RUNTIME_STATE_DIR}/preflight-worker.json"
PREFLIGHT_CONSOLE_STATE="${RUNTIME_STATE_DIR}/preflight-console.json"
capture_containerapp_state "${API_APP}" "${PREFLIGHT_API_STATE}"
capture_containerapp_state "${WORKER_APP}" "${PREFLIGHT_WORKER_STATE}"
capture_containerapp_state "${CONSOLE_APP}" "${PREFLIGHT_CONSOLE_STATE}"
CURRENT_API_IMAGE="$(containerapp_state_value \
  "${PREFLIGHT_API_STATE}" '.properties.template.containers[0].image')"
CURRENT_WORKER_IMAGE="$(containerapp_state_value \
  "${PREFLIGHT_WORKER_STATE}" '.properties.template.containers[0].image')"
CURRENT_CONSOLE_IMAGE="$(containerapp_state_value \
  "${PREFLIGHT_CONSOLE_STATE}" '.properties.template.containers[0].image')"
CURRENT_API_REVISION="$(containerapp_state_value \
  "${PREFLIGHT_API_STATE}" '.properties.latestReadyRevisionName // ""')"
CURRENT_WORKER_REVISION="$(containerapp_state_value \
  "${PREFLIGHT_WORKER_STATE}" '.properties.latestReadyRevisionName // ""')"
CURRENT_CONSOLE_REVISION="$(containerapp_state_value \
  "${PREFLIGHT_CONSOLE_STATE}" '.properties.latestReadyRevisionName // ""')"
if [[ "${CURRENT_API_IMAGE}" != "${PREVIOUS_API_IMAGE}" ||
  "${CURRENT_WORKER_IMAGE}" != "${PREVIOUS_WORKER_IMAGE}" ||
  "${CURRENT_CONSOLE_IMAGE}" != "${PREVIOUS_CONSOLE_IMAGE}" ||
  "${CURRENT_API_REVISION}" != "${PREVIOUS_API_REVISION}" ||
  "${CURRENT_WORKER_REVISION}" != "${PREVIOUS_WORKER_REVISION}" ||
  "${CURRENT_CONSOLE_REVISION}" != "${PREVIOUS_CONSOLE_REVISION}" ]]; then
  echo "ERROR: production API/worker/console rollback baselines changed while the artifact was building" >&2
  exit 1
fi
assert_live_rollout_state \
  preflight \
  "${PREVIOUS_API_IMAGE}" "${PREVIOUS_API_REVISION}" \
  "${PREVIOUS_WORKER_IMAGE}" "${PREVIOUS_WORKER_REVISION}" \
  "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
  "${DELIVERY_UNKNOWN_RECEIPT_MODE}"
run_snapshot_helper "scripts/verify-containerapp-release-config.sh" \
  "${PREVIOUS_API_IMAGE}" \
  "${PREVIOUS_WORKER_IMAGE}"
verify_signed_rollback_baseline_contract

# --- Roll BOTH apps to the same digest --------------------------------------
WORKER_UPDATE_ATTEMPTED="false"
API_UPDATE_ATTEMPTED="false"
rollback_partial_rollout() {
  local rollout_status=$1
  local rollback_failed="false"
  local rollback_api_state="${RUNTIME_STATE_DIR}/rollback-api-current.json"
  local rollback_worker_state="${RUNTIME_STATE_DIR}/rollback-worker-current.json"
  local rollback_console_state="${RUNTIME_STATE_DIR}/rollback-console-current.json"
  local current_api_image current_api_revision current_worker_image current_worker_revision
  local current_console_image current_console_revision current_api_mode current_worker_mode
  trap - ERR
  trap '' HUP INT TERM
  set +e
  echo "ERROR: rollout did not complete; reactivating the exact signed baseline revisions." >&2
  if ! verify_signed_rollback_baseline_contract same-attempt-rollback; then
    echo "ERROR: signed rollback baseline verification failed; no compensating write was attempted." >&2
    echo "Previous API image/revision   : ${PREVIOUS_API_IMAGE} / ${PREVIOUS_API_REVISION}" >&2
    echo "Previous worker image/revision: ${PREVIOUS_WORKER_IMAGE} / ${PREVIOUS_WORKER_REVISION}" >&2
    exit "${rollout_status}"
  fi
  capture_active_revision_state "${API_APP}" "${rollback_api_state}" || rollback_failed="true"
  capture_active_revision_state "${WORKER_APP}" "${rollback_worker_state}" || rollback_failed="true"
  capture_active_revision_state "${CONSOLE_APP}" "${rollback_console_state}" || rollback_failed="true"
  if [[ "${rollback_failed}" != "true" ]]; then
    current_api_image="$(containerapp_state_value "${rollback_api_state}" '.properties.template.containers[0].image')" || rollback_failed="true"
    current_api_revision="$(containerapp_state_value "${rollback_api_state}" '.name')" || rollback_failed="true"
    current_worker_image="$(containerapp_state_value "${rollback_worker_state}" '.properties.template.containers[0].image')" || rollback_failed="true"
    current_worker_revision="$(containerapp_state_value "${rollback_worker_state}" '.name')" || rollback_failed="true"
    current_console_image="$(containerapp_state_value "${rollback_console_state}" '.properties.template.containers[0].image')" || rollback_failed="true"
    current_console_revision="$(containerapp_state_value "${rollback_console_state}" '.name')" || rollback_failed="true"
    current_api_mode="$(delivery_unknown_mode_from_state "${rollback_api_state}" api)" || rollback_failed="true"
    current_worker_mode="$(delivery_unknown_mode_from_state "${rollback_worker_state}" worker)" || rollback_failed="true"
  fi
  if [[ "${rollback_failed}" != "true" ]] &&
    { [[ "${current_console_image}" != "${PREVIOUS_CONSOLE_IMAGE}" ]] ||
      [[ "${current_console_revision}" != "${PREVIOUS_CONSOLE_REVISION}" ]] ||
      [[ "${current_api_mode}" != "disabled" ]] ||
      [[ "${current_worker_mode}" != "${DELIVERY_UNKNOWN_RECEIPT_MODE}" ]] ||
      { [[ "${current_api_revision}" != "${PREVIOUS_API_REVISION}" ]] && [[ "${current_api_image}" != "${IMAGE}" ]]; } ||
      { [[ "${current_worker_revision}" != "${PREVIOUS_WORKER_REVISION}" ]] && [[ "${current_worker_image}" != "${IMAGE}" ]]; }; }; then
    echo "ERROR: active production identity changed outside this rollout; refusing compensating mutation" >&2
    rollback_failed="true"
  fi
  if [[ "${rollback_failed}" != "true" && "${WORKER_UPDATE_ATTEMPTED}" == "true" &&
    "${current_worker_revision}" != "${PREVIOUS_WORKER_REVISION}" ]]; then
    activate_containerapp_revision \
      "${WORKER_APP}" "${PREVIOUS_WORKER_REVISION}" "${PREVIOUS_WORKER_IMAGE}" \
      rollback-worker-before-activate \
      "${current_api_image}" "${current_api_revision}" \
      "${current_worker_image}" "${current_worker_revision}" \
      "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
      "${DELIVERY_UNKNOWN_RECEIPT_MODE}" \
      "${RUNTIME_STATE_DIR}/rollback-worker-result.json" \
      worker || rollback_failed="true"
    if [[ "${rollback_failed}" != "true" ]]; then
      current_worker_image="${PREVIOUS_WORKER_IMAGE}"
      current_worker_revision="${PREVIOUS_WORKER_REVISION}"
    fi
  fi
  if [[ "${rollback_failed}" != "true" && "${API_UPDATE_ATTEMPTED}" == "true" &&
    "${current_api_revision}" != "${PREVIOUS_API_REVISION}" ]]; then
    activate_containerapp_revision \
      "${API_APP}" "${PREVIOUS_API_REVISION}" "${PREVIOUS_API_IMAGE}" \
      rollback-api-before-activate \
      "${current_api_image}" "${current_api_revision}" \
      "${current_worker_image}" "${current_worker_revision}" \
      "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
      "${DELIVERY_UNKNOWN_RECEIPT_MODE}" \
      "${RUNTIME_STATE_DIR}/rollback-api-result.json" \
      api || rollback_failed="true"
    if [[ "${rollback_failed}" != "true" ]]; then
      current_api_image="${PREVIOUS_API_IMAGE}"
      current_api_revision="${PREVIOUS_API_REVISION}"
    fi
  fi
  if [[ "${rollback_failed}" != "true" && "${API_UPDATE_ATTEMPTED}" == "true" ]]; then
    set_api_traffic_to_exact_revision \
      "${PREVIOUS_API_REVISION}" \
      "${current_api_image}" "${current_api_revision}" \
      "${current_worker_image}" "${current_worker_revision}" \
      "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
      "${DELIVERY_UNKNOWN_RECEIPT_MODE}" \
      "${RUNTIME_STATE_DIR}/rollback-api-traffic.json" || rollback_failed="true"
  fi
  if [[ "${rollback_failed}" != "true" ]]; then
    assert_live_rollout_state \
      rollback-final \
      "${PREVIOUS_API_IMAGE}" "${PREVIOUS_API_REVISION}" \
      "${PREVIOUS_WORKER_IMAGE}" "${PREVIOUS_WORKER_REVISION}" \
      "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
      "${DELIVERY_UNKNOWN_RECEIPT_MODE}" || rollback_failed="true"
    verify_api_traffic_on_active_revision \
      "${PREVIOUS_API_REVISION}" \
      "${RUNTIME_STATE_DIR}/rollback-api-traffic-final.json" || rollback_failed="true"
  fi
  if [[ "${rollback_failed}" == "true" ]]; then
    echo "ERROR: automatic rollback verification failed; operator intervention is required." >&2
    echo "Previous API image   : ${PREVIOUS_API_IMAGE}" >&2
    echo "Previous worker image: ${PREVIOUS_WORKER_IMAGE}" >&2
    echo "Rejected image       : ${IMAGE}" >&2
  else
    echo "Rollback verified on both apps; retaining the lease for post-failure investigation." >&2
  fi
  exit "${rollout_status}"
}
rollback_on_error() {
  local rollout_status=$?
  rollback_partial_rollout "${rollout_status}"
}
rollback_on_signal() {
  local signal_status=$1
  rollback_partial_rollout "${signal_status}"
}
trap rollback_on_error ERR
trap 'rollback_on_signal 129' HUP
trap 'rollback_on_signal 130' INT
trap 'rollback_on_signal 143' TERM

# Readers first: the compatible API must be fully active before a new worker
# can persist newly appended enum values such as FAILED. Rollback reverses this
# order so the writer is disabled before an older reader is restored.
RELEASE_LOCK_SAFE_TO_RELEASE="false"
echo "Rolling ${API_APP} -> ${IMAGE}"
API_RESULT_STATE="${RUNTIME_STATE_DIR}/api-result.json"
update_containerapp_image \
  "${API_APP}" "${IMAGE}" forward-api-before-update \
  "${PREVIOUS_API_IMAGE}" "${PREVIOUS_API_REVISION}" \
  "${PREVIOUS_WORKER_IMAGE}" "${PREVIOUS_WORKER_REVISION}" \
  "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
  "${DELIVERY_UNKNOWN_RECEIPT_MODE}" "${API_RESULT_STATE}"
NEW_API_REVISION="$(containerapp_state_value "${API_RESULT_STATE}" '.properties.latestReadyRevisionName // ""')"
if [[ ! "${NEW_API_REVISION}" =~ ^${API_APP}--[a-z0-9][a-z0-9-]*$ ||
  "${NEW_API_REVISION}" == "${PREVIOUS_API_REVISION}" ]]; then
  echo "ERROR: API rollout did not create a distinct canonical revision" >&2
  false
fi
verify_retained_revision \
  "${API_APP}" "${PREVIOUS_API_REVISION}" "${PREVIOUS_API_IMAGE}" \
  "${RUNTIME_STATE_DIR}/post-api-retained-baseline.json"
run_snapshot_helper "scripts/verify-containerapp-release-config.sh" \
  "${IMAGE}" \
  "${PREVIOUS_WORKER_IMAGE}"
echo "API reader is healthy on ${DIGEST}"

echo "Rolling ${WORKER_APP} -> ${IMAGE}"
WORKER_RESULT_STATE="${RUNTIME_STATE_DIR}/worker-result.json"
update_containerapp_image \
  "${WORKER_APP}" "${IMAGE}" forward-worker-before-update \
  "${IMAGE}" "${NEW_API_REVISION}" \
  "${PREVIOUS_WORKER_IMAGE}" "${PREVIOUS_WORKER_REVISION}" \
  "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
  "${DELIVERY_UNKNOWN_RECEIPT_MODE}" "${WORKER_RESULT_STATE}"
NEW_WORKER_REVISION="$(containerapp_state_value "${WORKER_RESULT_STATE}" '.properties.latestReadyRevisionName // ""')"
if [[ ! "${NEW_WORKER_REVISION}" =~ ^${WORKER_APP}--[a-z0-9][a-z0-9-]*$ ||
  "${NEW_WORKER_REVISION}" == "${PREVIOUS_WORKER_REVISION}" ]]; then
  echo "ERROR: worker rollout did not create a distinct canonical revision" >&2
  false
fi
verify_retained_revision \
  "${API_APP}" "${PREVIOUS_API_REVISION}" "${PREVIOUS_API_IMAGE}" \
  "${RUNTIME_STATE_DIR}/post-worker-api-retained-baseline.json"
verify_retained_revision \
  "${WORKER_APP}" "${PREVIOUS_WORKER_REVISION}" "${PREVIOUS_WORKER_IMAGE}" \
  "${RUNTIME_STATE_DIR}/post-worker-retained-baseline.json"
run_snapshot_helper "scripts/verify-containerapp-release-config.sh" "${IMAGE}" "${IMAGE}"
assert_live_rollout_state \
  forward-final \
  "${IMAGE}" "${NEW_API_REVISION}" \
  "${IMAGE}" "${NEW_WORKER_REVISION}" \
  "${PREVIOUS_CONSOLE_IMAGE}" "${PREVIOUS_CONSOLE_REVISION}" \
  "${DELIVERY_UNKNOWN_RECEIPT_MODE}"
verify_retained_revision \
  "${API_APP}" "${PREVIOUS_API_REVISION}" "${PREVIOUS_API_IMAGE}" \
  "${RUNTIME_STATE_DIR}/final-api-retained-baseline.json"
verify_retained_revision \
  "${WORKER_APP}" "${PREVIOUS_WORKER_REVISION}" "${PREVIOUS_WORKER_IMAGE}" \
  "${RUNTIME_STATE_DIR}/final-worker-retained-baseline.json"
echo "API and worker are healthy on ${DIGEST}"

trap - ERR HUP INT TERM
RELEASE_LOCK_SAFE_TO_RELEASE="true"

cat <<EOF

Deployed and read back ${IMAGE} on ${API_APP} and ${WORKER_APP}.

Post-deploy verify:
  1. Confirm both apps run the new image on their active revision:
       az containerapp revision list -n ${API_APP} -g ${RESOURCE_GROUP} \\
         --query "[?properties.active].{rev:name,image:properties.template.containers[0].image}" -o table
       az containerapp revision list -n ${WORKER_APP} -g ${RESOURCE_GROUP} \\
         --query "[?properties.active].{rev:name,image:properties.template.containers[0].image}" -o table
  2. Tail logs for boot errors (the env validator fails fast on misconfig):
       az containerapp logs show -n ${API_APP} -g ${RESOURCE_GROUP} --tail 50
       az containerapp logs show -n ${WORKER_APP} -g ${RESOURCE_GROUP} --tail 50
  3. Hit the API health endpoint, run a tenant-zero smoke
     (approve -> queue -> worker), then check LangSmith for fresh traces.
EOF

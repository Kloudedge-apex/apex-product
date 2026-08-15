#!/usr/bin/env bash

# Run release-boundary Git commands without inheriting caller-controlled Git
# configuration, object stores, namespaces, hooks, transport executables, or
# interactive credential fallbacks. Callers still supply explicit -c options
# such as the approved gh credential helper and the exact repository URL.

set -euo pipefail

exec /usr/bin/env \
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

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
LISTS_DIR="${SCRIPT_DIR}/lists"

# Prefer native shell service script. If only .bat exists, env filters may stay empty.
if [[ -f "${SCRIPT_DIR}/service.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/service.sh" status_zapret
  source "${SCRIPT_DIR}/service.sh" check_updates
  source "${SCRIPT_DIR}/service.sh" load_game_filter
  source "${SCRIPT_DIR}/service.sh" load_user_lists
elif [[ -f "${SCRIPT_DIR}/service.bat" ]]; then
  echo "WARN: found service.bat only. GameFilterTCP/GameFilterUDP may be empty in Linux."
fi

GameFilterTCP="${GameFilterTCP:-}"
GameFilterUDP="${GameFilterUDP:-}"

WF_TCP="80,443,2053,2083,2087,2096,8443"
WF_UDP="443,19294-19344,50000-50100"
if [[ -n "${GameFilterTCP}" ]]; then
  WF_TCP="${WF_TCP},${GameFilterTCP}"
fi
if [[ -n "${GameFilterUDP}" ]]; then
  WF_UDP="${WF_UDP},${GameFilterUDP}"
fi

# Ensure optional user files exist (some presets reference them).
touch "${LISTS_DIR}/list-general-user.txt" \
      "${LISTS_DIR}/list-exclude-user.txt" \
      "${LISTS_DIR}/ipset-exclude-user.txt"

GAME_FILTER_TCP_ARGS=()
GAME_FILTER_UDP_ARGS=()
if [[ -n "${GameFilterTCP}" ]]; then
  GAME_FILTER_TCP_ARGS=(
    --new
    --filter-tcp="${GameFilterTCP}" --ipset="${LISTS_DIR}/ipset-all.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude-user.txt" --dpi-desync=fake,fakedsplit --dpi-desync-repeats=6 --dpi-desync-any-protocol=1 --dpi-desync-cutoff=n4 --dpi-desync-fooling=ts --dpi-desync-fakedsplit-pattern=0x00 --dpi-desync-fake-tls="${BIN_DIR}/stun.bin" --dpi-desync-fake-tls="${BIN_DIR}/tls_clienthello_www_google_com.bin" --dpi-desync-fake-http="${BIN_DIR}/tls_clienthello_max_ru.bin"
  )
fi
if [[ -n "${GameFilterUDP}" ]]; then
  GAME_FILTER_UDP_ARGS=(
    --new
    --filter-udp="${GameFilterUDP}" --ipset="${LISTS_DIR}/ipset-all.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude-user.txt" --dpi-desync=fake --dpi-desync-repeats=12 --dpi-desync-any-protocol=1 --dpi-desync-fake-unknown-udp="${BIN_DIR}/quic_initial_dbankcloud_ru.bin" --dpi-desync-cutoff=n3
  )
fi

cd "${BIN_DIR}"

if [[ -x "${BIN_DIR}/winws" ]]; then
  RUNNER=("${BIN_DIR}/winws")
elif [[ -f "${BIN_DIR}/winws.exe" ]] && command -v wine >/dev/null 2>&1; then
  RUNNER=(wine "${BIN_DIR}/winws.exe")
else
  echo "ERROR: winws binary not found. Need ${BIN_DIR}/winws or wine + ${BIN_DIR}/winws.exe"
  exit 1
fi

"${RUNNER[@]}" \
  --wf-tcp="${WF_TCP}" --wf-udp="${WF_UDP}" \
  --filter-udp=443 --hostlist="${LISTS_DIR}/list-general.txt" --hostlist="${LISTS_DIR}/list-general-user.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude-user.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude-user.txt" --dpi-desync=fake --dpi-desync-repeats=6 --dpi-desync-fake-quic="${BIN_DIR}/quic_initial_www_google_com.bin" --new \
  --filter-udp=19294-19344,50000-50100 --filter-l7=discord,stun --dpi-desync=fake --dpi-desync-fake-discord="${BIN_DIR}/quic_initial_dbankcloud_ru.bin" --dpi-desync-fake-stun="${BIN_DIR}/quic_initial_dbankcloud_ru.bin" --dpi-desync-repeats=6 --new \
  --filter-tcp=2053,2083,2087,2096,8443 --hostlist-domains=discord.media --dpi-desync=fake,fakedsplit --dpi-desync-repeats=6 --dpi-desync-fooling=ts --dpi-desync-fakedsplit-pattern=0x00 --dpi-desync-fake-tls="${BIN_DIR}/tls_clienthello_www_google_com.bin" --new \
  --filter-tcp=443 --hostlist="${LISTS_DIR}/list-google.txt" --ip-id=zero --dpi-desync=fake,fakedsplit --dpi-desync-repeats=6 --dpi-desync-fooling=ts --dpi-desync-fakedsplit-pattern=0x00 --dpi-desync-fake-tls="${BIN_DIR}/tls_clienthello_www_google_com.bin" --new \
  --filter-tcp=80,443 --hostlist="${LISTS_DIR}/list-general.txt" --hostlist="${LISTS_DIR}/list-general-user.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude-user.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude-user.txt" --dpi-desync=fake,fakedsplit --dpi-desync-repeats=6 --dpi-desync-fooling=ts --dpi-desync-fakedsplit-pattern=0x00 --dpi-desync-fake-tls="${BIN_DIR}/stun.bin" --dpi-desync-fake-tls="${BIN_DIR}/tls_clienthello_www_google_com.bin" --dpi-desync-fake-http="${BIN_DIR}/tls_clienthello_max_ru.bin" --new \
  --filter-udp=443 --ipset="${LISTS_DIR}/ipset-all.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude-user.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude-user.txt" --dpi-desync=fake --dpi-desync-repeats=6 --dpi-desync-fake-quic="${BIN_DIR}/quic_initial_www_google_com.bin" --new \
  --filter-tcp=80,443,8443 --ipset="${LISTS_DIR}/ipset-all.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude.txt" --hostlist-exclude="${LISTS_DIR}/list-exclude-user.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude.txt" --ipset-exclude="${LISTS_DIR}/ipset-exclude-user.txt" --dpi-desync=fake,fakedsplit --dpi-desync-repeats=6 --dpi-desync-fooling=ts --dpi-desync-fakedsplit-pattern=0x00 --dpi-desync-fake-tls="${BIN_DIR}/stun.bin" --dpi-desync-fake-tls="${BIN_DIR}/tls_clienthello_www_google_com.bin" --dpi-desync-fake-http="${BIN_DIR}/tls_clienthello_max_ru.bin" \
  "${GAME_FILTER_TCP_ARGS[@]}" \
  "${GAME_FILTER_UDP_ARGS[@]}"

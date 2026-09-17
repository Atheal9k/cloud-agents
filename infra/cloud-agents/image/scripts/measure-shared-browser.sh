#!/bin/bash
set -euo pipefail

duration_seconds="${SHARED_BROWSER_MEASURE_SECONDS:-60}"
[[ "${duration_seconds}" =~ ^[1-9][0-9]*$ ]] || {
  echo "SHARED_BROWSER_MEASURE_SECONDS must be a positive integer" >&2
  exit 2
}
(( duration_seconds <= 600 )) || {
  echo "SHARED_BROWSER_MEASURE_SECONDS must not exceed 600" >&2
  exit 2
}
(( $# > 0 )) || {
  echo "usage: measure-shared-browser.sh <build command> [args...]" >&2
  exit 2
}

interface="$(ip route show default | awk 'NR == 1 { print $5 }')"
read -r rx_before tx_before < <(awk -v iface="${interface}:" '$1 == iface { gsub(":", "", $1); print $2, $10 }' /proc/net/dev)
start_ms="$(date +%s%3N)"

"$@" &
build_pid=$!
samples=0
cpu_sum=0
rss_peak_kib=0
while kill -0 "${build_pid}" 2>/dev/null && (( $(date +%s%3N) - start_ms < duration_seconds * 1000 )); do
  read -r cpu rss < <({ ps -C dcvserver,Xdcv,chromium -o %cpu=,rss= 2>/dev/null || true; } | \
    awk '{ cpu += $1; rss += $2 } END { printf "%.2f %d\n", cpu, rss }')
  cpu_sum="$(awk -v total="${cpu_sum}" -v current="${cpu}" 'BEGIN { printf "%.2f", total + current }')"
  (( rss > rss_peak_kib )) && rss_peak_kib="${rss}"
  samples=$((samples + 1))
  sleep 1
done
if wait "${build_pid}"; then
  build_exit_code=0
else
  build_exit_code=$?
fi

read -r rx_after tx_after < <(awk -v iface="${interface}:" '$1 == iface { gsub(":", "", $1); print $2, $10 }' /proc/net/dev)
end_ms="$(date +%s%3N)"
viewer_latency_ms="$(curl --silent --output /dev/null --write-out '%{time_starttransfer}' \
  --max-time 5 http://127.0.0.1:8090/ | awk '{ printf "%.0f", $1 * 1000 }')"
average_cpu="$(awk -v total="${cpu_sum}" -v count="${samples}" \
  'BEGIN { printf "%.2f", count == 0 ? 0 : total / count }')"

jq --null-input \
  --argjson buildExitCode "${build_exit_code}" \
  --argjson durationMs "$((end_ms - start_ms))" \
  --argjson averageStreamCpuPercent "${average_cpu}" \
  --argjson peakStreamRssKiB "${rss_peak_kib}" \
  --argjson viewerFirstByteMs "${viewer_latency_ms}" \
  --argjson receivedBytes "$((rx_after - rx_before))" \
  --argjson transmittedBytes "$((tx_after - tx_before))" \
  '{
    buildExitCode: $buildExitCode,
    durationMs: $durationMs,
    averageStreamCpuPercent: $averageStreamCpuPercent,
    peakStreamRssKiB: $peakStreamRssKiB,
    viewerFirstByteMs: $viewerFirstByteMs,
    receivedBytes: $receivedBytes,
    transmittedBytes: $transmittedBytes
  }'

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${ROOT_DIR}/agent_state"
QTABLE_FILE="${QTABLE_FILE:-${ROOT_DIR}/trained_q_tables/trained_q_tables_5000000_high_default.json}"
BASE_PORT="${BASE_PORT:-8101}"
CAPITAL="${CAPITAL:-5000000}"

mkdir -p "${STATE_DIR}"

declare -a FINANCIERS=(
  "User1"
  "User2"
  "User3"
)

for idx in "${!FINANCIERS[@]}"; do
  financier_id="${FINANCIERS[$idx]}"
  port=$((BASE_PORT + idx))
  state_file="${STATE_DIR}/${financier_id}.json"

  echo "Starting RL+RL agent for ${financier_id} on port ${port}"
  nohup python3 "${ROOT_DIR}/rl_financier_service.py" \
    --financier-id "${financier_id}" \
    --port "${port}" \
    --capital "${CAPITAL}" \
    --wallet "${CAPITAL}" \
    --state-file "${state_file}" \
    --q-table-file "${QTABLE_FILE}" \
    --model-version "live-rl-rl-agent-v1" \
    --min-offer-apr 6 \
    --max-offer-apr 48 \
    > "${STATE_DIR}/${financier_id}.log" 2>&1 &
done

echo "Started ${#FINANCIERS[@]} financier agents."
echo "Example FINANCIER_RL_AGENTS value:"
printf '[\n'
for idx in "${!FINANCIERS[@]}"; do
  financier_id="${FINANCIERS[$idx]}"
  port=$((BASE_PORT + idx))
  comma=","
  if [[ "$idx" -eq $((${#FINANCIERS[@]} - 1)) ]]; then
    comma=""
  fi
  printf '  {"financierId":"%s","userId":"%s","agentUrl":"http://127.0.0.1:%s/quote"}%s\n' "${financier_id}" "${financier_id}" "${port}" "${comma}"
done
printf ']\n'

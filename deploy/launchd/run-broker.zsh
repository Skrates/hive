#!/bin/zsh
set -euo pipefail
umask 077

export HIVE_BROKER_DB="${HOME}/Library/Application Support/Hive/broker.sqlite"
export HIVE_BROKER_HOST="127.0.0.1"
export HIVE_BROKER_PORT="8790"
export HIVE_ADMIN_TOKEN="$(security find-generic-password -a hive -s is.sokrates.hive.admin -w)"
export HIVE_SLACK_APP_TOKEN="$(security find-generic-password -a hive -s is.sokrates.hive.slack-app -w)"
export HIVE_SLACK_BOT_TOKEN="$(security find-generic-password -a hive -s is.sokrates.hive.slack-bot -w)"
export HIVE_SLACK_WORKSPACE_ID="T0ANP1RUACU"
export HIVE_ADMISSION_POLICY='{"workspaceIds":["T0ANP1RUACU"],"channelIds":["C0BGBEQQQHH"],"userIds":["U0AQM4YL9HS","U0AND2JSHV1"],"appIds":["A0BG2QQ8WA3"],"routerMentionIds":["U0BGBUGGJ1H"]}'

exec "${HOME}/.local/bin/node" "${HOME}/.local/lib/hive/dist/cli.js" broker

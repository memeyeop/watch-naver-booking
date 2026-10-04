#!/bin/bash
# launchd 진입점: .env 로드 후 watch.py 실행
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
if [ -z "$SLACK_WEBHOOK_URL" ]; then
  echo "[$(date '+%F %T')] SLACK_WEBHOOK_URL 미설정 - 건너뜀" >&2
  exit 0
fi
exec /usr/bin/python3 watch.py

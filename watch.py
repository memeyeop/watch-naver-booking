#!/usr/bin/env python3
"""네이버 예약 디자이너 빈자리 감시 → Slack 알림.

빈자리 = isUnitBusinessDay and isUnitSaleDay and unitBookingCount < unitStock
직전 실행에서 못 본 빈자리가 생겼을 때만 알린다(state 파일로 중복 방지).

환경변수:
  SLACK_WEBHOOK_URL  Slack Incoming Webhook URL (없으면 stdout 출력만)
  WATCH_DAYS         오늘부터 며칠까지 볼지 (기본 60)
  WATCH_END          감시 마지막 날짜 YYYY-MM-DD (설정 시 WATCH_DAYS보다 우선해 범위를 자름)
"""
import datetime as dt
import json
import os
import sys
import urllib.request
from pathlib import Path

BUSINESS_ID = "648081"  # 헤어베이커
DESIGNERS = {"4347340": "현지"}  # bizItemId: 이름 (유나=4328420)
BOOKING_URL = "https://m.booking.naver.com/booking/13/bizes/{biz}/items/{item}"
GRAPHQL_URL = "https://m.booking.naver.com/graphql?opName=hourlySchedule"
QUERY = """query hourlySchedule($scheduleParams: ScheduleParams) {
  schedule(input: $scheduleParams) { bizItemSchedule { hourly {
    unitStartTime unitStock unitBookingCount isUnitBusinessDay isUnitSaleDay
  } } } }"""
STATE_FILE = Path(__file__).with_name("state.json")


def fetch_free_slots(item_id: str, start: dt.date, end: dt.date) -> list[str]:
    body = json.dumps({
        "operationName": "hourlySchedule",
        "query": QUERY,
        "variables": {"scheduleParams": {
            "businessTypeId": 13,
            "businessId": BUSINESS_ID,
            "bizItemId": item_id,
            "startDateTime": f"{start}T00:00:00",
            "endDateTime": f"{end}T23:59:59",
            "fixedTime": True,
            "includesHolidaySchedules": True,
        }},
    }).encode()
    req = urllib.request.Request(GRAPHQL_URL, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Referer": BOOKING_URL.format(biz=BUSINESS_ID, item=item_id),
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    if "errors" in data:
        raise RuntimeError(f"GraphQL error: {data['errors']}")
    hourly = data["data"]["schedule"]["bizItemSchedule"]["hourly"]
    return sorted(
        s["unitStartTime"][:16]  # "YYYY-MM-DD HH:MM"
        for s in hourly
        if s["isUnitBusinessDay"] and s["isUnitSaleDay"]
        and s["unitBookingCount"] < s["unitStock"]
    )


def format_message(name: str, item_id: str, slots: list[str]) -> str:
    by_day: dict[str, list[str]] = {}
    for s in slots:
        by_day.setdefault(s[:10], []).append(s[11:])
    lines = [f":scissors: *{name}* 디자이너 빈자리 {len(slots)}칸이 새로 열렸습니다"]
    for day, times in by_day.items():
        wd = "월화수목금토일"[dt.date.fromisoformat(day).weekday()]
        lines.append(f"• {day}({wd}) {', '.join(times)}")
    lines.append(f"<{BOOKING_URL.format(biz=BUSINESS_ID, item=item_id)}|예약하러 가기>")
    return "\n".join(lines)


def notify(text: str) -> None:
    webhook = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook:
        print(text)
        return
    req = urllib.request.Request(webhook, data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()


def main() -> int:
    today = dt.date.today()
    end = today + dt.timedelta(days=int(os.environ.get("WATCH_DAYS", "60")))
    if os.environ.get("WATCH_END"):
        end = min(end, dt.date.fromisoformat(os.environ["WATCH_END"]))
    if today > end:
        print(f"[{dt.datetime.now():%F %T}] 감시 기간({end}) 종료 - 건너뜀", file=sys.stderr)
        return 0
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}

    for item_id, name in DESIGNERS.items():
        free = fetch_free_slots(item_id, today, end)
        new = sorted(set(free) - set(state.get(item_id, [])))
        print(f"[{dt.datetime.now():%F %T}] {name}: free={len(free)} new={len(new)}", file=sys.stderr)
        if new:
            notify(format_message(name, item_id, new))
        state[item_id] = free  # 다시 찼다가 또 비면 그때 또 알린다

    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())

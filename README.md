# watch-naver-booking

네이버 예약에서 헤어베이커 "현지" 디자이너의 빈자리를 감시하고, 새 빈자리가 생기면 Slack으로 알립니다. 알림의 예약 링크를 누르면 로그인된 네이버 앱에서 예약 페이지가 바로 열립니다.

## 구성

```
Cloudflare Workers (naver-slot-watch)
 ├─ Cron: 1분마다 실행
 │   ├─ 네이버 예약 GraphQL 조회 (hourlySchedule)
 │   ├─ 직전 빈자리 목록과 비교 (KV: STATE)
 │   ├─ 새 빈자리가 있으면 Slack Incoming Webhook 발송
 │   └─ 조회 실패가 3분 이상 이어지면 장애 알림, 복구되면 복구 알림
 └─ HTTP: /go/<itemId>
     └─ 네이버 앱 호출 중계 페이지 (iOS 스킴 / Android intent)

GitHub Actions (watch.yml)
 └─ 수동 실행 전용: Slack 테스트 메시지 발송
```

| 경로 | 역할 |
|---|---|
| `worker/src/index.js` | 상시 감시와 중계 페이지 (운영 중) |
| `worker/wrangler.jsonc` | Worker 설정: Cron, 변수, KV |
| `.github/workflows/watch.yml` | 수동 실행용 워크플로 |
| `watch.py` | 같은 로직의 Python 버전 (Actions 테스트와 로컬 실행용) |
| `run.sh` | Mac launchd 실행용 진입점 (현재 미사용) |

## 빈자리 판정

네이버 예약의 `hourlySchedule` 쿼리는 디자이너 일정을 30분 단위 칸으로 돌려줍니다. 아래 세 조건을 모두 만족하는 칸을 빈자리로 봅니다.

- `isUnitBusinessDay` 가 true — 영업하는 시간대입니다.
- `isUnitSaleDay` 가 true — 예약을 받는 칸입니다. 지난 시간이나 디자이너가 막아 둔 칸은 false입니다.
- `unitBookingCount` 가 `unitStock` 미만 — 아직 예약이 차지 않았습니다.

로그인 없이 호출할 수 있는 API이지만 네이버가 공식으로 공개한 API는 아닙니다. 네이버가 예약 페이지를 바꾸면 조회가 실패할 수 있습니다.

| 대상 | 값 |
|---|---|
| 업체 ID (헤어베이커) | 648081 |
| 현지 디자이너 ID | 4347340 |
| 유나 디자이너 ID (테스트용) | 4328420 |

## 알림 규칙

- 직전 실행에서 없던 빈자리가 생겼을 때만 알립니다. 같은 빈자리는 다시 알리지 않습니다.
- 빈자리가 예약되어 사라졌다가 다시 비면 그때 또 알립니다.
- KV에는 빈자리 목록이 바뀔 때만 씁니다. 무료 플랜의 하루 쓰기 한도(1,000회)를 지키기 위해서입니다.
- 감시 범위는 오늘(한국 시간)부터 `WATCH_END` 까지입니다. 이 날짜가 지나면 조회를 건너뜁니다.

## 장애 알림

조회가 실패하면 "빈자리 없음"과 구분할 수 없으므로, 실패가 이어지면 따로 알립니다.

- HTTP 오류, GraphQL 오류, JSON이 아닌 응답(차단 페이지 등), 응답 구조 변경을 모두 실패로 셉니다.
- 실패가 3분 이상 이어지면 Slack으로 한 번 알립니다. 실패가 계속되어도 다시 알리지 않습니다.
- 장애 알림 뒤 조회가 성공하면 복구 알림을 보냅니다. 3분 안에 회복된 실패는 알리지 않습니다.
- 실패 상태는 KV의 `health` 키에 둡니다. 정상일 때는 키가 없고, 첫 실패·장애 알림·복구 때만 씁니다.
- Worker 자체가 실행되지 않는 장애(Cron 중단, 계정 문제)는 이 장치로 알 수 없습니다.

## 설정값

| 이름 | 종류 | 위치 | 설명 |
|---|---|---|---|
| `SLACK_WEBHOOK_URL` | Secret | Cloudflare, GitHub | Slack Incoming Webhook 주소 |
| `WATCH_END` | 변수 | `wrangler.jsonc`, GitHub | 감시 마지막 날짜 (YYYY-MM-DD) |
| `APP_LINK_BASE` | 변수 | `wrangler.jsonc` | 중계 페이지 주소. 없으면 웹 예약 링크를 씀 |
| `TEST_DESIGNERS` | 변수 | 배포 시 `--var` | 감시 대상 임시 추가 (`ID=이름,…`) |
| `TEST_MESSAGE` | 변수 | 배포 시 `--var` | 설정 시 감시 대신 이 메시지를 매분 발송 |

Webhook 주소는 레포에 넣지 않습니다. Cloudflare에는 아래 명령으로 등록합니다.

```bash
cd worker && npx wrangler secret put SLACK_WEBHOOK_URL
```

## 배포

```bash
cd worker && npx wrangler deploy
```

배포 후 실행 로그는 아래 명령으로 볼 수 있습니다. 매분 `현지: free=0 new=0 naver=850ms` 같은 줄이 찍히면 정상입니다. `naver` 는 네이버 조회에 걸린 시간입니다.

```bash
cd worker && npx wrangler tail
```

## 테스트

### Slack 발송만 확인

GitHub의 Actions 탭에서 watch 워크플로를 `test` 체크 후 실행합니다. 감시 상태는 바뀌지 않습니다.

`test` 체크 없이 실행하면 Actions가 Cloudflare와 별개의 상태로 감시하므로, 같은 빈자리가 한 번 더 알려질 수 있습니다.

### 실제 빈자리 감지부터 알림까지 확인

빈자리가 있는 디자이너를 잠시 감시 대상에 넣습니다. 첫 실행에서 알림 1건이 가고, 다음 실행부터는 가지 않아야 합니다.

```bash
cd worker && npx wrangler deploy --var "TEST_DESIGNERS:4328420=유나(테스트)"
```

확인이 끝나면 반드시 원래대로 배포하고 테스트 디자이너의 상태를 지웁니다.

```bash
cd worker && npx wrangler deploy && npx wrangler kv key delete 4328420 --binding STATE --remote
```

`TEST_MESSAGE` 는 설정된 동안 매분 메시지를 보내므로, 한 번 확인하면 바로 빼고 다시 배포합니다.

## 네이버 앱 중계 페이지

Slack은 링크를 자체 인앱 브라우저로 열기 때문에 네이버에 다시 로그인해야 합니다. 그래서 알림 링크는 `/go/<itemId>` 중계 페이지를 거쳐 네이버 앱을 호출합니다.

- **iOS** — `naversearchapp://inappbrowser?url=…&target=new&version=6`
- **Android** — `intent://inappbrowser?url=…#Intent;scheme=naversearchapp;package=com.nhn.android.search;end`
- **자동 이동 실패 시** — 화면의 "네이버 앱에서 열기" 또는 "웹으로 열기" 버튼을 누릅니다.

경로에서 숫자 ID만 받고 이동 주소는 코드 안에서 만들기 때문에, 임의의 주소로 이동시키는 데 쓰일 수 없습니다. iPhone에서 동작을 확인했고, Android는 확인하지 않았습니다.

## 무료 플랜 사용량

| 항목 | 무료 한도 | 사용량 |
|---|---|---|
| 하루 요청 수 | 100,000회 | 약 1,440회 |
| 실행 1회당 CPU 시간 | 10ms | 약 1ms |
| 실행 1회당 외부 호출 | 50회 | 1~2회 |
| KV 읽기 | 하루 100,000회 | 하루 1,440회 |
| KV 쓰기 | 하루 1,000회 | 빈자리가 바뀔 때만 |
| Cron 예약 개수 | 계정당 5개 | 1개 |

한도를 넘어도 요금은 청구되지 않고, 그날 남은 실행이 실패합니다. 하루 한도는 UTC 자정(한국 시간 오전 9시)에 초기화됩니다.

## 감시 종료

```bash
cd worker && npx wrangler delete
```

KV 저장소까지 지우려면 Cloudflare 대시보드의 Storage & Databases → KV에서 `naver-slot-watch-state` 를 삭제합니다.

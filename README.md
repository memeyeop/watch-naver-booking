# watch-naver-booking

네이버 예약에서 헤어베이커 "현지" 디자이너의 빈자리를 감시하고, 새 빈자리가 생기면 Slack으로 알립니다. 알림의 예약 링크를 누르면 로그인된 네이버 앱에서 예약 페이지가 바로 열립니다.

## 구성

```
Cloudflare Workers (naver-slot-watch)
 ├─ Watcher (Durable Object, 객체 1개, 위치 apac-ne)
 │   └─ 알람: 주간 10초, 0~8시 30초 (±2초 무작위)마다 실행
 │       ├─ 네이버 예약 GraphQL 조회 (hourlySchedule)
 │       ├─ 직전 빈자리 목록과 비교 (Watcher 저장소)
 │       ├─ 새 빈자리가 있으면 Slack Incoming Webhook 발송
 │       └─ 조회 실패가 3분 이상 이어지면 장애 알림, 복구되면 복구 알림
 ├─ Cron: 1분마다 실행 (감시자)
 │   └─ Watcher 알람이 멈췄으면 다시 걸고, 멈춤이 확인되면 Slack 알림
 └─ HTTP: /go/<itemId>
     └─ 네이버 앱 호출 중계 페이지 (iOS 스킴 / Android intent)

GitHub Actions (watch.yml)
 └─ 수동 실행 전용: Slack 테스트 메시지 발송
```

| 경로 | 역할 |
|---|---|
| `worker/src/index.js` | 진입점: 중계 페이지, Cron 감시자 |
| `worker/src/watcher.js` | Watcher Durable Object: 알람과 저장소 연결 |
| `worker/src/core.js` | 감시 로직: 조회, 비교, 알림, 간격 계산, 감시자 판정 |
| `worker/test/core.test.mjs` | `core.js` 단위 테스트 |
| `worker/wrangler.jsonc` | Worker 설정: Cron, 변수, KV, Durable Object |
| `docs/superpowers/specs/` | 설계 문서 |
| `.github/workflows/watch.yml` | 수동 실행용 워크플로 |
| `watch.py` | 같은 로직의 Python 버전 (Actions 테스트와 로컬 실행용) |
| `run.sh` | Mac launchd 실행용 진입점 (현재 미사용) |

## 빈자리 판정

네이버 예약의 `hourlySchedule` 쿼리는 디자이너 일정을 30분 단위 칸으로 돌려줍니다. 아래 네 조건을 모두 만족하는 칸을 빈자리로 봅니다.

- `isUnitBusinessDay` 가 true — 영업하는 시간대입니다.
- `isUnitSaleDay` 가 true — 예약을 받는 칸입니다. 디자이너가 막아 둔 칸은 false입니다.
- `unitBookingCount` 가 `unitStock` 미만 — 아직 예약이 차지 않았습니다.
- 시작 시각이 현재(한국 시간) 이후 — 오늘의 지난 칸도 `isUnitSaleDay` 가 true로 오기 때문에, 시술 시각이 지난 뒤에 취소된 칸을 알리지 않도록 따로 거릅니다.

로그인 없이 호출할 수 있는 API이지만 네이버가 공식으로 공개한 API는 아닙니다. 네이버가 예약 페이지를 바꾸면 조회가 실패할 수 있습니다.

| 대상 | 값 |
|---|---|
| 업체 ID (헤어베이커) | 648081 |
| 현지 디자이너 ID | 4347340 |
| 유나 디자이너 ID (테스트용) | 4328420 |

## 알림 규칙

- 직전 실행에서 없던 빈자리가 생겼을 때만 알립니다. 같은 빈자리는 다시 알리지 않습니다.
- 빈자리가 예약되어 사라졌다가 다시 비면 그때 또 알립니다.
- 빈자리 목록은 Watcher 저장소에 두고, 바뀔 때만 씁니다.
- 감시 범위는 오늘(한국 시간)부터 `WATCH_END` 까지입니다. 이 날짜가 지나면 알람 루프가 멈춥니다.

## 조회 간격

| 시간대 (한국 시간) | 간격 |
|---|---|
| 8~24시 | 10초 ± 2초 |
| 0~8시 | 30초 ± 2초 |

- 알람은 실행을 시작하자마자 다음 알람부터 예약합니다. 그래서 실행 도중 예외가 나도 루프가 이어집니다.
- 조회가 연속으로 실패하면 간격을 두 배씩 늘려 최대 5분까지 늦춥니다. 한 번 성공하면 원래 간격으로 돌아갑니다.

## 장애 알림

조회가 실패하면 "빈자리 없음"과 구분할 수 없으므로, 실패가 이어지면 따로 알립니다.

- HTTP 오류, GraphQL 오류, JSON이 아닌 응답(차단 페이지 등), 응답 구조 변경을 모두 실패로 셉니다.
- 실패가 3분 이상 이어지면 Slack으로 한 번 알립니다. 실패가 계속되어도 다시 알리지 않습니다.
- 장애 알림 뒤 조회가 성공하면 복구 알림을 보냅니다. 3분 안에 회복된 실패는 알리지 않습니다.
- 실패 상태는 Watcher 저장소의 `meta` 에 둡니다.

### 감시 루프 멈춤 알림

1분 Cron(감시자)이 Watcher를 호출해 알람 루프가 살아 있는지 확인합니다.

- 알람이 걸려 있지 않으면 바로 다시 겁니다.
- 마지막으로 끝까지 실행된 시각이 3분(간격이 늘어난 상태면 간격 + 1분)보다 오래되면 Slack으로 "감시 루프가 멈췄습니다"를 보냅니다.
- Watcher 호출이 실패하면 3분 이상 이어질 때만 알립니다. 배포할 때 Watcher가 재시작되면서 잠깐 실패하기 때문입니다.
- 루프가 다시 돌면 "다시 동작합니다"를 보냅니다. 감시자 상태는 KV의 `watchdog` 키에 두고, 상태가 바뀔 때만 씁니다.
- 감시자와 Watcher가 같은 Worker에 있으므로, Worker 전체가 멈추는 장애(계정 문제, Worker 삭제, 하루 요청 한도 초과)는 알 수 없습니다.

## 설정값

| 이름 | 종류 | 위치 | 설명 |
|---|---|---|---|
| `SLACK_WEBHOOK_URL` | Secret | Cloudflare, GitHub | Slack Incoming Webhook 주소 |
| `WATCH_END` | 변수 | `wrangler.jsonc`, GitHub | 감시 마지막 날짜 (YYYY-MM-DD) |
| `APP_LINK_BASE` | 변수 | `wrangler.jsonc` | 중계 페이지 주소. 없으면 웹 예약 링크를 씀 |
| `TEST_DESIGNERS` | 변수 | 배포 시 `--var` | 감시 대상 임시 추가 (`ID=이름,…`) |
| `TEST_MESSAGE` | 변수 | 배포 시 `--var` | 설정 시 이 메시지를 매분 발송 |
| `WATCHER_PAUSED` | 변수 | 배포 시 `--var` | 설정 시 알람 루프를 멈춤 (정지 스위치) |

Webhook 주소는 레포에 넣지 않습니다. Cloudflare에는 아래 명령으로 등록합니다.

```bash
cd worker && npx wrangler secret put SLACK_WEBHOOK_URL
```

## 배포

```bash
cd worker && npx wrangler deploy
```

배포 후 실행 로그는 아래 명령으로 볼 수 있습니다. 약 10초마다 `현지: free=0 new=0 naver=220ms` 같은 줄이 찍히면 정상입니다. `naver` 는 네이버 조회에 걸린 시간입니다.

```bash
cd worker && npx wrangler tail
```

**새 코드는 Watcher에 최대 5분 늦게 적용됩니다.** Durable Object는 재배포해도 객체가 쉬는 상태가 될 때까지 최대 300초 동안 이전 코드로 계속 실행됩니다. 이 객체는 10초마다 깨어나므로 거의 5분을 채운 뒤에 바뀝니다(실측 4분 39초). 그동안 루프는 이전 코드로 정상 동작하지만, `wrangler tail` 은 새 버전 로그만 보여 주므로 알람 로그가 비어 보입니다. `WATCHER_PAUSED` 같은 설정 변경도 같은 시간만큼 늦게 적용됩니다.

Durable Object를 도입한 뒤에는 `wrangler rollback` 으로 이전 버전에 돌아갈 수 없습니다. 문제가 생기면 `WATCHER_PAUSED` 로 루프를 멈춘 뒤 수정한 코드를 배포합니다.

## 테스트

### 단위 테스트

```bash
node --test worker/test/*.test.mjs
```

### Slack 발송만 확인

GitHub의 Actions 탭에서 watch 워크플로를 `test` 체크 후 실행합니다. 감시 상태는 바뀌지 않습니다.

`test` 체크 없이 실행하면 Actions가 Cloudflare와 별개의 상태로 감시하므로, 같은 빈자리가 한 번 더 알려질 수 있습니다. `watch.py` 는 1분 Cron 시절의 로직이며 Watcher로 옮기지 않았습니다.

### 실제 빈자리 감지부터 알림까지 확인

빈자리가 있는 디자이너를 잠시 감시 대상에 넣습니다. 첫 실행에서 알림 1건이 가고, 다음 실행부터는 가지 않아야 합니다.

```bash
cd worker && npx wrangler deploy --var "TEST_DESIGNERS:4328420=유나(테스트)"
```

확인이 끝나면 반드시 원래대로 배포합니다. 감시 대상에서 빠진 디자이너의 상태는 Watcher가 자동으로 지웁니다. 위의 코드 적용 지연 때문에 알림이 시작되고 멈추기까지 각각 최대 5분이 걸릴 수 있습니다.

```bash
cd worker && npx wrangler deploy
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
| Worker 요청 수 (Cron) | 하루 100,000회 | 약 1,440회 |
| Durable Object 요청 수 (알람 + 감시자 호출) | 하루 100,000회 | 약 8,200회 |
| Durable Object 실행 시간 | 하루 13,000 GB-s | 최대 10,800 GB-s |
| Durable Object 저장소 행 쓰기 | 하루 100,000행 | 약 13,400행 |
| 실행 1회당 CPU 시간 | 10ms | 약 1~2ms |
| KV 읽기 | 하루 100,000회 | 약 1,440회 |
| KV 쓰기 | 하루 1,000회 | 감시자 상태가 바뀔 때만 |
| Cron 예약 개수 | 계정당 5개 | 1개 |

Durable Object 실행 시간은 객체가 하루 종일 메모리에 있다고 가정한 최댓값입니다. 객체를 둘 이상 만들면 이 한도를 넘을 수 있으므로 Watcher는 하나만 둡니다.

한도를 넘어도 요금은 청구되지 않고, 그날 남은 실행이 실패합니다. 하루 한도는 UTC 자정(한국 시간 오전 9시)에 초기화됩니다.

## 감시 종료

잠시 멈출 때는 정지 스위치를 씁니다. 다시 켜려면 변수 없이 배포합니다.

```bash
cd worker && npx wrangler deploy --var WATCHER_PAUSED:1
```

완전히 없앨 때는 Worker를 삭제합니다. Watcher 저장소도 함께 삭제됩니다.

```bash
cd worker && npx wrangler delete
```

KV 저장소까지 지우려면 Cloudflare 대시보드의 Storage & Databases → KV에서 `naver-slot-watch-state` 를 삭제합니다.

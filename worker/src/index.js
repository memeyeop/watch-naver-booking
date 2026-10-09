// 네이버 예약 디자이너 빈자리 감시 → Slack 알림 (Cloudflare Workers Cron)
// 빈자리 = isUnitBusinessDay && isUnitSaleDay && unitBookingCount < unitStock
// 직전 실행에서 못 본 빈자리가 생겼을 때만 알린다(KV에 상태 저장, 바뀔 때만 write).

const BUSINESS_ID = "648081"; // 헤어베이커
const DESIGNERS = { "4347340": "현지" }; // bizItemId: 이름 (유나=4328420)
const GRAPHQL_URL = "https://m.booking.naver.com/graphql?opName=hourlySchedule";
const QUERY = `query hourlySchedule($scheduleParams: ScheduleParams) {
  schedule(input: $scheduleParams) { bizItemSchedule { hourly {
    unitStartTime unitStock unitBookingCount isUnitBusinessDay isUnitSaleDay
  } } } }`;
const KST_MS = 9 * 60 * 60 * 1000;
const HEALTH_KEY = "health"; // 연속 실패 상태 { failSince, alerted } — 정상이면 키 없음
const ALERT_AFTER_MS = 3 * 60 * 1000; // 실패가 이만큼 이어지면 Slack 장애 알림

const bookingUrl = (item) => `https://m.booking.naver.com/booking/13/bizes/${BUSINESS_ID}/items/${item}`;

async function fetchFreeSlots(item, start, end) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", Referer: bookingUrl(item) },
    body: JSON.stringify({
      operationName: "hourlySchedule",
      query: QUERY,
      variables: { scheduleParams: {
        businessTypeId: 13, businessId: BUSINESS_ID, bizItemId: item,
        startDateTime: `${start}T00:00:00`, endDateTime: `${end}T23:59:59`,
        fixedTime: true, includesHolidaySchedules: true,
      } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`naver HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  const hourly = data.data?.schedule?.bizItemSchedule?.hourly;
  if (!Array.isArray(hourly)) throw new Error("응답 구조 변경: hourly 없음");
  return hourly
    .filter((s) => s.isUnitBusinessDay && s.isUnitSaleDay && s.unitBookingCount < s.unitStock)
    .map((s) => s.unitStartTime.slice(0, 16)) // "YYYY-MM-DD HH:MM"
    .sort();
}

// Slack 인앱 브라우저 대신 로그인된 네이버 앱으로 예약 페이지를 여는 중계 페이지
function appRedirectPage(item) {
  const target = encodeURIComponent(bookingUrl(item));
  const ios = `naversearchapp://inappbrowser?url=${target}&target=new&version=6`;
  const android = `intent://inappbrowser?url=${target}&target=new&version=6#Intent;scheme=naversearchapp;package=com.nhn.android.search;end`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>네이버 앱으로 이동</title>
<style>body{font-family:-apple-system,sans-serif;text-align:center;padding:48px 16px}
a{display:block;margin:12px auto;max-width:320px;padding:14px;border-radius:8px;text-decoration:none;font-size:17px}
.app{background:#03c75a;color:#fff}.web{color:#555;border:1px solid #ccc}</style></head><body>
<p>네이버 앱에서 예약 페이지를 엽니다…</p>
<a class="app" id="app" href="${ios}">네이버 앱에서 열기</a>
<a class="web" href="${bookingUrl(item)}">웹으로 열기</a>
<script>var u=/Android/i.test(navigator.userAgent)?${JSON.stringify(android)}:${JSON.stringify(ios)};
document.getElementById("app").href=u;location.href=u;</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function formatMessage(name, item, slots, linkBase) {
  const byDay = {};
  for (const s of slots) (byDay[s.slice(0, 10)] ??= []).push(s.slice(11));
  const lines = [`:scissors: *${name}* 디자이너 빈자리 ${slots.length}칸이 새로 열렸습니다`];
  for (const [day, times] of Object.entries(byDay)) {
    const wd = "일월화수목금토"[new Date(`${day}T00:00:00Z`).getUTCDay()];
    lines.push(`• ${day}(${wd}) ${times.join(", ")}`);
  }
  lines.push(linkBase ? `<${linkBase}/go/${item}|네이버 앱으로 예약하기>` : `<${bookingUrl(item)}|예약하러 가기>`);
  return lines.join("\n");
}

async function notify(env, text) {
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`slack HTTP ${res.status}: ${await res.text()}`);
}

async function run(env) {
  if (env.TEST_MESSAGE) return notify(env, env.TEST_MESSAGE); // 배포 검증용 1회성

  const today = new Date(Date.now() + KST_MS).toISOString().slice(0, 10);
  const end = env.WATCH_END;
  if (today > end) return console.log(`감시 기간(${end}) 종료 - 건너뜀`);

  // TEST_DESIGNERS="4328420=유나(테스트),..." 로 감시 대상을 임시 추가
  const extra = (env.TEST_DESIGNERS ?? "").split(",").filter(Boolean).map((p) => p.split("="));
  const failures = [];
  for (const [item, name] of [...Object.entries(DESIGNERS), ...extra]) {
    try {
      await watchDesigner(env, item, name, today, end);
    } catch (e) {
      console.error(`${name}: 실패 ${e.message}`);
      failures.push(`${name}: ${e.message.slice(0, 300)}`);
    }
  }
  await updateHealth(env, failures);
}

async function watchDesigner(env, item, name, today, end) {
  const started = Date.now();
  const free = await fetchFreeSlots(item, today, end);
  const naverMs = Date.now() - started;
  const prevRaw = await env.STATE.get(item);
  const prev = new Set(prevRaw ? JSON.parse(prevRaw) : []);
  const fresh = free.filter((s) => !prev.has(s));
  console.log(`${name}: free=${free.length} new=${fresh.length} naver=${naverMs}ms`);
  if (fresh.length) await notify(env, formatMessage(name, item, fresh, env.APP_LINK_BASE));
  const next = JSON.stringify(free);
  if (next !== prevRaw) await env.STATE.put(item, next); // KV 무료 write 한도(1000/일) 보호
}

// 실패가 ALERT_AFTER_MS 이상 이어지면 한 번 알리고, 복구되면 복구를 알린다.
// KV에는 상태가 바뀔 때만 쓴다(첫 실패, 알림 발송, 복구).
async function updateHealth(env, failures) {
  const raw = await env.STATE.get(HEALTH_KEY);
  const health = raw ? JSON.parse(raw) : null;
  const now = Date.now();
  if (!failures.length) {
    if (!health) return;
    const minutes = Math.round((now - health.failSince) / 60000);
    if (health.alerted) await notify(env, `:white_check_mark: 빈자리 감시가 복구되었습니다 (약 ${minutes}분 중단)`);
    return env.STATE.delete(HEALTH_KEY);
  }
  if (!health) return env.STATE.put(HEALTH_KEY, JSON.stringify({ failSince: now, alerted: false }));
  if (health.alerted || now - health.failSince < ALERT_AFTER_MS) return;
  const minutes = Math.round((now - health.failSince) / 60000);
  await notify(env, [`:warning: 빈자리 감시가 ${minutes}분째 실패하고 있습니다`, ...failures].join("\n"));
  await env.STATE.put(HEALTH_KEY, JSON.stringify({ ...health, alerted: true }));
}

export default {
  async fetch(request) {
    const m = new URL(request.url).pathname.match(/^\/go\/(\d{1,12})$/);
    return m ? appRedirectPage(m[1]) : new Response("Not Found", { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

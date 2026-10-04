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
  return data.data.schedule.bizItemSchedule.hourly
    .filter((s) => s.isUnitBusinessDay && s.isUnitSaleDay && s.unitBookingCount < s.unitStock)
    .map((s) => s.unitStartTime.slice(0, 16)) // "YYYY-MM-DD HH:MM"
    .sort();
}

function formatMessage(name, item, slots) {
  const byDay = {};
  for (const s of slots) (byDay[s.slice(0, 10)] ??= []).push(s.slice(11));
  const lines = [`:scissors: *${name}* 디자이너 빈자리 ${slots.length}칸이 새로 열렸습니다`];
  for (const [day, times] of Object.entries(byDay)) {
    const wd = "일월화수목금토"[new Date(`${day}T00:00:00Z`).getUTCDay()];
    lines.push(`• ${day}(${wd}) ${times.join(", ")}`);
  }
  lines.push(`<${bookingUrl(item)}|예약하러 가기>`);
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

  for (const [item, name] of Object.entries(DESIGNERS)) {
    const free = await fetchFreeSlots(item, today, end);
    const prevRaw = await env.STATE.get(item);
    const prev = new Set(prevRaw ? JSON.parse(prevRaw) : []);
    const fresh = free.filter((s) => !prev.has(s));
    console.log(`${name}: free=${free.length} new=${fresh.length}`);
    if (fresh.length) await notify(env, formatMessage(name, item, fresh));
    const next = JSON.stringify(free);
    if (next !== prevRaw) await env.STATE.put(item, next); // KV 무료 write 한도(1000/일) 보호
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

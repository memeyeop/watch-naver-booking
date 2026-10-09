// 감시 로직 — Cloudflare 전용 모듈을 쓰지 않아 node --test 로 검증할 수 있다.
// 빈자리 = isUnitBusinessDay && isUnitSaleDay && unitBookingCount < unitStock && 아직 지나지 않은 칸
// 시계(clock)와 무작위 값(random)은 인자로 주입한다.

export const BUSINESS_ID = "648081"; // 헤어베이커
export const DESIGNERS = { "4347340": "현지" }; // bizItemId: 이름 (유나=4328420)
const GRAPHQL_URL = "https://m.booking.naver.com/graphql?opName=hourlySchedule";
const QUERY = `query hourlySchedule($scheduleParams: ScheduleParams) {
  schedule(input: $scheduleParams) { bizItemSchedule { hourly {
    unitStartTime unitStock unitBookingCount isUnitBusinessDay isUnitSaleDay
  } } } }`;
const KST_MS = 9 * 60 * 60 * 1000;
export const ALERT_AFTER_MS = 3 * 60 * 1000; // 실패가 이만큼 이어지면 Slack 장애 알림
const MAX_DELAY_MS = 5 * 60 * 1000; // 연속 실패 시 늘어나는 간격의 상한
const SLOTS_PREFIX = "slots:";

export const bookingUrl = (item) => `https://m.booking.naver.com/booking/13/bizes/${BUSINESS_ID}/items/${item}`;
const kst = (ms) => new Date(ms + KST_MS).toISOString(); // "YYYY-MM-DDTHH:MM:SS.sssZ" 형식의 한국 시각
export const kstDate = (ms) => kst(ms).slice(0, 10);

export async function fetchFreeSlots(item, start, end, now) {
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
  // 지난 시각의 칸도 isUnitSaleDay=true 로 오므로, 시술 시각이 지난 뒤의 취소를 알리지 않도록 걸러낸다
  const nowKst = kst(now).slice(0, 16).replace("T", " ");
  return hourly
    .filter((s) => s.isUnitBusinessDay && s.isUnitSaleDay && s.unitBookingCount < s.unitStock)
    .map((s) => s.unitStartTime.slice(0, 16)) // "YYYY-MM-DD HH:MM"
    .filter((s) => s > nowKst)
    .sort();
}

export function formatMessage(name, item, slots, linkBase) {
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

export async function notify(env, text) {
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`slack HTTP ${res.status}: ${await res.text()}`);
}

// 0~8시(한국 시간)는 30초, 그 외 10초. ±2초 무작위로 흔들고, 연속 실패 n회면 2ⁿ배(최대 5분)
export function nextDelay(now, failures, random) {
  const base = Number(kst(now).slice(11, 13)) < 8 ? 30000 : 10000;
  const jittered = base + Math.round((random() * 2 - 1) * 2000);
  return Math.min(jittered * 2 ** failures, MAX_DELAY_MS);
}

// 실패 상태 전이. failSince 가 null 이면 정상이다.
// 실패가 ALERT_AFTER_MS 이상 이어지면 "alert" 를 한 번, 알린 뒤 정상이 되면 "recover" 를 돌려준다.
export function trackFailure(state, failSince, now) {
  if (failSince == null) return { state: null, event: state?.alerted ? "recover" : null };
  const cur = state ?? { failSince, alerted: false };
  if (!cur.alerted && now - cur.failSince >= ALERT_AFTER_MS) return { state: { ...cur, alerted: true }, event: "alert" };
  return { state: cur, event: null };
}

export const isPaused = (env, now) => Boolean(env.WATCHER_PAUSED) || kstDate(now) > env.WATCH_END;

// TEST_DESIGNERS="4328420=유나(테스트),..." 로 감시 대상을 임시 추가
function watchedDesigners(env) {
  const extra = (env.TEST_DESIGNERS ?? "").split(",").filter(Boolean).map((p) => p.split("="));
  return [...Object.entries(DESIGNERS), ...extra];
}

async function checkDesigner({ storage, env, item, name, today, clock }) {
  const started = clock();
  const free = await fetchFreeSlots(item, today, env.WATCH_END, started);
  const naverMs = clock() - started;
  let prev = await storage.get(SLOTS_PREFIX + item);
  const migrating = prev === undefined;
  if (migrating) {
    // 1단계(KV)에서 넘어오는 첫 회차: 이미 알린 빈자리를 다시 알리지 않도록 KV 목록을 기준값으로 쓴다
    const raw = await env.STATE.get(item);
    prev = raw ? JSON.parse(raw) : [];
  }
  const prevSet = new Set(prev);
  const fresh = free.filter((s) => !prevSet.has(s));
  console.log(`${name}: free=${free.length} new=${fresh.length} naver=${naverMs}ms`);
  if (fresh.length) await notify(env, formatMessage(name, item, fresh, env.APP_LINK_BASE));
  // 알림 다음에 저장한다 — 중간에 끊기면 중복 알림이 나지만 누락은 나지 않는다
  if (migrating || JSON.stringify(free) !== JSON.stringify(prev)) await storage.put(SLOTS_PREFIX + item, free);
}

// 알람 한 회차. storage 는 Durable Object storage 와 같은 인터페이스
// (get, put, delete, list, setAlarm, deleteAlarm) 를 따른다.
export async function runCycle({ storage, env, clock, random }) {
  const now = clock();
  if (isPaused(env, now)) {
    await storage.deleteAlarm();
    return console.log("감시 중지(WATCHER_PAUSED 또는 WATCH_END 경과) - 알람 해제");
  }
  // 다음 알람을 먼저 건다 — 이후 단계에서 예외가 나도 루프는 이어진다
  let delay = nextDelay(now, 0, random);
  await storage.setAlarm(now + delay);

  const meta = (await storage.get("meta")) ?? { failures: 0, health: null };
  const today = kstDate(now);
  const designers = watchedDesigners(env);
  const failures = [];
  for (const [item, name] of designers) {
    try {
      await checkDesigner({ storage, env, item, name, today, clock });
    } catch (e) {
      console.error(`${name}: 실패 ${e.message}`);
      failures.push(`${name}: ${e.message.slice(0, 300)}`);
    }
  }

  // 감시 대상에서 빠진 디자이너(TEST_DESIGNERS 제거 등)의 상태를 지운다
  const watched = new Set(designers.map(([item]) => SLOTS_PREFIX + item));
  for (const key of (await storage.list({ prefix: SLOTS_PREFIX })).keys()) {
    if (!watched.has(key)) await storage.delete(key);
  }

  const { state: health, event } = trackFailure(meta.health, failures.length ? now : null, now);
  if (event === "alert") {
    const minutes = Math.round((now - health.failSince) / 60000);
    await notify(env, [`:warning: 빈자리 감시가 ${minutes}분째 실패하고 있습니다`, ...failures].join("\n"));
  } else if (event === "recover") {
    const minutes = Math.round((now - meta.health.failSince) / 60000);
    await notify(env, `:white_check_mark: 빈자리 감시가 복구되었습니다 (약 ${minutes}분 중단)`);
  }

  const failCount = failures.length ? meta.failures + 1 : 0;
  if (failCount) {
    delay = nextDelay(now, failCount, random);
    await storage.setAlarm(now + delay);
  }
  await storage.put("meta", { lastCompletedAt: clock(), delay, failures: failCount, health });
}

// 감시자(Cron)가 부른다. 알람이 없으면 다시 걸고, 감시자 판정에 쓸 상태를 돌려준다.
export async function ensureLoop({ storage, env, clock }) {
  const now = clock();
  if (isPaused(env, now)) {
    await storage.deleteAlarm();
    return { paused: true };
  }
  if ((await storage.getAlarm()) == null) await storage.setAlarm(now);
  let bootAt = await storage.get("bootAt");
  if (bootAt === undefined) await storage.put("bootAt", (bootAt = now));
  return { paused: false, bootAt, meta: (await storage.get("meta")) ?? null };
}

// 감시자 판정: 멈춘 것으로 보이면 그 시작 시각을, 정상이면 null 을 돌려준다.
// status 는 { ok: false } (ensure 호출 실패) 또는 { ok: true, ...ensureLoop 결과 }.
export function watchdogFailSince(status, now) {
  if (!status.ok) return now; // 배포 중 재시작으로도 잠깐 실패하므로 trackFailure 의 3분 유예를 받는다
  const last = status.meta?.lastCompletedAt ?? status.bootAt;
  const limit = Math.max(ALERT_AFTER_MS, (status.meta?.delay ?? 0) + 60000);
  return now - last > limit ? last : null; // 이미 limit 이상 지났으므로 바로 알린다
}

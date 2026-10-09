// 네이버 예약 디자이너 빈자리 감시 → Slack 알림
// 감시 루프는 Durable Object(Watcher)의 알람이 돌고, 1분 Cron 은 루프가 살아 있는지만 확인한다.

import { bookingUrl, notify, trackFailure, watchdogFailSince } from "./core.js";
export { Watcher } from "./watcher.js";

const WATCHDOG_KEY = "watchdog"; // 감시자 상태 { failSince, alerted } — 정상이면 키 없음

// locationHint 는 객체가 처음 만들어질 때만 적용되므로 stub 은 반드시 여기서만 만든다
const getWatcher = (env) => env.WATCHER.get(env.WATCHER.idFromName("main"), { locationHint: "apac-ne" });

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

// 감시 루프가 멈췄으면 알리고, 다시 돌면 재개를 알린다. KV에는 상태가 바뀔 때만 쓴다.
async function watchdog(env) {
  if (env.TEST_MESSAGE) await notify(env, env.TEST_MESSAGE); // 배포 검증용 1회성

  let status;
  try {
    status = { ok: true, ...(await getWatcher(env).ensure()) };
  } catch (e) {
    console.error(`감시자: ensure 실패 ${e.message}`);
    status = { ok: false, error: e.message };
  }
  if (status.paused) return console.log("감시자: 감시 중지 상태 - 판정 생략");

  const now = Date.now();
  const raw = await env.STATE.get(WATCHDOG_KEY);
  const prev = raw ? JSON.parse(raw) : null;
  const { state, event } = trackFailure(prev, watchdogFailSince(status, now), now);
  if (event === "alert") {
    const reason = status.ok
      ? `마지막 완료 ${Math.round((now - state.failSince) / 60000)}분 전`
      : `Watcher 호출 실패: ${status.error.slice(0, 300)}`;
    await notify(env, `:rotating_light: 빈자리 감시 루프가 멈췄습니다 (${reason})`);
  } else if (event === "recover") {
    await notify(env, ":white_check_mark: 빈자리 감시 루프가 다시 동작합니다");
  }
  if (!state) {
    if (prev) await env.STATE.delete(WATCHDOG_KEY);
  } else if (JSON.stringify(state) !== raw) {
    await env.STATE.put(WATCHDOG_KEY, JSON.stringify(state));
  }
}

export default {
  async fetch(request) {
    const m = new URL(request.url).pathname.match(/^\/go\/(\d{1,12})$/);
    return m ? appRedirectPage(m[1]) : new Response("Not Found", { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(watchdog(env));
  },
};

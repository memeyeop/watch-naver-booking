// core.js 단위 테스트 — 실행: node --test worker/test/*.test.mjs
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  ALERT_AFTER_MS, ensureLoop, fetchFreeSlots, nextDelay, runCycle, trackFailure, watchdogFailSince,
} from "../src/core.js";

const KST = (s) => Date.parse(`${s}+09:00`); // "2026-10-09T12:05:00" → epoch ms
const MIN = 60_000;

// ── 가짜 네이버·Slack ─────────────────────────────────────────
const slot = (t, booked, extra = {}) => ({
  unitStartTime: `${t}:00`, unitStock: 1, unitBookingCount: booked, isUnitBusinessDay: true, isUnitSaleDay: true, ...extra,
});
const ok = (hourly) => Response.json({ data: { schedule: { bizItemSchedule: { hourly } } } });
let naver; // () => Response
let slack;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://slack.invalid")) {
    slack.push(JSON.parse(init.body).text);
    return new Response("ok");
  }
  return naver();
};
console.log = () => {};
console.error = () => {};

// ── 가짜 Durable Object 저장소와 KV ─────────────────────────
function fakeStorage(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    data, alarm: null, alarmLog: [],
    async get(k) { return data.get(k); },
    async put(k, v) { data.set(k, structuredClone(v)); },
    async delete(k) { data.delete(k); },
    async list({ prefix }) { return new Map([...data].filter(([k]) => k.startsWith(prefix))); },
    async getAlarm() { return this.alarm; },
    async setAlarm(t) { this.alarm = t; this.alarmLog.push(t); },
    async deleteAlarm() { this.alarm = null; },
  };
}
const fakeKV = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { get: async (k) => m.get(k) ?? null };
};
const baseEnv = (extra = {}) => ({
  WATCH_END: "2026-10-31", SLACK_WEBHOOK_URL: "https://slack.invalid/hook", STATE: fakeKV(), ...extra,
});
const fixed = (t) => () => t;
const mid = () => 0.5; // 무작위 폭 0

beforeEach(() => {
  slack = [];
  naver = () => ok([]);
});

describe("fetchFreeSlots", () => {
  const now = KST("2026-10-09T12:05:00");

  test("네 조건을 모두 만족하는 미래 칸만 빈자리로 본다", async () => {
    naver = () => ok([
      slot("2026-10-09 11:00", 0), // 지난 칸
      slot("2026-10-09 12:00", 0), // 진행 중인 칸 (지난 칸)
      slot("2026-10-09 12:30", 0), // 빈자리
      slot("2026-10-09 13:00", 1), // 예약 참
      slot("2026-10-09 13:30", 0, { isUnitSaleDay: false }),
      slot("2026-10-09 14:00", 0, { isUnitBusinessDay: false }),
      slot("2026-10-10 10:30", 0), // 빈자리
    ]);
    assert.deepEqual(await fetchFreeSlots("1", "2026-10-09", "2026-10-31", now), ["2026-10-09 12:30", "2026-10-10 10:30"]);
  });

  for (const [label, res, pattern] of [
    ["HTTP 오류", () => new Response("x", { status: 500 }), /naver HTTP 500/],
    ["JSON 이 아닌 응답", () => new Response("<html>blocked</html>"), /JSON|Unexpected/],
    ["GraphQL 오류", () => Response.json({ errors: [{ message: "denied" }] }), /GraphQL error/],
    ["응답 구조 변경", () => Response.json({ data: { schedule: null } }), /응답 구조 변경/],
  ]) {
    test(`${label}는 실패로 던진다`, async () => {
      naver = res;
      await assert.rejects(fetchFreeSlots("1", "2026-10-09", "2026-10-31", now), pattern);
    });
  }
});

describe("nextDelay", () => {
  test("0~8시는 30초, 8시부터 10초", () => {
    assert.equal(nextDelay(KST("2026-10-09T07:59:59"), 0, mid), 30000);
    assert.equal(nextDelay(KST("2026-10-09T08:00:00"), 0, mid), 10000);
    assert.equal(nextDelay(KST("2026-10-09T23:59:59"), 0, mid), 10000);
    assert.equal(nextDelay(KST("2026-10-10T00:00:00"), 0, mid), 30000);
  });

  test("무작위 폭은 ±2초", () => {
    const t = KST("2026-10-09T12:00:00");
    assert.equal(nextDelay(t, 0, () => 0), 8000);
    assert.equal(nextDelay(t, 0, () => 0.999999), 12000);
  });

  test("연속 실패마다 2배로 늘고 5분에서 멈춘다", () => {
    const t = KST("2026-10-09T12:00:00");
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => nextDelay(t, n, mid)), [10000, 20000, 40000, 80000, 160000, 300000, 300000]);
  });
});

describe("trackFailure", () => {
  const t0 = KST("2026-10-09T12:00:00");

  test("3분 미만은 알리지 않고, 3분째 한 번만 알린다", () => {
    let r = trackFailure(null, t0, t0);
    assert.equal(r.event, null);
    r = trackFailure(r.state, t0 + MIN, t0 + 2 * MIN);
    assert.equal(r.event, null);
    assert.equal(r.state.failSince, t0, "처음 실패한 시각을 유지한다");
    r = trackFailure(r.state, t0 + 3 * MIN, t0 + ALERT_AFTER_MS);
    assert.equal(r.event, "alert");
    r = trackFailure(r.state, t0 + 4 * MIN, t0 + 4 * MIN);
    assert.equal(r.event, null, "재알림 없음");
    r = trackFailure(r.state, null, t0 + 5 * MIN);
    assert.deepEqual(r, { state: null, event: "recover" });
  });

  test("알리기 전에 회복하면 복구 알림도 없다", () => {
    const r = trackFailure({ failSince: t0, alerted: false }, null, t0 + MIN);
    assert.deepEqual(r, { state: null, event: null });
  });
});

describe("runCycle", () => {
  const now = KST("2026-10-09T12:05:00");

  test("다음 알람을 조회보다 먼저 예약한다", async () => {
    const storage = fakeStorage();
    let alarmAtFetch;
    naver = () => { alarmAtFetch = storage.alarm; return ok([]); };
    await runCycle({ storage, env: baseEnv(), clock: fixed(now), random: mid });
    assert.equal(alarmAtFetch, now + 10000);
  });

  test("전환 첫 회차는 KV 목록을 기준값으로 써서 이미 알린 빈자리를 다시 알리지 않는다", async () => {
    const storage = fakeStorage();
    const env = baseEnv({ STATE: fakeKV({ "4347340": JSON.stringify(["2026-10-13 11:00"]) }) });
    naver = () => ok([slot("2026-10-13 11:00", 0), slot("2026-10-14 11:00", 0)]);
    await runCycle({ storage, env, clock: fixed(now), random: mid });
    assert.equal(slack.length, 1);
    assert.match(slack[0], /빈자리 1칸/);
    assert.match(slack[0], /2026-10-14/);
    assert.deepEqual(storage.data.get("slots:4347340"), ["2026-10-13 11:00", "2026-10-14 11:00"]);
  });

  test("KV 기준값이 지금 목록과 같아도 저장해서 다음 회차부터 KV를 읽지 않는다", async () => {
    const storage = fakeStorage();
    const env = baseEnv({ STATE: fakeKV({ "4347340": "[]" }) });
    await runCycle({ storage, env, clock: fixed(now), random: mid });
    assert.deepEqual(storage.data.get("slots:4347340"), []);
  });

  test("같은 빈자리는 다시 알리지 않고, 마감 후 다시 비면 또 알린다", async () => {
    const storage = fakeStorage();
    const run = () => runCycle({ storage, env: baseEnv(), clock: fixed(now), random: mid });
    naver = () => ok([slot("2026-10-13 11:00", 0)]);
    await run(); await run();
    assert.equal(slack.length, 1);
    naver = () => ok([slot("2026-10-13 11:00", 1)]);
    await run();
    naver = () => ok([slot("2026-10-13 11:00", 0)]);
    await run();
    assert.equal(slack.length, 2);
  });

  test("감시 대상에서 빠진 디자이너의 상태를 지운다", async () => {
    const storage = fakeStorage({ "slots:4328420": ["2026-10-13 11:00"], "slots:4347340": [] });
    await runCycle({ storage, env: baseEnv(), clock: fixed(now), random: mid });
    assert.equal(storage.data.has("slots:4328420"), false);
    assert.equal(storage.data.has("slots:4347340"), true);
  });

  test("TEST_DESIGNERS 는 함께 조회하고, 상태가 없으면 첫 회차에 알린다", async () => {
    const storage = fakeStorage({ "slots:4347340": [] });
    naver = () => ok([slot("2026-10-13 11:00", 0)]);
    await runCycle({ storage, env: baseEnv({ TEST_DESIGNERS: "4328420=유나(테스트)" }), clock: fixed(now), random: mid });
    assert.equal(slack.length, 2, "현지(새 빈자리 1칸) + 유나(첫 회차)");
    assert.ok(slack.some((s) => s.includes("유나(테스트)")));
  });

  test("실패하면 간격을 늘려 다시 예약하고, 3분이 지나면 장애 알림, 성공하면 복구 알림", async () => {
    const storage = fakeStorage({ "slots:4347340": [] });
    let t = now;
    const run = () => runCycle({ storage, env: baseEnv(), clock: () => t, random: mid });
    naver = () => new Response("x", { status: 503 });
    await run();
    assert.equal(storage.alarm - t, 20000);
    assert.equal(storage.data.get("meta").failures, 1);
    t += 20000; await run();
    assert.equal(storage.alarm - t, 40000);
    t += ALERT_AFTER_MS; await run();
    assert.equal(slack.length, 1);
    assert.match(slack[0], /실패하고 있습니다/);
    assert.match(slack[0], /naver HTTP 503/);
    t += 60000; await run();
    assert.equal(slack.length, 1, "재알림 없음");
    naver = () => ok([]);
    t += 60000; await run();
    assert.equal(slack.length, 2);
    assert.match(slack[1], /복구/);
    assert.deepEqual(storage.data.get("meta"), { lastCompletedAt: t, delay: 10000, failures: 0, health: null });
    assert.equal(storage.alarm - t, 10000);
  });

  test("중간에 예외가 나면 lastCompletedAt 을 갱신하지 않지만 다음 알람은 남는다", async () => {
    const storage = fakeStorage({ meta: { lastCompletedAt: 1, delay: 10000, failures: 0, health: null } });
    storage.list = async () => { throw new Error("storage down"); };
    await assert.rejects(runCycle({ storage, env: baseEnv(), clock: fixed(now), random: mid }), /storage down/);
    assert.equal(storage.data.get("meta").lastCompletedAt, 1);
    assert.equal(storage.alarm, now + 10000);
  });

  for (const [label, env] of [
    ["정지 스위치", baseEnv({ WATCHER_PAUSED: "1" })],
    ["감시 기간 종료", baseEnv({ WATCH_END: "2026-10-08" })],
  ]) {
    test(`${label}면 알람을 해제하고 조회하지 않는다`, async () => {
      const storage = fakeStorage();
      storage.alarm = now + 5000;
      naver = () => assert.fail("조회하면 안 된다");
      await runCycle({ storage, env, clock: fixed(now), random: mid });
      assert.equal(storage.alarm, null);
    });
  }
});

describe("ensureLoop", () => {
  const now = KST("2026-10-09T12:05:00");

  test("알람이 없으면 즉시 실행되도록 걸고, 최초 시각을 한 번만 기록한다", async () => {
    const storage = fakeStorage();
    let r = await ensureLoop({ storage, env: baseEnv(), clock: fixed(now) });
    assert.equal(storage.alarm, now);
    assert.deepEqual(r, { paused: false, bootAt: now, meta: null });
    storage.alarm = now + 9000;
    r = await ensureLoop({ storage, env: baseEnv(), clock: fixed(now + MIN) });
    assert.equal(storage.alarm, now + 9000, "걸려 있는 알람은 건드리지 않는다");
    assert.equal(r.bootAt, now);
  });

  test("정지 상태면 알람을 해제한다", async () => {
    const storage = fakeStorage();
    storage.alarm = now;
    assert.deepEqual(await ensureLoop({ storage, env: baseEnv({ WATCHER_PAUSED: "1" }), clock: fixed(now) }), { paused: true });
    assert.equal(storage.alarm, null);
  });
});

describe("watchdogFailSince", () => {
  const now = KST("2026-10-09T12:05:00");
  const status = (lastCompletedAt, delay = 10000) => ({ ok: true, bootAt: now - 60 * MIN, meta: { lastCompletedAt, delay } });

  test("최근에 완료했으면 정상", () => {
    assert.equal(watchdogFailSince(status(now - 20000), now), null);
  });

  test("3분 넘게 완료가 없으면 마지막 완료 시각부터 멈춘 것으로 보고 바로 알린다", () => {
    const last = now - 3 * MIN - 1000;
    assert.equal(watchdogFailSince(status(last), now), last);
    assert.equal(trackFailure(null, last, now).event, "alert");
  });

  test("간격이 5분으로 늘어난 정상 상태는 멈춤이 아니다", () => {
    assert.equal(watchdogFailSince(status(now - 5 * MIN, 300000), now), null);
    assert.notEqual(watchdogFailSince(status(now - 6 * MIN - 1000, 300000), now), null);
  });

  test("완료 기록이 없으면 최초 시각을 기준으로 본다", () => {
    assert.equal(watchdogFailSince({ ok: true, bootAt: now - MIN, meta: null }, now), null);
    assert.equal(watchdogFailSince({ ok: true, bootAt: now - 4 * MIN, meta: null }, now), now - 4 * MIN);
  });

  test("호출 실패는 3분 유예 뒤에 알린다", () => {
    let r = trackFailure(null, watchdogFailSince({ ok: false }, now), now);
    assert.equal(r.event, null);
    r = trackFailure(r.state, watchdogFailSince({ ok: false }, now + 2 * MIN), now + 2 * MIN);
    assert.equal(r.event, null);
    r = trackFailure(r.state, watchdogFailSince({ ok: false }, now + 3 * MIN), now + 3 * MIN);
    assert.equal(r.event, "alert");
  });
});

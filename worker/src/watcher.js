// 빈자리 감시 루프를 도는 Durable Object. 알람이 다음 알람을 예약하며 10초(야간 30초)마다 실행된다.
// 로직은 core.js 에 있고, 여기서는 Durable Object 저장소를 연결만 한다.
import { DurableObject } from "cloudflare:workers";
import { ensureLoop, runCycle } from "./core.js";

export class Watcher extends DurableObject {
  async alarm() {
    await runCycle({ storage: this.ctx.storage, env: this.env, clock: Date.now, random: Math.random });
  }

  async ensure() {
    return ensureLoop({ storage: this.ctx.storage, env: this.env, clock: Date.now });
  }
}

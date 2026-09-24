import sharp from "sharp";

/**
 * In-memory kie.ai market API + result file host. createTask → a task that is
 * "generating" for N polls then "success" with a downloadable JPEG.
 */
export class FakeKie {
  tasks = new Map<string, { model: string; input: Record<string, any>; polls: number; key: string; fail?: string }>();
  credits: Record<string, number> = {};
  createCalls: Array<{ key: string; model: string; input: Record<string, any> }> = [];
  pollsBeforeDone = 1;
  /** Keys that answer 402 (out of credits). */
  brokeKeys = new Set<string>();
  /** Next N tasks end in state "fail". */
  failNextTasks = 0;
  /** Next N createTask calls answer HTTP 200 with an error envelope. */
  envelopeErrors = 0;
  private seq = 0;
  private image?: Buffer;

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const key = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace("Bearer ", "");
    if (url.hostname === "files.fake-kie.test") {
      this.image ??= await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 30, g: 90, b: 160 } } })
        .composite([{ input: Buffer.from(`<svg width="1080" height="1350"><circle cx="540" cy="600" r="300" fill="#f5c542"/></svg>`) }])
        .jpeg()
        .toBuffer();
      return new Response(new Uint8Array(this.image), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (url.pathname === "/api/v1/jobs/createTask") {
      if (this.brokeKeys.has(key)) return j({ code: 402, msg: "Credits insufficient" });
      if (this.envelopeErrors > 0) {
        this.envelopeErrors--;
        return j({ code: 422, msg: "Invalid input" });
      }
      const body = JSON.parse(String(init?.body));
      const taskId = `task_${++this.seq}`;
      this.createCalls.push({ key, model: body.model, input: body.input });
      const fail = this.failNextTasks > 0 ? (this.failNextTasks--, "content policy") : undefined;
      this.tasks.set(taskId, { model: body.model, input: body.input, polls: 0, key, fail });
      return j({ code: 200, msg: "success", data: { taskId } });
    }
    if (url.pathname === "/api/v1/jobs/recordInfo") {
      const t = this.tasks.get(url.searchParams.get("taskId") ?? "");
      if (!t || t.key !== key) return j({ code: 404, msg: "task not found" });
      t.polls++;
      if (t.polls <= this.pollsBeforeDone) return j({ code: 200, data: { taskId: "x", state: "generating" } });
      if (t.fail) return j({ code: 200, data: { state: "fail", failCode: "501", failMsg: t.fail } });
      return j({
        code: 200,
        data: { state: "success", resultJson: JSON.stringify({ resultUrls: [`https://files.fake-kie.test/${this.seq}.jpg`] }), creditsConsumed: 18, costTime: 12000 },
      });
    }
    if (url.pathname === "/api/v1/chat/credit") return j({ code: 200, data: this.credits[key] ?? 1000 });
    return j({ code: 404, msg: "no route" });
  };
}

const j = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

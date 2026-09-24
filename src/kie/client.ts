import { sleep, type FetchLike } from "../lib/async.js";
import { PermanentError, RateLimitedError, TransientError } from "../lib/errors.js";

/**
 * kie.ai market API client. Ported from ~/Projects/kickshot/src/kie.mjs and
 * ~/Projects/kie-mcp: `{code, msg, data}` envelope where code !== 200 is an
 * error even on HTTP 200, and 402 (out of credits) fails over to the next key.
 * Endpoints: docs/RESEARCH.md §3.
 */

export class KieError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "KieError";
  }
}

export type KieState = "waiting" | "queuing" | "generating" | "success" | "fail";

export interface KieTask {
  taskId: string;
  state: KieState;
  resultUrls: string[];
  failCode?: string;
  failMsg?: string;
  creditsConsumed?: number;
  costTimeMs?: number;
}

export interface KieClientOptions {
  keys: string[];
  baseUrl?: string;
  uploadBaseUrl?: string;
  fetchImpl?: FetchLike;
  pollDelaysMs?: number[];
  timeoutMs?: number;
}

export class KieClient {
  private readonly keys: string[];
  private readonly base: string;
  private readonly uploadBase: string;
  private readonly f: FetchLike;
  private readonly pollDelays: number[];
  private readonly timeoutMs: number;

  constructor(o: KieClientOptions) {
    if (!o.keys.length) throw new PermanentError("No kie.ai API key configured (KIE_API_KEY)");
    this.keys = o.keys;
    this.base = (o.baseUrl ?? "https://api.kie.ai").replace(/\/$/, "");
    this.uploadBase = (o.uploadBaseUrl ?? "https://kieai.redpandaai.co").replace(/\/$/, "");
    this.f = o.fetchImpl ?? fetch;
    this.pollDelays = o.pollDelaysMs ?? [3000, 4000, 6000, 8000, 10000, 12000, 15000];
    this.timeoutMs = o.timeoutMs ?? 10 * 60_000;
  }

  private async callWith<T>(keyIndex: number, base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.f(base + path, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${this.keys[keyIndex]}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new TransientError(`kie ${path}: network error ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: { code?: number; msg?: string; data?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      json = { msg: text.slice(0, 200) };
    }
    const code = typeof json.code === "number" ? json.code : res.status;
    if (res.ok && code === 200) return json.data as T;
    const msg = `kie ${init.method ?? "GET"} ${path} → ${code}: ${json.msg ?? text.slice(0, 200)}`;
    if (code === 402) throw new KieError(msg, 402);
    if (code === 429) throw new RateLimitedError(msg, 15_000);
    if (code === 455 || code >= 500) throw new TransientError(msg);
    throw new PermanentError(msg, { code });
  }

  /** Try each key in turn when the current one is out of credits. */
  private async call<T>(base: string, path: string, init: { method?: string; body?: unknown } = {}, prefer?: number): Promise<{ data: T; keyIndex: number }> {
    const order = prefer !== undefined ? [prefer, ...this.keys.map((_, i) => i).filter((i) => i !== prefer)] : this.keys.map((_, i) => i);
    let last: unknown;
    for (const i of order) {
      try {
        return { data: await this.callWith<T>(i, base, path, init), keyIndex: i };
      } catch (e) {
        last = e;
        if (!(e instanceof KieError && e.code === 402)) throw e;
      }
    }
    throw new PermanentError(`All kie.ai keys are out of credits: ${(last as Error)?.message}`);
  }

  async createTask(model: string, input: Record<string, unknown>, callBackUrl?: string): Promise<{ taskId: string; keyIndex: number }> {
    const r = await this.call<{ taskId?: string }>(this.base, "/api/v1/jobs/createTask", {
      method: "POST",
      body: { model, input, ...(callBackUrl ? { callBackUrl } : {}) },
    });
    if (!r.data?.taskId) throw new TransientError("kie createTask returned no taskId");
    return { taskId: r.data.taskId, keyIndex: r.keyIndex };
  }

  async getTask(taskId: string, keyIndex?: number): Promise<KieTask> {
    // A task is only visible to the key that created it; try that one first.
    const order = keyIndex !== undefined ? [keyIndex, ...this.keys.map((_, i) => i).filter((i) => i !== keyIndex)] : this.keys.map((_, i) => i);
    let last: unknown;
    for (const i of order) {
      try {
        const d = await this.callWith<RecordInfo>(i, this.base, `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
        return parseRecord(taskId, d);
      } catch (e) {
        last = e;
        if (e instanceof TransientError) throw e;
      }
    }
    throw last;
  }

  async waitForTask(taskId: string, keyIndex?: number): Promise<KieTask> {
    const deadline = Date.now() + this.timeoutMs;
    for (let i = 0; ; i++) {
      const t = await this.getTask(taskId, keyIndex);
      if (t.state === "success") {
        if (!t.resultUrls.length) throw new PermanentError(`kie task ${taskId} succeeded with no result URLs`);
        return t;
      }
      if (t.state === "fail") throw new PermanentError(`kie task ${taskId} failed: ${t.failMsg ?? t.failCode ?? "unknown"}`);
      if (Date.now() > deadline) throw new TransientError(`kie task ${taskId} still ${t.state} after ${this.timeoutMs}ms`);
      await sleep(this.pollDelays[Math.min(i, this.pollDelays.length - 1)]);
    }
  }

  async credits(): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < this.keys.length; i++) {
      try {
        out.push(Number(await this.callWith<number>(i, this.base, "/api/v1/chat/credit")));
      } catch {
        out.push(NaN);
      }
    }
    return out;
  }

  /** Re-host a public URL on kie's temporary storage (24h) when a model cannot fetch the original. */
  async uploadFromUrl(fileUrl: string, fileName: string): Promise<string> {
    const r = await this.call<{ downloadUrl?: string; fileUrl?: string }>(this.uploadBase, "/api/file-url-upload", {
      method: "POST",
      body: { fileUrl, uploadPath: "ai-instagram-agent", fileName },
    });
    const url = r.data?.downloadUrl ?? r.data?.fileUrl;
    if (!url) throw new TransientError("kie upload returned no URL");
    return url;
  }
}

interface RecordInfo {
  taskId?: string;
  state?: KieState;
  resultJson?: string | { resultUrls?: string[] };
  failCode?: string | number;
  failMsg?: string;
  creditsConsumed?: number;
  costTime?: number;
}

export function parseRecord(taskId: string, d: RecordInfo): KieTask {
  let result: { resultUrls?: string[] } | undefined;
  if (typeof d.resultJson === "string" && d.resultJson) {
    try {
      result = JSON.parse(d.resultJson);
    } catch {
      result = undefined;
    }
  } else if (d.resultJson && typeof d.resultJson === "object") {
    result = d.resultJson;
  }
  return {
    taskId,
    state: d.state ?? "waiting",
    resultUrls: result?.resultUrls ?? [],
    failCode: d.failCode !== undefined ? String(d.failCode) : undefined,
    failMsg: d.failMsg,
    creditsConsumed: d.creditsConsumed,
    costTimeMs: d.costTime,
  };
}

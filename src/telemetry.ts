import { request as httpsRequest } from "node:https";
import { object } from "./engine";

export const TELEMETRY_ENDPOINT = "https://telemetry.outerspace.sh/";
const OPERATIONS = new Set(["inspect", "history_list", "history_show", "history_diff", "capture_session", "generate_rest", "generate_mcp"]);
const OUTCOMES = new Set(["success", "refused", "failed"]);
const exact = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Project only the closed, identifier-free engine report onto the wire. */
export function usagePayload(preview: unknown): string | undefined {
    try {
        if (!object(preview) || preview.collection_enabled !== true || typeof preview.payload !== "string" || Buffer.byteLength(preview.payload) > 16384) { return; }
        const report: unknown = JSON.parse(preview.payload);
        if (!object(report) || !exact(report, ["schema_version", "context", "events"]) || report.schema_version !== "apizr.telemetry/v1" || report.context !== "vscode" || !Array.isArray(report.events) || !report.events.length || report.events.length > 32) { return; }
        const seen = new Set<string>();
        const events: { operation: string; outcome: string; count: number }[] = [];
        let total = 0;
        for (const event of report.events) {
            if (!object(event) || !exact(event, ["operation", "outcome", "count"]) || typeof event.operation !== "string" || !OPERATIONS.has(event.operation) || typeof event.outcome !== "string" || !OUTCOMES.has(event.outcome) || typeof event.count !== "number" || !Number.isSafeInteger(event.count) || event.count < 1 || event.count > 1000) { return; }
            const key = event.operation + ":" + event.outcome;
            total += event.count;
            if (seen.has(key) || total > 1000) { return; }
            seen.add(key);
            events.push({ operation: event.operation, outcome: event.outcome, count: event.count });
        }
        return JSON.stringify({ schema_version: "apizr.telemetry/v1", context: "vscode", events });
    } catch { return; }
}

/** One HTTPS attempt, with verified TLS, no redirect, retry, cookie or response log. */
export function postReport(payload: string, signal: AbortSignal, request: typeof httpsRequest = httpsRequest, timeoutMs = 3000): Promise<boolean> {
    const body = usagePayload({ collection_enabled: true, payload });
    if (!body || signal.aborted) { return Promise.resolve(false); }
    return new Promise(resolve => {
        let settled = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (accepted: boolean) => {
            if (settled) { return; }
            settled = true;
            if (deadline) { clearTimeout(deadline); }
            resolve(accepted);
        };
        try {
            const req = request(TELEMETRY_ENDPOINT, {
                method: "POST", agent: false, rejectUnauthorized: true, maxHeaderSize: 8192, signal,
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
            }, response => {
                response.on("error", () => finish(false));
                response.on("aborted", () => finish(false));
                response.on("data", () => { finish(false); response.destroy(); });
                response.on("end", () => finish(response.statusCode === 204 && !signal.aborted));
                response.resume();
            });
            req.on("error", () => finish(false));
            deadline = setTimeout(() => { finish(false); req.destroy(); }, timeoutMs);
            req.end(body);
        } catch { finish(false); }
    });
}

type Sender = (payload: string, signal: AbortSignal) => Promise<boolean>;
type Pending = { payload: string; resolve: (accepted: boolean) => void };

/** A small memory-only queue; opting out drops pending reports and aborts I/O. */
export class UsageTelemetry {
    private readonly queue: Pending[] = [];
    private current: AbortController | undefined;
    private running = false;
    private disposed = false;
    lastDelivery: "none" | "accepted" | "failed" = "none";
    constructor(private readonly allowed: () => boolean, private readonly send: Sender = postReport) {}
    submit(preview: unknown): Promise<boolean> {
        const payload = usagePayload(preview);
        if (this.disposed || !this.allowed() || !payload || this.queue.length >= 8) { return Promise.resolve(false); }
        return new Promise(resolve => { this.queue.push({ payload, resolve }); void this.drain(); });
    }
    clear(): void {
        this.current?.abort();
        for (const item of this.queue.splice(0)) { item.resolve(false); }
        this.lastDelivery = "none";
    }
    dispose(): void { this.disposed = true; this.clear(); }
    private async drain(): Promise<void> {
        if (this.running) { return; }
        this.running = true;
        try {
            while (this.queue.length) {
                if (this.disposed || !this.allowed()) { this.clear(); break; }
                const item = this.queue.shift()!;
                const controller = new AbortController();
                this.current = controller;
                let accepted = false;
                try { accepted = await this.send(item.payload, controller.signal); } catch { /* Usage delivery never changes an editor result. */ }
                accepted = accepted && !controller.signal.aborted && !this.disposed && this.allowed();
                if (!controller.signal.aborted) { this.lastDelivery = accepted ? "accepted" : "failed"; }
                item.resolve(accepted);
                this.current = undefined;
            }
        } finally { this.running = false; }
    }
}

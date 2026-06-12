import type { Request, Response } from "express";
import type { JobRun } from "../jobs/types.js";

export interface RunEventStream {
  subscribe(req: Request, res: Response): void;
}

export class RunEventHub implements RunEventStream {
  private readonly clients = new Set<Response>();
  private readonly heartbeat?: ReturnType<typeof setInterval>;
  private nextId = 1;

  constructor(heartbeatMs = 25000) {
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 0) {
      throw new Error("[RunEventHub.constructor] heartbeatMs must be a non-negative integer");
    }
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
      this.heartbeat.unref();
    }
  }

  subscribe(req: Request, res: Response): void {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    this.clients.add(res);
    this.write(res, "retry: 5000\n: connected\n\n");
    req.on("close", () => this.clients.delete(res));
  }

  publishRun(run: JobRun): void {
    if (!run || typeof run.id !== "string") throw new Error("[RunEventHub.publishRun] run is required");
    this.publish("runs", { runId: run.id, status: run.status, at: new Date().toISOString() });
  }

  close(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private publish(event: string, data: Record<string, unknown>): void {
    const body = [
      `id: ${this.nextId++}`,
      `event: ${event}`,
      `data: ${JSON.stringify(data)}`,
      "",
      "",
    ].join("\n");
    for (const res of [...this.clients]) this.write(res, body);
  }

  private ping(): void {
    for (const res of [...this.clients]) this.write(res, ": ping\n\n");
  }

  private write(res: Response, message: string): void {
    try {
      res.write(message);
    } catch {
      this.clients.delete(res);
    }
  }
}

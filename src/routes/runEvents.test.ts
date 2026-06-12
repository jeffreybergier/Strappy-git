import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { RunEventHub } from "./runEvents.js";
import type { JobRun } from "../jobs/types.js";

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  writes: string[];
  ended: boolean;
  flushed: boolean;
  status(code: number): FakeResponse;
  set(headers: Record<string, string>): FakeResponse;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
}

function fakeReq(): EventEmitter & Request {
  return new EventEmitter() as EventEmitter & Request;
}

function fakeRes(): FakeResponse & Response {
  const res: FakeResponse = {
    statusCode: 0,
    headers: {},
    writes: [],
    ended: false,
    flushed: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      this.headers = { ...this.headers, ...headers };
      return this;
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(chunk) {
      this.writes.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
  return res as FakeResponse & Response;
}

function run(id: string, status: JobRun["status"]): JobRun {
  return { id, jobId: "j", status, startedAt: "2026-06-12T00:00:00.000Z", stepRuns: [] };
}

function eventData(message: string): Record<string, unknown> {
  const line = message.split("\n").find((l) => l.startsWith("data: "));
  if (line === undefined) throw new Error("missing data line");
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

test("RunEventHub subscribes a response as an SSE stream", () => {
  const hub = new RunEventHub(0);
  const res = fakeRes();
  hub.subscribe(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res.flushed, true);
  assert.equal(res.writes[0], "retry: 5000\n: connected\n\n");
  hub.close();
});

test("RunEventHub publishes run updates to subscribed clients", () => {
  const hub = new RunEventHub(0);
  const res = fakeRes();
  hub.subscribe(fakeReq(), res);
  hub.publishRun(run("r1", "running"));
  const message = res.writes.at(-1) ?? "";
  assert.match(message, /^id: 1\n/m);
  assert.match(message, /^event: runs\n/m);
  assert.deepEqual(
    { runId: eventData(message).runId, status: eventData(message).status },
    { runId: "r1", status: "running" },
  );
  hub.close();
});

test("RunEventHub drops clients when the request closes", () => {
  const hub = new RunEventHub(0);
  const req = fakeReq();
  const res = fakeRes();
  hub.subscribe(req, res);
  req.emit("close");
  hub.publishRun(run("r2", "succeeded"));
  assert.equal(res.writes.length, 1);
  hub.close();
});

test("RunEventHub closes subscribed responses", () => {
  const hub = new RunEventHub(0);
  const res = fakeRes();
  hub.subscribe(fakeReq(), res);
  hub.close();
  assert.equal(res.ended, true);
});

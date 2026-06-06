import { test } from "node:test";
import assert from "node:assert/strict";
import { SequentialQueue } from "./queue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("SequentialQueue runs items one at a time, in FIFO order", async () => {
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const queue = new SequentialQueue<number>(async (n) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${n}`);
    await delay(5);
    events.push(`end:${n}`);
    active -= 1;
  });
  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);
  await queue.whenIdle();
  assert.deepEqual(events, ["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
  assert.equal(maxActive, 1);
});

test("SequentialQueue keeps draining after a handler throws", async () => {
  const done: number[] = [];
  const queue = new SequentialQueue<number>(async (n) => {
    if (n === 2) throw new Error("boom");
    done.push(n);
  });
  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);
  await queue.whenIdle();
  assert.deepEqual(done, [1, 3]);
});

test("SequentialQueue rejects a non-function handler", () => {
  assert.throws(() => new SequentialQueue(undefined as never), /handler must be a function/);
});

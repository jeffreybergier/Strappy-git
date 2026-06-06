import { createLogger } from "../logger.js";

const log = createLogger("JobQueue");

// Runs enqueued items one at a time in FIFO order. Each enqueue appends to a
// promise chain, so handlers never overlap no matter how fast items arrive. A
// throwing handler is logged and does not stall the queue.
export class SequentialQueue<T> {
  private readonly items: T[] = [];
  private readonly handler: (item: T) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();

  constructor(handler: (item: T) => Promise<void>) {
    if (typeof handler !== "function") throw new Error("[SequentialQueue] handler must be a function");
    this.handler = handler;
  }

  get size(): number {
    return this.items.length;
  }

  enqueue(item: T): void {
    this.items.push(item);
    this.chain = this.chain.then(() => this.runNext());
  }

  // Resolves once everything enqueued so far has finished draining.
  whenIdle(): Promise<void> {
    return this.chain;
  }

  private async runNext(): Promise<void> {
    const item = this.items.shift();
    if (item === undefined) return;
    try {
      await this.handler(item);
    } catch (error) {
      log.error("runNext", "handler failed", error);
    }
  }
}

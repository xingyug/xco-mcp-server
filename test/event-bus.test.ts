import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEventBus } from "../src/lib/event-bus.js";

describe("createEventBus", () => {
  it("delivers events to subscribers", () => {
    const bus = createEventBus();
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe((event) => received.push(event));

    bus.emit({ type: "test", value: 1 });
    bus.emit({ type: "test", value: 2 });

    assert.equal(received.length, 2);
    assert.equal(received[0].value, 1);
    assert.equal(received[1].value, 2);
  });

  it("supports multiple subscribers", () => {
    const bus = createEventBus();
    let countA = 0;
    let countB = 0;
    bus.subscribe(() => countA++);
    bus.subscribe(() => countB++);

    bus.emit({ type: "ping" });

    assert.equal(countA, 1);
    assert.equal(countB, 1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createEventBus();
    let count = 0;
    const unsub = bus.subscribe(() => count++);

    bus.emit({ type: "a" });
    unsub();
    bus.emit({ type: "b" });

    assert.equal(count, 1);
  });

  it("isolates listener errors from other subscribers", () => {
    const bus = createEventBus();
    const received: string[] = [];

    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((event) => received.push(event.type as string));

    bus.emit({ type: "test" });

    assert.equal(received.length, 1);
    assert.equal(received[0], "test");
  });

  it("works with zero subscribers", () => {
    const bus = createEventBus();
    // Should not throw
    bus.emit({ type: "lonely" });
  });
});

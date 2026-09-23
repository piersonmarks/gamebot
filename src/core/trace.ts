import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TraceEvent, TraceSink } from "./types.js";

/** Serializes a session's events into inspectable JSON Lines. */
export class FileTraceSink implements TraceSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  record(event: TraceEvent): Promise<void> {
    const write = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`);
    });
    this.tail = write.catch(() => undefined);
    return write;
  }
}

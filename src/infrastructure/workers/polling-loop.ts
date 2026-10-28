import { errorFields, type Logger } from '../../observability/logger';

/**
 * Runs `tick` repeatedly with a pause between iterations. `stop()` resolves after the
 * in-flight iteration finished, so shutdown never interrupts a unit of work midway.
 * When a tick reports it did work, the next one starts immediately (drains backlogs).
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
    this.logger.info({ worker: this.name }, 'worker started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.current;
    this.logger.info({ worker: this.name }, 'worker stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (error) {
        this.logger.error({ ...errorFields(error), worker: this.name }, 'worker iteration failed');
      }
      if (!this.running) break;
      if (!didWork) await this.pause(this.intervalMs);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

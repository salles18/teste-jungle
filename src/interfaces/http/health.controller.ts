import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Metrics } from '../../observability/metrics';
import { Public } from './auth';

export interface ReadinessCheck {
  name: string;
  check(): Promise<'up' | 'skipped'>;
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  /** Process is alive and the event loop responds. No dependency checks on purpose. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL and SQS reachable. 503 when any dependency is down. No internals exposed. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: string; checks: Record<string, string> }> {
    const results: Record<string, string> = {};
    let ok = true;
    await Promise.all(
      this.checks.map(async (c) => {
        try {
          results[c.name] = await withTimeout(c.check(), 2000);
        } catch {
          results[c.name] = 'down';
          ok = false;
        }
      }),
    );
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: results };
  }
}

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  @Get()
  @ApiExcludeEndpoint()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

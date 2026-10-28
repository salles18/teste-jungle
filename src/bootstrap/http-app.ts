import 'reflect-metadata';
import { type DynamicModule, type INestApplication, type LoggerService, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ProcessWagerTransactionUseCase } from '../application/wagering/process-wager-transaction';
import { WalletUseCases } from '../application/wallet/wallet-use-cases';
import { pingSqs } from '../infrastructure/sqs/sqs';
import { AuthGuard, NoAuthProviderIdentity, PROVIDER_IDENTITY } from '../interfaces/http/auth';
import { WageringController, WalletsController } from '../interfaces/http/controllers';
import { correlationMiddleware } from '../interfaces/http/correlation.middleware';
import { HealthController, MetricsController, READINESS_CHECKS, type ReadinessCheck } from '../interfaces/http/health.controller';
import { HttpErrorFilter } from '../interfaces/http/http-error.filter';
import type { Logger } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import type { Container } from './container';
import type { Runtime } from './runtime';

@Module({})
class AppModule {
  static register(container: Container, readiness: ReadinessCheck[]): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: WalletUseCases, useValue: container.wallets },
        { provide: ProcessWagerTransactionUseCase, useValue: container.wagers },
        { provide: Metrics, useValue: container.metrics },
        { provide: READINESS_CHECKS, useValue: readiness },
        { provide: PROVIDER_IDENTITY, useValue: new NoAuthProviderIdentity() },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}

class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown): void {
    this.logger.debug({ source: 'nest' }, String(message));
  }
  error(message: unknown, trace?: string): void {
    this.logger.error({ source: 'nest', trace }, String(message));
  }
  warn(message: unknown): void {
    this.logger.warn({ source: 'nest' }, String(message));
  }
  debug(message: unknown): void {
    this.logger.debug({ source: 'nest' }, String(message));
  }
  verbose(message: unknown): void {
    this.logger.trace({ source: 'nest' }, String(message));
  }
}

export function readinessChecks(container: Container, runtime: Runtime | null): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    {
      name: 'postgres',
      check: async () => {
        await container.orm.em.fork().getConnection().execute('SELECT 1');
        return 'up';
      },
    },
  ];
  checks.push({
    name: 'sqs',
    check: async () => {
      if (!runtime?.sqs) return 'skipped';
      await pingSqs(runtime.sqs, 1500);
      if (!runtime.queueUrls) throw new Error('queues not resolved');
      return 'up';
    },
  });
  return checks;
}

export async function createHttpApp(container: Container, runtime: Runtime | null): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(container, readinessChecks(container, runtime)), {
    logger: new NestPinoLogger(container.logger),
    bodyParser: true,
  });
  app.use(correlationMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: false }));
  app.useGlobalFilters(new HttpErrorFilter(container.logger));

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Jungle Wallet')
      .setDescription('Wallet & wagering ledger. Money is always a decimal string with two decimals.')
      .setVersion('1.0.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
  return app;
}

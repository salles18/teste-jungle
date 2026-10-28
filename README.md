# Jungle Wallet — carteira e ledger de apostas

Serviço de carteira para provedores de jogos: recebe instruções financeiras (BET, WIN, LOSS, REFUND, ROLLBACK) por **HTTP** e por **SQS FIFO**, aplica-as com integridade garantida pelo **PostgreSQL** e publica eventos de integração por **Transactional Outbox**.

- **Stack:** Bun 1.3 · TypeScript (strict) · NestJS 11 · MikroORM 6 · PostgreSQL · AWS SDK v3 (SQS) · LocalStack · prom-client · pino
- **Dinheiro:** sempre string decimal com duas casas (`"80.00"`), `NUMERIC(20,2)` no banco, `decimal.js` no domínio. Nunca `number`.
- **Concorrência:** `SELECT … FOR UPDATE` na wallet; idempotência e invariantes no banco (constraints + triggers).

Decisões e garantias em detalhe: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Pré-requisitos

| Ferramenta | Versão | Observação |
|---|---|---|
| Bun | ≥ 1.3.0 (testado com 1.3.1) | `npm i -g bun` ou https://bun.sh |
| Docker + Compose v2 | recente | PostgreSQL 17 e LocalStack 4.7 |

Nenhuma credencial AWS real é necessária: o LocalStack aceita credenciais fictícias (`test`/`test`). Fora de `NODE_ENV=production` o endpoint SQS padrão é `http://localhost:4566`, então o serviço nunca fala com a AWS real por engano.

## Setup rápido

```bash
cp .env.example .env          # Bun carrega .env automaticamente
bun install --frozen-lockfile
bun run setup                 # docker compose up (postgres + localstack) + migrations + filas
bun run start                 # API em http://localhost:3000, Swagger em /docs
```

`bun run setup` equivale a:

```bash
bun run infra:up              # docker compose up -d --wait postgres localstack
bun run db:migrate            # aplica as migrations
bun run queues:setup          # cria as filas FIFO (idempotente)
```

Dados de demonstração determinísticos (idempotente): `bun run seed`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run infra:up` / `infra:down` | sobe / derruba (com volumes) PostgreSQL e LocalStack |
| `bun run db:migrate` | aplica migrations pendentes |
| `bun run db:rollback` | reverte a última migration |
| `bun run db:fresh` | reverte tudo e reaplica (banco vazio) |
| `bun run db:status` | migrations executadas / pendentes |
| `bun run queues:setup` | cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wallet-events.fifo` |
| `bun run start` / `dev` | sobe a aplicação (HTTP + consumer SQS + publisher da outbox + worker de referências) |
| `bun run seed` | cria 3 wallets de demonstração |
| `bun run demo:concurrency` | cenário 100.00 × 2 apostas de 80.00 contra a API em execução |
| `bun run test:unit` | testes de unidade (sem dependências externas) |
| `bun run test:integration` | integração com PostgreSQL real (+ SQS real se LocalStack estiver no ar) |
| `bun run test:concurrency` | concorrência real, inclusive 3 processos independentes |
| `bun run test` | as três suítes acima (sem SQS, os cenários de SQS aparecem como `skip`) |
| `bun run test:required` | as três suítes com `REQUIRE_SQS=1`: **falha** se o SQS não estiver acessível |
| `bun run validate` | validação completa da entrega; falha (exit ≠ 0) se faltar Docker, PostgreSQL ou LocalStack (ver abaixo) |
| `bun run typecheck` / `lint` / `format` | `tsc --noEmit`, Biome |

Três instâncias da aplicação em containers (portas 3001-3003): `docker compose --profile app up -d --build`.

## Papéis do processo

Cada processo pode executar qualquer combinação de papéis (padrão: todos):

| Variável | Papel |
|---|---|
| `RUN_HTTP` | API HTTP |
| `RUN_SQS_CONSUMER` | consome `wager-transactions.fifo` |
| `RUN_OUTBOX_PUBLISHER` | publica a outbox em `wallet-events.fifo` |
| `RUN_PENDING_REFERENCE_WORKER` | reprocessa `PENDING_REFERENCE` |

Todos são seguros com N instâncias simultâneas. Se o SQS estiver fora do ar no boot, os papéis SQS ficam tentando em background e `/health/ready` responde 503.

## Variáveis de ambiente

Lista completa e comentada em [.env.example](.env.example). As principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgresql://jungle:jungle@localhost:5432/jungle_wallet` | banco da aplicação |
| `TEST_DATABASE_URL` | `…/jungle_wallet_test` | banco dos testes (recriado a cada arquivo de teste) |
| `DB_LOCK_TIMEOUT_MS` | 5000 | `SET LOCAL lock_timeout` de cada transação |
| `TX_RETRY_MAX_ATTEMPTS` | 5 | retries de deadlock / lock timeout / corrida de inserção |
| `SUPPORTED_CURRENCIES` | `BRL` | moedas habilitadas (o domínio conhece outras) |
| `SQS_ENDPOINT` | `http://localhost:4566` (fora de produção) | LocalStack |
| `SQS_MAX_ATTEMPTS` | 5 | tentativas do consumer antes da DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` / `_TTL_MS` | 10 / 1h | orçamento de espera por referência |

## API

Swagger UI: `http://localhost:3000/docs` (JSON em `/docs-json`).

| Método | Rota | |
|---|---|---|
| POST | `/wallets` | cria a wallet (saldo inicial > 0 gera OPENING + CREDIT na mesma transação) |
| GET | `/wallets/:walletId` | saldo e versão |
| GET | `/wallets/:walletId/ledger?cursor=…&limit=50` | lançamentos, mais recentes primeiro, cursor opaco |
| POST | `/wallets/:walletId/reconciliation` | saldo materializado × ledger |
| POST | `/wagering/transactions` | BET/WIN/LOSS/REFUND/ROLLBACK (header `Idempotency-Key` obrigatório) |
| GET | `/wagering/transactions/:transactionId` | por id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | por identidade externa |
| GET | `/health/live` · `/health/ready` | liveness · readiness (PostgreSQL + SQS) |
| GET | `/metrics` | Prometheus |

### Contrato de status (POST /wagering/transactions)

| Status | Quando | Corpo |
|---|---|---|
| **201** | transação nova, `PROCESSED` | transação |
| **200** | replay idempotente de `PROCESSED` (`idempotentReplay: true`, header `Idempotent-Replay: true`) | transação original |
| **202** | `PENDING_REFERENCE` (referência ainda não chegou) | transação |
| **400** | `VALIDATION_FAILED`: corpo inválido, `Idempotency-Key` ausente/inválida, `kind: OPENING`, valor numérico/sem 2 casas | erro |
| **404** | `WALLET_NOT_FOUND` | erro |
| **409** | `IDEMPOTENCY_KEY_REUSED` (mesma chave, payload diferente) · `EXTERNAL_TRANSACTION_CONFLICT` (mesmo `externalTransactionId`, outra chave) | erro |
| **422** | rejeição de negócio: a transação `REJECTED` com `failureCode` — ou erro `PLAYER_WALLET_MISMATCH` / `CURRENCY_MISMATCH` / `CURRENCY_NOT_SUPPORTED` | transação ou erro |
| **503** | `TRANSIENT_INFRASTRUCTURE_FAILURE` (+ `Retry-After`): repita com a **mesma** chave | erro |

Formato de erro: `{ "error": { "code", "message", "details"? }, "correlationId" }`. Rejeições de negócio nunca retornam 500.

`failureCode`s: `INSUFFICIENT_FUNDS`, `ROLLBACK_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_INVALID_KIND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_SELF`, `INTERNAL_INVARIANT_VIOLATION` (significados em [ARCHITECTURE.md §8](ARCHITECTURE.md#8-regras-financeiras-e-ambiguidades)).

### Exemplos curl

```bash
# criar wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-42","currency":"BRL","initialBalance":"100.00"}'
# => {"walletId":"<WALLET>","balance":"100.00","version":1,...}

WALLET=<walletId retornado>

# apostar
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: prov-bet-0001' \
  -d "{\"providerId\":\"prov\",\"externalTransactionId\":\"bet-0001\",\"walletId\":\"$WALLET\",
       \"playerId\":\"player-42\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",
       \"kind\":\"BET\",\"amount\":\"80.00\",\"currency\":\"BRL\"}"

# reembolsar a aposta (referência obrigatória)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: prov-refund-0001' \
  -d "{\"providerId\":\"prov\",\"externalTransactionId\":\"refund-0001\",\"walletId\":\"$WALLET\",
       \"playerId\":\"player-42\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"REFUND\",
       \"amount\":\"80.00\",\"currency\":\"BRL\",\"referenceExternalTransactionId\":\"bet-0001\"}"

# ledger (paginar com ?cursor=<nextCursor>)
curl -s "localhost:3000/wallets/$WALLET/ledger?limit=50"

# reconciliar
curl -s -X POST "localhost:3000/wallets/$WALLET/reconciliation"
# => {"materializedBalance":"100.00","ledgerBalance":"100.00","difference":"0.00","consistent":true,"checkedEntries":3,...}
```

### Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "idempotencyKey": "prov-bet-0001",
  "correlationId": "optional-trace-id",
  "transaction": { "...": "mesmo corpo do POST /wagering/transactions" }
}
```

`MessageGroupId` = `walletId` (ordem por wallet). `MessageDeduplicationId` recomendado = `idempotencyKey`. A deduplicação do broker (5 min) é só otimização; a garantia vem do PostgreSQL.

## Demonstração do cenário de concorrência

Com a API rodando (`bun run start`):

```bash
bun run demo:concurrency
# bet 201 PROCESSED            balanceAfter 20.00
# bet 422 REJECTED INSUFFICIENT_FUNDS balanceAfter 20.00
# ledger: OPENING CREDIT 100.00 (v1) + um único DEBIT 80.00 (v2)
# reconciliation { consistent: true, difference: "0.00", ... }
```

Para mandar as duas apostas a instâncias diferentes: `API_URL=http://localhost:3001 API_URL_2=http://localhost:3002 bun run demo:concurrency` (com o profile `app`).

Nos testes, o mesmo cenário roda em 25 wallets simultaneamente e também entre processos distintos (`test/concurrency`).

## Testes

```bash
bun run infra:up
bun run test:unit
bun run test:integration     # PostgreSQL real; SQS real se o LocalStack estiver no ar
bun run test:concurrency     # paralelismo real + 3 processos independentes
bun run test:required                   # = REQUIRE_SQS=1 bun run test: falha (em vez de marcar skip) se o SQS estiver indisponível
```

Sem SQS disponível, os cenários de SQS aparecem como `skip` no relatório. O que cada suíte cobre está em [ARCHITECTURE.md §14](ARCHITECTURE.md#14-estratégia-de-testes). Os testes de integração recriam o schema de `TEST_DATABASE_URL` (`DROP SCHEMA public CASCADE` + migrations) a cada arquivo — nunca aponte essa variável para um banco com dados.

## Validação completa da entrega

Numa máquina com Docker, a partir de um clone limpo:

```bash
git clone https://github.com/salles18/teste-jungle.git && cd teste-jungle
cp .env.example .env
bun install --frozen-lockfile
bun run validate
```

`bun run validate` ([scripts/validate-delivery.ts](scripts/validate-delivery.ts)) executa, nesta ordem, e para no primeiro erro com exit code ≠ 0:

1. Docker e Compose v2 presentes;
2. `docker compose up -d --wait postgres localstack` (espera os healthchecks);
3. o endpoint SQS **é o LocalStack** (`/_localstack/health`, com `sqs` ativo) — outros emuladores são recusados;
4. conexão com `jungle_wallet` e `jungle_wallet_test`;
5. migrations num banco vazio temporário: up, rollback total, up;
6. `db:migrate` e `queues:setup`;
7. `typecheck`, `lint`, `test:unit`, `test:integration` e `test:concurrency` com `REQUIRE_SQS=1`;
8. e2e contra o app real com todos os papéis: 100.00 × 2 apostas de 80.00 (201 + 422, saldo 20.00), 50 envios da mesma operação (1 criada + 49 replays), BET entregue por `wager-transactions.fifo`, evento da outbox chegando em `wallet-events.fifo` e reconciliação consistente.

Ao final imprime um resumo por etapa e `RESULTADO: VALIDADO` ou `RESULTADO: FALHOU em "<etapa>"`. Com a infraestrutura já de pé: `SKIP_DOCKER=1 bun run validate`.

Passo a passo equivalente, manual:

```bash
docker compose up -d --wait postgres localstack
curl -s localhost:4566/_localstack/health      # "sqs": "available" ou "running"
bun run db:migrate
bun run queues:setup
bun run typecheck && bun run lint
bun run test:required
bun run start &                                 # em outro terminal
curl -s localhost:3000/health/ready             # {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
bun run demo:concurrency
```

## Limitações conhecidas

- **Autenticação fora do escopo.** Há um `AuthGuard` com `ProviderIdentityPort` como ponto de extensão (implementação padrão permite tudo). Ver ARCHITECTURE.md §12.
- **Entrega de eventos é at-least-once.** Consumidores precisam deduplicar por `eventId`.
- **Ordem dos eventos publicados** é por wallet dentro de um lote; com vários publishers simultâneos, eventos da mesma wallet podem sair fora de ordem. Os eventos carregam `walletVersion` para reordenação no consumidor.
- **Uma moeda habilitada (BRL).** O domínio suporta moedas ISO-4217 de 2 casas; moedas de 0 ou 3 casas exigiriam escala por moeda.
- **Transações rejeitadas consomem a identidade externa:** reenviar um BET rejeitado com nova chave resulta em `EXTERNAL_TRANSACTION_CONFLICT` (decisão deliberada; ver ARCHITECTURE.md §7).
- Mensagens `DEAD` na outbox e na DLQ exigem reprocessamento manual (não há ferramenta de redrive).

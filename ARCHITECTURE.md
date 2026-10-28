# Arquitetura

Este documento registra as decisões, as garantias e onde cada uma é aplicada (domínio, aplicação ou banco). Quando uma garantia depende de mais de uma camada, isso está dito explicitamente.

## 1. Componentes

```
                ┌────────────── processo (N instâncias idênticas) ──────────────┐
 provider ─HTTP─▶ NestJS controllers ─┐                                          │
                │                     ├─▶ ProcessWagerTransactionUseCase ──┐     │
 provider ─SQS──▶ SqsWagerConsumer ───┘   (único caso de uso financeiro)   │     │
  (FIFO)        │   └ WagerMessageHandler (inbox)          ▲               │     │
                │                                          │               ▼     │
                │ PendingReference worker ─────────────────┘      UnitOfWork (MikroORM, │
                │                                                  fork por transação)  │
                │ OutboxPublisher ──SendMessageBatch──▶ wallet-events.fifo       │
                └───────────────────────────────┬──────────────────────────────┘
                                                ▼
                     PostgreSQL: wallets · wager_transactions · wallet_ledger_entries
                                 inbox_messages · outbox_messages
                                 (+ CHECK / UNIQUE / FK compostas / triggers)
```

Camadas (`src/`):

| Pasta | Responsabilidade | Depende de |
|---|---|---|
| `domain/` | `Money`, `Wallet` (aggregate root), `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, `IntegrationEvent`, `settleWagerTransaction` (regras) | nada (nem Nest, nem ORM) |
| `application/` | casos de uso, portas (`UnitOfWork`, repositórios, `Clock`), erros de aplicação, canonicalização/hash | domínio |
| `infrastructure/` | MikroORM (EntitySchema + mapeadores + repositórios), migrations, SQS, outbox, polling | aplicação |
| `interfaces/` | HTTP (Nest), contrato de entrada compartilhado HTTP/SQS | aplicação |
| `bootstrap/` | composition root (`container.ts`), runtime dos workers, app Nest | tudo |

As entidades do domínio têm construtor privado e fábricas (`create`/`open`/`opening`/`fromEvent`/`rehydrate`). `rehydrate` reconstrói o estado persistido sem reaplicar regras de transição — por exemplo, uma transação `PROCESSED` é reidratada sem passar por `markProcessed`. O ORM nunca vê as classes de domínio: os repositórios usam *records* (`infrastructure/database/entities.ts`) e mapeadores.

## 2. Bounded contexts

- **Wallet** — saldo materializado, versão, ledger imutável. Dono do invariante `saldo = Σ ledger`.
- **Wagering** — instruções dos provedores, estados, referências, idempotência. Decide *se* e *como* o saldo muda; delega o movimento à `Wallet`.
- **Messaging** — inbox (deduplicação de entregas) e outbox (publicação confiável). Não contém regras financeiras.

Wallet e Wagering compartilham a mesma transação SQL por decisão: o débito e o registro da instrução precisam ser atômicos, e a fronteira de consistência é a wallet.

## 3. Fluxo financeiro

```
POST /wagering/transactions  ─ ou ─  mensagem SQS
  │ valida contrato (mesmo validador nos dois canais) + Idempotency-Key
  │ fast path SEM lock: (provider, key) já existe? → replay / 409
  ▼
BEGIN (READ COMMITTED) ; SET LOCAL lock_timeout, statement_timeout
  [SQS] INSERT inbox ON CONFLICT DO NOTHING ; SELECT inbox FOR UPDATE → já concluída? ack
  SELECT wallet FOR UPDATE                     ← serializa tudo desta wallet
  re-checa idempotência (vê o que o dono anterior do lock commitou)
  valida coerência player/moeda
  resolve referência (mesma wallet ⇒ protegida pelo mesmo lock)
  settleWagerTransaction(): PROCESSED | REJECTED | PENDING_REFERENCE
  INSERT wager_transactions (estado final + snapshot do saldo)
  INSERT wallet_ledger_entries                 (se moveu dinheiro)
  UPDATE wallets … WHERE version = esperada    (guarda otimista extra)
  INSERT outbox_messages                       (eventos)
  UPDATE dependentes PENDING_REFERENCE → checar agora
  [SQS] UPDATE inbox → PROCESSED
COMMIT  ← triggers DEFERRED reverificam ledger × saldo × status
  [SQS] DeleteMessage (ack) somente aqui
```

## 4. Modelo de estados

`WagerTransaction`: `PENDING → {PENDING_REFERENCE, PROCESSED, REJECTED, FAILED}`, `PENDING_REFERENCE → {PENDING_REFERENCE, PROCESSED, REJECTED, FAILED}`. `PROCESSED`, `REJECTED` e `FAILED` são terminais — no domínio (`transition()` lança) **e** no banco (trigger `jw_wager_before_update` recusa qualquer UPDATE de linha terminal).

- `PENDING` só existe em memória: a linha é inserida já no estado decidido.
- `FAILED` (`INTERNAL_INVARIANT_VIOLATION`) é produzido quando o worker de referências encontra um erro **não transitório** ao reavaliar uma transação pendente; sem isso ela seria reprocessada para sempre.
- `OPENING` é interno (`provider_id = 'system'`, CHECK `ck_wager_opening_internal`); o contrato de entrada o rejeita com 400.

## 5. Estratégia de concorrência

**Unidade de concorrência: `walletId`.** Toda escrita que toca uma wallet começa com `SELECT … FOR UPDATE` na linha da wallet, dentro da transação, antes de ler saldo, idempotência ou referência.

Por que lock pessimista e não otimista puro: o caso típico (rajadas de apostas na mesma wallet, ex.: 2×80 sobre 100) com otimista vira tempestade de retries; com o lock, o segundo espera milissegundos e decide sobre dado commitado. O `UPDATE … WHERE version = expected` permanece como **segunda** linha de defesa: se algum caminho futuro esquecer o lock, o resultado é erro, não *lost update*.

Propriedades:

- **Sem lost update / débito duplicado / saldo negativo**: decisão e escrita acontecem sob o lock; `CHECK (balance >= 0)`; a trigger de wallet exige `version = old + 1` em toda mudança de saldo; `uq_ledger_wallet_version` impede dois lançamentos com a mesma versão.
- **Wallets diferentes em paralelo**: não há lock global; o teste `wallets are independent` mantém uma wallet travada e mostra outras dez sendo processadas.
- **Múltiplas instâncias**: nenhum estado no processo; tudo é linha no PostgreSQL. Testado com 3 processos.
- **Ordem de locks**: cada operação trava no máximo **uma** wallet; não há transferência entre wallets, então não há ciclo entre wallets. O consumer trava `inbox_messages` → `wallet`; nenhum caminho trava `wallet` → `inbox`. O worker de referências **não** usa `SKIP LOCKED` na linha da transação justamente para não inverter a ordem (lock da transação → lock da wallet), o que poderia gerar deadlock com o caminho principal, que atualiza dependentes sob o lock da wallet. Se um dia houver operações multi-wallet, elas devem travar em ordem crescente de `id`.
- **Deadlocks/erros transitórios**: `MikroOrmUnitOfWork` re-executa a closure inteira (nova transação, novo `EntityManager`) para `40P01`, `40001`, `55P03`, conexão perdida e corrida de inserção (`23505` nas chaves de idempotência), até `TX_RETRY_MAX_ATTEMPTS`, com backoff exponencial e jitter. É seguro porque a closure re-checa idempotência sob o lock — inclusive quando o COMMIT foi aplicado mas a resposta se perdeu. Esgotado, vira 503.
- **EntityManager**: `allowGlobalContext: false`; cada unidade de trabalho faz `orm.em.fork()`; leituras usam `disableIdentityMap` (nunca um objeto em cache de antes do lock). Nenhum EM atravessa operações concorrentes.

Cenário obrigatório (`test/concurrency/in-process.test.ts`, 25 wallets em paralelo; `multi-process.test.ts`, entre processos): saldo 100.00, duas apostas de 80.00 simultâneas → uma `PROCESSED` (201), uma `REJECTED/INSUFFICIENT_FUNDS` (422), saldo 20.00, exatamente um `DEBIT` no ledger.

## 6. Limites transacionais

| Operação | Uma transação SQL contém |
|---|---|
| criar wallet | wallet + transação OPENING + lançamento CREDIT + evento `WalletBalanceChanged` |
| transação via HTTP | transação + lançamento + wallet + eventos + wake-up de dependentes |
| mensagem SQS | **inbox** + tudo acima |
| worker de referência | reavaliação + lançamento + wallet + eventos |
| reconciliação | duas leituras no mesmo snapshot `REPEATABLE READ`, read-only |
| outbox publisher | *claim* (autocommit), **rede fora de transação**, *settle* (autocommit) |

Nada de rede (SQS) dentro de transação SQL; nenhum efeito externo dentro de uma closure que pode ser re-executada.

## 7. Idempotência e canonicalização

- **Fonte da verdade:** header `Idempotency-Key` (8–128 chars `[A-Za-z0-9._:-]`).
- **Escopo:** por provedor — `UNIQUE (provider_id, idempotency_key)`. Dois provedores podem usar a mesma chave sem colisão.
- **Identidade externa:** `UNIQUE (provider_id, external_transaction_id)`.
- **Hash:** SHA-256 de JSON canônico contendo **somente** os campos de negócio (`providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, amount, currency, referenceExternalTransactionId`). Chaves ordenadas recursivamente, sem espaços, strings em NFC, `amount` normalizado por `Money` (2 casas), ausente ⇒ `null`; números não inteiros são recusados. Header, correlation id e metadados de transporte ficam fora.

| Situação | Resultado |
|---|---|
| mesma chave + mesmo hash | replay: a transação original, `idempotentReplay: true` (200 se PROCESSED; 202/422 conforme o estado) |
| mesma chave + hash diferente | 409 `IDEMPOTENCY_KEY_REUSED`, nada executado |
| outra chave + mesmo `externalTransactionId` | 409 `EXTERNAL_TRANSACTION_CONFLICT`, nada executado |
| 50 requisições simultâneas com a mesma chave | uma cria; 49 esperam o lock da wallet e viram replay (teste in-process, teste HTTP real e estresse 20×50) |
| o original commita *entre* as duas consultas do fast path (chave ⇒ nada; id externo ⇒ linha com a mesma chave) | replay, não conflito: a linha carrega a própria chave (achado da auditoria; teste determinístico `idempotency-race.test.ts`) |
| mesma chave simultânea para wallets **diferentes** | locks diferentes ⇒ a unique constraint dispara para os perdedores ⇒ retry ⇒ 409 (teste) |
| crash depois do COMMIT, antes da resposta | o retry do cliente encontra a linha ⇒ replay (teste) |
| redelivery SQS | inbox detecta; e mesmo outra mensagem com a mesma operação cai na idempotência financeira (testes) |

**Snapshot da resposta:** `result_balance` e `result_wallet_version` são gravados na mesma transação SQL que muda o saldo. O replay devolve o saldo observado na conclusão, não o saldo atual (teste: após um WIN posterior, o replay do BET ainda responde `20.00`). Escolhi colunas tipadas em vez de um JSON da resposta: a resposta é derivada deterministicamente da linha, e as colunas participam de CHECKs (`ck_wager_processed_snapshot`).

Decisão: transações `REJECTED` também consomem a chave e a identidade externa. Reapresentar a mesma instrução recebe a mesma rejeição; uma *nova* tentativa exige novo `externalTransactionId`. Isso evita que um BET rejeitado por saldo vire "processado" depois de um depósito, com o mesmo id externo.

Inbox × idempotência financeira: a inbox deduplica **entregas** de uma mensagem do broker (`consumer_name + message_id`); a idempotência financeira deduplica **operações**, venham por HTTP ou por qualquer mensagem. São independentes e ambas são persistentes.

## 8. Regras financeiras e ambiguidades

| Kind | Efeito | Referência |
|---|---|---|
| BET | DEBIT; saldo insuficiente ⇒ `INSUFFICIENT_FUNDS` | proibida |
| WIN | CREDIT | opcional, deve ser BET |
| LOSS | nenhum lançamento; gera `WagerTransactionProcessed`; valor ≥ 0 | opcional, deve ser BET |
| REFUND | CREDIT do valor exato do BET | obrigatória, BET `PROCESSED` |
| ROLLBACK | inverte o lançamento da referência, valor integral | obrigatória, BET/WIN/REFUND `PROCESSED` |

Validações de referência (domínio, `WagerTransaction.validateReference`; FK composta `fk_wager_reference` como reforço): mesmo provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`), tipo permitido (`REFERENCE_INVALID_KIND`), referência terminal e `PROCESSED` (`REFERENCE_NOT_PROCESSED`), valor de REFUND/ROLLBACK igual ao da referência (`REFERENCE_AMOUNT_MISMATCH`).

Decisões sobre ambiguidades:

1. **Uma reversão efetiva por referência, somando os tipos.** Um BET pode ter um REFUND **ou** um ROLLBACK processado, não ambos (os dois creditariam). Garantido no domínio (`REFERENCE_ALREADY_REVERSED`) e por `ux_wager_single_reversal` (índice único parcial em `reference_transaction_id WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')`). Tentativas rejeitadas podem se acumular.
2. **ROLLBACK de REFUND é permitido** (desfaz o reembolso: DEBIT). Depois disso o BET **não** pode ser reembolsado de novo — o REFUND original continua contando como sua reversão. Preferi o estado mais conservador; reabrir exigiria uma regra explícita do negócio.
3. **ROLLBACK de ROLLBACK e de LOSS** não são permitidos (`REFERENCE_INVALID_KIND`).
4. **ROLLBACK que deixaria saldo negativo** ⇒ `REJECTED / ROLLBACK_INSUFFICIENT_FUNDS` (código distinto de `INSUFFICIENT_FUNDS` para diferenciar no monitoramento).
5. **REFUND/ROLLBACK carregam `amount`** no contrato (para o hash ser completo) e ele precisa ser igual ao da referência; não há reversão parcial.
6. **WIN/LOSS com referência ausente** também esperam (`PENDING_REFERENCE`), como as reversões.
7. **WIN após o BET ter sido revertido** é aceito: a regra de "uma vez" fala de reversões; bloquear WIN exigiria regra de jogo que o enunciado não define.
8. **Referência que existe mas ainda está pendente** (cadeia ROLLBACK → REFUND → BET fora de ordem) ⇒ o dependente também espera; esgotado o orçamento, `REFERENCE_NOT_PROCESSED`.

## 9. Money

- `Money` é imutável (`Object.freeze`), `decimal.js` com precisão 50; só soma e subtrai, então nenhum arredondamento é exercitado. Overflow além de `NUMERIC(20,2)` é erro, não arredondamento.
- Parser estrito: `^-?(0|[1-9]\d*)(\.\d{1,2})?$`, até 18 dígitos inteiros. Rejeita notação científica, `NaN`, `Infinity`, `+`, espaços, zeros à esquerda, vírgula, string vazia e mais de 2 casas. `Money.of` (entrada) também rejeita negativos; `Money.parse` (valores internos/persistidos) aceita sinal.
- O contrato HTTP/SQS exige **exatamente** duas casas (`"80.00"`); `amount` numérico (`80`) é 400.
- Serialização: `amount` sempre com 2 casas, nunca `"-0.00"`; `toJSON()` → `{ amount, currency }`.
- Moedas: ISO-4217 com 2 casas decimais (BRL, USD, EUR, …). Moedas incompatíveis lançam `CurrencyMismatchError`. A aplicação habilita só `SUPPORTED_CURRENCIES` (padrão BRL).
- No banco: `NUMERIC(20,2)`, lido como string (tipo `decimal` do MikroORM → string; `pg` devolve NUMERIC como string). Nenhum valor monetário passa por `number` em nenhum ponto, inclusive agregados (`SUM(...)::numeric(22,2)::text`).

## 10. PostgreSQL: constraints, índices e triggers

Migrations versionadas e reversíveis (`src/infrastructure/database/migrations`), lista explícita (sem glob), testadas do zero, com reversão total e reaplicação (`database-invariants.test.ts`). `disableForeignKeys` do migrator fica **desligado** — ligado, ele rodaria as migrations com `session_replication_role = replica`, desativando as triggers.

**Constraints declarativas**

| Garantia | Mecanismo |
|---|---|
| uma wallet por player+moeda | `uq_wallets_player_currency` |
| saldo/valores válidos | `CHECK balance >= 0`, `amount > 0` (≥ 0 para LOSS), `NUMERIC(20,2)` |
| idempotência / identidade externa | `uq_wager_provider_idempotency`, `uq_wager_provider_external` |
| transação coerente com a wallet (player e moeda) | FK composta `(wallet_id, player_id, currency) → wallets` |
| referência na mesma wallet/moeda/rodada/provider | FK composta `fk_wager_reference` |
| um lançamento por transação | `uq_ledger_transaction` (implica unicidade por wallet+transação) |
| ordem total do ledger por wallet | `uq_ledger_wallet_version` |
| aritmética do lançamento | `ck_ledger_arithmetic` (`after = before ± amount`) |
| lançamento coerente com a wallet e a transação | FKs compostas com `currency` |
| uma reversão efetiva por referência | `ux_wager_single_reversal` (parcial) |
| OPENING é interno | `ck_wager_opening_internal` |
| estados consistentes | `ck_wager_failure_code`, `ck_wager_processed_snapshot`, `ck_wager_pending_schedule`, … |
| inbox única | `uq_inbox_consumer_message` |

**Triggers (o que constraint não expressa)** — todas lançam SQLSTATE `JW001`, mapeado para `IntegrityViolationError` (500, nunca rejeição de negócio):

- ledger **append-only**: `UPDATE`, `DELETE` e `TRUNCATE` recusados;
- encadeamento do ledger: `balance_before` = `balance_after` anterior, versões crescentes, primeiro lançamento parte de 0;
- lançamento coerente com a transação: valor igual, LOSS sem lançamento, direção por tipo, ROLLBACK com direção inversa à da referência;
- wallet: identidade imutável, `version` muda **se e somente se** o saldo muda, sempre `+1`, sem DELETE;
- **DEFERRED** (no COMMIT): toda mudança de saldo tem o lançamento correspondente (`before`, `after`, `version`); toda transação `PROCESSED` que move dinheiro tem exatamente um lançamento, e as demais nenhum;
- transação terminal imutável; campos de negócio sempre imutáveis; sem DELETE;
- outbox: mensagem não `PUBLISHED` não pode ser apagada; conteúdo imutável; `PUBLISHED` não reabre;
- inbox: linha terminal imutável.

O que depende de lock e não de constraint: "o saldo usado na decisão é o atual" e "a referência não muda durante a decisão" — garantidos pelo `FOR UPDATE` na wallet, porque todas as transações de uma wallet só são escritas sob esse lock. Se esse protocolo for violado, as triggers e `uq_ledger_wallet_version` transformam a falha em erro em vez de corrupção.

**Índices de consulta**: `ix_wager_pending_due` (parcial, worker), `ix_wager_pending_by_reference` (parcial, wake-up), `ix_wager_reference_tx` (reversões), `ix_wager_wallet_created`, `ix_outbox_pending` (parcial, publisher e lag), `ix_inbox_open`. A paginação do ledger usa a própria `uq_ledger_wallet_version`.

**Paginação do ledger**: keyset em `wallet_version DESC`. O cursor é opaco (`base64url("l1:<walletId>:<version>")`), validado e amarrado à wallet. `wallet_version` é atribuída sob o lock da wallet, portanto segue a ordem de commit e não tem buracos: lançamentos novos sempre entram *antes* do cursor e nunca deslocam páginas seguintes (teste insere entre páginas). Sem `OFFSET`.

**Reconciliação**: `REPEATABLE READ` read-only; compara `wallets.balance` com `Σ ledger` e a versão com a do último lançamento. Divergência ⇒ log `error` + `wallet_reconciliation_mismatch_total`; **nunca** corrige. O teste corrompe o saldo desativando as triggers (superusuário) e verifica a detecção.

## 11. Mensageria: inbox, SQS, outbox

### Filas

| Fila | Atributos |
|---|---|
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=true` (fallback; produtores devem enviar `MessageDeduplicationId`), visibility 30 s, long poll 10 s, `RedrivePolicy` → DLQ com `maxReceiveCount=10` |
| `wager-transactions-dlq.fifo` | FIFO, retenção 14 dias |
| `wallet-events.fifo` | FIFO, saída da outbox; `MessageGroupId = walletId`, `MessageDeduplicationId = eventId` |

Criadas por `bun run queues:setup` (`ensureQueues`, idempotente) e pelo script de init do LocalStack.

### Consumer

- Mesmo caso de uso do HTTP (`executeInTransaction`), mesmo validador de contrato.
- Inbox + efeitos financeiros + outbox numa transação; **`DeleteMessage` só depois do COMMIT**.
- Mensagens do mesmo `MessageGroupId` (wallet) em sequência; grupos diferentes em paralelo. Se uma mensagem vai para retry, as seguintes do mesmo grupo no lote são devolvidas sem processar (preserva FIFO).
- Decisões:
  - sucesso ou **rejeição de negócio** (`REJECTED`) ⇒ ack (terminal; sem retry);
  - **inválida** (JSON, contrato, `OPENING`) ou **permanente** (`WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `PLAYER_WALLET_MISMATCH`…) ⇒ inbox `DEAD_LETTERED`, `SendMessage` para a DLQ, *depois* delete;
  - **transitória** ⇒ rollback; tentativa registrada fora da transação (`attempts`, `last_error`); `ChangeMessageVisibility` com backoff exponencial + jitter (`SQS_BASE_BACKOFF_MS`…`SQS_MAX_BACKOFF_MS`);
  - tentativas ≥ `SQS_MAX_ATTEMPTS` (máximo entre o contador da inbox e `ApproximateReceiveCount`) ⇒ DLQ.
- Redrive policy do SQS (`maxReceiveCount=10`) é rede de segurança para crash loops, acima do limite da aplicação (5).
- **SIGTERM**: para o long poll (AbortController), espera as mensagens em andamento até `SHUTDOWN_GRACE_MS`; o que não terminou volta após o visibility timeout — seguro pela idempotência.

### Transactional Outbox

- Eventos são inseridos na mesma transação da mudança (`IntegrationEvent` abstrata; `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WagerTransactionPendingReference` (na entrada em espera), `WalletBalanceChanged` (só quando há lançamento)). Envelope: `eventId, eventType, version, aggregateType, aggregateId, correlationId, causationId, occurredAt (ISO-8601), data`; dinheiro em `data` é sempre `{ amount: "x.xx", currency }`.
- Publisher:
  1. **claim** — `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`, grava `locked_by`, `locked_until = now() + lease` (relógio do banco) e incrementa `attempts`. Publishers concorrentes nunca pegam a mesma linha.
  2. **publica** em lote, sem transação aberta.
  3. **settle** — `PUBLISHED` ou falha com `next_attempt_at = now() + backoff` (exponencial + jitter) calculado no **relógio do banco**, o mesmo do claim e do lease — servidores de aplicação com relógios diferentes não distorcem o backoff (achado da auditoria; teste com relógio da aplicação 1h adiantado); acima de `OUTBOX_MAX_ATTEMPTS` ⇒ `DEAD` (mantida, métrica, requeue manual).
  4. **crash** entre publicar e marcar ⇒ o lease expira e outro publisher reenvia.
- **At-least-once, não exactly-once.** Exactly-once exigiria que o SQS participasse da transação do PostgreSQL (2PC/XA), o que ele não suporta; sempre existe a janela "enviado, mas não registrado". A mitigação é o `eventId` estável: deduplicação do FIFO em 5 min e deduplicação obrigatória no consumidor.
- Nenhum evento é publicado antes do COMMIT: o publisher só enxerga linhas commitadas.

### Ordenação

- Entrada: FIFO por `MessageGroupId = walletId`; processamento sequencial por grupo.
- Ledger: ordem total por wallet (`wallet_version`).
- Saída: um publisher envia em ordem de `seq` por lote; com publishers concorrentes, eventos da mesma wallet podem sair fora de ordem. Os eventos carregam `walletVersion` para o consumidor reordenar/descartar. Garantir ordem estrita na saída exigiria um publisher por partição de wallet (risco residual aceito).

### Referências fora de ordem

`PENDING_REFERENCE` guarda `reference_attempts`, `next_reference_check_at` e `reference_deadline_at` (fixado na primeira espera). O worker busca as devidas pelo índice parcial e reavalia cada uma em transação própria: lock da wallet → reler → se já não está pendente ou não está devida, pula (é assim que vários workers coexistem sem duplicar). Backoff exponencial com jitter; limite de tentativas **e** TTL ⇒ `REJECTED / REFERENCE_NOT_FOUND` + evento. Quando a referência chega, a mesma transação antecipa `next_reference_check_at` dos dependentes da mesma wallet, então a resolução não espera o backoff. O estado está todo no banco: reiniciar o serviço só retoma (teste com SIGKILL dos 3 processos).

## 12. Autenticação

Fora do escopo, por decisão (não vale pontos e um sistema caseiro de usuários seria pior que nenhum). Ponto de extensão pronto:

- `AuthGuard` global (`interfaces/http/auth.ts`) aplicado a todas as rotas, exceto as marcadas `@Public()` (health, metrics).
- `ProviderIdentityPort` (`identify(request)`, `mayActAs(identity, providerId)`); a implementação padrão `NoAuthProviderIdentity` permite tudo.

Integração futura com Keycloak (ou outro IdP OIDC): cada provedor é um *client* com client-credentials; o serviço valida o JWT (JWKS do realm, `iss`, `aud`, `exp`) e lê o `providerId` de `azp` ou de um claim próprio; `mayActAs` exige que o `providerId` do corpo seja o do token (403 se não for). Para SQS, a autorização é feita por IAM na fila (quem pode `SendMessage`), e o `providerId` da mensagem é validado contra o produtor quando a fila for por provedor.

Independentemente da autenticação, a coerência dos dados já é validada: wallet existe, pertence ao `playerId`, moeda confere, referências no mesmo provider/player/wallet/moeda/rodada, `providerId = system` reservado.

## 13. Observabilidade

- **Logs** JSON (pino), com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` propagados por `AsyncLocalStorage` (HTTP: `X-Correlation-Id` ou gerado e devolvido no header; SQS: `correlationId` da mensagem). Não se registram payloads completos nem segredos (há `redact` para headers de autorização como segunda barreira).
- **Métricas** (`GET /metrics`, registry isolado por instância — testável):
  `wallet_wager_transactions_total{kind,status,channel}`, `wallet_duplicates_detected_total{type,channel}` (replay, conflito de chave, conflito de id externo, redelivery da inbox), `wallet_retries_total{component,reason}`, `wallet_lock_conflicts_total{type}`, `wallet_dlq_messages_total{reason}`, `wallet_outbox_lag_seconds`, `wallet_outbox_pending_messages`, `wallet_outbox_published_total`, `wallet_outbox_failures_total`, `wallet_pending_reference_transactions`, `wallet_reconciliation_mismatch_total`, `wallet_processing_latency_seconds{channel,outcome}`.
- **Health**: `/health/live` não consulta dependências; `/health/ready` executa `SELECT 1` e `ListQueues` com timeout e responde 503 com `{"postgres":"up","sqs":"down"}` sem detalhes internos.

## 14. Estratégia de testes

| Suíte | Arquivos | Dependências |
|---|---|---|
| unidade | `test/unit/*` — Money, Wallet, ledger, máquina de estados, todas as regras de settlement, FailureCodes, hash/canonicalização, contrato, cursor, retry policy, inbox/outbox, envelope | nenhuma |
| integração | `database-invariants` (migrations do zero/rollback; cada constraint e trigger violada via SQL direto) · `wagering-flows` (fluxos, idempotência, crash pós-commit, rollback de exceção, referências fora de ordem, 2 workers, TTL, FAILED, reconciliação, cursor) · `inbox-outbox` (redelivery, entregas concorrentes, DLQ, lock timeout → retry → DLQ, 2 publishers, crash com lease, DEAD) · `http-api` (contrato de status) · `sqs-localstack` (protocolo SQS real) | PostgreSQL real; SQS real no último |
| concorrência | `audit-regressions` (os 12 cenários eliminatórios da auditoria: 50 requisições HTTP reais com a mesma chave + estresse 20×50, mesma chave com payloads diferentes em paralelo, mesmo id externo com chaves diferentes em paralelo, 50 redeliveries simultâneas, 50 mensagens distintas da mesma operação, REFUND/ROLLBACK duplicados antes do BET com 2 workers, resposta HTTP perdida após o commit, conexão morta no meio da transação, reconciliação de todas as wallets) · `in-process` (50× mesma chave, 100 vs 2×80 em 25 wallets, wallets independentes sob lock, 20 reversões simultâneas, REFUND × BET em corrida, mesma chave em wallets diferentes, carga mista aleatória com duplicatas) · `multi-process` (3 processos; 2×80 em instâncias diferentes; 30 BETs duplicadas entre instâncias; SIGKILL de todos + reinício; 3 consumers SQS) | PostgreSQL real, processos reais |

Depois de cada cenário o estado é verificado no banco por uma auditoria em SQL independente do código da aplicação (`test/helpers/db.ts → auditWallet`): `saldo = Σ ledger`, encadeamento, nada negativo, versão da wallet = versão do último lançamento; e consultas próprias para lançamentos duplicados por transação, reversões duplicadas, pendências remanescentes.

No `inbox-outbox.test.ts` o broker de saída é um gravador em processo — o alvo ali é a máquina de estados da inbox/outbox contra o banco real; o protocolo SQS é coberto por `sqs-localstack.test.ts`.

## 15. Recuperação de falhas

| Falha | Efeito | Recuperação |
|---|---|---|
| exceção no meio da transação | rollback total (teste) | cliente repete |
| deadlock / lock timeout | retry interno limitado | 503 se esgotar; cliente repete com a mesma chave |
| crash após COMMIT, antes da resposta HTTP | efeito aplicado uma vez | retry ⇒ replay |
| crash após COMMIT, antes do ack SQS | efeito aplicado uma vez | redelivery ⇒ inbox `PROCESSED` ⇒ ack |
| crash antes do COMMIT | nada aplicado | redelivery reprocessa |
| crash do publisher após enviar | evento pendente com lease | lease expira ⇒ reenvio (duplicata tolerada) |
| SQS fora do ar | eventos acumulam na outbox (lag) | backoff; publica quando voltar |
| PostgreSQL fora do ar | 503 / mensagens voltam à fila | consumer conta tentativas por `ApproximateReceiveCount` |
| processo morto com pendências de referência | estado no banco | qualquer instância retoma (teste) |
| bug que quebra invariante | trigger aborta o COMMIT (`JW001`) | nada corrompido; investigação |

## 16. Trade-offs, riscos residuais e limitações

- **Lock por wallet = throughput serial por wallet.** Correto para carteira de jogador (contenção baixa por wallet, alta entre wallets). Uma wallet "da casa" muito quente precisaria de sub-contas ou agregação assíncrona.
- **Triggers custam algumas leituras por escrita** (lançamento anterior, contagem do ledger no COMMIT), todas por índice. É o preço de ter o banco como última linha de defesa; mensurável e removível individualmente.
- **Duas idas extras por transação** (`SET LOCAL lock_timeout/statement_timeout`). Poderia ir para a configuração do role no banco.
- **Ordem da saída de eventos** não é estrita com vários publishers (ver §11).
- **DEAD na outbox / DLQ** sem ferramenta de redrive.
- **Autenticação** ausente (ponto de extensão pronto).
- **Moedas** apenas de 2 casas.
- **Relógio do worker de referências**: `next_reference_check_at` e o TTL usam o relógio da aplicação (a outbox já usa o do banco). Com relógios sincronizados por NTP o desvio (ms) é irrelevante perto do backoff (s); um nó muito adiantado anteciparia checagens e consumiria o orçamento de tentativas mais cedo.
- **SIGTERM** é tratado em `main.ts` e a parada graciosa do consumer é testada chamando `stop()` com mensagem em andamento; o envio do sinal ao processo em si não foi testado (Windows não entrega SIGTERM a processos Bun).
- **Retenção**: não há limpeza de `outbox_messages` publicadas nem de `inbox_messages` antigas (a trigger permite apagar outbox `PUBLISHED`; falta o job).
- **Testes SQS** dependem do LocalStack (ou de outro emulador compatível); sem ele, esses casos aparecem como **skip** no relatório do runner (não como pass) — `REQUIRE_SQS=1` transforma o skip em falha.

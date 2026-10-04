# OCPP 1.6J EV Charger Simulator

Simulador simples de carregador veicular elétrico em Node.js utilizando TypeScript e protocolo OCPP 1.6J sobre WebSocket. Controlado via requisições HTTP API.

## Instalação

1. Instale dependências:
   ```bash
   npm install
   ```

2. Compile o projeto:
   ```bash
   npm run build
   ```

3. Inicie o simulador:
   ```bash
   npm start
   ```

## Configuração (`.env`)

Crie arquivo `.env` na raiz do projeto seguindo o modelo:

```env
CENTRAL_SYSTEM_URL=ws://localhost:3000/ocpp
CHARGER_ID=CARREGADOR-001
PORT=8080
```

- `CENTRAL_SYSTEM_URL`: URL de conexão do sistema central (CMS).
- `CHARGER_ID`: ID único de identificação da estação.
- `PORT`: Porta do servidor HTTP local para receber comandos.

## Endpoints HTTP

Comandos aceitos pelo servidor HTTP local (padrão: `http://localhost:8080`):

- **`GET /status`**
  - Retorna o estado atual interno do carregador (conector, transação ativa e energia acumulada).

- **`GET /connect`**
  - Simula inserção do cabo no veículo. Atualiza status do conector para `Preparing`. Aguarda comando `RemoteStartTransaction` do CMS.

- **`GET /disconnect`**
  - Simula desconexão física do cabo. Retorna o status do conector para `Available`.

- **`GET /start`**
  - Inicia recarga manualmente.
  - Parâmetros opcionais (query):
    - `limit`: Limite de kWh. Se fornecido, a recarga dura exatamente 3 minutos com taxa de 0.5 kWh por pulso.
    - `idTag`: Identificação do usuário.
  - Exemplo: `http://localhost:8080/start?limit=10&idTag=WEB_USER`

- **`GET /stop`**
  - Interrompe a recarga em andamento. Status muda para `Finishing`.

- **`GET /suspend/:connectorId`** (E07)
  - O veículo para de puxar energia com o cabo conectado: envia `StatusNotification` `SuspendedEV`, e as `MeterValues` seguem a cada 10 s com potência 0 (a energia não sobe). Responde 409 se o conector não estiver carregando.

- **`GET /resume/:connectorId`** (E07)
  - O veículo volta a carregar: `SuspendedEV` → `Charging`. Responde 409 se o conector não estiver suspenso.

As `MeterValues` periódicas trazem também `Temperature` (°C, `location: Body`), que sobe durante a carga e cai com o conector parado.

- **`GET /authorize`**
  - Envia `Authorize` com o `idTag` da query (padrão `TAG-12345`) e devolve a resposta do CMS.
  - Exemplo: `http://localhost:8080/authorize?idTag=TAG-12345`

- **`GET /status`** também mostra `lastRemoteStartIdTag` (idTag recebido no último `RemoteStartTransaction`) e, por conector, `lastIdTag` e `lastStartStatus` (status do `idTagInfo` no último `StartTransaction`).

## Validação de idTag (E02)

Quando o `StartTransaction` volta com `idTagInfo.status` diferente de `Accepted`, o simulador se comporta como um carregador com `StopTransactionOnInvalidId=true`: envia `StopTransaction` com `reason: DeAuthorized` na hora e volta o conector para `Available`. Para simular um carregador que ignora o `Invalid` e continua entregando energia, suba com `IGNORE_INVALID=true`.

### Cenários automatizados

`npm run scenarios:e02` roda os quatro cenários do ticket E02-06 contra o backend e o gateway **locais**:

1. tag aleatória → `Invalid` em `Authorize` e `StartTransaction`;
2. remote start pela API (`skipPayment`) → aceito, com um idTag por sessão (nunca `APP_USER`);
3. reutilizar o token da sessão 2 depois do stop → `Invalid`;
4. carregador com `allowLocalStart=true` → aceito (o valor original é restaurado no fim).

Pré-requisitos: simulador rodando com `CHARGER_ID` igual à identity do carregador; tenant do carregador com `strictIdTag=true` (em modo observação tudo é aceito e só registrado, então os cenários 1 e 3 falham de propósito).

```env
SIM_URL=http://localhost:8080
API_URL=http://localhost:3030/v1
API_TOKEN=<JWT de um usuário de teste com CHARGERS_UPDATE e TRANSACTIONS_SKIP_PAYMENT>
CHARGER_DB_ID=<_id do carregador>
TENANT_ID=<tenant do carregador>
CONNECTOR=1
```

## Telemetria e ociosidade (E07)

`npm run scenarios:e07` roda contra o backend e o gateway **locais**:

1. remote start pela API (`skipPayment`) e conferência da visão ao vivo (`GET /chargers/:id/live`);
2. série de medições gravada (`GET /transactions/:id/meter-values`, gráfico e tabela, com `Temperature` e o valor bruto);
3. `/suspend` → `idleStartedAt` marcado;
4. `/resume` → marcação limpa;
5. `/suspend` de novo → marcação nova, que não muda com as `MeterValues` de 0 W seguintes;
6. `/stop` → linha do tempo (`GET /transactions/:id/timeline`) com início, ociosidade, fim, `SuspendedEV` e `RemoteStartTransaction`, e a leitura `Transaction.End` do `transactionData` na tabela.

Mesmas variáveis do E02. O token precisa de `CHARGERS_VIEW`, `TRANSACTIONS_VIEW`, `TRANSACTIONS_CREATE` e `TRANSACTIONS_SKIP_PAYMENT`. `METER_WAIT_MS` (padrão 25000) é a espera por duas leituras de 10 s mais o flush de 2 s da ingestão.

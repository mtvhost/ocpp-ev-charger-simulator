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
## Autenticação OCPP (E06, Security Profile 1)

Com `CHARGER_PASSWORD` definida, o simulador conecta com `Authorization: Basic base64(CHARGER_ID:senha)`, o mesmo formato de um carregador real configurado com `AuthorizationKey`. Sem ela, conecta como carregador legado. O subprotocolo `ocpp1.6` é sempre oferecido, exceto em `/ws/connect?protocol=none`.

```env
CHARGER_PASSWORD=<senha gerada na aba Segurança do carregador>
```

### Endpoints de conexão

- **`GET /ws/connect`**: fecha a conexão atual e conecta de novo. Parâmetros:
  - `password=…` troca a senha; `noAuth=1` conecta sem senha;
  - `url=ws://…` conecta em outro gateway (por exemplo, a segunda instância);
  - `protocol=none` não oferece `ocpp1.6`;
  - `auto=0|1` liga ou desliga a reconexão automática. Por padrão, uma recusa (401/400/429) não entra em loop.
- **`GET /ws/disconnect`**: fecha a conexão e desliga a reconexão automática.
- **`GET /reboot`**: simula um reboot. Fecha a conexão, reconecta com a senha atual e manda `BootNotification`.
- **`GET /status`** agora traz `connection`:
  - `connected`;
  - `lastHandshakeStatus`: 101 se conectou, ou o status HTTP da recusa (401, 400, 429, 503);
  - `lastCloseCode`: 4000 quando outra conexão autenticada substituiu esta;
  - `protocol` e `url`.

Correções do E06:

- Um handshake recusado agendava duas retentativas (`error` e `close`), e o número de tentativas crescia a cada rodada. Agora há uma retentativa por vez.
- O servidor HTTP sobe antes da primeira conexão, então o simulador continua controlável quando o gateway recusa.
- Chamadas sem resposta falham em 30 s.

### Cenários automatizados

`npm run scenarios:e06` roda contra o backend local e **duas instâncias** do gateway (Mongo e Redis locais, nunca o `.env` de produção do backend):

1. sem credencial → 401, e o backend registra a recusa (`lastRejectedAt`);
2. senha errada → 401;
3. senha certa → conecta com `ocpp1.6`, e o backend registra `auth=basic`;
4. `requireAuth` sem subprotocolo → 400;
5. rotação com sessão ativa (remote start): a conexão e a transação seguem até o stop; na reconexão, a senha antiga é recusada e a nova aceita;
6. reboot → reconecta e o carregador volta a ficar online;
7. duas instâncias:
   - uma cópia **sem senha** na instância B não derruba o simulador na A;
   - uma cópia **autenticada** na B faz a A fechar o socket com 4000;
   - aparece `CONNECTION_REPLACED` no histórico, e o carregador continua online;
8. legado (`requireAuth=false`) conecta sem senha e é registrado como `auth=none`;
9. (opcional, `RATE_LIMIT_ATTEMPTS`) falhas seguidas → 429, inclusive na outra instância.

O cenário gera e rotaciona a senha do carregador. No fim, devolve `requireAuth` ao valor original e imprime a senha final.

```env
SIM_URL=http://localhost:8080
API_URL=http://localhost:3030/v1
API_TOKEN=<JWT com CHARGERS_SECURITY, CHARGERS_VIEW e TRANSACTIONS_SKIP_PAYMENT>
CHARGER_DB_ID=<_id do carregador>
CHARGER_ID=<identity do carregador>
TENANT_ID=<tenant do carregador>
GATEWAY_A=ws://localhost:8081
GATEWAY_B=ws://localhost:8082
# RATE_LIMIT_ATTEMPTS=5   # use o mesmo valor de OCPP_AUTH_MAX_FAILS_PER_IP dos gateways, com OCPP_AUTH_BLOCK_S curto
```

## Operações guiadas (E08)

O simulador responde às operações que o painel envia por `POST /chargers/:id/operations/:action` (código em `src/operations.ts`):

| Action | Resposta do simulador |
|---|---|
| `ChangeAvailability` | `Accepted` (o conector vai para `Unavailable`/`Available`); `Scheduled` se `Inoperative` num conector carregando; `Rejected` para conector inexistente |
| `TriggerMessage` | `Accepted` e envia a mensagem pedida (Boot, Heartbeat, Status, MeterValues, FirmwareStatus, DiagnosticsStatus); `Rejected` para conector inexistente |
| `GetConfiguration` | chaves com `readonly`; `AuthorizationKey` volta com valor (o CMS precisa mascarar); `unknownKey` para as que não existem |
| `ChangeConfiguration` | `Accepted`; `RebootRequired` em `MeterValueSampleInterval` e `WebSocketPingInterval`; `Rejected` em chave somente leitura; `NotSupported` em chave desconhecida |
| `GetDiagnostics` | `{ fileName }` e envia o arquivo por **POST multipart** para `<location><arquivo>`, com `DiagnosticsStatusNotification` `Uploading` → `Uploaded`/`UploadFailed`; `location` que não é HTTP(S) → `{}` (sem arquivo) |
| `UnlockConnector` | `Unlocked` (encerra a sessão do conector com `UnlockCommand`); `NotSupported` para conector inexistente |
| `Reset` | `Accepted`, encerra as sessões (`SoftReset`/`HardReset`) e reconecta com novo `BootNotification` |
| `DataTransfer` | `AntigravityEV` + `messageId=Echo` → `Accepted` com o `data` de volta; outro vendor → `UnknownVendorId` |
| `GetLocalListVersion` / `SendLocalList` | versão guardada em memória; diferencial com versão antiga → `VersionMismatch` |
| `ClearCache` / `ClearChargingProfile` | `Accepted` / `Unknown` |

### Endpoints de teste

- **`GET /behavior?action=<Action>&respond=Rejected|NotSupported|NotImplemented|timeout|default`**: força a resposta de uma action. `NotImplemented` vira CALLERROR; `timeout` nunca responde; `default` volta ao normal. O estado atual aparece em `/status` (`operations.behaviors`).
- **`GET /data-transfer?vendorId=&messageId=&data=`**: envia um `DataTransfer` iniciado pelo carregador (o CMS responde `UnknownVendorId`).

### Cenário automatizado

`npm run scenarios:e08` roda contra o backend e o gateway **locais** e confere: configuração com segredo mascarado, Accepted/RebootRequired/Rejected, 400 de payload fora do OCPP 1.6 e de `AuthorizationKey`, TriggerMessage, lista local, DataTransfer, `NotImplemented` → `NOT_SUPPORTED`, `timeout` → `TIMEOUT` (202 + polling), 409 de sessão ativa e `SCHEDULED`, upload do diagnóstico pelo link, DataTransfer de entrada, Reset Hard com reconexão, `OFFLINE` com o carregador desconectado e a trilha de auditoria.

```env
SIM_URL=http://localhost:8080
API_URL=http://localhost:3030/v1
API_TOKEN=<JWT com CHARGERS_VIEW, CHARGERS_OPERATE e CHARGERS_OPERATE_CRITICAL>
CHARGER_DB_ID=<_id do carregador>
CONNECTOR=1
```

O backend precisa de `PUBLIC_API_URL` acessível pelo simulador (o `location` do GetDiagnostics é montado com ela). Para o caso de timeout não demorar 30 s no POST, use `OCPP_OPERATION_SYNC_WAIT_MS=5000` no backend local.

## Tarifação v2 (E09)

`npm run scenarios:e09` roda contra o backend e o gateway **locais**, com o tenant do carregador em `tariffV2Enabled`. Ele grava no carregador uma tarifa com faixa de ponta e taxa de ociosidade, confere o simulador de preço (`30 kWh, 50 min, 15 min ocioso → R$ 105,00`) e faz uma recarga local (RFID, `allowLocalStart`). No meio da sessão muda a tarifa, para provar que o preço continua congelado, e deixa o conector em `SuspendedEV` por `IDLE_WAIT_MS` (padrão 75 s). Depois encerra e confere os itens do preço: energia na faixa, minutos de ociosidade e total igual à soma. No fim devolve a tarifa original do carregador.

Variáveis: `API_TOKEN` (com `CHARGERS_UPDATE`, `CHARGERS_VIEW`, `TRANSACTIONS_VIEW` e `TARIFFS_MANAGE`), `CHARGER_DB_ID`, `CONNECTOR`, `METER_WAIT_MS`, `IDLE_WAIT_MS`.

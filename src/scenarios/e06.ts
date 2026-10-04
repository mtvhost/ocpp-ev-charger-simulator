/**
 * E06-07 — cenários de autenticação OCPP (Security Profile 1) contra backend +
 * DUAS instâncias do gateway locais.
 *
 * Pré-requisitos:
 *  - backend local (Mongo/Redis locais, nunca o .env de produção) com OCPP_INTERNAL_API_KEY;
 *  - gateway A e gateway B no mesmo Redis, com BACKEND_INTERNAL_URL e a mesma chave;
 *  - simulador rodando (`npm start`) com CHARGER_ID = identity do carregador e
 *    CENTRAL_SYSTEM_URL = GATEWAY_A;
 *  - API_TOKEN de um usuário de teste com CHARGERS_SECURITY, CHARGERS_VIEW e
 *    TRANSACTIONS_SKIP_PAYMENT.
 *
 * Os cenários geram e rotacionam a senha do carregador e ligam requireAuth. Ao
 * final, requireAuth volta ao valor original; a senha fica a última gerada.
 *
 * Variáveis:
 *   SIM_URL        http://localhost:8080
 *   API_URL        http://localhost:3030/v1
 *   API_TOKEN      JWT de teste
 *   CHARGER_DB_ID  _id do carregador
 *   CHARGER_ID     identity do carregador (usuário do Basic)
 *   TENANT_ID      tenant do carregador (remote start)
 *   GATEWAY_A      ws://localhost:8081
 *   GATEWAY_B      ws://localhost:8082
 *   RATE_LIMIT_ATTEMPTS  0 pula o cenário de bloqueio (padrão 0). Use o mesmo valor
 *                        de OCPP_AUTH_MAX_FAILS_PER_IP dos gateways, que bloqueia
 *                        127.0.0.1 por OCPP_AUTH_BLOCK_S (use um valor curto local).
 *   CONNECTOR      1
 *
 *   npm run scenarios:e06
 */
import 'dotenv/config';
import WebSocket from 'ws';

const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
const API_URL = process.env.API_URL || 'http://localhost:3030/v1';
const API_TOKEN = process.env.API_TOKEN || '';
const CHARGER_DB_ID = process.env.CHARGER_DB_ID || '';
const CHARGER_ID = process.env.CHARGER_ID || '';
const TENANT_ID = process.env.TENANT_ID || '';
const GATEWAY_A = process.env.GATEWAY_A || 'ws://localhost:8081';
const GATEWAY_B = process.env.GATEWAY_B || 'ws://localhost:8082';
const RATE_LIMIT_ATTEMPTS = Number(process.env.RATE_LIMIT_ATTEMPTS || 0);
const CONNECTOR = Number(process.env.CONNECTOR || 1);

type Connection = {
  connected: boolean;
  lastHandshakeStatus: number | null;
  lastCloseCode: number | null;
  protocol: string | null;
  url: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sim(path: string): Promise<any> {
  const res = await fetch(`${SIM_URL}${path}`);
  if (!res.ok) throw new Error(`simulator ${path}: HTTP ${res.status}`);
  return res.json();
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${method} ${path}: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const connection = async (): Promise<Connection> => (await sim('/status')).connection;
const connector = async () => (await sim('/status')).connectors[String(CONNECTOR)];
const credentials = () => api('GET', `/chargers/${CHARGER_DB_ID}/ocpp-credentials`);

async function connect(query: Record<string, string>): Promise<Connection> {
  const qs = new URLSearchParams({ auto: '0', ...query }).toString();
  return (await sim(`/ws/connect?${qs}`)).connection;
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function expectEqual(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

/** Abre um socket fora do simulador (segunda "cópia" do carregador). */
function rawConnect(url: string, password: string | null): Promise<{ status: number; ws?: WebSocket }> {
  const headers: Record<string, string> = {};
  if (password) headers.Authorization = `Basic ${Buffer.from(`${CHARGER_ID}:${password}`).toString('base64')}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/${CHARGER_ID}`, 'ocpp1.6', { headers });
    ws.on('open', () => resolve({ status: 101, ws }));
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      ws.terminate();
      resolve({ status: res.statusCode ?? 0 });
    });
    ws.on('error', () => resolve({ status: 0 }));
  });
}

const results: Array<{ scenario: string; ok: boolean; detail: string }> = [];
async function scenario(name: string, fn: () => Promise<string>) {
  try {
    results.push({ scenario: name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ scenario: name, ok: false, detail: (e as Error).message });
  }
}

async function main() {
  if (!API_TOKEN || !CHARGER_DB_ID || !CHARGER_ID || !TENANT_ID) {
    throw new Error('Defina API_TOKEN, CHARGER_DB_ID, CHARGER_ID e TENANT_ID.');
  }
  const original = await credentials();
  let password = (await api('POST', `/chargers/${CHARGER_DB_ID}/ocpp-credentials`)).password as string;
  await api('PATCH', `/chargers/${CHARGER_DB_ID}/ocpp-auth`, { requireAuth: true });
  await sleep(500);

  await scenario('1. Sem credencial → 401', async () => {
    const c = await connect({ noAuth: '1', url: GATEWAY_A });
    expectEqual(c.connected, false, 'conectado');
    expectEqual(c.lastHandshakeStatus, 401, 'status do upgrade');
    await waitFor('lastRejectedAt no backend', async () => (await credentials()).lastRejectedAt);
    return 'HTTP 401 antes do handshake; rejeição registrada no backend';
  });

  await scenario('2. Senha errada → 401', async () => {
    const c = await connect({ password: 'senha-errada-0000000000000000000', url: GATEWAY_A });
    expectEqual(c.lastHandshakeStatus, 401, 'status do upgrade');
    return 'HTTP 401';
  });

  await scenario('3. Senha certa → conecta (ocpp1.6, auth=basic)', async () => {
    const before = Date.now();
    const c = await connect({ password, url: GATEWAY_A, auto: '1' });
    expectEqual(c.connected, true, 'conectado');
    expectEqual(c.protocol, 'ocpp1.6', 'subprotocolo');
    await waitFor('lastAuthMode=basic', async () => {
      const cred = await credentials();
      return cred.lastAuthMode === 'basic' && new Date(cred.lastConnectedAt).getTime() >= before - 1000;
    });
    return 'conectado; backend registrou auth=basic';
  });

  await scenario('4. Sem subprotocolo com requireAuth → 400', async () => {
    const c = await connect({ password, url: GATEWAY_A, protocol: 'none' });
    expectEqual(c.lastHandshakeStatus, 400, 'status do upgrade');
    await connect({ password, url: GATEWAY_A, auto: '1' });
    return 'HTTP 400';
  });

  await scenario('5. Rotação com sessão ativa: não cai; senha nova na próxima conexão', async () => {
    await sim(`/connect/${CONNECTOR}`);
    await api('POST', '/transactions/remote-start', {
      tenantId: TENANT_ID,
      chargerId: CHARGER_DB_ID,
      connectorId: CONNECTOR,
      meterStart: 0,
      skipPayment: true,
    });
    const started = await waitFor('StartTransaction', async () => {
      const c = await connector();
      return c.transactionId !== null ? c : null;
    });
    const old = password;
    password = (await api('POST', `/chargers/${CHARGER_DB_ID}/ocpp-credentials`)).password;
    await sleep(3000); // MeterValues seguem chegando na mesma conexão
    expectEqual((await connection()).connected, true, 'conexão após rotacionar');
    expectEqual((await connector()).transactionId, started.transactionId, 'transação após rotacionar');
    await sim(`/stop/${CONNECTOR}`);
    await sleep(500);
    await sim(`/disconnect/${CONNECTOR}`).catch(() => undefined);

    const withOld = await connect({ password: old, url: GATEWAY_A });
    expectEqual(withOld.lastHandshakeStatus, 401, 'senha antiga na reconexão');
    const withNew = await connect({ password, url: GATEWAY_A, auto: '1' });
    expectEqual(withNew.connected, true, 'senha nova na reconexão');
    return `transação ${started.transactionId} seguiu até o stop; senha antiga recusada, nova aceita`;
  });

  await scenario('6. Reconexão após reboot', async () => {
    const r = await sim('/reboot');
    expectEqual(r.ok, true, `reboot (${r.error ?? ''})`);
    await waitFor('charger online', async () => (await api('GET', `/chargers/${CHARGER_DB_ID}`)).isOnline);
    return 'reconectou com a senha atual e mandou BootNotification';
  });

  await scenario('7. Duas instâncias: conexão nova na B substitui a da A', async () => {
    await connect({ password, url: GATEWAY_A, auto: '0' });
    const sinceLogs = new Date().toISOString();
    const intruder = await rawConnect(GATEWAY_B, null);
    expectEqual(intruder.status, 401, 'cópia sem senha na B');
    expectEqual((await connection()).connected, true, 'simulador na A depois da tentativa sem senha');

    const twin = await rawConnect(GATEWAY_B, password);
    expectEqual(twin.status, 101, 'cópia autenticada na B');
    const closed = await waitFor('A fecha o socket antigo', async () => {
      const c = await connection();
      return !c.connected ? c : null;
    });
    expectEqual(closed.lastCloseCode, 4000, 'código de fechamento');
    const logs = await api('GET', `/chargers/${CHARGER_DB_ID}/logs?limit=20`);
    const items: any[] = logs.items ?? logs.data ?? logs;
    const replaced = items.find((l) => l.type === 'CONNECTION_REPLACED' && l.createdAt >= sinceLogs);
    if (!replaced) throw new Error('CONNECTION_REPLACED não apareceu no histórico');
    expectEqual((await api('GET', `/chargers/${CHARGER_DB_ID}`)).isOnline, true, 'carregador online (sem disconnected)');
    twin.ws?.close();
    await sleep(500);
    await connect({ password, url: GATEWAY_A, auto: '1' });
    return `socket da A fechado com 4000; ${replaced.details?.previousInstance} → ${replaced.details?.instance}`;
  });

  await scenario('8. Legado (requireAuth=false) conecta sem senha', async () => {
    await api('PATCH', `/chargers/${CHARGER_DB_ID}/ocpp-auth`, { requireAuth: false });
    await sleep(500);
    const c = await connect({ noAuth: '1', url: GATEWAY_A, auto: '1' });
    expectEqual(c.connected, true, 'conectado sem senha');
    await waitFor('lastAuthMode=none', async () => (await credentials()).lastAuthMode === 'none');
    await api('PATCH', `/chargers/${CHARGER_DB_ID}/ocpp-auth`, { requireAuth: true });
    await connect({ password, url: GATEWAY_A, auto: '1' });
    return 'aceito como legado e registrado como auth=none';
  });

  if (RATE_LIMIT_ATTEMPTS > 0) {
    await scenario('9. Rate-limit por IP → 429', async () => {
      let last = 0;
      for (let i = 0; i <= RATE_LIMIT_ATTEMPTS; i++) last = (await rawConnect(GATEWAY_B, 'errada')).status;
      expectEqual(last, 429, 'status após o limite');
      const evenRight = await rawConnect(GATEWAY_A, password);
      expectEqual(evenRight.status, 429, 'IP bloqueado nas duas instâncias');
      return `bloqueado após ${RATE_LIMIT_ATTEMPTS} falhas, inclusive na outra instância`;
    });
  }

  await api('PATCH', `/chargers/${CHARGER_DB_ID}/ocpp-auth`, { requireAuth: !!original.requireAuth }).catch(() => undefined);
  console.log(`Senha OCPP final do carregador (configure no simulador): CHARGER_PASSWORD=${password}`);
  console.table(results);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * E02 — cenários de validação de idTag contra backend + gateway locais.
 *
 * Pré-requisitos:
 *  - simulador rodando (`npm start`) com CHARGER_ID = identity do carregador;
 *  - tenant do carregador com strictIdTag=true (senão só o cenário 2 e 4 passam:
 *    em observação tudo é aceito e apenas registrado);
 *  - API_TOKEN de um usuário de teste com CHARGERS_UPDATE e TRANSACTIONS_SKIP_PAYMENT.
 *
 * Variáveis:
 *   SIM_URL        http://localhost:8080        (servidor HTTP do simulador)
 *   API_URL        http://localhost:3030/v1     (backend)
 *   API_TOKEN      JWT de teste
 *   CHARGER_DB_ID  _id do carregador no Mongo
 *   TENANT_ID      tenant do carregador
 *   CONNECTOR      1
 *
 *   npm run scenarios:e02
 */
import 'dotenv/config';

const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
const API_URL = process.env.API_URL || 'http://localhost:3030/v1';
const API_TOKEN = process.env.API_TOKEN || '';
const CHARGER_DB_ID = process.env.CHARGER_DB_ID || '';
const TENANT_ID = process.env.TENANT_ID || '';
const CONNECTOR = Number(process.env.CONNECTOR || 1);

type Status = {
  lastRemoteStartIdTag: string | null;
  connectors: Record<string, {
    connectorStatus: string;
    transactionId: number | null;
    lastIdTag: string | null;
    lastStartStatus: string | null;
  }>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomTag = () => `RND${Math.random().toString(16).slice(2, 12).toUpperCase()}`;

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

const status = async (): Promise<Status> => sim('/status');
const connector = async () => (await status()).connectors[String(CONNECTOR)];

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Leaves the connector Available with no transaction. */
async function reset() {
  const c = await connector();
  if (c.transactionId !== null) await sim(`/stop/${CONNECTOR}`);
  await sleep(500);
  const after = await connector();
  if (after.connectorStatus === 'Preparing' || after.connectorStatus === 'Finishing') {
    await sim(`/disconnect/${CONNECTOR}`);
  }
}

async function setAllowLocalStart(value: boolean) {
  await api('PATCH', `/chargers/${CHARGER_DB_ID}`, { allowLocalStart: value });
}

const results: Array<{ scenario: string; ok: boolean; detail: string }> = [];
async function scenario(name: string, fn: () => Promise<string>) {
  try {
    results.push({ scenario: name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ scenario: name, ok: false, detail: (e as Error).message });
  } finally {
    await reset().catch(() => undefined);
  }
}

function expectEqual(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

async function main() {
  if (!API_TOKEN || !CHARGER_DB_ID || !TENANT_ID) {
    throw new Error('Defina API_TOKEN, CHARGER_DB_ID e TENANT_ID.');
  }
  const original = await api('GET', `/chargers/${CHARGER_DB_ID}`);
  await setAllowLocalStart(false);
  await reset();

  await scenario('1. Tag aleatória → Invalid', async () => {
    const tag = randomTag();
    const auth = await sim(`/authorize?idTag=${tag}`);
    expectEqual(auth.response?.idTagInfo?.status, 'Invalid', 'Authorize');
    await sim(`/connect/${CONNECTOR}`);
    await sim(`/start/${CONNECTOR}?idTag=${tag}`);
    const c = await connector();
    expectEqual(c.lastStartStatus, 'Invalid', 'StartTransaction');
    expectEqual(c.transactionId, null, 'transação no simulador após DeAuthorized');
    return `Authorize e StartTransaction Invalid para ${tag}`;
  });

  let sessionToken = '';
  await scenario('2. Remote start → aceito', async () => {
    await sim(`/connect/${CONNECTOR}`);
    const trx = await api('POST', '/transactions/remote-start', {
      tenantId: TENANT_ID,
      chargerId: CHARGER_DB_ID,
      connectorId: CONNECTOR,
      meterStart: 0,
      skipPayment: true,
    });
    const c = await waitFor('StartTransaction do remote start', async () => {
      const now = await connector();
      return now.transactionId !== null ? now : null;
    });
    sessionToken = (await status()).lastRemoteStartIdTag ?? '';
    if (!sessionToken || sessionToken === 'APP_USER') {
      throw new Error(`idTag do RemoteStart não é um token por sessão: ${sessionToken}`);
    }
    expectEqual(c.lastIdTag, sessionToken, 'idTag do StartTransaction');
    expectEqual(c.lastStartStatus, 'Accepted', 'StartTransaction');
    await sim(`/stop/${CONNECTOR}`);
    return `sessão ${trx._id ?? '?'} com idTag ${sessionToken}`;
  });

  await scenario('3. Reutilizar token de sessão encerrada → Invalid', async () => {
    if (!sessionToken) throw new Error('cenário 2 não gerou token');
    const auth = await sim(`/authorize?idTag=${sessionToken}`);
    expectEqual(auth.response?.idTagInfo?.status, 'Invalid', 'Authorize');
    await sim(`/connect/${CONNECTOR}`);
    await sim(`/start/${CONNECTOR}?idTag=${sessionToken}`);
    expectEqual((await connector()).lastStartStatus, 'Invalid', 'StartTransaction');
    return `token ${sessionToken} recusado`;
  });

  await scenario('4. Carregador com allowLocalStart → aceito', async () => {
    await setAllowLocalStart(true);
    const tag = randomTag();
    const auth = await sim(`/authorize?idTag=${tag}`);
    expectEqual(auth.response?.idTagInfo?.status, 'Accepted', 'Authorize');
    await sim(`/connect/${CONNECTOR}`);
    await sim(`/start/${CONNECTOR}?idTag=${tag}`);
    expectEqual((await connector()).lastStartStatus, 'Accepted', 'StartTransaction');
    await sim(`/stop/${CONNECTOR}`);
    return `tag ${tag} aceita`;
  });

  await setAllowLocalStart(!!original.allowLocalStart);

  console.table(results);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

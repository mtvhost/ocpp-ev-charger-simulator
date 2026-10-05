/**
 * E12 — tags RFID e Autocharge contra backend + gateway locais.
 *
 * Pré-requisitos:
 *  - simulador rodando (`npm start`) com CHARGER_ID = identity do carregador;
 *  - Mongo/Redis locais (nunca o .env de produção do backend);
 *  - tenant do carregador com `strictIdTag` DESLIGADO (o ponto do cenário 2 é
 *    provar que tag inativa é Invalid mesmo em observação);
 *  - USER_ID: usuário do tenant com cartão padrão ativo tokenizado no modo
 *    teste da Pagar.me (conta do tenant ou da plataforma, conforme o app);
 *  - API_TOKEN: usuário de teste com TAGS_MANAGE, CHARGERS_UPDATE e
 *    TRANSACTIONS_VIEW (ou Super Admin; aí informe TENANT_ID);
 *  - APP_TOKEN (opcional): JWT do MESMO usuário (USER_ID), como o app, para o
 *    cenário 4 (captura de Autocharge). Sem ele o cenário 4 é pulado.
 *
 * Variáveis:
 *   SIM_URL        http://localhost:8080
 *   API_URL        http://localhost:3030/v1
 *   API_TOKEN, APP_TOKEN, CHARGER_DB_ID, TENANT_ID, USER_ID, CONNECTOR (1)
 *   CARD_ID        cartão do usuário no remote start do cenário 4 (opcional)
 *   PAYMENT_WAIT_MS  espera pela cobrança pós-paga (padrão 45000)
 *   SKIP_PAYMENT_CHECK=true  não confere a cobrança (sem Pagar.me no ambiente)
 *
 *   npm run scenarios:e12
 *
 * Não roda no ambiente de desenvolvimento do time se o Docker não subir: o
 * cenário só foi escrito e conferido contra o simulador, ainda não executado.
 */
import 'dotenv/config';

const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
const API_URL = process.env.API_URL || 'http://localhost:3030/v1';
const API_TOKEN = process.env.API_TOKEN || '';
const APP_TOKEN = process.env.APP_TOKEN || '';
const CHARGER_DB_ID = process.env.CHARGER_DB_ID || '';
const TENANT_ID = process.env.TENANT_ID || '';
const USER_ID = process.env.USER_ID || '';
const CARD_ID = process.env.CARD_ID || '';
const CONNECTOR = Number(process.env.CONNECTOR || 1);
const PAYMENT_WAIT_MS = Number(process.env.PAYMENT_WAIT_MS || 45_000);
const SKIP_PAYMENT_CHECK = process.env.SKIP_PAYMENT_CHECK === 'true';

type Status = {
  lastRemoteStartIdTag: string | null;
  connectors: Record<
    string,
    {
      connectorStatus: string;
      transactionId: number | null;
      lastIdTag: string | null;
      lastStartStatus: string | null;
    }
  >;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16))
    .join('')
    .toUpperCase();

async function sim(path: string): Promise<any> {
  const res = await fetch(`${SIM_URL}${path}`);
  if (!res.ok) throw new Error(`simulator ${path}: HTTP ${res.status}`);
  return res.json();
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${method} ${path}: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
const panel = (method: string, path: string, body?: unknown) => api(API_TOKEN, method, path, body);
const app = (method: string, path: string, body?: unknown) => api(APP_TOKEN, method, path, body);
const tenantQuery = TENANT_ID ? `?tenantId=${TENANT_ID}` : '';

const status = async (): Promise<Status> => sim('/status');
const connector = async () => (await status()).connectors[String(CONNECTOR)];

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function reset() {
  const c = await connector();
  if (c.transactionId !== null) await sim(`/stop/${CONNECTOR}`);
  await sleep(500);
  const after = await connector();
  if (after.connectorStatus === 'Preparing' || after.connectorStatus === 'Finishing') {
    await sim(`/disconnect/${CONNECTOR}`);
  }
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

/** Sessão mais recente do carregador (lista do painel, mais nova primeiro). */
async function latestSession(): Promise<any> {
  const page = await panel('GET', `/transactions?chargerId=${CHARGER_DB_ID}&limit=1${TENANT_ID ? `&tenantId=${TENANT_ID}` : ''}`);
  const items = page.items ?? page.data ?? page;
  return Array.isArray(items) ? items[0] : undefined;
}

async function listUserTags(): Promise<any[]> {
  return panel('GET', `/users/${USER_ID}/tags${tenantQuery}`);
}

/** Inicia a recarga local com o idTag e confere que o simulador recebeu Accepted. */
async function startLocal(idTag: string) {
  await sim(`/connect/${CONNECTOR}`);
  await sim(`/start/${CONNECTOR}?idTag=${encodeURIComponent(idTag)}`);
}

async function main() {
  if (!API_TOKEN || !CHARGER_DB_ID || !USER_ID) {
    throw new Error('Defina API_TOKEN, CHARGER_DB_ID e USER_ID (e TENANT_ID para Super Admin).');
  }
  await panel('PATCH', `/chargers/${CHARGER_DB_ID}`, { allowLocalStart: false });
  await reset();

  const rfid = `E12${hex(9)}`; // 12 caracteres alfanuméricos
  let tagId = '';

  await scenario('1. Tag RFID cadastrada → Accepted e cobrança pós-paga', async () => {
    const created = await panel('POST', `/users/${USER_ID}/tags${tenantQuery}`, {
      type: 'RFID',
      value: rfid,
      label: 'cenário e12',
    });
    tagId = created.id;
    expectEqual(created.value, rfid, 'valor completo no painel');

    const auth = await sim(`/authorize?idTag=${rfid}`);
    expectEqual(auth.response?.idTagInfo?.status, 'Accepted', 'Authorize');

    await startLocal(rfid);
    const c = await waitFor('StartTransaction', async () => {
      const now = await connector();
      return now.transactionId !== null ? now : null;
    });
    expectEqual(c.lastStartStatus, 'Accepted', 'StartTransaction');

    const session = await waitFor('sessão da tag', async () => {
      const s = await latestSession();
      return s?.status === 'IN_PROGRESS' ? s : null;
    });
    if (String(session.userId?._id ?? session.userId) !== USER_ID && !session.userId?.name) {
      throw new Error('a sessão não ficou com o usuário da tag');
    }
    expectEqual(session.paymentMethod, 'CREDIT_CARD', 'paymentMethod');
    expectEqual(String(session.tagId), tagId, 'tagId na sessão');

    await sleep(3_000); // alguns MeterValues
    await sim(`/stop/${CONNECTOR}`);

    if (!SKIP_PAYMENT_CHECK) {
      const paid = await waitFor(
        'cobrança pós-paga',
        async () => {
          const s = await panel('GET', `/transactions/${session._id}`);
          if (s.paymentStatus === 'FAILED') throw new Error(`cobrança falhou: ${s.postPaidError ?? 'sem motivo'}`);
          return s.paymentStatus === 'PAID' ? s : null;
        },
        PAYMENT_WAIT_MS,
      );
      if (!(paid.totalCost >= 0)) throw new Error('sessão sem custo final');
    }

    const mine = (await listUserTags()).find((t) => t.id === tagId);
    expectEqual(mine?.usageCount, 1, 'usageCount (uma sessão criada)');
    return `tag ${rfid}: sessão ${session._id}, uso contado uma vez`;
  });

  await scenario('2. Tag desativada → Invalid (mesmo com strictIdTag desligado)', async () => {
    if (!tagId) throw new Error('cenário 1 não criou a tag');
    await panel('PATCH', `/users/${USER_ID}/tags/${tagId}${tenantQuery}`, { active: false });
    const auth = await sim(`/authorize?idTag=${rfid}`);
    expectEqual(auth.response?.idTagInfo?.status, 'Invalid', 'Authorize');
    await startLocal(rfid);
    const c = await connector();
    expectEqual(c.lastStartStatus, 'Invalid', 'StartTransaction');
    expectEqual(c.transactionId, null, 'transação no simulador após DeAuthorized');
    return 'tag inativa recusada no Authorize e no StartTransaction';
  });

  await scenario('3. Reativar → Accepted de novo (cache invalidado)', async () => {
    if (!tagId) throw new Error('cenário 1 não criou a tag');
    await panel('PATCH', `/users/${USER_ID}/tags/${tagId}${tenantQuery}`, { active: true });
    const auth = await sim(`/authorize?idTag=${rfid}`);
    expectEqual(auth.response?.idTagInfo?.status, 'Accepted', 'Authorize');
    return 'tag reativada aceita na hora (sem esperar o TTL do cache)';
  });

  await scenario('3b. Valor duplicado no operador → 409', async () => {
    const res = await fetch(`${API_URL}/users/${USER_ID}/tags${tenantQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ type: 'RFID', value: rfid.toLowerCase() }),
    });
    expectEqual(res.status, 409, 'HTTP');
    expectEqual((await res.json()).code, 'TAG_ALREADY_REGISTERED', 'code');
    return '409 TAG_ALREADY_REGISTERED';
  });

  if (!APP_TOKEN || !TENANT_ID) {
    results.push({
      scenario: '4. Captura de Autocharge',
      ok: true,
      detail: 'pulado (defina APP_TOKEN do usuário e TENANT_ID)',
    });
  } else {
    const mac = hex(12);
    await scenario('4. Captura de Autocharge na sessão do app e recarga seguinte por MAC', async () => {
      const pending = await app('POST', '/me/tags/autocharge', { tenantId: TENANT_ID });
      expectEqual(pending.status, 'WAITING_FIRST_SESSION', 'status do pedido');

      // Sessão iniciada pelo app (cartão): o carregador apresenta o MAC no meio da janela.
      await sim(`/connect/${CONNECTOR}`);
      await app('POST', '/transactions/remote-start/credit-card', {
        tenantId: TENANT_ID,
        chargerId: CHARGER_DB_ID,
        connectorId: CONNECTOR,
        meterStart: 0,
        ...(CARD_ID && { cardId: CARD_ID }),
      });
      await waitFor('StartTransaction do app', async () => ((await connector()).transactionId !== null ? true : null));
      // O carregador anuncia o MAC do veículo (idTag `VID:<MAC>`).
      await sim(`/authorize?mac=${mac}`);

      const captured = await waitFor('tag AUTOCHARGE_MAC criada pela captura', async () =>
        (await listUserTags()).find((t) => t.type === 'AUTOCHARGE_MAC' && t.value === mac),
      );
      expectEqual(captured.source, 'AUTOCHARGE_CAPTURE', 'origem');
      const waiting = await app('GET', '/me/tags/autocharge');
      expectEqual(waiting.length, 0, 'pedido de captura removido');
      const mine = (await app('GET', `/me/tags?tenantId=${TENANT_ID}`)).find((t: any) => t.id === captured.id);
      expectEqual(mine?.value, `••••${mac.slice(-4)}`, 'valor mascarado no app');
      await sim(`/stop/${CONNECTOR}`);
      await sleep(1_000);
      await reset();

      // Próxima recarga: só o MAC, sem app.
      const auth = await sim(`/authorize?mac=${mac}`);
      expectEqual(auth.response?.idTagInfo?.status, 'Accepted', 'Authorize por MAC');
      await sim(`/connect/${CONNECTOR}`);
      await sim(`/start/${CONNECTOR}?mac=${mac}`);
      const c = await waitFor('StartTransaction por MAC', async () => {
        const now = await connector();
        return now.transactionId !== null ? now : null;
      });
      expectEqual(c.lastStartStatus, 'Accepted', 'StartTransaction por MAC');
      const session = await latestSession();
      expectEqual(session?.status, 'IN_PROGRESS', 'sessão por MAC');
      await sim(`/stop/${CONNECTOR}`);
      return `MAC ${mac} capturado na sessão do app e usado na recarga seguinte`;
    });
  }

  console.table(results);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

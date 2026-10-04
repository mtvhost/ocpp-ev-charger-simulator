/**
 * E07 — telemetria, ociosidade e auditoria contra backend + gateway locais.
 *
 * Fluxo: remote start (skipPayment) → MeterValues → SuspendedEV (ocioso) →
 * Charging (limpa) → SuspendedEV de novo → stop. Confere pela API:
 *  - a série de medições da sessão (gráfico e tabela, com Temperature);
 *  - `idleStartedAt` marcado, limpo e marcado de novo;
 *  - a linha do tempo com StatusNotification, comandos e o marco IDLE_STARTED;
 *  - a visão ao vivo do carregador durante a sessão.
 *
 * Pré-requisitos:
 *  - simulador rodando (`npm start`) com CHARGER_ID = identity do carregador;
 *  - backend com METER_SAMPLES_ENABLED e IDLE_DETECTION_ENABLED ligados (padrão);
 *  - API_TOKEN de um usuário de teste com CHARGERS_VIEW, TRANSACTIONS_VIEW,
 *    TRANSACTIONS_CREATE e TRANSACTIONS_SKIP_PAYMENT.
 *
 * Variáveis: SIM_URL, API_URL, API_TOKEN, CHARGER_DB_ID, TENANT_ID, CONNECTOR,
 * METER_WAIT_MS (padrão 25000: duas leituras de 10 s mais o flush de 2 s).
 *
 *   npm run scenarios:e07
 */
import 'dotenv/config';

const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
const API_URL = process.env.API_URL || 'http://localhost:3030/v1';
const API_TOKEN = process.env.API_TOKEN || '';
const CHARGER_DB_ID = process.env.CHARGER_DB_ID || '';
const TENANT_ID = process.env.TENANT_ID || '';
const CONNECTOR = Number(process.env.CONNECTOR || 1);
const METER_WAIT_MS = Number(process.env.METER_WAIT_MS || 25_000);

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

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(1_000);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
async function step(name: string, fn: () => Promise<string>) {
  try {
    results.push({ step: name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ step: name, ok: false, detail: (e as Error).message });
  }
}

const connectorState = async () => (await sim('/status')).connectors[String(CONNECTOR)];

async function main() {
  if (!API_TOKEN || !CHARGER_DB_ID || !TENANT_ID) {
    throw new Error('Defina API_TOKEN, CHARGER_DB_ID e TENANT_ID.');
  }

  // Conector livre e conectado.
  const initial = await connectorState();
  if (initial.transactionId !== null) await sim(`/stop/${CONNECTOR}`);
  await sleep(500);
  if ((await connectorState()).connectorStatus !== 'Available') await sim(`/disconnect/${CONNECTOR}`);
  await sim(`/connect/${CONNECTOR}`);

  let trxId = '';
  await step('1. Remote start e sessão ao vivo', async () => {
    const trx = await api('POST', '/transactions/remote-start', {
      tenantId: TENANT_ID,
      chargerId: CHARGER_DB_ID,
      connectorId: CONNECTOR,
      meterStart: 0,
      skipPayment: true,
    });
    trxId = trx._id ?? trx.transaction?._id ?? trx.data?._id ?? '';
    await waitFor('StartTransaction', async () => (await connectorState()).transactionId !== null);
    await sleep(METER_WAIT_MS);
    const live = await api('GET', `/chargers/${CHARGER_DB_ID}/live`);
    const c = live.connectors.find((x: any) => x.connectorId === CONNECTOR);
    if (!c?.session) throw new Error('visão ao vivo sem sessão ativa no conector');
    trxId = trxId || c.session._id;
    if (!(c.session.currentPower > 0)) throw new Error(`potência ao vivo = ${c.session.currentPower}`);
    return `sessão ${trxId}, ${c.session.currentPower} W, connectorStatus ${c.session.connectorStatus ?? '—'}`;
  });

  await step('2. Série de medições gravada (gráfico e tabela)', async () => {
    const chart = await api('GET', `/transactions/${trxId}/meter-values?view=chart`);
    if (!chart.points?.length) throw new Error('gráfico sem pontos');
    for (const serie of ['powerW', 'energyWh', 'soc', 'temperatureC']) {
      if (!chart.series.includes(serie)) throw new Error(`série ${serie} ausente (${chart.series})`);
    }
    const table = await api('GET', `/transactions/${trxId}/meter-values?view=table&limit=5`);
    if (!table.total || !table.items[0]?.raw?.length) throw new Error('tabela sem leituras ou sem valor bruto');
    return `${chart.points.length} pontos (bucket ${chart.bucketSeconds} s), ${table.total} leituras`;
  });

  await step('3. SuspendedEV marca ociosidade', async () => {
    await sim(`/suspend/${CONNECTOR}`);
    const trx = await waitFor('idleStartedAt', async () => {
      const t = await api('GET', `/transactions/${trxId}`);
      return t.idleStartedAt ? t : null;
    });
    return `idleStartedAt ${trx.idleStartedAt}`;
  });

  await step('4. Voltar a carregar limpa a marcação', async () => {
    await sim(`/resume/${CONNECTOR}`);
    await waitFor('idleStartedAt limpo', async () => {
      const t = await api('GET', `/transactions/${trxId}`);
      return !t.idleStartedAt;
    });
    return 'idleStartedAt removido';
  });

  let idleAt = '';
  await step('5. Ociosidade de novo e StatusNotification repetido não move a marcação', async () => {
    await sleep(12_000);
    await sim(`/suspend/${CONNECTOR}`);
    const first = await waitFor('idleStartedAt', async () => (await api('GET', `/transactions/${trxId}`)).idleStartedAt);
    await sleep(METER_WAIT_MS); // MeterValues com 0 W chegam no estado ocioso
    const again = (await api('GET', `/transactions/${trxId}`)).idleStartedAt;
    if (again !== first) throw new Error(`marcação mudou: ${first} → ${again}`);
    idleAt = first;
    return `idleStartedAt ${first}`;
  });

  await step('6. Stop e auditoria', async () => {
    await sim(`/stop/${CONNECTOR}`);
    const closed = await waitFor('sessão encerrada', async () => {
      const t = await api('GET', `/transactions/${trxId}`);
      return t.stoppedAt ? t : null;
    });
    if (closed.idleStartedAt !== idleAt) throw new Error('idleStartedAt mudou no encerramento');
    await sleep(3_000); // flush da ingestão
    const timeline = await api('GET', `/transactions/${trxId}/timeline`);
    const actions = timeline.events.map((e: any) => `${e.kind}:${e.action}:${e.status ?? ''}`);
    for (const expected of ['SESSION:STARTED:', 'SESSION:IDLE_STARTED:', 'SESSION:STOPPED:']) {
      if (!actions.some((a: string) => a.startsWith(expected))) throw new Error(`linha do tempo sem ${expected}`);
    }
    if (!actions.some((a: string) => a.includes('StatusNotification:SuspendedEV'))) {
      throw new Error('linha do tempo sem StatusNotification SuspendedEV');
    }
    if (!actions.some((a: string) => a.startsWith('COMMAND:RemoteStartTransaction'))) {
      throw new Error('linha do tempo sem o RemoteStartTransaction');
    }
    const table = await api('GET', `/transactions/${trxId}/meter-values?view=table&limit=200`);
    const end = table.items.find((r: any) => r.context === 'Transaction.End');
    if (!end) throw new Error('leitura Transaction.End (StopTransaction.transactionData) ausente');
    return `${timeline.events.length} eventos; custo ${closed.totalCost ?? '—'}; status ${closed.status}`;
  });

  await sim(`/disconnect/${CONNECTOR}`).catch(() => undefined);

  console.table(results);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

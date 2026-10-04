/**
 * E09 — tarifação v2 (ociosidade, tarifa de ponta, tarifa congelada) contra
 * backend + gateway locais.
 *
 * Fluxo: grava no carregador uma tarifa v2 (R$ 2,00/kWh, faixa de ponta o dia
 * inteiro a R$ 3,00/kWh, ociosidade R$ 1,00/min sem carência), confere o
 * simulador de preço, inicia uma recarga local (RFID, allowLocalStart), muda a
 * tarifa no meio da sessão, deixa o conector ocioso (SuspendedEV) por
 * IDLE_WAIT_MS e encerra. Confere:
 *  - simulador: 30 kWh, 50 min, 15 min ocioso → R$ 105,00;
 *  - snapshot da sessão com v2Enforced, ociosidade e faixa;
 *  - preço final com a tarifa do início (a mudança no meio não vale);
 *  - itens: energia na faixa de ponta (R$ 3,00) e ociosidade (minutos inteiros);
 *  - total = soma dos itens.
 * No fim devolve a tarifa original do carregador.
 *
 * Pré-requisitos:
 *  - simulador rodando (`npm start`) com CHARGER_ID = identity do carregador;
 *  - tenant do carregador com tariffV2Enabled (Super Admin liga em Empresas);
 *  - API_TOKEN com CHARGERS_UPDATE, CHARGERS_VIEW, TRANSACTIONS_VIEW e TARIFFS_MANAGE;
 *  - Mongo/Redis locais (nunca o .env de produção do backend).
 *
 * Variáveis: SIM_URL, API_URL, API_TOKEN, CHARGER_DB_ID, CONNECTOR,
 * METER_WAIT_MS (padrão 25000), IDLE_WAIT_MS (padrão 75000).
 *
 *   npm run scenarios:e09
 */
import 'dotenv/config';

const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
const API_URL = process.env.API_URL || 'http://localhost:3030/v1';
const API_TOKEN = process.env.API_TOKEN || '';
const CHARGER_DB_ID = process.env.CHARGER_DB_ID || '';
const CONNECTOR = Number(process.env.CONNECTOR || 1);
const METER_WAIT_MS = Number(process.env.METER_WAIT_MS || 25_000);
const IDLE_WAIT_MS = Number(process.env.IDLE_WAIT_MS || 75_000);

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

const TARIFF = {
  isPaymentEnabled: true,
  billingModel: 'KWH',
  unitValue: 2,
  activationFeeEnabled: false,
  activationFeeValue: 0,
  idleFeeEnabled: true,
  idleFee: { valuePerMinute: 1, graceMinutes: 0, maxAmount: 0 },
  touPeriods: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', unitValue: 3 }],
  overrides: ['payment', 'price', 'activationFee', 'idleFee', 'touPeriods'],
};

async function main() {
  if (!API_TOKEN || !CHARGER_DB_ID) throw new Error('Defina API_TOKEN e CHARGER_DB_ID.');

  const charger = await api('GET', `/chargers/${CHARGER_DB_ID}`);
  const original = { billingConfig: charger.billingConfig, allowLocalStart: !!charger.allowLocalStart };
  const resolved = await api('GET', `/chargers/${CHARGER_DB_ID}/billing/resolved`);
  if (!resolved.v2Enabled) throw new Error('O tenant do carregador está com tariffV2Enabled desligado.');

  try {
    await step('1. Tarifa v2 gravada e origem por campo', async () => {
      await api('PATCH', `/chargers/${CHARGER_DB_ID}`, { billingConfig: TARIFF, allowLocalStart: true });
      const r = await api('GET', `/chargers/${CHARGER_DB_ID}/billing/resolved`);
      if (r.fieldSources.idleFee !== 'CHARGER' || r.fieldSources.touPeriods !== 'CHARGER') {
        throw new Error(`origem inesperada ${JSON.stringify(r.fieldSources)}`);
      }
      return `fontes ${JSON.stringify(r.fieldSources)}`;
    });

    await step('2. Simulador: 30 kWh, 50 min, 15 min ocioso', async () => {
      const s = await api('POST', '/transactions/pricing/simulate', {
        chargerId: CHARGER_DB_ID,
        energyKwh: 30,
        durationMinutes: 50,
        idleMinutes: 15,
      });
      if (s.totalCost !== 105) throw new Error(`esperado 105, veio ${s.totalCost}`);
      return `R$ ${s.totalCost} (${s.breakdown.items.map((i: any) => `${i.type}:${i.amount}`).join(', ')})`;
    });

    // Conector livre e conectado.
    const initial = await connectorState();
    if (initial.transactionId !== null) await sim(`/stop/${CONNECTOR}`);
    await sleep(500);
    if ((await connectorState()).connectorStatus !== 'Available') await sim(`/disconnect/${CONNECTOR}`);
    await sim(`/connect/${CONNECTOR}`);

    let trxId = '';
    await step('3. Recarga local com a tarifa congelada (v2Enforced)', async () => {
      await sim(`/start/${CONNECTOR}`);
      await waitFor('StartTransaction', async () => (await connectorState()).transactionId !== null);
      await sleep(METER_WAIT_MS);
      const live = await api('GET', `/chargers/${CHARGER_DB_ID}/live`);
      trxId = live.connectors.find((x: any) => x.connectorId === CONNECTOR)?.session?._id;
      if (!trxId) throw new Error('sessão ativa não encontrada');
      const trx = await waitFor('tariffSnapshot', async () => {
        const t = await api('GET', `/transactions/${trxId}`);
        return t.tariffSnapshot ? t : null;
      });
      const snap = trx.tariffSnapshot;
      if (!snap.v2Enforced || !snap.idleFeeEnabled || snap.touPeriods?.length !== 1) {
        throw new Error(`snapshot sem v2: ${JSON.stringify(snap)}`);
      }
      return `sessão ${trxId}, snapshot v2 (${snap.timezone})`;
    });

    await step('4. Mudar a tarifa no meio da sessão não muda o preço', async () => {
      await api('PATCH', `/chargers/${CHARGER_DB_ID}`, {
        billingConfig: { ...TARIFF, touPeriods: [{ ...TARIFF.touPeriods[0], unitValue: 99 }], idleFee: { ...TARIFF.idleFee, valuePerMinute: 99 } },
      });
      return 'faixa e ociosidade a R$ 99 gravadas no carregador';
    });

    await step('5. Ocioso (SuspendedEV) por IDLE_WAIT_MS', async () => {
      await sim(`/suspend/${CONNECTOR}`);
      const t = await waitFor('idleStartedAt', async () => (await api('GET', `/transactions/${trxId}`)).idleStartedAt);
      await sleep(IDLE_WAIT_MS);
      return `idleStartedAt ${t}`;
    });

    await step('6. Stop: energia na faixa, ociosidade e total = soma dos itens', async () => {
      await sim(`/stop/${CONNECTOR}`);
      const closed = await waitFor('sessão encerrada', async () => {
        const t = await api('GET', `/transactions/${trxId}`);
        return t.stoppedAt && t.costBreakdown ? t : null;
      });
      const items = closed.costBreakdown.items as any[];
      const energy = items.filter((i) => i.type === 'ENERGY');
      const idle = items.find((i) => i.type === 'IDLE');
      if (!energy.length || energy.some((i) => i.unitValue !== 3 || i.period !== '00:00-24:00')) {
        throw new Error(`energia fora da faixa de ponta: ${JSON.stringify(energy)}`);
      }
      if (!idle || idle.unitValue !== 1 || idle.quantity < 1) throw new Error(`ociosidade: ${JSON.stringify(idle)}`);
      const sum = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
      if (Math.abs(sum - closed.totalCost) > 0.001) throw new Error(`total ${closed.totalCost} ≠ soma ${sum}`);
      return `total R$ ${closed.totalCost}: ${items.map((i) => `${i.type} ${i.quantity}×${i.unitValue}=${i.amount}`).join('; ')} (${closed.costBreakdown.touMethod})`;
    });
  } finally {
    await api('PATCH', `/chargers/${CHARGER_DB_ID}`, original).catch((e) => console.error('restaurar tarifa:', e.message));
    await sim(`/disconnect/${CONNECTOR}`).catch(() => undefined);
  }

  console.table(results);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

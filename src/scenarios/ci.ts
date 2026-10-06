/**
 * CI — recarga ponta a ponta contra backend + gateway + simulador locais (E14-05).
 *
 * Duas sessões no mesmo conector, depois de o simulador conectar ao gateway e o
 * BootNotification ser aceito:
 *
 *  A) Remote start pela API → StartTransaction → MeterValues → stop → COMPLETED.
 *     Com `PAGARME_TEST_SECRET_KEY` (+ `PAGARME_TEST_PUBLIC_KEY`, sandbox real) a
 *     sessão é paga no cartão de teste do motorista (`/remote-start/credit-card`):
 *     o custo precisa ser kWh × preço (±0,01) e o `paymentStatus` fechar `PAID`.
 *     Sem os secrets a etapa de pagamento é pulada (`payment step skipped`): o
 *     remote start vira uma sessão de cortesia (`skipPayment`, `FREE_PAID`, custo 0),
 *     porque a API recusa remote start comum em carregador com tarifa.
 *
 *  B) Partida local com qualquer idTag (o carregador do seed tem `allowLocalStart`):
 *     a sessão é cobrada pela tarifa congelada, sem gateway. Confere
 *     `totalCost` = kWh × preço (±0,01), nos dois modos.
 *
 * Sai com código ≠ 0 em qualquer falha ou timeout.
 *
 * Variáveis (o `e2e.env` do seed do backend traz as de baixo):
 *   SIM_URL (padrão http://127.0.0.1:8081), API_URL (padrão http://127.0.0.1:3030/v1),
 *   CONNECTOR (1), METER_READINGS (3), STEP_TIMEOUT_MS (60000), E2E_ENV_FILE (e2e.env),
 *   API_TOKEN, CHARGER_DB_ID, CHARGER_ID, TENANT_ID, UNIT_VALUE,
 *   DRIVER_TOKEN, CARD_ID (só com pagamento), PAGARME_TEST_SECRET_KEY.
 *
 *   npm run scenarios:ci
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';

/** `E2E_ENV_FILE` (padrão `e2e.env`): variáveis do seed, sem sobrescrever o ambiente. */
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnvFile(process.env.E2E_ENV_FILE || 'e2e.env');

const SIM_URL = process.env.SIM_URL || 'http://127.0.0.1:8081';
const API_URL = process.env.API_URL || 'http://127.0.0.1:3030/v1';
const API_TOKEN = process.env.API_TOKEN || '';
const CHARGER_DB_ID = process.env.CHARGER_DB_ID || '';
const CHARGER_ID = process.env.CHARGER_ID || '';
const TENANT_ID = process.env.TENANT_ID || '';
const UNIT_VALUE = Number(process.env.UNIT_VALUE || NaN);
const DRIVER_TOKEN = process.env.DRIVER_TOKEN || '';
const CARD_ID = process.env.CARD_ID || '';
const CONNECTOR = Number(process.env.CONNECTOR || 1);
const METER_READINGS = Number(process.env.METER_READINGS || 3);
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 60_000);
const LOCAL_ID_TAG = 'CI-LOCAL-TAG';
const PAYMENT = !!process.env.PAGARME_TEST_SECRET_KEY && !!DRIVER_TOKEN && !!CARD_ID;
/** Diferença aceita entre o custo gravado e kWh × preço (arredondamento de centavos). */
const COST_TOLERANCE = 0.011;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sim(path: string): Promise<any> {
  const res = await fetch(`${SIM_URL}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`simulador ${path}: HTTP ${res.status}`);
  return res.json();
}

async function api(method: string, path: string, body?: unknown, token = API_TOKEN): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${method} ${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await sleep(1_000);
  }
  throw new Error(`timeout (${Math.round(timeoutMs / 1000)} s) esperando ${label}${lastError ? `: ${lastError}` : ''}`);
}

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail });
    console.log(`✔ ${name} (${Math.round((Date.now() - startedAt) / 1000)} s): ${detail}`);
    return true;
  } catch (e) {
    const detail = (e as Error).message;
    results.push({ step: name, ok: false, detail });
    console.error(`✘ ${name}: ${detail}`);
    return false;
  }
}

const connectorState = async () => (await sim('/status')).connectors[String(CONNECTOR)];
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Conector livre e plugado (Preparing), como um carro conectado. */
async function plugIn() {
  const initial = await connectorState();
  if (initial.transactionId !== null) await sim(`/stop/${CONNECTOR}`);
  await sleep(500);
  if ((await connectorState()).connectorStatus !== 'Available') await sim(`/disconnect/${CONNECTOR}`);
  await sim(`/connect/${CONNECTOR}`);
}

async function waitMeterReadings(trxId: string): Promise<number> {
  return waitFor(
    `${METER_READINGS} leituras de medidor`,
    async () => {
      const table = await api('GET', `/transactions/${trxId}/meter-values?view=table&limit=50`);
      return table.total >= METER_READINGS ? table.total : null;
    },
    STEP_TIMEOUT_MS * 2,
  );
}

async function stopAndComplete(trxId: string): Promise<any> {
  await sim(`/stop/${CONNECTOR}`);
  return waitFor('transação COMPLETED', async () => {
    const t = await api('GET', `/transactions/${trxId}`);
    return t.status === 'COMPLETED' && t.stoppedAt ? t : null;
  });
}

/** kWh entregues e custo esperado (kWh × preço) de uma sessão encerrada. */
function expectedCost(t: any): { kwh: number; expected: number } {
  const kwh = ((t.meterStop ?? 0) - (t.meterStart ?? 0)) / 1000;
  if (!(kwh > 0)) throw new Error(`nenhuma energia entregue (${t.meterStart} → ${t.meterStop})`);
  return { kwh, expected: round2(kwh * UNIT_VALUE) };
}

function assertCost(t: any): string {
  const { kwh, expected } = expectedCost(t);
  const actual = Number(t.totalCost);
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > COST_TOLERANCE) {
    throw new Error(`totalCost ${t.totalCost} ≠ ${kwh.toFixed(3)} kWh × ${UNIT_VALUE} = ${expected}`);
  }
  return `${kwh.toFixed(3)} kWh × R$ ${UNIT_VALUE} = R$ ${expected} (gravado ${actual})`;
}

async function main() {
  const missing = [
    ['API_TOKEN', API_TOKEN],
    ['CHARGER_DB_ID', CHARGER_DB_ID],
    ['CHARGER_ID', CHARGER_ID],
    ['TENANT_ID', TENANT_ID],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (!Number.isFinite(UNIT_VALUE)) missing.push('UNIT_VALUE');
  if (missing.length) {
    throw new Error(`Defina ${missing.join(', ')} (o seed do backend gera o e2e.env).`);
  }
  if (!PAYMENT) {
    console.warn(
      'payment step skipped: PAGARME_TEST_SECRET_KEY/PAGARME_TEST_PUBLIC_KEY ausentes (ou sem cartão no seed); a cobrança no gateway não é exercitada.',
    );
  }

  let ok = await step('1. Simulador conectado ao gateway e BootNotification aceito', async () => {
    const charger = await waitFor('BootNotification aceito (carregador online na API)', async () => {
      const c = await api('GET', `/chargers/${CHARGER_DB_ID}`);
      return c.isOnline === true && c.vendor === 'AntigravityEV' ? c : null;
    });
    return `${charger.identity} online, ${charger.vendor} ${charger.model}`;
  });

  // ── A) Remote start pela API ─────────────────────────────────────────────
  let remoteId = '';
  if (ok) {
    ok = await step('2. Remote start pela API e StartTransaction no carregador', async () => {
      await plugIn();
      const body = { tenantId: TENANT_ID, chargerId: CHARGER_DB_ID, connectorId: CONNECTOR, meterStart: 0 };
      const started = PAYMENT
        ? await api('POST', '/transactions/remote-start/credit-card', { ...body, cardId: CARD_ID }, DRIVER_TOKEN)
        : await api('POST', '/transactions/remote-start', { ...body, skipPayment: true });
      remoteId = started._id ?? started.transaction?._id ?? started.data?._id ?? '';
      await waitFor('StartTransaction no simulador', async () => (await connectorState()).transactionId !== null);
      if (!remoteId) {
        const list = await api('GET', `/transactions?chargerId=${CHARGER_DB_ID}&limit=1&sortBy=startedAt&sortOrder=desc`);
        remoteId = list.items?.[0]?._id ?? '';
      }
      if (!remoteId) throw new Error('não foi possível identificar a transação criada');
      return `transação ${remoteId} (${PAYMENT ? 'cartão de teste Pagar.me' : 'cortesia, sem gateway'})`;
    });
  }

  if (ok) ok = await step(`3. ${METER_READINGS} MeterValues chegam ao backend`, async () => `${await waitMeterReadings(remoteId)} leituras gravadas`);

  if (ok) {
    ok = await step('4. Stop e transação COMPLETED', async () => {
      const closed = await stopAndComplete(remoteId);
      return `COMPLETED, medidor ${closed.meterStart ?? 0} → ${closed.meterStop} Wh`;
    });
  }

  if (ok) {
    if (PAYMENT) {
      await step('5. Custo = kWh × preço e pagamento capturado no sandbox do Pagar.me', async () => {
        const paid = await waitFor('paymentStatus PAID', async () => {
          const t = await api('GET', `/transactions/${remoteId}`);
          if (t.paymentStatus === 'FAILED') throw new Error(`pagamento FAILED (${t.gatewayTransactionId ?? 'sem id'})`);
          return t.paymentStatus === 'PAID' ? t : null;
        });
        return `${assertCost(paid)}; PAID, gateway ${paid.gatewayTransactionId ?? '—'}`;
      });
    } else {
      console.warn('payment step skipped');
      await step('5. Sessão de cortesia fechada sem cobrança (payment step skipped)', async () => {
        const t = await api('GET', `/transactions/${remoteId}`);
        if (t.paymentStatus !== 'FREE_PAID') throw new Error(`paymentStatus ${t.paymentStatus} (esperado FREE_PAID)`);
        if (Number(t.totalCost) !== 0) throw new Error(`totalCost ${t.totalCost} (esperado 0 na cortesia)`);
        return 'FREE_PAID, custo 0';
      });
    }
  }

  // ── B) Partida local cobrada pela tarifa (sem gateway) ───────────────────
  let localId = '';
  if (ok) {
    ok = await step('6. Partida local com idTag livre cria a sessão cobrada pela tarifa', async () => {
      await plugIn();
      await sim(`/start/${CONNECTOR}?idTag=${LOCAL_ID_TAG}`);
      await waitFor('StartTransaction local no simulador', async () => (await connectorState()).transactionId !== null);
      localId = await waitFor('sessão local na API', async () => {
        const list = await api('GET', `/transactions?chargerId=${CHARGER_DB_ID}&limit=5&sortBy=startedAt&sortOrder=desc`);
        const hit = (list.items ?? []).find((t: any) => t.rfidTag === LOCAL_ID_TAG && t.status === 'IN_PROGRESS');
        return hit?._id ?? null;
      });
      return `transação ${localId}`;
    });
  }

  if (ok) ok = await step(`7. ${METER_READINGS} MeterValues da sessão local`, async () => `${await waitMeterReadings(localId)} leituras gravadas`);

  if (ok) {
    await step('8. Stop da sessão local: custo = kWh × preço (±0,01)', async () => {
      const closed = await stopAndComplete(localId);
      return assertCost(closed);
    });
  }

  await sim(`/disconnect/${CONNECTOR}`).catch(() => undefined);

  console.table(results);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

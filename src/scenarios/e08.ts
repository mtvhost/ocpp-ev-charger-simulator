/**
 * E08 — operações OCPP guiadas contra backend + gateway locais.
 *
 * Exercita `POST /chargers/:id/operations/:action` e confere o resultado do
 * carregador em cada caso (ACCEPTED, REJECTED, NOT_SUPPORTED, SCHEDULED,
 * REBOOT_REQUIRED, OFFLINE, TIMEOUT), o 409 de sessão ativa, a validação do
 * payload, o mascaramento da AuthorizationKey, o upload do diagnóstico, o
 * DataTransfer de entrada e a trilha de auditoria.
 *
 * Pré-requisitos:
 *  - simulador rodando (`npm start`) com CHARGER_ID = identity do carregador;
 *  - backend com PUBLIC_API_URL acessível pelo simulador (upload do diagnóstico);
 *  - API_TOKEN de um usuário com CHARGERS_VIEW, CHARGERS_OPERATE e
 *    CHARGERS_OPERATE_CRITICAL (ou Super Admin).
 *  - Para o caso TIMEOUT, OCPP_OPERATION_SYNC_WAIT_MS pequeno no backend agiliza (202 + polling).
 *
 * Variáveis: SIM_URL, API_URL, API_TOKEN, CHARGER_DB_ID, CONNECTOR.
 *
 *   npm run scenarios:e08
 */
import 'dotenv/config';

const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
const API_URL = process.env.API_URL || 'http://localhost:3030/v1';
const API_TOKEN = process.env.API_TOKEN || '';
const CHARGER_DB_ID = process.env.CHARGER_DB_ID || '';
const CONNECTOR = Number(process.env.CONNECTOR || 1);
const OTHER_CONNECTOR = CONNECTOR === 1 ? 2 : 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sim(path: string): Promise<any> {
  const res = await fetch(`${SIM_URL}${path}`);
  if (!res.ok) throw new Error(`simulator ${path}: HTTP ${res.status}`);
  return res.json();
}

async function apiRaw(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const { status, body: data } = await apiRaw(method, path, body);
  if (status >= 400) throw new Error(`API ${method} ${path}: HTTP ${status} ${JSON.stringify(data)}`);
  return data;
}

/** Executa a operação e, se vier 202, consulta até sair de PENDING. */
async function operate(action: string, payload: Record<string, unknown> = {}, confirmActiveSession?: boolean) {
  const res = await apiRaw('POST', `/chargers/${CHARGER_DB_ID}/operations/${action}`, { payload, confirmActiveSession });
  if (res.status !== 200 && res.status !== 202) return res;
  let op = res.body;
  const deadline = Date.now() + 50_000;
  while (op.outcome === 'PENDING' && Date.now() < deadline) {
    await sleep(1_000);
    op = await api('GET', `/chargers/${CHARGER_DB_ID}/operations/${op.operationId}`);
  }
  return { status: res.status, body: op };
}

async function expectOutcome(action: string, payload: Record<string, unknown>, outcome: string, confirm?: boolean) {
  const { status, body } = await operate(action, payload, confirm);
  if (body.outcome !== outcome) {
    throw new Error(`${action}: esperado ${outcome}, veio HTTP ${status} ${JSON.stringify(body)}`);
  }
  return body;
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

async function main() {
  if (!API_TOKEN || !CHARGER_DB_ID) throw new Error('Defina API_TOKEN e CHARGER_DB_ID.');
  for (const action of ['UnlockConnector', 'ClearCache']) await sim(`/behavior?action=${action}&respond=default`);

  await step('1. GetConfiguration: aceita, AuthorizationKey mascarada', async () => {
    const op = await expectOutcome('GetConfiguration', {}, 'ACCEPTED');
    const keys = op.response.configurationKey as any[];
    const auth = keys.find((k) => k.key === 'AuthorizationKey');
    if (!auth?.masked || auth.value === 'sim-secret-key') throw new Error('AuthorizationKey não foi mascarada');
    if (!keys.find((k) => k.key === 'NumberOfConnectors')?.readonly) throw new Error('readonly não veio');
    return `${keys.length} chaves`;
  });

  await step('2. ChangeConfiguration: Accepted, RebootRequired, Rejected (readonly) e 400 no segredo', async () => {
    await expectOutcome('ChangeConfiguration', { key: 'HeartbeatInterval', value: '90' }, 'ACCEPTED', true);
    await expectOutcome('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '15' }, 'REBOOT_REQUIRED', true);
    await expectOutcome('ChangeConfiguration', { key: 'NumberOfConnectors', value: '3' }, 'REJECTED', true);
    const secret = await apiRaw('POST', `/chargers/${CHARGER_DB_ID}/operations/ChangeConfiguration`, {
      payload: { key: 'AuthorizationKey', value: 'x' },
    });
    if (secret.status !== 400 || secret.body.code !== 'SENSITIVE_KEY') throw new Error(`segredo: HTTP ${secret.status}`);
    return 'ok';
  });

  await step('3. Payload fora do OCPP 1.6 → 400 sem enviar', async () => {
    const bad = await apiRaw('POST', `/chargers/${CHARGER_DB_ID}/operations/Reset`, { payload: { type: 'Medium' } });
    const unknown = await apiRaw('POST', `/chargers/${CHARGER_DB_ID}/operations/RemoteStartTransaction`, { payload: {} });
    if (bad.status !== 400 || unknown.status !== 404) throw new Error(`HTTP ${bad.status} / ${unknown.status}`);
    return 'Reset{type:Medium} → 400; action fora do catálogo → 404';
  });

  await step('4. TriggerMessage StatusNotification → ACCEPTED', async () => {
    await expectOutcome('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: CONNECTOR }, 'ACCEPTED');
    return 'ok';
  });

  await step('5. Lista local: versão, Full, Differential com versão antiga → REJECTED', async () => {
    const before = await expectOutcome('GetLocalListVersion', {}, 'ACCEPTED');
    const next = Number(before.response.listVersion) + 1;
    await expectOutcome('SendLocalList', {
      listVersion: next,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'E08-TAG-1', idTagInfo: { status: 'Accepted' } }],
    }, 'ACCEPTED', true);
    const after = await expectOutcome('GetLocalListVersion', {}, 'ACCEPTED');
    if (after.response.listVersion !== next) throw new Error(`versão ${after.response.listVersion}`);
    await expectOutcome('SendLocalList', { listVersion: 1, updateType: 'Differential' }, 'REJECTED', true);
    return `versão ${before.response.listVersion} → ${next}`;
  });

  await step('6. DataTransfer: vendor conhecido → ACCEPTED com dados; desconhecido → REJECTED', async () => {
    const echo = await expectOutcome('DataTransfer', { vendorId: 'AntigravityEV', messageId: 'Echo', data: 'ping' }, 'ACCEPTED', true);
    if (echo.response.data !== 'ping') throw new Error('eco não voltou');
    await expectOutcome('DataTransfer', { vendorId: 'other.vendor' }, 'REJECTED', true);
    return 'ok';
  });

  await step('7. CALLERROR NotImplemented → NOT_SUPPORTED', async () => {
    await sim('/behavior?action=UnlockConnector&respond=NotImplemented');
    try {
      await expectOutcome('UnlockConnector', { connectorId: OTHER_CONNECTOR }, 'NOT_SUPPORTED', true);
    } finally {
      await sim('/behavior?action=UnlockConnector&respond=default');
    }
    return 'ok';
  });

  await step('8. Sem resposta → TIMEOUT (202 + polling quando passa da espera)', async () => {
    await sim('/behavior?action=ClearCache&respond=timeout');
    try {
      const { status } = await operate('ClearCache', {}, true);
      const history = await api('GET', `/chargers/${CHARGER_DB_ID}/operations?action=ClearCache&limit=1`);
      if (history.items[0]?.outcome !== 'TIMEOUT') throw new Error(`outcome ${history.items[0]?.outcome}`);
      return `HTTP ${status}`;
    } finally {
      await sim('/behavior?action=ClearCache&respond=default');
    }
  });

  await step('9. Sessão ativa: 409 sem confirmação; com confirmação ChangeAvailability → SCHEDULED', async () => {
    const state = (await sim('/status')).connectors[String(CONNECTOR)];
    if (state.transactionId === null) {
      await sim(`/connect/${CONNECTOR}`).catch(() => undefined);
      await sim(`/start/${CONNECTOR}`);
    }
    await waitFor('sessão ativa no backend', async () => {
      const live = await api('GET', `/chargers/${CHARGER_DB_ID}/live`);
      return live.connectors.find((c: any) => c.connectorId === CONNECTOR)?.session;
    });
    const conflict = await apiRaw('POST', `/chargers/${CHARGER_DB_ID}/operations/Reset`, { payload: { type: 'Soft' } });
    if (conflict.status !== 409 || conflict.body.code !== 'ACTIVE_SESSION') throw new Error(`HTTP ${conflict.status}`);
    if (JSON.stringify(conflict.body).match(/email|userId|name/)) throw new Error('409 expõe dados do motorista');
    // Outro conector livre: não avisa.
    await expectOutcome('UnlockConnector', { connectorId: OTHER_CONNECTOR }, 'ACCEPTED');
    await expectOutcome('ChangeAvailability', { connectorId: CONNECTOR, type: 'Inoperative' }, 'SCHEDULED', true);
    return `${conflict.body.sessions.length} sessão(ões) no 409`;
  });

  await step('10. GetDiagnostics: fileName na resposta e arquivo recebido pelo link', async () => {
    const op = await expectOutcome('GetDiagnostics', { retries: 1, retryInterval: 5 }, 'ACCEPTED');
    if (!op.response.fileName) throw new Error('sem fileName');
    if (!String(op.payload.location).includes('/diagnostics-uploads/')) throw new Error('location não gerado pelo backend');
    const received = await waitFor('arquivo recebido', async () => {
      const list = await api('GET', `/chargers/${CHARGER_DB_ID}/diagnostics?limit=1`);
      return list[0]?.status === 'Uploaded' && list[0].files.length ? list[0] : null;
    }, 45_000);
    const file = await api('GET', `/chargers/${CHARGER_DB_ID}/diagnostics/${received._id}/files/0`);
    if (!file.url) throw new Error('sem URL de download');
    return `${received.files[0].name} (${received.files[0].size} B)`;
  });

  await step('11. DataTransfer de entrada → UnknownVendorId', async () => {
    const { response } = await sim('/data-transfer?vendorId=com.example.vendor&messageId=Hello');
    if (response.status !== 'UnknownVendorId') throw new Error(`status ${response.status}`);
    return 'ok';
  });

  await step('12. Reset Hard confirmado: sessão encerrada e carregador reconecta', async () => {
    await expectOutcome('Reset', { type: 'Hard' }, 'ACCEPTED', true);
    await waitFor('reconexão do simulador', async () => {
      const status = await sim('/status');
      return status.connection.connected && status.connectors[String(CONNECTOR)].transactionId === null;
    }, 45_000);
    return 'ok';
  });

  await step('13. Carregador offline → OFFLINE (send_failed), sem esperar 30 s', async () => {
    await sim('/ws/disconnect');
    const started = Date.now();
    try {
      await sleep(2_000);
      await expectOutcome('TriggerMessage', { requestedMessage: 'Heartbeat' }, 'OFFLINE');
    } finally {
      await sim('/ws/connect');
    }
    return `${Date.now() - started} ms`;
  });

  await step('14. Trilha de auditoria: usuário, payload e resposta', async () => {
    const history = await api('GET', `/chargers/${CHARGER_DB_ID}/operations?limit=50`);
    const actions = new Set(history.items.map((o: any) => o.action));
    for (const a of ['GetConfiguration', 'ChangeConfiguration', 'Reset', 'GetDiagnostics', 'DataTransfer']) {
      if (!actions.has(a)) throw new Error(`histórico sem ${a}`);
    }
    if (history.items.some((o: any) => !o.actor || !o.requestedAt)) throw new Error('registro sem autor/horário');
    if (history.items.some((o: any) => 'userId' in o)) throw new Error('histórico expõe userId');
    return `${history.total} operações`;
  });

  await sim(`/disconnect/${CONNECTOR}`).catch(() => undefined);
  console.table(results);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

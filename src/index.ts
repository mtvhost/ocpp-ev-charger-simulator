import 'dotenv/config';
import express from 'express';
import { OCPPClient } from './ocpp-client';
import { ChargerSimulator } from './simulator';
import { FORCED_BEHAVIORS, ForcedBehavior, OperationsHandler } from './operations';

/**
 * idTag da requisição: `?idTag=` literal, ou `?mac=AABBCCDDEEFF` (E12), que vira
 * `VID:AABBCCDDEEFF`, o idTag que carregadores com Autocharge enviam.
 */
function resolveIdTag(query: Record<string, unknown>): string {
  const mac = query.mac as string | undefined;
  if (mac) return `VID:${mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase()}`;
  return (query.idTag as string) || DEFAULT_ID_TAG;
}


const CENTRAL_SYSTEM_URL = process.env.CENTRAL_SYSTEM_URL || 'ws://ev.mim.tec.br/ocpp';
const CHARGER_ID = process.env.CHARGER_ID || 'MIM-001';
// E06: senha OCPP (Security Profile 1). Vazia = conecta sem Authorization (carregador legado).
const CHARGER_PASSWORD = process.env.CHARGER_PASSWORD || '';
const DEFAULT_ID_TAG = 'TAG-12345';
const PORT = process.env.PORT || 8080;
const RECONNECT_DELAY_MS = 5000;

async function main(): Promise<void> {
  console.log(`Starting simulator for charger ${CHARGER_ID}...`);
  const client = new OCPPClient(CENTRAL_SYSTEM_URL, CHARGER_ID, CHARGER_PASSWORD);
  const simulator = new ChargerSimulator(client);

  // Uma retentativa agendada por vez; /ws/disconnect desliga a reconexão automática.
  let autoReconnect = true;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function scheduleReconnect() {
    if (!autoReconnect || reconnectTimer) return;
    console.log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000} seconds...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectWithRetry();
    }, RECONNECT_DELAY_MS);
  }

  function cancelReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  async function connectOnce(): Promise<void> {
    await client.connect();
    await simulator.boot();
  }

  async function connectWithRetry() {
    try {
      await connectOnce();
    } catch (err) {
      console.log(`Connection failed (${(err as Error).message}).`);
      scheduleReconnect();
    }
  }

  client.addCloseListener(() => scheduleReconnect());

  /** Reboot pedido pelo CMS (Reset): fecha, reconecta e manda BootNotification. */
  async function rebootFromCms(): Promise<void> {
    cancelReconnect();
    autoReconnect = false;
    await client.disconnect();
    autoReconnect = true;
    await connectWithRetry();
  }

  // E08: respostas às operações guiadas da plataforma.
  const operations = new OperationsHandler(client, simulator, rebootFromCms);

  const app = express();

  app.get('/status', (req, res) => {
    res.json({ ...simulator.getStatus(), connection: client.connection, autoReconnect, operations: operations.getState() });
  });

  /**
   * E06: reconecta com outra senha/URL. Fecha a conexão atual antes.
   *   ?password=…   senha nova (vazia = sem Authorization)   ?noAuth=1 idem
   *   ?url=ws://…   outro gateway (ex.: segunda instância)
   *   ?protocol=none  não oferece o subprotocolo ocpp1.6
   *   ?auto=0       não reconecta sozinho se falhar
   */
  app.get('/ws/connect', async (req, res) => {
    cancelReconnect();
    autoReconnect = false;
    await client.disconnect();
    if (req.query.noAuth === '1') client.setPassword('');
    else if (typeof req.query.password === 'string') client.setPassword(req.query.password);
    if (typeof req.query.url === 'string' && req.query.url) client.setUrl(req.query.url);
    client.offerSubprotocol = req.query.protocol !== 'none';
    try {
      await connectOnce();
      autoReconnect = req.query.auto !== '0';
      res.json({ ok: true, connection: client.connection });
    } catch (err) {
      // Recusa (401/400/429) não entra em loop de retentativa, a menos que ?auto=1.
      autoReconnect = req.query.auto === '1';
      if (autoReconnect) scheduleReconnect();
      res.status(200).json({ ok: false, error: (err as Error).message, connection: client.connection });
    }
  });

  app.get('/ws/disconnect', async (req, res) => {
    autoReconnect = false;
    cancelReconnect();
    await client.disconnect();
    res.json({ ok: true, connection: client.connection });
  });

  /** Simula reboot: fecha o socket, reconecta com a senha atual e manda BootNotification. */
  app.get('/reboot', async (req, res) => {
    cancelReconnect();
    autoReconnect = false;
    await client.disconnect();
    try {
      await connectOnce();
      autoReconnect = true;
      res.json({ ok: true, connection: client.connection });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message, connection: client.connection });
    }
  });

  app.get('/connect/:connectorId?', async (req, res) => {
    const connectorId = parseInt(req.params.connectorId || req.query.connectorId as string || req.query.connector as string) || 1;
    await simulator.plugIn(connectorId);
    res.json({ message: `Connector ${connectorId} plugged in. Status updated to Preparing.`, state: simulator.getStatus() });
  });

  app.get('/disconnect/:connectorId?', async (req, res) => {
    const connectorId = parseInt(req.params.connectorId || req.query.connectorId as string || req.query.connector as string) || 1;
    await simulator.plugOut(connectorId);
    res.json({ message: `Connector ${connectorId} unplugged. Status updated to Available.`, state: simulator.getStatus() });
  });

  app.get('/start/:connectorId?', async (req, res) => {
    const connectorId = parseInt(req.params.connectorId || req.query.connectorId as string || req.query.connector as string) || 1;
    const limitQuery = req.query.limit;
    const limit = limitQuery ? parseFloat(limitQuery as string) : undefined;
    const tag = resolveIdTag(req.query);
    await simulator.startCharging(tag, connectorId, limit);
    res.json({ message: `StartTransaction sent for connector ${connectorId}.`, state: simulator.getStatus() });
  });

  app.get('/authorize', async (req, res) => {
    const tag = resolveIdTag(req.query);
    try {
      const response = await simulator.authorize(tag);
      res.json({ message: `Authorize sent for idTag ${tag}.`, response });
    } catch (err) {
      res.status(502).json({ message: `Authorize failed: ${(err as Error).message}` });
    }
  });

  app.get('/suspend/:connectorId?', async (req, res) => {
    const connectorId = parseInt(req.params.connectorId || req.query.connectorId as string || req.query.connector as string) || 1;
    const ok = await simulator.suspend(connectorId);
    res.status(ok ? 200 : 409).json({
      message: ok ? `Connector ${connectorId} suspended by the EV (SuspendedEV, 0 W).` : `Connector ${connectorId} is not charging.`,
      state: simulator.getStatus(),
    });
  });

  app.get('/resume/:connectorId?', async (req, res) => {
    const connectorId = parseInt(req.params.connectorId || req.query.connectorId as string || req.query.connector as string) || 1;
    const ok = await simulator.resume(connectorId);
    res.status(ok ? 200 : 409).json({
      message: ok ? `Connector ${connectorId} charging again.` : `Connector ${connectorId} is not suspended.`,
      state: simulator.getStatus(),
    });
  });

  app.get('/stop/:connectorId?', async (req, res) => {
    const connectorId = parseInt(req.params.connectorId || req.query.connectorId as string || req.query.connector as string) || 1;
    await simulator.stopCharging(connectorId);
    res.json({ message: `StopTransaction sent for connector ${connectorId}.`, state: simulator.getStatus() });
  });

  /**
   * E08: força a resposta de uma action (Rejected | NotSupported | NotImplemented | timeout);
   * `respond=default` volta ao comportamento normal.
   */
  app.get('/behavior', (req, res) => {
    const action = String(req.query.action || '');
    const respond = String(req.query.respond || 'default');
    if (!action || (respond !== 'default' && !FORCED_BEHAVIORS.includes(respond as ForcedBehavior))) {
      res.status(400).json({ message: `Use ?action=<Action>&respond=${[...FORCED_BEHAVIORS, 'default'].join('|')}` });
      return;
    }
    operations.setBehavior(action, respond as ForcedBehavior | 'default');
    res.json({ behaviors: operations.getBehaviors() });
  });

  /** E08: DataTransfer iniciado pelo carregador (o CMS responde UnknownVendorId). */
  app.get('/data-transfer', async (req, res) => {
    try {
      const response = await operations.sendDataTransfer(
        String(req.query.vendorId || 'com.example.vendor'),
        req.query.messageId as string | undefined,
        req.query.data as string | undefined,
      );
      res.json({ response });
    } catch (err) {
      res.status(502).json({ message: `DataTransfer failed: ${(err as Error).message}` });
    }
  });

  // Servidor HTTP sobe antes da primeira conexão: o simulador é controlável
  // mesmo quando o gateway recusa (401) ou está fora.
  app.listen(PORT, () => {
    console.log(`HTTP Control Server listening on port ${PORT}`);
  });

  await connectWithRetry();
}

main().catch(console.error);

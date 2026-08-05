import 'dotenv/config';
import express from 'express';
import { OCPPClient } from './ocpp-client';
import { ChargerSimulator } from './simulator';

const CENTRAL_SYSTEM_URL = process.env.CENTRAL_SYSTEM_URL || 'ws://ev.mim.tec.br/ocpp';
const CHARGER_ID = process.env.CHARGER_ID || 'MIM-001';
const DEFAULT_ID_TAG = 'TAG-12345';
const PORT = process.env.PORT || 8080;

async function main(): Promise<void> {
  console.log(`Starting simulator for charger ${CHARGER_ID}...`);
  const client = new OCPPClient(CENTRAL_SYSTEM_URL, CHARGER_ID);
  const simulator = new ChargerSimulator(client);

  async function connectWithRetry() {
    try {
      await client.connect();
      await simulator.boot();
    } catch (err) {
      console.log('Connection failed. Retrying in 5 seconds...');
      setTimeout(connectWithRetry, 5000);
    }
  }

  client.addCloseListener(() => {
    console.log('Reconnecting in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  });

  await connectWithRetry();

  const app = express();

  app.get('/status', (req, res) => {
    res.json(simulator.getStatus());
  });

  app.get('/connect', async (req, res) => {
    const connectorId = parseInt(req.query.connectorId as string) || 1;
    await simulator.plugIn(connectorId);
    res.json({ message: `Connector ${connectorId} plugged in. Status updated to Preparing.`, state: simulator.getStatus() });
  });

  app.get('/disconnect', async (req, res) => {
    const connectorId = parseInt(req.query.connectorId as string) || 1;
    await simulator.plugOut(connectorId);
    res.json({ message: `Connector ${connectorId} unplugged. Status updated to Available.`, state: simulator.getStatus() });
  });

  app.get('/start', async (req, res) => {
    const connectorId = parseInt(req.query.connectorId as string) || 1;
    const limitQuery = req.query.limit;
    const limit = limitQuery ? parseFloat(limitQuery as string) : undefined;
    const tag = (req.query.idTag as string) || DEFAULT_ID_TAG;
    await simulator.startCharging(tag, connectorId, limit);
    res.json({ message: `StartTransaction sent for connector ${connectorId}.`, state: simulator.getStatus() });
  });

  app.get('/stop', async (req, res) => {
    const connectorId = parseInt(req.query.connectorId as string) || 1;
    await simulator.stopCharging(connectorId);
    res.json({ message: `StopTransaction sent for connector ${connectorId}.`, state: simulator.getStatus() });
  });

  app.listen(PORT, () => {
    console.log(`HTTP Control Server listening on port ${PORT}`);
  });
}

main().catch(console.error);

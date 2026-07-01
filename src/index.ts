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
    await simulator.plugIn();
    res.json({ message: 'Connector plugged in. Status updated to Preparing.', state: simulator.getStatus() });
  });

  app.get('/disconnect', async (req, res) => {
    await simulator.plugOut();
    res.json({ message: 'Connector unplugged. Status updated to Available.', state: simulator.getStatus() });
  });

  app.get('/start', async (req, res) => {
    const limitQuery = req.query.limit;
    const limit = limitQuery ? parseFloat(limitQuery as string) : undefined;
    const tag = (req.query.idTag as string) || DEFAULT_ID_TAG;
    await simulator.startCharging(tag, limit);
    res.json({ message: 'StartTransaction sent.', state: simulator.getStatus() });
  });

  app.get('/stop', async (req, res) => {
    await simulator.stopCharging();
    res.json({ message: 'StopTransaction sent.', state: simulator.getStatus() });
  });

  app.listen(PORT, () => {
    console.log(`HTTP Control Server listening on port ${PORT}`);
  });
}

main().catch(console.error);

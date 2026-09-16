import { OCPPClient } from './ocpp-client';

interface ConnectorState {
  status: string;
  transactionId: number | null;
  currentMeter: number;
  currentSoC: number;
  meterValuesInterval: NodeJS.Timeout | null;
}

export class ChargerSimulator {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private connectors: Record<number, ConnectorState> = {
    1: { status: 'Available', transactionId: null, currentMeter: 0, currentSoC: 20, meterValuesInterval: null },
    2: { status: 'Available', transactionId: null, currentMeter: 0, currentSoC: 20, meterValuesInterval: null },
  };

  constructor(private client: OCPPClient) {
    this.client.addCloseListener(() => {
      console.log('Clearing simulator intervals due to disconnect.');
      this.shutdown();
      for (const id of [1, 2]) {
        this.connectors[id].transactionId = null;
        this.connectors[id].status = 'Available';
        this.connectors[id].currentSoC = 20;
      }
    });

    this.client.onRequest('RemoteStartTransaction', async (payload) => {
      const idTag = payload.idTag as string;
      const connectorId = payload.connectorId as number | undefined;
      // Default to 1 if not provided or 0
      const targetConnector = connectorId && connectorId > 0 ? connectorId : 1;

      const connector = this.connectors[targetConnector];

      if (connector && connector.status === 'Preparing' && connector.transactionId === null) {
        console.log(`Received RemoteStartTransaction for connector ${targetConnector} with idTag: ${idTag}. Accepting.`);

        let limitKwh: number | undefined;
        if (typeof payload.limit === 'number') {
          limitKwh = payload.limit;
        } else if (payload.chargingProfile) {
          const profile = payload.chargingProfile as Record<string, unknown>;
          const schedule = profile.chargingSchedule as Record<string, unknown>;
          if (schedule && Array.isArray(schedule.chargingSchedulePeriod)) {
            const period = schedule.chargingSchedulePeriod[0] as Record<string, unknown>;
            if (typeof period.limit === 'number') {
              limitKwh = period.limit;
            }
          }
        }

        setTimeout(() => this.startCharging(idTag, targetConnector, limitKwh), 500);
        return { status: 'Accepted' };
      }
      console.log(`Received RemoteStartTransaction for connector ${targetConnector} but status is ${connector?.status}. Rejecting.`);
      return { status: 'Rejected' };
    });

    this.client.onRequest('RemoteStopTransaction', async (payload) => {
      const txId = payload.transactionId as number;
      for (const id of [1, 2]) {
        if (this.connectors[id].transactionId === txId) {
          console.log(`Received RemoteStopTransaction for txId: ${txId} (Connector ${id}). Accepting.`);
          setTimeout(() => this.stopCharging(id), 500);
          return { status: 'Accepted' };
        }
      }
      console.log(`Received RemoteStopTransaction for txId ${txId} but no active transaction found. Rejecting.`);
      return { status: 'Rejected' };
    });
  }

  public async plugIn(connectorId: number = 1): Promise<void> {
    const connector = this.connectors[connectorId];
    if (!connector) return;
    if (connector.status !== 'Available') {
      console.log(`Cannot connect/plug in connector ${connectorId}. Status is ${connector.status}`);
      return;
    }
    connector.status = 'Preparing';
    await this.sendStatusNotification(connectorId, 'Preparing');
  }

  public async plugOut(connectorId: number = 1): Promise<void> {
    const connector = this.connectors[connectorId];
    if (!connector) return;
    if (connector.status !== 'Preparing' && connector.status !== 'Finishing') {
      console.log(`Cannot disconnect/unplug connector ${connectorId}. Status is ${connector.status}`);
      return;
    }
    connector.status = 'Available';
    await this.sendStatusNotification(connectorId, 'Available');
  }

  public async sendStatusNotification(connectorId: number, status: string): Promise<void> {
    console.log(`Sending StatusNotification for Connector ${connectorId}: ${status}...`);
    try {
      await this.client.send('StatusNotification', {
        connectorId,
        errorCode: 'NoError',
        status,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Failed to send StatusNotification for Connector ${connectorId}:`, err);
    }
  }

  public async boot(): Promise<void> {
    console.log('Sending BootNotification...');
    const response = await this.client.send('BootNotification', {
      chargePointVendor: 'AntigravityEV',
      chargePointModel: 'Sim-Model-1.6',
    });

    if (response.status === 'Accepted') {
      const interval = (response.interval as number) || 60;
      this.startHeartbeat(interval);

      // Notify central system of connector statuses
      await this.sendStatusNotification(0, 'Available');
      await this.sendStatusNotification(1, this.connectors[1].status);
      await this.sendStatusNotification(2, this.connectors[2].status);
    }
  }

  public async startCharging(idTag: string, connectorId: number = 1, limitKwh?: number): Promise<void> {
    const connector = this.connectors[connectorId];
    if (!connector) return;
    if (connector.transactionId !== null) {
      console.log(`Transaction already in progress on connector ${connectorId}`);
      return;
    }

    connector.status = 'Preparing';
    connector.currentSoC = 20; // reset SoC when starting a new charge
    await this.sendStatusNotification(connectorId, 'Preparing');

    console.log(`Starting Transaction on connector ${connectorId}...`);
    const txResponse = await this.client.send('StartTransaction', {
      connectorId,
      idTag,
      meterStart: connector.currentMeter,
      timestamp: new Date().toISOString(),
    });
    console.log(`StartTransaction Response (Connector ${connectorId}):`, txResponse);

    const txId = txResponse.transactionId;
    if (typeof txId === 'number') {
      connector.transactionId = txId;
      connector.status = 'Charging';
      await this.sendStatusNotification(connectorId, 'Charging');

      // OCPP 1.6: Transaction.Begin MeterValues — initial readings at transaction start
      await this.client.send('MeterValues', {
        connectorId,
        transactionId: txId,
        meterValue: [{
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: Math.round(connector.currentMeter).toString(),
              context: 'Transaction.Begin',
              measurand: 'Energy.Active.Import.Register',
              unit: 'Wh',
            },
            {
              value: connector.currentSoC.toString(),
              context: 'Transaction.Begin',
              measurand: 'SoC',
              location: 'EV',
              unit: 'Percent',
            },
          ],
        }],
      });

      this.startMeterValues(connectorId, limitKwh);
    } else {
      connector.status = 'Available';
      await this.sendStatusNotification(connectorId, 'Available');
    }
  }

  public async stopCharging(connectorId: number = 1): Promise<void> {
    const connector = this.connectors[connectorId];
    if (!connector) return;
    if (connector.transactionId === null) {
      console.log(`No active transaction on connector ${connectorId}`);
      return;
    }

    console.log(`Stopping Transaction on connector ${connectorId}...`);
    this.stopMeterValues(connectorId);
    connector.status = 'Finishing';
    await this.sendStatusNotification(connectorId, 'Finishing');

    const finalSoC = Math.min(Math.round(connector.currentSoC), 100);
    const response = await this.client.send('StopTransaction', {
      transactionId: connector.transactionId,
      meterStop: connector.currentMeter,
      timestamp: new Date().toISOString(),
      reason: 'Local',
      // OCPP 1.6: transactionData with Transaction.End readings
      transactionData: [{
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: Math.round(connector.currentMeter).toString(),
            context: 'Transaction.End',
            measurand: 'Energy.Active.Import.Register',
            unit: 'Wh',
          },
          {
            value: finalSoC.toString(),
            context: 'Transaction.End',
            measurand: 'SoC',
            location: 'EV',
            unit: 'Percent',
          },
          {
            value: '220',
            context: 'Transaction.End',
            measurand: 'Voltage',
            unit: 'V',
          },
          {
            value: '0',
            context: 'Transaction.End',
            measurand: 'Current.Import',
            unit: 'A',
          },
          {
            value: '0',
            context: 'Transaction.End',
            measurand: 'Power.Active.Import',
            unit: 'W',
          },
        ],
      }],
    });
    console.log(`StopTransaction Response (Connector ${connectorId}):`, response);
    connector.transactionId = null;
  }

  private startHeartbeat(intervalSeconds: number): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    const sendHeartbeat = async () => {
      try {
        console.log('Sending Heartbeat...');
        await this.client.send('Heartbeat', {});
      } catch (err) {
        console.error('Failed to send heartbeat:', err);
      }
    };

    // Send immediately on start
    sendHeartbeat();

    this.heartbeatInterval = setInterval(sendHeartbeat, intervalSeconds * 1000);
  }

  private startMeterValues(connectorId: number, limitKwh?: number): void {
    const connector = this.connectors[connectorId];
    if (!connector) return;
    if (connector.meterValuesInterval) clearInterval(connector.meterValuesInterval);

    const TIME_ACCELERATION = 30; // 30x faster than real life
    let intervalMs = 10000; // 10s interval
    let targetMeterValue: number | null = null;

    if (limitKwh && limitKwh > 0) {
      targetMeterValue = connector.currentMeter + (limitKwh * 1000);
      console.log(`Connector ${connectorId} Charging with limit: ${limitKwh} kWh.`);
    } else {
      console.log(`Connector ${connectorId} Charging without limit.`);
    }

    connector.meterValuesInterval = setInterval(async () => {
      let activeCount = 0;
      if (this.connectors[1].status === 'Charging' || this.connectors[1].status === 'Finishing') activeCount++;
      if (this.connectors[2].status === 'Charging' || this.connectors[2].status === 'Finishing') activeCount++;
      if (activeCount === 0) activeCount = 1;

      const powerW = 60000 / activeCount;
      const currentA = (powerW / 220).toFixed(2);

      // Energy added in this interval (Wh), accelerated
      const pulseValueWh = powerW * (intervalMs / 3600000) * TIME_ACCELERATION;

      connector.currentMeter += pulseValueWh;

      // Total battery = 34000 Wh. SoC increase based on added energy.
      connector.currentSoC += (pulseValueWh / 34000) * 100;

      console.log(`Connector ${connectorId}: Active Connectors: ${activeCount}, Power: ${powerW}W, Added: ${(pulseValueWh / 1000).toFixed(3)}kWh, SoC: ${connector.currentSoC.toFixed(2)}%`);
      try {
        await this.client.send('MeterValues', {
          connectorId,
          transactionId: connector.transactionId,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                {
                  value: Math.round(connector.currentMeter).toString(),
                  context: 'Sample.Periodic',
                  measurand: 'Energy.Active.Import.Register',
                  unit: 'Wh',
                },
                {
                  value: Math.min(Math.round(connector.currentSoC), 100).toString(),
                  context: 'Sample.Periodic',
                  measurand: 'SoC',
                  location: 'EV',
                  unit: 'Percent',
                },
                {
                  value: '220',
                  context: 'Sample.Periodic',
                  measurand: 'Voltage',
                  unit: 'V',
                },
                {
                  value: currentA.toString(),
                  context: 'Sample.Periodic',
                  measurand: 'Current.Import',
                  unit: 'A',
                },
                {
                  value: Math.round(powerW).toString(),
                  context: 'Sample.Periodic',
                  measurand: 'Power.Active.Import',
                  unit: 'W',
                }
              ],
            },
          ],
        });

        if (targetMeterValue !== null && connector.currentMeter >= targetMeterValue) {
          console.log(`Target kWh limit reached for Connector ${connectorId}. Autostopping transaction...`);
          await this.stopCharging(connectorId);
        } else if (connector.currentSoC >= 100) {
          console.log(`Target SoC 100% reached for Connector ${connectorId}. Autostopping transaction...`);
          await this.stopCharging(connectorId);
        }
      } catch (err) {
        console.error(`Failed to send meter values for Connector ${connectorId}:`, err);
      }
    }, intervalMs);
  }

  private stopMeterValues(connectorId: number): void {
    const connector = this.connectors[connectorId];
    if (connector && connector.meterValuesInterval) {
      clearInterval(connector.meterValuesInterval);
      connector.meterValuesInterval = null;
    }
  }

  public getStatus() {
    return {
      connectors: {
        1: {
          connectorStatus: this.connectors[1].status,
          transactionId: this.connectors[1].transactionId,
          currentMeterWh: this.connectors[1].currentMeter,
          currentSoC: this.connectors[1].currentSoC,
        },
        2: {
          connectorStatus: this.connectors[2].status,
          transactionId: this.connectors[2].transactionId,
          currentMeterWh: this.connectors[2].currentMeter,
          currentSoC: this.connectors[2].currentSoC,
        }
      }
    };
  }

  public shutdown(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.stopMeterValues(1);
    this.stopMeterValues(2);
  }
}

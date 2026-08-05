import { OCPPClient } from './ocpp-client';

interface ConnectorState {
  status: string;
  transactionId: number | null;
  currentMeter: number;
  meterValuesInterval: NodeJS.Timeout | null;
}

export class ChargerSimulator {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private connectors: Record<number, ConnectorState> = {
    1: { status: 'Available', transactionId: null, currentMeter: 0, meterValuesInterval: null },
    2: { status: 'Available', transactionId: null, currentMeter: 0, meterValuesInterval: null },
  };

  constructor(private client: OCPPClient) {
    this.client.addCloseListener(() => {
      console.log('Clearing simulator intervals due to disconnect.');
      this.shutdown();
      for (const id of [1, 2]) {
        this.connectors[id].transactionId = null;
        this.connectors[id].status = 'Available';
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

    const response = await this.client.send('StopTransaction', {
      transactionId: connector.transactionId,
      meterStop: connector.currentMeter,
      timestamp: new Date().toISOString(),
      reason: 'Local',
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

    const pulseValueWh = 500; // 0.5 kWh per pulse
    let intervalMs = 10000; // Default 10s interval
    let targetMeterValue: number | null = null;

    if (limitKwh && limitKwh > 0) {
      const totalWhToCharge = limitKwh * 1000;
      targetMeterValue = connector.currentMeter + totalWhToCharge;

      const totalPulses = totalWhToCharge / pulseValueWh;
      const totalDurationMs = 180 * 1000; // 3 minutes

      intervalMs = totalDurationMs / totalPulses;
      console.log(`Connector ${connectorId} Charging with limit: ${limitKwh} kWh. Total pulses: ${totalPulses}. Interval: ${(intervalMs / 1000).toFixed(2)}s`);
    } else {
      console.log(`Connector ${connectorId} Charging without limit. Interval: 10s`);
    }

    connector.meterValuesInterval = setInterval(async () => {
      connector.currentMeter += pulseValueWh;
      console.log(`Sending MeterValues for Connector ${connectorId}: ${connector.currentMeter / 1000} kWh (Added 0.5 kWh)...`);
      try {
        await this.client.send('MeterValues', {
          connectorId,
          transactionId: connector.transactionId,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                {
                  value: connector.currentMeter.toString(),
                  context: 'Sample.Periodic',
                  measurand: 'Energy.Active.Import.Register',
                  unit: 'Wh',
                },
              ],
            },
          ],
        });

        if (targetMeterValue !== null && connector.currentMeter >= targetMeterValue) {
          console.log(`Target kWh limit reached for Connector ${connectorId}. Autostopping transaction...`);
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
        },
        2: {
          connectorStatus: this.connectors[2].status,
          transactionId: this.connectors[2].transactionId,
          currentMeterWh: this.connectors[2].currentMeter,
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

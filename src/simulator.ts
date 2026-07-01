import { OCPPClient } from './ocpp-client';

export class ChargerSimulator {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private meterValuesInterval: NodeJS.Timeout | null = null;
  private transactionId: number | null = null;
  private currentMeter = 0; // in Wh

  private connectorStatus = 'Available';

  constructor(private client: OCPPClient) {
    this.client.addCloseListener(() => {
      console.log('Clearing simulator intervals due to disconnect.');
      this.shutdown();
      this.transactionId = null;
      this.connectorStatus = 'Available';
    });

    this.client.onRequest('RemoteStartTransaction', async (payload) => {
      const idTag = payload.idTag as string;
      if (this.connectorStatus === 'Preparing' && this.transactionId === null) {
        console.log(`Received RemoteStartTransaction with idTag: ${idTag}. Accepting.`);
        
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

        setTimeout(() => this.startCharging(idTag, limitKwh), 500);
        return { status: 'Accepted' };
      }
      console.log(`Received RemoteStartTransaction but status is ${this.connectorStatus}. Rejecting.`);
      return { status: 'Rejected' };
    });

    this.client.onRequest('RemoteStopTransaction', async (payload) => {
      const txId = payload.transactionId as number;
      if (this.transactionId === txId) {
        console.log(`Received RemoteStopTransaction for txId: ${txId}. Accepting.`);
        setTimeout(() => this.stopCharging(), 500);
        return { status: 'Accepted' };
      }
      console.log(`Received RemoteStopTransaction but txId ${txId} does not match active tx ${this.transactionId}. Rejecting.`);
      return { status: 'Rejected' };
    });
  }

  public async plugIn(): Promise<void> {
    if (this.connectorStatus !== 'Available') {
      console.log(`Cannot connect/plug in. Connector is currently ${this.connectorStatus}`);
      return;
    }
    this.connectorStatus = 'Preparing';
    await this.sendStatusNotification(1, 'Preparing');
  }

  public async plugOut(): Promise<void> {
    if (this.connectorStatus !== 'Preparing' && this.connectorStatus !== 'Finishing') {
      console.log(`Cannot disconnect/unplug. Connector is currently ${this.connectorStatus}`);
      return;
    }
    this.connectorStatus = 'Available';
    await this.sendStatusNotification(1, 'Available');
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
      await this.sendStatusNotification(1, 'Available');
    }
  }

  public async startCharging(idTag: string, limitKwh?: number): Promise<void> {
    if (this.transactionId !== null) {
      console.log('Transaction already in progress');
      return;
    }

    this.connectorStatus = 'Preparing';
    await this.sendStatusNotification(1, 'Preparing');

    console.log('Starting Transaction...');
    const txResponse = await this.client.send('StartTransaction', {
      connectorId: 1,
      idTag,
      meterStart: this.currentMeter,
      timestamp: new Date().toISOString(),
    });
    console.log('StartTransaction Response:', txResponse);

    const txId = txResponse.transactionId;
    if (typeof txId === 'number') {
      this.transactionId = txId;
      this.connectorStatus = 'Charging';
      await this.sendStatusNotification(1, 'Charging');
      this.startMeterValues(limitKwh);
    } else {
      this.connectorStatus = 'Available';
      await this.sendStatusNotification(1, 'Available');
    }
  }

  public async stopCharging(): Promise<void> {
    if (this.transactionId === null) {
      console.log('No active transaction');
      return;
    }

    console.log('Stopping Transaction...');
    this.stopMeterValues();
    this.connectorStatus = 'Finishing';
    await this.sendStatusNotification(1, 'Finishing');

    const response = await this.client.send('StopTransaction', {
      transactionId: this.transactionId,
      meterStop: this.currentMeter,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    console.log('StopTransaction Response:', response);
    this.transactionId = null;
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

  private startMeterValues(limitKwh?: number): void {
    if (this.meterValuesInterval) clearInterval(this.meterValuesInterval);

    const pulseValueWh = 500; // 0.5 kWh per pulse
    let intervalMs = 10000; // Default 10s interval
    let targetMeterValue: number | null = null;

    if (limitKwh && limitKwh > 0) {
      const totalWhToCharge = limitKwh * 1000;
      targetMeterValue = this.currentMeter + totalWhToCharge;
      
      const totalPulses = totalWhToCharge / pulseValueWh;
      const totalDurationMs = 180 * 1000; // 3 minutes
      
      intervalMs = totalDurationMs / totalPulses;
      console.log(`Charging with limit: ${limitKwh} kWh. Total pulses: ${totalPulses}. Interval between pulses: ${(intervalMs / 1000).toFixed(2)}s`);
    } else {
      console.log(`Charging without limit. Interval between pulses: 10s`);
    }

    this.meterValuesInterval = setInterval(async () => {
      this.currentMeter += pulseValueWh;
      console.log(`Sending MeterValues: ${this.currentMeter / 1000} kWh (Added 0.5 kWh)...`);
      try {
        await this.client.send('MeterValues', {
          connectorId: 1,
          transactionId: this.transactionId,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                {
                  value: this.currentMeter.toString(),
                  context: 'Sample.Periodic',
                  measurand: 'Energy.Active.Import.Register',
                  unit: 'Wh',
                },
              ],
            },
          ],
        });

        if (targetMeterValue !== null && this.currentMeter >= targetMeterValue) {
          console.log('Target kWh limit reached. Autostopping transaction...');
          await this.stopCharging();
        }
      } catch (err) {
        console.error('Failed to send meter values:', err);
      }
    }, intervalMs);
  }

  private stopMeterValues(): void {
    if (this.meterValuesInterval) {
      clearInterval(this.meterValuesInterval);
      this.meterValuesInterval = null;
    }
  }

  public getStatus() {
    return {
      connectorStatus: this.connectorStatus,
      transactionId: this.transactionId,
      currentMeterWh: this.currentMeter,
    };
  }

  public shutdown(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.stopMeterValues();
  }
}

import { OCPPClient } from './ocpp-client';
import { ChargerSimulator } from './simulator';

/**
 * E08: respostas do simulador às operações guiadas da plataforma
 * (ChangeAvailability, TriggerMessage, Get/ChangeConfiguration, GetDiagnostics,
 * UnlockConnector, ClearCache, Reset, DataTransfer, Get/SendLocalList,
 * ClearChargingProfile). `/behavior` força a resposta de qualquer action para
 * exercitar os resultados na tela: Rejected, NotSupported, NotImplemented ou timeout.
 */

export type ForcedBehavior = 'Rejected' | 'NotSupported' | 'NotImplemented' | 'timeout';
export const FORCED_BEHAVIORS: ForcedBehavior[] = ['Rejected', 'NotSupported', 'NotImplemented', 'timeout'];

type Payload = Record<string, unknown>;

interface ConfigEntry {
  value: string;
  readonly: boolean;
  /** Alterar responde RebootRequired. */
  rebootRequired?: boolean;
}

const VENDOR_ID = 'AntigravityEV';

class CallError extends Error {
  constructor(readonly ocppErrorCode: string, message: string) {
    super(message);
  }
}

export class OperationsHandler {
  private readonly behaviors = new Map<string, ForcedBehavior>();
  private localListVersion = 0;
  private localList = new Map<string, string>();
  private diagnosticsStatus = 'Idle';
  private readonly config: Record<string, ConfigEntry> = {
    HeartbeatInterval: { value: '60', readonly: false },
    ConnectionTimeOut: { value: '60', readonly: false },
    MeterValueSampleInterval: { value: '10', readonly: false, rebootRequired: true },
    WebSocketPingInterval: { value: '30', readonly: false, rebootRequired: true },
    LocalAuthListEnabled: { value: 'true', readonly: false },
    // Devolvida de propósito: o CMS precisa mascarar.
    AuthorizationKey: { value: 'sim-secret-key', readonly: false },
    NumberOfConnectors: { value: '2', readonly: true },
    SupportedFeatureProfiles: {
      value: 'Core,FirmwareManagement,LocalAuthListManagement,RemoteTrigger,SmartCharging',
      readonly: true,
    },
  };

  constructor(
    private readonly client: OCPPClient,
    private readonly simulator: ChargerSimulator,
    private readonly reboot: () => Promise<void>,
  ) {
    this.register('ChangeAvailability', (p) => this.changeAvailability(p));
    this.register('TriggerMessage', (p) => this.triggerMessage(p));
    this.register('GetConfiguration', (p) => this.getConfiguration(p));
    this.register('ChangeConfiguration', (p) => this.changeConfiguration(p));
    this.register('GetDiagnostics', (p) => this.getDiagnostics(p));
    this.register('UnlockConnector', (p) => this.unlockConnector(p));
    this.register('ClearCache', async () => ({ status: 'Accepted' }));
    this.register('Reset', (p) => this.reset(p));
    this.register('DataTransfer', (p) => this.dataTransfer(p));
    this.register('GetLocalListVersion', async () => ({ listVersion: this.localListVersion }));
    this.register('SendLocalList', (p) => this.sendLocalList(p));
    this.register('ClearChargingProfile', async () => ({ status: 'Unknown' }));
  }

  setBehavior(action: string, behavior: ForcedBehavior | 'default'): void {
    if (behavior === 'default') this.behaviors.delete(action);
    else this.behaviors.set(action, behavior);
  }

  getBehaviors(): Record<string, ForcedBehavior> {
    return Object.fromEntries(this.behaviors);
  }

  /** DataTransfer de entrada (o CMS responde UnknownVendorId por padrão). */
  sendDataTransfer(vendorId: string, messageId?: string, data?: string): Promise<Payload> {
    return this.client.send('DataTransfer', {
      vendorId,
      ...(messageId && { messageId }),
      ...(data && { data }),
    });
  }

  getState() {
    return {
      behaviors: this.getBehaviors(),
      localListVersion: this.localListVersion,
      localListSize: this.localList.size,
      diagnosticsStatus: this.diagnosticsStatus,
      config: Object.fromEntries(
        Object.entries(this.config).map(([k, v]) => [k, k === 'AuthorizationKey' ? '***' : v.value]),
      ),
    };
  }

  private register(action: string, handler: (payload: Payload) => Promise<Payload>): void {
    this.client.onRequest(action, async (payload) => {
      const forced = this.behaviors.get(action);
      if (forced === 'timeout') return new Promise<Payload>(() => undefined); // nunca responde
      if (forced === 'NotImplemented') throw new CallError('NotImplemented', `${action} not implemented (forced)`);
      if (forced === 'Rejected' || forced === 'NotSupported') {
        // DataTransfer não tem NotSupported; GetConfiguration/GetLocalListVersion/GetDiagnostics não têm status.
        return { status: forced === 'NotSupported' && action === 'DataTransfer' ? 'UnknownVendorId' : forced };
      }
      return handler(payload ?? {});
    });
  }

  private later(fn: () => Promise<unknown>, ms = 300): void {
    setTimeout(() => fn().catch((e) => console.error('E08 follow-up failed:', (e as Error).message)), ms);
  }

  private targets(connectorId: number): number[] {
    return connectorId === 0 ? this.simulator.connectorIds() : [connectorId];
  }

  private async changeAvailability(p: Payload): Promise<Payload> {
    const connectorId = Number(p.connectorId ?? 0);
    const operative = p.type === 'Operative';
    const ids = this.targets(connectorId);
    if (ids.some((id) => this.simulator.connectorStatus(id) === null)) return { status: 'Rejected' };
    if (!operative && ids.some((id) => this.simulator.isCharging(id))) return { status: 'Scheduled' };
    this.later(async () => {
      for (const id of ids) await this.simulator.setAvailability(id, operative);
    });
    return { status: 'Accepted' };
  }

  private async triggerMessage(p: Payload): Promise<Payload> {
    const requested = String(p.requestedMessage);
    const connectorId = p.connectorId === undefined ? undefined : Number(p.connectorId);
    if (connectorId !== undefined && connectorId > 0 && this.simulator.connectorStatus(connectorId) === null) {
      return { status: 'Rejected' };
    }
    const send: Record<string, () => Promise<unknown>> = {
      BootNotification: () => this.simulator.boot(),
      Heartbeat: () => this.simulator.sendHeartbeatNow(),
      StatusNotification: async () => {
        for (const id of connectorId ? [connectorId] : this.simulator.connectorIds()) {
          await this.simulator.sendStatusNotification(id, this.simulator.connectorStatus(id) ?? 'Available');
        }
      },
      MeterValues: () => this.simulator.sendMeterValuesNow(connectorId || 1),
      FirmwareStatusNotification: () => this.client.send('FirmwareStatusNotification', { status: 'Idle' }),
      DiagnosticsStatusNotification: () =>
        this.client.send('DiagnosticsStatusNotification', { status: this.diagnosticsStatus }),
    };
    const action = send[requested];
    if (!action) return { status: 'NotImplemented' };
    this.later(action);
    return { status: 'Accepted' };
  }

  private async getConfiguration(p: Payload): Promise<Payload> {
    const requested = Array.isArray(p.key) ? (p.key as string[]) : [];
    const keys = requested.length ? requested : Object.keys(this.config);
    return {
      configurationKey: keys
        .filter((k) => this.config[k])
        .map((k) => ({ key: k, readonly: this.config[k].readonly, value: this.config[k].value })),
      unknownKey: keys.filter((k) => !this.config[k]),
    };
  }

  private async changeConfiguration(p: Payload): Promise<Payload> {
    const entry = this.config[String(p.key)];
    if (!entry) return { status: 'NotSupported' };
    if (entry.readonly) return { status: 'Rejected' };
    entry.value = String(p.value ?? '');
    return { status: entry.rebootRequired ? 'RebootRequired' : 'Accepted' };
  }

  /**
   * Responde com o nome do arquivo e envia por HTTP POST multipart para
   * `<location><arquivo>`, avisando Uploading → Uploaded/UploadFailed.
   */
  private async getDiagnostics(p: Payload): Promise<Payload> {
    const location = String(p.location ?? '');
    if (!/^https?:\/\//.test(location)) return {}; // FTP etc.: sem arquivo
    const fileName = `diag-${Date.now()}.log`;
    this.later(async () => {
      this.diagnosticsStatus = 'Uploading';
      await this.client.send('DiagnosticsStatusNotification', { status: 'Uploading' });
      const body = new FormData();
      const content = [
        `Simulador E08 — diagnóstico ${new Date().toISOString()}`,
        `startTime=${p.startTime ?? '-'} stopTime=${p.stopTime ?? '-'}`,
        JSON.stringify(this.simulator.getStatus()),
      ].join('\n');
      body.append('file', new Blob([content], { type: 'text/plain' }), fileName);
      let ok = false;
      try {
        const url = location.endsWith('/') ? `${location}${fileName}` : `${location}/${fileName}`;
        const res = await fetch(url, { method: 'POST', body });
        ok = res.ok;
        console.log(`Diagnostics upload → HTTP ${res.status}`);
      } catch (e) {
        console.error('Diagnostics upload failed:', (e as Error).message);
      }
      this.diagnosticsStatus = ok ? 'Uploaded' : 'UploadFailed';
      await this.client.send('DiagnosticsStatusNotification', { status: this.diagnosticsStatus });
    }, 500);
    return { fileName };
  }

  private async unlockConnector(p: Payload): Promise<Payload> {
    const connectorId = Number(p.connectorId);
    if (this.simulator.connectorStatus(connectorId) === null) return { status: 'NotSupported' };
    if (this.simulator.isCharging(connectorId)) {
      this.later(() => this.simulator.stopCharging(connectorId, 'UnlockCommand'));
    }
    return { status: 'Unlocked' };
  }

  private async reset(p: Payload): Promise<Payload> {
    const reason = p.type === 'Hard' ? 'HardReset' : 'SoftReset';
    this.later(async () => {
      for (const id of this.simulator.connectorIds()) {
        if (this.simulator.isCharging(id)) await this.simulator.stopCharging(id, reason);
      }
      await this.reboot();
    }, 500);
    return { status: 'Accepted' };
  }

  private async dataTransfer(p: Payload): Promise<Payload> {
    if (p.vendorId !== VENDOR_ID) return { status: 'UnknownVendorId' };
    if (p.messageId && p.messageId !== 'Echo') return { status: 'UnknownMessageId' };
    return { status: 'Accepted', data: typeof p.data === 'string' ? p.data : '' };
  }

  private async sendLocalList(p: Payload): Promise<Payload> {
    const version = Number(p.listVersion);
    const entries = Array.isArray(p.localAuthorizationList)
      ? (p.localAuthorizationList as { idTag: string; idTagInfo?: { status?: string } }[])
      : [];
    if (p.updateType === 'Differential' && version <= this.localListVersion) return { status: 'VersionMismatch' };
    if (p.updateType === 'Full') this.localList.clear();
    for (const e of entries) {
      if (e.idTagInfo) this.localList.set(e.idTag, e.idTagInfo.status ?? 'Accepted');
      else this.localList.delete(e.idTag); // diferencial sem idTagInfo = remover
    }
    this.localListVersion = version;
    return { status: 'Accepted' };
  }
}

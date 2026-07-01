import WebSocket from 'ws';

export type OCPPMessage = [number, string, string, Record<string, unknown>] | [number, string, Record<string, unknown>];

export class OCPPClient {
  private ws: WebSocket | null = null;
  private requests = new Map<string, {
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();

  private closeListeners: (() => void)[] = [];

  constructor(private url: string, private chargerId: string) {}

  public addCloseListener(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const endpoint = `${this.url}/${this.chargerId}`;
      this.ws = new WebSocket(endpoint, 'ocpp1.6');

      this.ws.on('open', () => {
        console.log(`\x1b[33mConnected to Central System: ${endpoint}\x1b[0m`);
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err) => {
        console.error('\x1b[31mWebSocket connection error:\x1b[0m', err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`\x1b[33mConnection closed. Code: ${code}, Reason: ${reason.toString()}\x1b[0m`);
        this.closeListeners.forEach(cb => cb());
      });
    });
  }

  public send(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket is not connected'));
      }
      const messageId = Math.random().toString(36).substring(2, 15);
      const message = JSON.stringify([2, messageId, action, payload]);
      
      console.log(`\x1b[32mSending:\x1b[0m ${message}`);
      this.requests.set(messageId, { resolve, reject });
      this.ws.send(message);
    });
  }

  private handlers = new Map<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>>();

  public onRequest(action: string, handler: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>): void {
    this.handlers.set(action, handler);
  }

  private async handleMessage(messageStr: string): Promise<void> {
    console.log(`\x1b[36mReceived:\x1b[0m ${messageStr}`);
    try {
      const parsed = JSON.parse(messageStr);
      if (!Array.isArray(parsed)) return;

      const [msgType, messageId] = parsed;

      if (msgType === 2) {
        // CALL (incoming request)
        const [, , action, payload] = parsed;
        const handler = this.handlers.get(action);
        if (handler) {
          try {
            const responsePayload = await handler(payload as Record<string, unknown>);
            const message = JSON.stringify([3, messageId, responsePayload]);
            console.log(`\x1b[32mSending Response:\x1b[0m ${message}`);
            this.ws?.send(message);
          } catch (err) {
            const message = JSON.stringify([4, messageId, "InternalError", "Handler crashed", {}]);
            this.ws?.send(message);
          }
        } else {
          const message = JSON.stringify([4, messageId, "NotImplemented", `No handler for ${action}`, {}]);
          this.ws?.send(message);
        }
      } else if (msgType === 3) {
        // CALLRESULT
        const [, , payload] = parsed;
        const pending = this.requests.get(messageId);
        if (pending) {
          pending.resolve(payload as Record<string, unknown>);
          this.requests.delete(messageId);
        }
      } else if (msgType === 4) {
        // CALLERROR
        const [, , errorCode, errorDescription] = parsed;
        const pending = this.requests.get(messageId);
        if (pending) {
          pending.reject(new Error(`${errorCode}: ${errorDescription}`));
          this.requests.delete(messageId);
        }
      }
    } catch (err) {
      console.error('Failed to parse incoming message:', err);
    }
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
    }
  }
}

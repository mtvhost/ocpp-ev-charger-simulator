import WebSocket from 'ws';

export type OCPPMessage = [number, string, string, Record<string, unknown>] | [number, string, Record<string, unknown>];

export class OCPPClient {
  private ws: WebSocket | null = null;
  private requests = new Map<string, {
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();

  private closeListeners: (() => void)[] = [];

  /** Senha OCPP (Security Profile 1). Vazia = conecta sem Authorization. */
  private password: string;
  /** false = conecta sem oferecer subprotocolo (teste do gateway). */
  public offerSubprotocol = true;

  /** Estado da conexão, exposto em /status para os cenários. */
  public connection = {
    connected: false,
    /** Status HTTP quando o gateway recusou o upgrade (401, 400, 429, 503); 101 = conectou. */
    lastHandshakeStatus: null as number | null,
    lastCloseCode: null as number | null,
    lastCloseReason: null as string | null,
    lastError: null as string | null,
    protocol: null as string | null,
    url: '',
  };

  constructor(private url: string, private chargerId: string, password = '') {
    this.password = password;
    this.connection.url = url;
  }

  public setPassword(password: string): void {
    this.password = password;
  }

  public setUrl(url: string): void {
    this.url = url;
    this.connection.url = url;
  }

  public isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public addCloseListener(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const endpoint = `${this.url}/${this.chargerId}`;
      const headers: Record<string, string> = {};
      if (this.password) {
        // Security Profile 1: HTTP Basic com usuário = identity do carregador.
        headers.Authorization = `Basic ${Buffer.from(`${this.chargerId}:${this.password}`).toString('base64')}`;
      }
      const ws = new WebSocket(endpoint, this.offerSubprotocol ? 'ocpp1.6' : undefined, { headers });
      this.ws = ws;
      let opened = false;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.connection.lastError = err.message;
        reject(err);
      };

      ws.on('open', () => {
        opened = true;
        settled = true;
        Object.assign(this.connection, {
          connected: true,
          lastHandshakeStatus: 101,
          lastError: null,
          protocol: ws.protocol || null,
        });
        console.log(`\x1b[33mConnected to Central System: ${endpoint} (auth=${this.password ? 'basic' : 'none'})\x1b[0m`);
        resolve();
      });

      // Gateway recusou antes do handshake (ex.: 401 sem senha).
      ws.on('unexpected-response', (_req, res) => {
        this.connection.lastHandshakeStatus = res.statusCode ?? null;
        console.error(`\x1b[31mHandshake rejected: HTTP ${res.statusCode}\x1b[0m`);
        res.resume();
        ws.terminate();
        fail(new Error(`Unexpected server response: ${res.statusCode}`));
      });

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      ws.on('error', (err) => {
        console.error('\x1b[31mWebSocket connection error:\x1b[0m', err.message);
        fail(err);
      });

      ws.on('close', (code, reason) => {
        if (this.ws !== ws) return; // socket antigo, já trocado por um connect() novo
        this.connection.connected = false;
        this.connection.lastCloseCode = code;
        this.connection.lastCloseReason = reason.toString();
        // Requisições pendentes não ficam penduradas para sempre.
        for (const [, pending] of this.requests) pending.reject(new Error('WebSocket closed'));
        this.requests.clear();
        // Handshake que falhou já rejeitou o connect(); só conexão que abriu avisa os listeners
        // (antes os dois caminhos agendavam retentativa e elas se multiplicavam).
        if (!opened) return;
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
      // Sem resposta em 30 s a chamada falha em vez de travar o simulador.
      const timer = setTimeout(() => {
        if (this.requests.delete(messageId)) reject(new Error(`${action}: timeout`));
      }, 30_000);
      this.requests.set(messageId, {
        resolve: (p) => { clearTimeout(timer); resolve(p); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
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

  /** Fecha o socket e espera o close (usado por /ws/disconnect e /reboot). */
  public disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { ws.terminate(); resolve(); }, 3000);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      ws.close();
    });
  }
}

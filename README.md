# OCPP 1.6J EV Charger Simulator

Simulador simples de carregador veicular elétrico em Node.js utilizando TypeScript e protocolo OCPP 1.6J sobre WebSocket. Controlado via requisições HTTP API.

## Instalação

1. Instale dependências:
   ```bash
   npm install
   ```

2. Compile o projeto:
   ```bash
   npm run build
   ```

3. Inicie o simulador:
   ```bash
   npm start
   ```

## Configuração (`.env`)

Crie arquivo `.env` na raiz do projeto seguindo o modelo:

```env
CENTRAL_SYSTEM_URL=ws://localhost:3000/ocpp
CHARGER_ID=CARREGADOR-001
PORT=8080
```

- `CENTRAL_SYSTEM_URL`: URL de conexão do sistema central (CMS).
- `CHARGER_ID`: ID único de identificação da estação.
- `PORT`: Porta do servidor HTTP local para receber comandos.

## Endpoints HTTP

Comandos aceitos pelo servidor HTTP local (padrão: `http://localhost:8080`):

- **`GET /status`**
  - Retorna o estado atual interno do carregador (conector, transação ativa e energia acumulada).

- **`GET /connect`**
  - Simula inserção do cabo no veículo. Atualiza status do conector para `Preparing`. Aguarda comando `RemoteStartTransaction` do CMS.

- **`GET /disconnect`**
  - Simula desconexão física do cabo. Retorna o status do conector para `Available`.

- **`GET /start`**
  - Inicia recarga manualmente.
  - Parâmetros opcionais (query):
    - `limit`: Limite de kWh. Se fornecido, a recarga dura exatamente 3 minutos com taxa de 0.5 kWh por pulso.
    - `idTag`: Identificação do usuário.
  - Exemplo: `http://localhost:8080/start?limit=10&idTag=WEB_USER`

- **`GET /stop`**
  - Interrompe a recarga em andamento. Status muda para `Finishing`.

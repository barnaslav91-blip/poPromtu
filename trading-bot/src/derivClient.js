const WebSocket = require('ws');
const { EventEmitter } = require('events');

const WS_URL = 'wss://ws.derivws.com/websockets/v3';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class DerivClient extends EventEmitter {
  constructor({ appId, token }) {
    super();
    this.appId = appId;
    this.token = token;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
    this.reconnectAttempt = 0;
    this.closedByUser = false;
    this.authorized = false;
  }

  connect() {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_URL}?app_id=${this.appId}`);

      this.ws.once('open', async () => {
        this.reconnectAttempt = 0;
        try {
          if (this.token) {
            await this.authorize(this.token);
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on('message', (raw) => this._handleMessage(raw));

      this.ws.once('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', () => {
        this.authorized = false;
        this.emit('disconnected');
        if (!this.closedByUser) this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    setTimeout(() => {
      this.connect().catch((err) => this.emit('error', err));
    }, delay);
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.error) {
      const pending = msg.req_id && this.pending.get(msg.req_id);
      if (pending) {
        this.pending.delete(msg.req_id);
        pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        return;
      }
      this.emit('api-error', msg.error);
      return;
    }

    if (msg.req_id && this.pending.has(msg.req_id)) {
      this.pending.get(msg.req_id).resolve(msg);
      this.pending.delete(msg.req_id);
    }

    if (msg.msg_type === 'tick') this.emit('tick', msg.tick);
    if (msg.msg_type === 'proposal_open_contract') {
      this.emit('contract-update', msg.proposal_open_contract);
    }
  }

  _send(payload) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket не подключен'));
    }
    const reqId = ++this.reqId;
    const message = { ...payload, req_id: reqId };

    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  async authorize(token) {
    const res = await this._send({ authorize: token });
    this.authorized = true;
    return res.authorize;
  }

  async getActiveSymbols() {
    const res = await this._send({ active_symbols: 'brief', product_type: 'basic' });
    return res.active_symbols;
  }

  async getTicksHistory(symbol, { count = 5000, end = 'latest' } = {}) {
    const res = await this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end,
      style: 'ticks',
    });
    return res.history;
  }

  async subscribeTicks(symbol) {
    return this._send({ ticks: symbol, subscribe: 1 });
  }

  async buyMultiplier({ symbol, direction, stake, multiplier, stopLossUsd, currency = 'USD' }) {
    const contractType = direction === 'up' ? 'MULTUP' : 'MULTDOWN';
    const res = await this._send({
      buy: 1,
      price: stake,
      parameters: {
        amount: stake,
        basis: 'stake',
        contract_type: contractType,
        symbol,
        multiplier,
        currency,
        limit_order: stopLossUsd ? { stop_loss: stopLossUsd } : undefined,
      },
    });
    return res.buy;
  }

  async sellContract(contractId) {
    const res = await this._send({ sell: contractId, price: 0 });
    return res.sell;
  }

  async subscribeContract(contractId) {
    return this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }

  async getBalance() {
    const res = await this._send({ balance: 1 });
    return res.balance;
  }
}

module.exports = { DerivClient };

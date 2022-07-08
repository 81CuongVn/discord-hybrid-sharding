const Util = require('../Util/Util.js');
class PromiseHandler {
    constructor() {
        this.nonce = new Map();
    }
    resolve(message) {
        const promise = this.nonce.get(message.nonce);
        if (promise) {
            if (promise.timeout) clearTimeout(promise.timeout);
            this.nonce.delete(message.nonce);
            if (message._error) {
                const error = new Error(message._error.message);
                error.stack = message.stack || message._error.stack;
                error.name = message._error.name;
                promise.reject(error);
            } else {
                promise.resolve(message._result);
            }
        }
    }
    insertResult({ nonce, _result, _error }) {
        const promise = this.nonce.get(nonce);
        if (promise) {
            if (!promise.results) promise.results = [];
            if (_error) this.resolve({ nonce, _error });
            promise.results.push(_result);
            if (promise.options.limit === promise.results.length) {
                this.resolve({ nonce: nonce, _result: promise.results });
            }
            this.nonce.set(nonce, promise);
        }
    }

    async create(message, options = {}) {
        if (Object.keys(options).length === 0 && message.options) options = message.options;
        if (!message.nonce) message.nonce = Util.generateNonce();
        const promise = await new Promise((resolve, reject) => {
            let timeout = undefined;
            if (options.timeout) {
                timeout = setTimeout(() => {
                    this.nonce.delete(message.nonce);
                    const error = new Error('Promise timed out');
                    error.stack = message.stack || error.stack;
                    reject(error);
                }, options.timeout);
            }
            this.nonce.set(message.nonce, { resolve, reject, options });
        });
        return promise;
    }
}
module.exports = PromiseHandler;

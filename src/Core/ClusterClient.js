const { IPCMessage, BaseMessage } = require('../Structures/IPCMessage.js');
const Util = require('../Util/Util.js');
const { Events } = require('../Util/Constants.js');

const { WorkerClient } = require('../Structures/Worker.js');
const { ChildClient } = require('../Structures/Child.js');

const EventEmitter = require('events');
///communicates between the master workers and the process
class ClusterClient extends EventEmitter {
    /**
     * @param {Client} client Client of the current cluster
     */
    constructor(client) {
        super();
        /**
         * Client for the Cluster
         * @type {Client}
         */
        this.client = client;

        /**
         * Mode the Cluster was spawned with
         * @type {ClusterManagerMode}
         */
        this.mode = this.info.CLUSTER_MANAGER_MODE;
        let mode = this.mode;

        /**
         * If the Cluster is spawned automatically or with a own controller
         * @type {ClusterQueueMode}
         */
        this.queue = {
            mode: this.info.CLUSTER_QUEUE_MODE,
        };

        /**
         * Ongoing promises for calls to {@link ClusterManager#evalOnCluster}, mapped by the `script` they were called with
         * @type {Map<string, Promise>}
         * @private
         */
        this._nonce = new Map();

        /**
         * The Interval of the Heartbeat Messages and the Heartbeat CheckUp to respawn unresponsive Clusters.
         * @type {number}
         */
        this.keepAliveInterval = isNaN(Number(this.info.KEEP_ALIVE_INTERVAL)) ? 0 : this.info.KEEP_ALIVE_INTERVAL;

        this.ready = false;

        /**
         * The Heartbeat Object, which contains the missed Heartbeats, the last Heartbeat and the Heartbeat Interval
         * @type {object}
         */
        this.heartbeat = {};

        this.process = null;

        if (mode === 'process') this.process = new ChildClient(this);
        else if (mode === 'worker') this.process = new WorkerClient(this);

        this.process.ipc.on('message', this._handleMessage.bind(this));
        client.on?.('ready', () => {
            this.triggerReady();
        });
        client.on?.('disconnect', () => {
            this.process.send({ _disconnect: true });
        });
        client.on?.('reconnecting', () => {
            this.process.send({ _reconnecting: true });
        });
    }
    /**
     * cluster's id
     * @type {number}
     * @readonly
     */
    get id() {
        return this.info.CLUSTER;
    }
    /**
     * Array of shard IDs of this client
     * @type {number[]}
     * @readonly
     */
    get ids() {
        if (!this.client.ws) return this.info.SHARD_LIST;
        return this.client.ws.shards;
    }
    /**
     * Total number of clusters
     * @type {number}
     * @readonly
     */
    get count() {
        return this.info.CLUSTER_COUNT;
    }
    /**
     * Gets several Info like Cluster_Count, Number, Total shards...
     * @type {object}
     * @readonly
     */
    get info() {
        return ClusterClient.getInfo();
    }
    /**
     * Sends a message to the master process.
     * @param {*} message Message to send
     * @returns {Promise<void>}
     * @fires Cluster#message
     */
    send(message) {
        if (typeof message === 'object') message = new BaseMessage(message).toJSON();
        return this.process.send(message);
    }
    /**
     * Fetches a client property value of each cluster, or a given cluster.
     * @param {string} prop Name of the client property to get, using periods for nesting
     * @param {number} [cluster] Cluster to fetch property from, all if undefined
     * @returns {Promise<*>|Promise<Array<*>>}
     * @example
     * client.cluster.fetchClientValues('guilds.cache.size')
     *   .then(results => console.log(`${results.reduce((prev, val) => prev + val, 0)} total guilds`))
     *   .catch(console.error);
     * @see {@link ClusterManager#fetchClientValues}
     */
    fetchClientValues(prop, cluster) {
        return new Promise((resolve, reject) => {
            const parent = this.process.ipc;

            const listener = message => {
                if (!message || message._sFetchProp !== prop || message._sFetchPropShard !== cluster) return;
                parent.removeListener('message', listener);
                if (!message._error) resolve(message._result);
                else reject(Util.makeError(message._error));
            };
            parent.on('message', listener);

            this.send({ _sFetchProp: prop, _sFetchPropShard: cluster }).catch(err => {
                parent.removeListener('message', listener);
                reject(err);
            });
        });
    }

    /**
     * Evaluates a script or function on all clusters, or a given cluster, in the context of the {@link Client}s.
     * @param {string|Function} script JavaScript to run on each cluster
     * @param {BroadcastEvalOptions} [options={}] The options for the broadcast
     * @returns {Promise<*>|Promise<Array<*>>} Results of the script execution
     * @example
     * client.cluster.broadcastEval('this.guilds.cache.size')
     *   .then(results => console.log(`${results.reduce((prev, val) => prev + val, 0)} total guilds`))
     *   .catch(console.error);
     * @see {@link ClusterManager#broadcastEval}
     */
    broadcastEval(script, options = {}) {
        return new Promise((resolve, reject) => {
            if (!script || (typeof script !== 'string' && typeof script !== 'function'))
                reject(
                    new TypeError(
                        'Script for BroadcastEvaling has not been provided or must be a valid String/Function!',
                    ),
                );
            script = typeof script === 'function' ? `(${script})(this, ${JSON.stringify(options.context)})` : script;

            const parent = this.process.ipc;
            let evalTimeout;

            const listener = message => {
                if (message._sEval !== script || message._sEvalShard !== options.cluster) return;
                parent.removeListener('message', listener);
                if (evalTimeout) clearTimeout(evalTimeout);
                if (!message._error) resolve(message._result);
                else reject(Util.makeError(message._error));
            };
            parent.on('message', listener);
            this.send({ _sEval: script, _sEvalShard: options.cluster, _sEvalTimeout: options.timeout })
                .then(m => {
                    if (options.timeout) {
                        evalTimeout = setTimeout(() => {
                            parent.removeListener('message', listener);
                            reject(new Error(`BROADCAST_EVAL_REQUEST_TIMED_OUT`));
                        }, options.timeout + 100); //Add 100 ms more to prevent timeout on client side
                    }
                })
                .catch(err => {
                    if (evalTimeout) clearTimeout(evalTimeout);
                    parent.removeListener('message', listener);
                    reject(err);
                });
        });
    }

    /**
     * Evaluates a script or function on the Cluster Manager
     * @param {string|Function} script JavaScript to run on the Manager
     * @param {object} options Some options such as the Eval timeout or the Context
     * @param {number} [options.timeout=10000] The time in ms to wait, until the eval will be rejected without any response
     * @param {any} [options.context] The context to pass to the script, when providing functions
     * @returns {Promise<*>|Promise<Array<*>>} Result of the script execution
     * @example
     * client.cluster.evalOnManager('process.uptime')
     *   .then(result => console.log(result))
     *   .catch(console.error);
     * @see {@link ClusterManager#evalOnManager}
     */
    evalOnManager(script, options = {}) {
        return new Promise((resolve, reject) => {
            const parent = this.process.ipc;
            if (!script || (typeof script !== 'string' && typeof script !== 'function'))
                reject(
                    new TypeError(
                        'Script for BroadcastEvaling has not been provided or must be a valid String/Function!',
                    ),
                );
            script = typeof script === 'function' ? `(${script})(this, ${JSON.stringify(options.context)})` : script;

            const nonce = Date.now().toString(36) + Math.random().toString(36);
            this._nonce.set(nonce, { resolve, reject });
            if (!options.timeout) options.timeout = 10000;
            setTimeout(() => {
                if (this._nonce.has(nonce)) {
                    this._nonce.get(nonce).reject(new Error('EVAL Request Timed out'));
                    this._nonce.delete(nonce);
                }
            }, options.timeout);
            this.send({ _sManagerEval: script, nonce, ...options });
        });
    }

    /**
     * Evaluates a script or function on the ClusterClient
     * @param {string|Function} script JavaScript to run on the ClusterClient
     * @param {object} options Some options such as the TargetCluster or the Eval timeout
     * @param {number} [options.cluster] The Id od the target Cluster
     * @param {number} [options.shard] The Id od the target Shard, when the Cluster has not been provided.
     * @param {number} [options.timeout=10000] The time in ms to wait, until the eval will be rejected without any response
     * @param {any} [options.context] The context to pass to the script, when providing functions
     * @returns {Promise<*>|Promise<Array<*>>} Result of the script execution
     * @example
     * client.cluster.evalOnCluster('this.cluster.id',  {timeout: 10000, cluster: 0})
     *   .then(result => console.log(result))
     *   .catch(console.error);
     * @see {@link ClusterManager#evalOnCluster}
     */
    evalOnCluster(script, options = {}) {
        return new Promise((resolve, reject) => {
            if (
                !options.hasOwnProperty('cluster') &&
                !options.hasOwnProperty('shard') &&
                !options.hasOwnProperty('guildId')
            )
                reject('TARGET CLUSTER HAS NOT BEEN PROVIDED');
            if (!script || (typeof script !== 'string' && typeof script !== 'function'))
                reject(
                    new TypeError(
                        'Script for BroadcastEvaling has not been provided or must be a valid String/Function!',
                    ),
                );
            script = typeof script === 'function' ? `(${script})(this, ${JSON.stringify(options.context)})` : script;
            const nonce = Date.now().toString(36) + Math.random().toString(36);
            this._nonce.set(nonce, { resolve, reject });
            const trace = new Error().stack
            if (!options.timeout) options.timeout = 10000;
            setTimeout(() => {
                if (this._nonce.has(nonce)) {
                    this._nonce.get(nonce).reject(new Error("EVAL Request Timed out\n" + trace));
                    this._nonce.delete(nonce);
                }
            }, options.timeout);
            this.send({ _sClusterEval: script, nonce, ...options });
        });
    }

    /**
     * Sends a Request to the ParentCluster and returns the reply
     * @param {BaseMessage} message Message, which should be sent as request
     * @returns {Promise<*>} Reply of the Message
     * @example
     * client.cluster.request({content: 'hello'})
     *   .then(result => console.log(result)) //hi
     *   .catch(console.error);
     * @see {@link IPCMessage#reply}
     */
    request(message = {}) {
        message._sRequest = true;
        message._sReply = false;
        message = new BaseMessage(message).toJSON();
        return new Promise((resolve, reject) => {
            this._nonce.set(message.nonce, { resolve, reject });
            setTimeout(() => {
                if (this._nonce.has(message.nonce)) {
                    this._nonce.get(message.nonce).reject(new Error('EVAL Request Timed out'));
                    this._nonce.delete(message.nonce);
                }
            }, message.timeout || 10000);
            this.send(message);
        }).catch(e => ({ ...message, error: e }));
    }

    /**
     * Requests a respawn of all clusters.
     * @param {ClusterRespawnOptions} [options] Options for respawning shards
     * @returns {Promise<void>} Resolves upon the message being sent
     * @see {@link ClusterManager#respawnAll}
     */
    respawnAll({ clusterDelay = 5000, respawnDelay = 7000, timeout = 30000 } = {}) {
        return this.send({ _sRespawnAll: { clusterDelay, respawnDelay, timeout } });
    }

    /**
     * Handles an IPC message.
     * @param {*} message Message received
     * @private
     */
    async _handleMessage(message) {
        if (!message) return;
        if (message._fetchProp) {
            const props = message._fetchProp.split('.');
            let value = this.client;
            for (const prop of props) value = value[prop];
            this._respond('fetchProp', { _fetchProp: message._fetchProp, _result: value });
            return;
        } else if (message._eval) {
            try {
                this._respond('eval', { _eval: message._eval, _result: await this._eval(message._eval) });
            } catch (err) {
                this._respond('eval', { _eval: message._eval, _error: Util.makePlainError(err) });
            }
            return;
        } else if (message.hasOwnProperty('_sClusterEvalRequest')) {
            try {
                this._respond('evalOnCluster', {
                    _sClusterEvalResponse: await this._eval(message._sClusterEvalRequest),
                    nonce: message.nonce,
                    cluster: message.cluster,
                });
            } catch (err) {
                this._respond('evalOnCluster', {
                    _sClusterEvalResponse: {},
                    _error: Util.makePlainError(err),
                    nonce: message.nonce,
                });
            }
            return;
        } else if (message.hasOwnProperty('_sClusterEvalResponse')) {
            const promise = this._nonce.get(message.nonce);
            if (!promise) return;
            if (message._error) {
                promise.reject(message._error);
                this._nonce.delete(message.nonce);
            } else {
                promise.resolve(message._sClusterEvalResponse);
                this._nonce.delete(message.nonce);
            }
            return;
        } else if (message.hasOwnProperty('_sManagerEvalResponse')) {
            const promise = this._nonce.get(message.nonce);
            if (!promise) return;
            if (message._error) {
                promise.reject(message._error);
                this._nonce.delete(message.nonce);
            } else {
                promise.resolve(message._sManagerEvalResponse);
                this._nonce.delete(message.nonce);
            }
            return;
        } else if (message.ack) {
            return this._heartbeatAckMessage();
        } else if (message._sCustom) {
            if (message._sReply) {
                const promise = this._nonce.get(message.nonce);
                if (promise) {
                    promise.resolve(message);
                    this._nonce.delete(message.nonce);
                }
                return;
            } else if (message._sRequest) {
                //this.request(message).then(e => this.send(e)).catch(e => this.send({...message, error: e}))
            }

            let emitMessage;
            if (typeof message === 'object') emitMessage = new IPCMessage(this, message);
            else emitMessage = message;
            /**
             * Emitted upon receiving a message from the parent process/worker.
             * @event ClusterClient#message
             * @param {*} message Message that was received
             */
            this.emit('message', emitMessage);
        }
    }

    _eval(script) {
        if (this.client._eval) return this.client._eval(script);
        this.client._eval = function (_) {
            return eval(_);
        }.bind(this.client);
        return this.client._eval(script);
    }

    /**
     * Sends a message to the master process, emitting an error from the client upon failure.
     * @param {string} type Type of response to send
     * @param {*} message Message to send, which can be a Object or a String
     * @private
     */
    _respond(type, message) {
        this.send(message).catch(err => {
            let error = { err };

            error.message = `Error when sending ${type} response to master process: ${err.message}`;
            /**
             * Emitted when the client encounters an error.
             * @event Client#error
             * @param {Error} error The error encountered
             */
            this.client.emit?.(Events.ERROR, error);
        });
    }

    /*Heartbeat System*/
    _heartbeatAckMessage() {
        this.heartbeat.last = Date.now();
        this.heartbeat.missed = 0;
    }

    _checkIfAckReceived() {
        this.client.emit('clusterDebug', `[ClusterClient ${this.id}] Heartbeat Ack Interval CheckUp Started`, this.id);
        this.heartbeat.ack = setInterval(() => {
            if (!this.heartbeat) return;
            const diff = Date.now() - Number(this.heartbeat.last);
            if (isNaN(diff)) return;
            if (diff > this.keepAliveInterval + 2000) {
                this.heartbeat.missed = (this.heartbeat.missed || 0) + 1;
                if (this.heartbeat.missed < 5) {
                    this.client.emit(
                        'clusterDebug',
                        `[ClusterClient ${this.id}][Heartbeat_ACK_MISSING] ${this.heartbeat.missed} Heartbeat(s) Ack have been missed.`,
                        this.id,
                    );
                    return;
                } else this._cleanupHeartbeat();
            }
        }, this.keepAliveInterval);
        return this.heartbeat;
    }

    _checkIfClusterAlive() {
        this.heartbeat.interval = setInterval(() => {
            this.send({ _keepAlive: true, heartbeat: { last: Date.now() } });
        }, this.keepAliveInterval);
        return this.heartbeat.interval;
    }

    _cleanupHeartbeat() {
        clearInterval(this.heartbeat.interval);
        clearInterval(this.heartbeat.ack);
        this.heartbeat = {};
        return this.heartbeat;
    }

    //Hooks
    triggerReady() {
        this.process.send({ _ready: true });
        if (this.keepAliveInterval) {
            this._cleanupHeartbeat();
            this._checkIfClusterAlive();
            this._checkIfAckReceived();
        }
        this.ready = true;
        return this.ready;
    }

    spawnNextCluster() {
        if (this.queue.mode === 'auto')
            throw new Error('Next Cluster can just be spawned when the queue is not on auto mode.');
        return this.process.send({ _spawnNextCluster: true });
    }

    /**
     * gets the total Internal shard count and shard list.
     * @returns {ClusterClientUtil}
     */
    static getInfo() {
        let clusterMode = process.env.CLUSTER_MANAGER_MODE;
        if (!clusterMode) return;
        if (clusterMode !== 'worker' && clusterMode !== 'process')
            throw new Error('NO CHILD/MASTER EXISTS OR SUPPLIED CLUSTER_MANAGER_MODE IS INCORRECT');
        let data;
        if (clusterMode === 'process') {
            const shardList = [];
            let parseShardList = process.env.SHARD_LIST.split(',');
            parseShardList.forEach(c => shardList.push(Number(c)));
            data = {
                SHARD_LIST: shardList,
                TOTAL_SHARDS: Number(process.env.TOTAL_SHARDS),
                CLUSTER_COUNT: Number(process.env.CLUSTER_COUNT),
                CLUSTER: Number(process.env.CLUSTER),
                CLUSTER_MANAGER_MODE: clusterMode,
                KEEP_ALIVE_INTERVAL: Number(process.env.KEEP_ALIVE_INTERVAL),
                CLUSTER_QUEUE_MODE: process.env.CLUSTER_QUEUE_MODE,
            };
        } else {
            data = require('worker_threads').workerData;
        }

        data.FIRST_SHARD_ID = data.SHARD_LIST[0];
        data.LAST_SHARD_ID = data.SHARD_LIST[data.SHARD_LIST.length - 1];

        return data;
    }
}
module.exports = ClusterClient;

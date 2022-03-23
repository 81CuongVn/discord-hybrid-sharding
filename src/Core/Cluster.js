const EventEmitter = require('events');
const path = require('path');
const Util = require('../Util/Util.js');
const { IPCMessage, BaseMessage } = require('../Structures/IPCMessage.js');

const { Worker } = require('../Structures/Worker.js');
const { Child } = require('../Structures/Child.js');

let Thread = null;

/**
 * A self-contained cluster created by the {@link ClusterManager}. Each one has a {@link ChildProcess} that contains
 * an instance of the bot and its {@link Client}. When its child process/worker exits for any reason, the cluster will
 * spawn a new one to replace it as necessary.
 * @augments EventEmitter
 */
class Cluster extends EventEmitter {
    /**
     * @param {ClusterManager} manager Manager that is creating this cluster
     * @param {number} id ID of this cluster
     * @param shardList
     * @param totalShards
     */
    constructor(manager, id, shardList, totalShards) {
        super();
        if (manager.mode === 'process') Thread = Child;
        else if (manager.mode === 'worker') Thread = Worker;
        /**
         * Manager that created the cluster
         * @type {ClusterManager}
         */
        this.manager = manager;
        /**
         * ID of the cluster in the manager
         * @type {number}
         */
        this.id = id;

        /**
         * Arguments for the shard's process (only when {@link ShardingManager#mode} is `process`)
         * @type {string[]}
         */
        this.args = manager.shardArgs || [];

        /**
         * Arguments for the shard's process executable (only when {@link ShardingManager#mode} is `process`)
         * @type {string[]}
         */
        this.execArgv = manager.execArgv;
        /**
         * Internal Shards which will get spawned in the cluster
         * @type {number}
         */
        this.shardList = shardList;
        /**
         * the amount of real shards
         * @type {number}
         */
        this.totalShards = totalShards;
        /**
         * Environment variables for the cluster's process, or workerData for the cluster's worker
         * @type {object}
         */
        this.env = Object.assign({}, process.env, {
            SHARD_LIST: this.shardList,
            TOTAL_SHARDS: this.totalShards,
            CLUSTER_MANAGER: true,
            CLUSTER: this.id,
            CLUSTER_COUNT: this.manager.totalClusters,
            KEEP_ALIVE_INTERVAL: this.manager.keepAlive.interval,
            DISCORD_TOKEN: this.manager.token,
        });
        /**
         * Whether the cluster's {@link Client} is ready
         * @type {boolean}
         */

        /**
         * Process of the cluster (if {@link ClusterManager#mode} is `process`)
         * @type {?ChildProcess|?Worker}
         */
        this.thread = null;

        /**
         * The Heartbeat Object, which contains the missed Heartbeats, the last Heartbeat and the Heartbeat Interval
         * @type {object}
         */
        this.heartbeat = {};

        /**
         * The Amount of maximal Restarts, which can be executed by the HeartBeat Checkup
         * @type {object}
         */
        this._restarts = {};
        if (this.manager.keepAlive) {
            if (Object.keys(this.manager.keepAlive)) {
                this._restarts.current = 0;
                this._restarts.interval = setInterval(() => {
                    this._restarts.current = 0;
                }, 60000 * 60);
            }
        }

        /**
         * Ongoing promises for calls to {@link Cluster#eval}, mapped by the `script` they were called with
         * @type {Map<string, Promise>}
         * @private
         */
        this._evals = new Map();

        /**
         * Ongoing promises for calls to {@link Cluster#fetchClientValue}, mapped by the `prop` they were called with
         * @type {Map<string, Promise>}
         * @private
         */
        this._fetches = new Map();

        /**
         * Listener function for the {@link ChildProcess}' `exit` event
         * @type {Function}
         * @private
         */
        this._exitListener = this._handleExit.bind(this, undefined);
    }
    /**
     * Forks a child process or creates a worker thread for the cluster.
     * <warn>You should not need to call this manually.</warn>
     * @param {number} [spawnTimeout=30000] The amount in milliseconds to wait until the {@link Client} has become ready
     * before resolving. (-1 or Infinity for no wait)
     * @returns {Promise<ChildProcess>}
     */
    async spawn(spawnTimeout = 30000) {
        if (this.thread) throw new Error('CLUSTERING_PROCESS_EXISTS', this.id);
        this.thread = new Thread(path.resolve(this.manager.file), {
            ...this.manager.clusterOptions,
            execArgv: this.execArgv,
            env: this.env,
            args: this.args,
            clusterData: {...this.env, ...this.manager.clusterData},
        });

        
        this.thread
        .spawn()
        .on('message', this._handleMessage.bind(this))
        .on('exit', this._exitListener)
        .on('error', this._handleError.bind(this));
      
        this._evals.clear();
        this._fetches.clear();

        /**
         * Emitted upon the creation of the cluster's child process/worker.
         * @event Cluster#spawn
         * @param {ChildProcess|Worker} process Child process/worker that was created
         */
        this.emit('spawn', this.thread.process);

        if (spawnTimeout === -1 || spawnTimeout === Infinity) return this.thread.process;

        await new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(spawnTimeoutTimer);
                this.off('ready', onReady);
                this.off('disconnect', onDisconnect);
                this.off('death', onDeath);
            };

            const onReady = () => {
                this._cleanupHeartbeat();
                cleanup();
                resolve();
            };

            const onDisconnect = () => {
                cleanup();
                reject(new Error('CLUSTERING_READY_DISCONNECTED', this.id));
            };

            const onDeath = () => {
                cleanup();
                reject(new Error('CLUSTERING_READY_DIED', this.id));
            };

            const onTimeout = () => {
                cleanup();
                reject(new Error('CLUSTERING_READY_TIMEOUT', this.id));
            };

            const spawnTimeoutTimer = setTimeout(onTimeout, spawnTimeout);
            this.once('ready', onReady);
            this.once('disconnect', onDisconnect);
            this.once('death', onDeath);
        });
        return this.thread.process;
    }
    /**
     * Immediately kills the clusters's process/worker and does not restart it.
     * @param {object} options Some Options for managing the Kill
     * @param {object} options.force Whether the Cluster should be force kill and be ever respawned...
     */
    kill(options = {}) {
        this.thread.kill(options);
        if (options.force) this._cleanupHeartbeat();
        this._handleExit(false);
    }
    /**
     * Kills and restarts the cluster's process/worker.
     * @param {ClusterRespawnOptions} [options] Options for respawning the cluster
     * @returns {Promise<ChildProcess>}
     */
    async respawn({ delay = 500, timeout = 30000 } = {}) {
        if (this.thread) this.kill({ force: true });
        if (delay > 0) await Util.delayFor(delay);
        return this.spawn(timeout);
    }
    /**
     * Sends a message to the cluster's process/worker.
     * @param {*|BaseMessage} message Message to send to the cluster
     * @returns {Promise<Shard>}
     */
    send(message) {
        if (typeof message === 'object') message = new BaseMessage(message).toJSON();
        return this.thread.send(message);
    }

    /**
     * Sends a Request to the ClusterClient and returns the reply
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
            const nonce = message.nonce;
            this.manager._nonce.set(nonce, { resolve, reject });
            const sent = this.send(message, void 0, void 0, e => {
                if (e) reject(new Error(`Failed to deliver Message to cluster: ${e}`));
                setTimeout(() => {
                    if (this.manager._nonce.has(nonce)) {
                        this.manager._nonce.get(nonce).reject(new Error('Eval Request Timed out'));
                        this.manager._nonce.delete(nonce);
                    }
                }, message.timeout || 10000);
            });
            if (!sent) reject(new Error('CLUSTERING_IN_PROCESS or CLUSTERING_DIED'));
        }).catch(e => ({ ...message, error: new Error(e.toString()) }));
    }

    /**
     * Fetches a client property value of the cluster.
     * @param {string} prop Name of the client property to get, using periods for nesting
     * @returns {Promise<*>}
     * @example
     * cluster.fetchClientValue('guilds.cache.size')
     *   .then(count => console.log(`${count} guilds in cluster ${cluster.id}`))
     *   .catch(console.error);
     */
    fetchClientValue(prop) {
        // Shard is dead (maybe respawning), don't cache anything and error immediately
        if (!this.thread) return Promise.reject(new Error('CLUSTERING_NO_CHILD_EXISTS', this.id));

        // Cached promise from previous call
        if (this._fetches.has(prop)) return this._fetches.get(prop);

        const promise = new Promise((resolve, reject) => {
            const child = this.thread.process;

            const listener = message => {
                if (!message || message._fetchProp !== prop) return;
                child.removeListener('message', listener);
                this._fetches.delete(prop);
                resolve(message._result);
            };
            child.on('message', listener);

            this.send({ _fetchProp: prop }).catch(err => {
                child.removeListener('message', listener);
                this._fetches.delete(prop);
                reject(err);
            });
        });

        this._fetches.set(prop, promise);
        return promise;
    }

    /**
     * Evaluates a script or function on the cluster, in the context of the {@link Client}.
     * @param {string|Function} script JavaScript to run on the cluster
     * @param context
     * @param timeout
     * @returns {Promise<*>} Result of the script execution
     */
    eval(script, context, timeout) {
        // Stringify the script if it's a Function
        const _eval = typeof script === 'function' ? `(${script})(this, ${JSON.stringify(context)})` : script;

        // cluster is dead (maybe respawning), don't cache anything and error immediately
        if (!this.thread) return Promise.reject(new Error('CLUSTERING_NO_CHILD_EXISTS', this.id));

        // Cached promise from previous call
        if (this._evals.has(_eval)) return this._evals.get(_eval);

        const promise = new Promise((resolve, reject) => {
            const child = this.thread.process;

            //Set A timeout for the eval
            let tempTimeout;

            const listener = message => {
                if (!message || message._eval !== _eval) return;
                if (tempTimeout) clearTimeout(tempTimeout);
                child.removeListener('message', listener);
                this._evals.delete(_eval);
                if (!message._error) resolve(message._result);
                else reject(Util.makeError(message._error));
            };
            child.on('message', listener);

            this.send({ _eval })
                .then(m => {
                    if (timeout) {
                        tempTimeout = setTimeout(() => {
                            if (!this._evals.has(_eval)) return;
                            child.removeListener('message', listener);
                            this._evals.delete(_eval);
                            reject(new Error(`BROADCAST_EVAL_REQUEST_TIMED_OUT`));
                        }, timeout);
                    }
                })
                .catch(err => {
                    if (tempTimeout) clearTimeout(tempTimeout);
                    child.removeListener('message', listener);
                    this._evals.delete(_eval);
                    reject(err);
                });
        });

        this._evals.set(_eval, promise);
        return promise;
    }

    /**
     * Handles a message received from the child process/worker.
     * @param {*} message Message received
     * @private
     */
    _handleMessage(message) {
        if (message) {
            // Cluster is ready
            if (message._ready) {
                this.ready = true;
                /**
                 * Emitted upon the cluster's {@link Client#ready} event.
                 * @event Cluster#ready
                 */
                this.emit('ready');
                this.manager._debug('Ready', this.id);
                this._cleanupHeartbeat();
                this._checkIfClusterAlive();
                return;
            }

            // Cluster has disconnected
            if (message._disconnect) {
                this.ready = false;
                /**
                 * Emitted upon the cluster's {@link Client#disconnect} event.
                 * @event Cluster#disconnect
                 */
                this.emit('disconnect');
                this.manager._debug('[DISCONNECT] Some Shards disconnected', this.id);
                return;
            }

            // Cluster is attempting to reconnect
            if (message._reconnecting) {
                this.ready = false;
                /**
                 * Emitted upon the cluster's {@link Client#reconnecting} event.
                 * @event Cluster#reconnecting
                 */
                this.emit('reconnecting');
                this.manager._debug('[RECONNECTING] Some Shards are attempting reconnect', this.id);
                return;
            }

            //The Heartbeat, which has been sent by Client
            if (message._keepAlive) {
                if (this.manager.keepAlive) this._heartbeatMessage(message);
                return;
            }

            // Cluster is requesting a property fetch
            if (message._sFetchProp) {
                const resp = { _sFetchProp: message._sFetchProp, _sFetchPropShard: message._sFetchPropShard };
                this.manager.fetchClientValues(message._sFetchProp, message._sFetchPropShard).then(
                    results => this.send({ ...resp, _result: results }),
                    err => this.send({ ...resp, _error: Util.makePlainError(err) }),
                );
                return;
            }

            // Cluster is requesting an eval broadcast
            if (message._sEval) {
                const resp = { _sEval: message._sEval, _sEvalShard: message._sEvalShard };
                this.manager
                    ._performOnShards('eval', [message._sEval], message._sEvalShard, message._sEvalTimeout)
                    .then(
                        results => this.send({ ...resp, _result: results }),
                        err => this.send({ ...resp, _error: Util.makePlainError(err) }),
                    );
                return;
            }

            //Evals a Request on a Cluster
            if (message.hasOwnProperty('_sManagerEval')) {
                this.manager.evalOnManager(message._sManagerEval).then(result => {
                    if (result._results) return this.send({ _sManagerEvalResponse: result._results, ...message });
                    if (result._error) return this.send({ _error: Util.makePlainError(result._error), ...message });
                });
                return;
            }

            //Evals a Request on a Cluster
            if (message.hasOwnProperty('_sClusterEval')) {
                this.manager
                    .evalOnCluster(message._sClusterEval, { ...message, requestCluster: this.id })
                    .catch(e => new Error(e));
                return;
            }

            //If Message is a Eval Response
            if (message.hasOwnProperty('_sClusterEvalResponse')) {
                const promise = this.manager._nonce.get(message.nonce);
                if (!promise) return;
                if (promise) {
                    if (message._error) {
                        promise.reject(message._error);
                        this.manager._nonce.delete(message.nonce);
                        if (this.manager.clusters.has(promise.requestCluster)) {
                            this.manager.clusters.get(promise.requestCluster).send(message);
                        }
                    } else {
                        promise.resolve(message._sClusterEvalResponse);
                        this.manager._nonce.delete(message.nonce);
                        if (this.manager.clusters.has(promise.requestCluster)) {
                            this.manager.clusters.get(promise.requestCluster).send(message);
                        }
                    }
                }
                return;
            }

            // Cluster is requesting a respawn of all shards
            if (message._sRespawnAll) {
                const { clusterDelay, respawnDelay, timeout } = message._sRespawnAll;
                this.manager._debug('Cluster requested respawn of all Clusters', this.id);
                this.manager.respawnAll({ clusterDelay, respawnDelay, timeout }).catch(() => {
                    // Do nothing
                });
                return;
            }

            if (message._spawnNextCluster) {
                return this.manager.queue.next();
            }

            if (message._sCustom) {
                if (message._sReply) {
                    const promise = this.manager._nonce.get(message.nonce);
                    if (promise) {
                        promise.resolve(message);
                        this.manager._nonce.delete(message.nonce);
                    }
                } else if (message._sRequest) {
                    // this.manager.request(message).then(e => this.send(e)).catch(e => this.send({...message, error: e}))
                }
            }
        }

        let emitMessage;
        if (typeof message === 'object') {
            emitMessage = new IPCMessage(this, message);
            if (emitMessage._sRequest) this.manager.emit('clientRequest', emitMessage);
        } else emitMessage = message;
        /**
         * Emitted upon receiving a message from the child process/worker.
         * @event Shard#message
         * @param {*|IPCMessage} message Message that was received
         */
        this.emit('message', emitMessage);
    }

    /**
     * Handles the cluster's process/worker exiting.
     * @param {boolean} [respawn=this.manager.respawn] Whether to spawn the cluster again
     * @private
     */
    _handleExit(respawn = this.manager.respawn) {
        /**
         * Emitted upon the cluster's child process/worker exiting.
         * @event Cluster#death
         * @param {ChildProcess|Worker} process Child process/worker that exited
         */
        this.emit('death', this.thread.process);
        this.manager._debug('[DEATH] Cluster died, attempting respawn', this.id);

        this.ready = false;
        this.thread = null;
        this._evals.clear();
        this._fetches.clear();

        if (respawn) this.spawn().catch(err => this.emit('error', err));
    }

    ///Custom Functions

    /**
     * Handles the cluster's process/worker error.
     * @param {object} [error] the error, which occurred on the worker/child process
     * @private
     */
    _handleError(error) {
        /**
         * Emitted upon the cluster's child process/worker error.
         * @event Cluster#error
         * @param {ChildProcess|Worker} process Child process/worker, where error occurred
         */
        this.manager.emit('error', error);
    }

    /**
     * Handles the keepAlive Heartbeat and validates it.
     * @param {object} [message] the heartbeat message, which has been received
     * @private
     */
    _heartbeatMessage(message) {
        if (!this.manager.keepAlive) return;
        if (Object.keys(this.manager.keepAlive).length === 0) return;
        this.heartbeat.last = Date.now();
        this.heartbeat.missed = 0;
        this.send({ ack: true, last: Date.now() }).catch(e =>
            this.manager._debug('[ACK_FAILED] ACK could not be sent. IPC Channel is dead or busy', this.id),
        );
    }

    _checkIfClusterAlive() {
        if (!this.manager.keepAlive) return;
        if (Object.keys(this.manager.keepAlive).length === 0) return;
        this.manager._debug('Heartbeat Interval CheckUp has started', this.id);
        this.heartbeat.interval = setInterval(() => {
            if (!this.heartbeat) return;
            const diff = Date.now() - Number(this.heartbeat.last);
            if (isNaN(diff)) return;
            if (diff > this.manager.keepAlive.interval + 2000) {
                this.heartbeat.missed++;
                if (this.heartbeat.missed < this.manager.keepAlive.maxMissedHeartbeats)
                    this.manager._debug(
                        `[Heartbeat_MISSING] ${this.heartbeat.missed} Heartbeat(s) have been missed.`,
                        this.id,
                    );
                if (this.heartbeat.missed > this.manager.keepAlive.maxMissedHeartbeats) {
                    if (this._restarts) {
                        if (this._restarts.current !== undefined) {
                            this._restarts.current++;
                            if (this._restarts.current === this.manager.keepAlive.maxClusterRestarts) {
                                return this.manager._debug(
                                    `[Heartbeat_MISSING] Already attempted maximal Amount of Respawns in less then 1 hour | Cluster will be respawned, when the cooldown ends.`,
                                    this.id,
                                );
                            }
                            if (this._restarts.current > this.manager.keepAlive.maxClusterRestarts) return;
                        }
                    }
                    this.manager._debug(
                        `[Heartbeat_MISSING] Attempting respawn | Too many heartbeats were missing.`,
                        this.id,
                    );
                    this._cleanupHeartbeat();
                    this.respawn();
                }
            } else return;
        }, this.manager.keepAlive.interval);
        return this.heartbeat;
    }

    _cleanupHeartbeat() {
        clearInterval(this.heartbeat.interval);
        if (Object.keys(this.manager.keepAlive).length === 0) return;
        this.heartbeat = {};
        this.manager._debug('[Heartbeat] Heartbeat has been cleared', this.id);
        return this.heartbeat;
    }
}

module.exports = Cluster;

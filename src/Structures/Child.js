const childProcess = require('child_process');

class Child {
    constructor(file, options = {}) {
        this.file = file;
        this.process = null;

        this.processOptions = {};

        // Custom options
        if (options.clusterData) this.processOptions.env = options.clusterData;
        if (options.args) this.processOptions.args = options.args;

        if (options.cwd) this.processOptions.cwd = options.cwd;
        if (options.detached) this.processOptions.detached = options.detached;
        if (options.execArgv) this.processOptions.execArgv = options.execArgv;
        if (options.env) this.processOptions.env = options.env;
        if (options.execPath) this.processOptions.execPath = options.execPath;
        if (options.gid) this.processOptions.gid = options.gid;

        if (options.serialization) this.processOptions.serialization = options.serialization;
        if (options.signal) this.processOptions.signal = options.signal;
        if (options.killSignal) this.processOptions.killSignal = options.killSignal;
        if (options.silent) this.processOptions.silent = options.silent;

        if (options.stdio) this.processOptions.stdio = options.stdio;
        if (options.uid) this.processOptions.uid = options.uid;

        if (options.windowsVerbatimArguments)
            this.processOptions.windowsVerbatimArguments = options.windowsVerbatimArguments;
        if (options.timeout) this.processOptions.timeout = options.timeout;
    }

    spawn() {
        return (this.process = childProcess.fork(this.file, this.processOptions.args, this.processOptions));
    }

    respawn() {
        this.kill();
        return this.spawn();
    }

    kill() {
        this.process?.removeAllListeners();
        return this.process?.kill();
    }

    send(message) {
        return new Promise((resolve, reject) => {
            this.process?.send(message, err => {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }
}

class ChildClient {
    constructor() {
        this.ipc = process;
    }
    send(message) {
        return new Promise((resolve, reject) => {
            process.send(message, err => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    getData() {
        return process.env;
    }
}

module.exports = { Child, ChildClient };

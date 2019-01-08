/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const adapterName = require('./package.json').name.split('.').pop();
const utils 	  = require('./lib/utils'); // Get common adapter utils
const tools 	  = require(utils.controllerDir + '/lib/tools.js');
const SocketIO    = require('./lib/socket');
const Web         = require('./lib/web');

let socket      = null;
let webServer   = null;

let objects     = {};
let states      = {};
let secret      = 'Zgfr56gFe87jJOM'; // Will be generated by first start
let adapter;

function startAdapter(options) {
    options = options || {};
	Object.assign(options, {
	    name:           adapterName, // adapter name
	    dirname:        __dirname,   // say own position
	    logTransporter: true,        // receive the logs
	    systemConfig:   true,
	    install:        callback => typeof callback === 'function' && callback()
	});

    adapter = new utils.Adapter(options);

    adapter.on('objectChange', (id, obj) => {
        if (obj) {
            //console.log('objectChange: ' + id);
            objects[id] = obj;

            if (id === 'system.repositories') {
                writeUpdateInfo();
            }
        } else {
            //console.log('objectDeleted: ' + id);
            if (objects[id]) {
                delete objects[id];
            }
        }

        // TODO Build in some threshold of messages
        if (socket) {
            socket.objectChange(id, obj);
        }
    });

    adapter.on('stateChange', (id, state) => {
        if (!state) {
            if (states[id]) {
                delete states[id];
            }
        } else {
            states[id] = state;
        }
        if (socket) {
            socket.stateChange(id, state);
        }
    });

    adapter.on('ready', () => {
        adapter.getForeignObject('system.config', (err, obj) => {
            if (!err && obj) {
                obj.native = obj.native || {};
                if (!obj.native.secret) {
                    require('crypto').randomBytes(24, (ex, buf) => {
                        adapter.config.secret = buf.toString('hex');
                        adapter.extendForeignObject('system.config', {native: {secret: adapter.config.secret}});
                        main();
                    });
                } else {
                    adapter.config.secret = obj.native.secret;
                    main();
                }
            } else {
                adapter.config.secret = secret;
                adapter.logger.error('Cannot find object system.config');
            }
        });
    });

    adapter.on('message', obj => {
        if (!obj || !obj.message) {
            return false;
        }

        if (socket) {
            socket.sendCommand(obj);
        }

        return true;
    });

    adapter.on('unload', callback => {
        if (socket) {
            // unsubscribe all
            socket.unsubscribeAll();
        }

        try {
            adapter.log.info('terminating http' + (adapter.config.secure ? 's' : '') + ' server on port ' + adapter.config.port);
            webServer.close();
            callback();
        } catch (e) {
            callback();
        }
    });

// obj = {message: msg, severity: level, from: this.namespace, ts: (new Date()).getTime()}
    adapter.on('log', obj => socket && socket.sendLog(obj));

    return adapter;
}

function createUpdateInfo() {
    // create connected object and state
    let updatesNumberObj = objects[adapter.namespace + '.info.updatesNumber'];

    if (!updatesNumberObj || !updatesNumberObj.common || updatesNumberObj.common.type !== 'number') {
        let obj = {
            _id:  'info.updatesNumber',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'Number of adapters to update',
                type:  'number',
                read:  true,
                write: false,
                def:   0
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let updatesListObj = objects[adapter.namespace + '.info.updatesList'];

    if (!updatesListObj || !updatesListObj.common || updatesListObj.common.type !== 'string') {
        let obj = {
            _id:  'info.updatesList',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'List of adapters to update',
                type:  'string',
                read:  true,
                write: false,
                def:   ''
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let newUpdatesObj = objects[adapter.namespace + '.info.newUpdates'];

    if (!newUpdatesObj || !newUpdatesObj.common || newUpdatesObj.common.type !== 'boolean') {
        let obj = {
            _id:  'info.newUpdates',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'Indicator if new adapter updates are available',
                type:  'boolean',
                read:  true,
                write: false,
                def:   false
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let updatesJsonObj = objects[adapter.namespace + '.info.updatesJson'];

    if (!updatesJsonObj || !updatesJsonObj.common || updatesJsonObj.common.type !== 'string') {
        let obj = {
            _id:  'info.updatesJson',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'JSON string with adapter update information',
                type:  'string',
                read:  true,
                write: false,
                def:   '{}'
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let lastUpdateCheckObj = objects[adapter.namespace + '.info.lastUpdateCheck'];

    if (!lastUpdateCheckObj || !lastUpdateCheckObj.common || lastUpdateCheckObj.common.type !== 'string') {
        let obj = {
            _id:  'info.lastUpdateCheck',
            type: 'state',
            common: {
                role:  'value.datetime',
                name:  'Timestamp of last update check',
                type:  'string',
                read:  true,
                write: false,
                def:   '{}'
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }
}

// Helper methods
function upToDate(a, b) {
    a = a.split('.');
    b = b.split('.');
    a[0] = parseInt(a[0], 10);
    b[0] = parseInt(b[0], 10);
    if (a[0] > b[0]) {
        return false;
    } else if (a[0] < b[0]) {
        return true;
    } else if (a[0] === b[0]) {
        a[1] = parseInt(a[1], 10);
        b[1] = parseInt(b[1], 10);
        if (a[1] > b[1]) {
            return false;
        } else if (a[1] < b[1]) {
            return true;
        } else if (a[1] === b[1]) {
            a[2] = parseInt(a[2], 10);
            b[2] = parseInt(b[2], 10);
            return a[2] <= b[2];
        }
    } else {
        return true;
    }
}

function writeUpdateInfo(sources) {
    if (!sources) {
        let obj = objects['system.repositories'];
        if (!objects['system.config'] || !objects['system.config'].common) {
            adapter.log.warn('Repository cannot be read. Invalid "system.config" object.');
            return;
        }

        const activeRepo = objects['system.config'].common.activeRepo;

        if (obj && obj.native && obj.native.repositories && obj.native.repositories[activeRepo] &&
            obj.native.repositories[activeRepo].json) {
            sources = obj.native.repositories[activeRepo].json;
        } else {
            adapter.setState('info.updatesNumber', 0, true);
            adapter.setState('info.updatesList',  '', true);
            adapter.setState('info.newUpdates', false, true);
            adapter.setState('info.updatesJson', '{}', true);
            let updateTime = new Date();
            adapter.setState('info.lastUpdateCheck', new Date(updateTime - updateTime.getTimezoneOffset() * 60000).toISOString(), true);
            if (obj && obj.native && obj.native.repositories && obj.native.repositories[activeRepo]) {
                adapter.log.warn('Repository cannot be read');
            } else {
                adapter.log.warn('No repository source configured');
            }
            return;
        }
    }

    let installed = tools.getInstalledInfo();
    let list  = [];
    let updatesJson = {};
    let newUpdateIndicator = false;
    adapter.getState('info.updatesJson', (err, state) => {
        let oldUpdates;
        if (state && state.val) oldUpdates = JSON.parse(state.val) || {};
        else oldUpdates = {};
        for (let name in sources) {
            if (!sources.hasOwnProperty(name)) continue;
            if (installed[name] && installed[name].version && sources[name].version) {
                if (sources[name].version !== installed[name].version &&
                    !upToDate(sources[name].version, installed[name].version)) {
                    // Check if updates are new or already known to user
                    if (!oldUpdates || !oldUpdates[name] || oldUpdates[name].availableVersion !== sources[name].version) {
                        newUpdateIndicator = true;
                    } // endIf
                    updatesJson[name] = {
                        availableVersion: sources[name].version,
                        installedVersion: installed[name].version
                    };
                    // remove first part of the name
                    const n = name.indexOf('.');
                    list.push(n === -1 ? name : name.substring(n + 1));
                }
            }
        }
        adapter.setState('info.updatesNumber', list.length, true);
        adapter.setState('info.updatesList', list.join(', '), true);
        adapter.setState('info.newUpdates', newUpdateIndicator, true);
        adapter.setState('info.updatesJson', JSON.stringify(updatesJson), true);
        let updateTime = new Date();
        adapter.setState('info.lastUpdateCheck', new Date(updateTime - updateTime.getTimezoneOffset() * 60000).toISOString(), true);
    });

}

// to do => remove it later, when all repositories patched.
function patchRepos(callback) {
    return callback && callback();
    // do not patch any more. Delete it later 2018.04.23
    /*
    adapter.getForeignObject('system.repositories', (err, obj) => {
        let changed = false;
        if (obj && obj.native && obj.native.repositories) {
            // default link should point to stable
            if (!obj.native.repositories.default || obj.native.repositories.default.link !== 'http://download.iobroker.net/sources-dist.json') {
                changed = true;
                obj.native.repositories.default = {
                    link: 'http://download.iobroker.net/sources-dist.json'
                };
            }
            // latest link should point to latest
            if (!obj.native.repositories.latest) {
                obj.native.repositories.latest = {
                    link: 'http://download.iobroker.net/sources-dist-latest.json'
                };
                changed = true;
            }

            // change URL of raw sources from ioBroker.js-controller to ioBroker.repositories
            for (let r in obj.native.repositories) {
                if (obj.native.repositories.hasOwnProperty(r) &&
                    obj.native.repositories[r].link === 'https://raw.githubusercontent.com/ioBroker/ioBroker.js-controller/master/conf/sources-dist.json') {
                    obj.native.repositories[r].link = 'https://raw.githubusercontent.com/ioBroker/ioBroker.repositories/master/sources-dist.json';
                    changed = true;
                }
            }
        }
        if (changed) {
            adapter.setForeignObject(obj._id, obj, function () {
                callback && callback();
            });
        } else {
            callback && callback();
        }
    });*/
}
function initSocket(server, store) {
    socket = new SocketIO(server, adapter.config, adapter, objects, states, store);
    socket.subscribe(null, 'objectChange', '*');
}

function main() {
    // adapter.subscribeForeignStates('*');
    // adapter.subscribeForeignObjects('*');

    adapter.config.defaultUser = adapter.config.defaultUser || 'admin';
    if (!adapter.config.defaultUser.match(/^system\.user\./)) {
        adapter.config.defaultUser = 'system.user.' + adapter.config.defaultUser;
    }

    if (adapter.config.secure) {
        // Load certificates
        adapter.getCertificates((err, certificates, leConfig) => {
            adapter.config.certificates = certificates;
            adapter.config.leConfig     = leConfig;

            getData(() => webServer = new Web(adapter.config, adapter, initSocket));
        });
    } else {
        getData(() => webServer = new Web(adapter.config, adapter, initSocket));
    }

    patchRepos(() => {
        // By default update repository every 24 hours
        if (adapter.config.autoUpdate === undefined) {
            adapter.config.autoUpdate = 24;
        }
        adapter.config.autoUpdate = parseInt(adapter.config.autoUpdate, 10) || 0;
        if (adapter.config.autoUpdate) {
            setInterval(() => updateRegister(), adapter.config.autoUpdate * 3600000);
            updateRegister();
        }
    });
}


function getData(callback) {
    adapter.log.info('requesting all states');
    let tasks = 0;
    tasks++;
    adapter.getForeignStates('*', (err, res) => {
        adapter.log.info('received all states');
        states = res;
        if (!--tasks && callback) callback();
    });
    adapter.log.info('requesting all objects');
    tasks++;
    adapter.objects.getObjectList({include_docs: true}, (err, res) => {
        adapter.log.info('received all objects');
        res = res.rows;
        objects = {};
        let tmpPath = '';
        for (let i = 0; i < res.length; i++) {
            objects[res[i].doc._id] = res[i].doc;
            if (res[i].doc.type === 'instance' && res[i].doc.common && res[i].doc.common.tmpPath) {
                if (tmpPath) {
                    adapter.log.warn('tmpPath has multiple definitions!!');
                }
                tmpPath = res[i].doc.common.tmpPath;
            }
        }

        // Some adapters want access on specified tmp directory
        if (tmpPath) {
            adapter.config.tmpPath = tmpPath;
            adapter.config.tmpPathAllow = true;
        }

        createUpdateInfo();
        writeUpdateInfo();
        if (!--tasks && callback) callback();
    });
}

// read repository information from active repository
function updateRegister() {
    adapter.log.info('Request actual repository...');
    adapter.getForeignObject('system.config', (err, data) => {
        if (data && data.common) {

            adapter.sendToHost(adapter.host, 'getRepository', {
                repo:   data.common.activeRepo,
                update: true
            }, _repository => {
                if (_repository === 'permissionError') {
                    adapter.log.error('May not read "getRepository"');
                } else {
                    adapter.log.info('Repository received successfully.');

                    if (socket) {
                        socket.repoUpdated();
                    }
                }
            });
        }
    });
}

// If started as allInOne mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}

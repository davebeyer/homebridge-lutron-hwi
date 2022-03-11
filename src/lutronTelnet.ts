import { LutronHWIPlatform } from './platform';

import { Telnet } from 'telnet-client';

import AsyncQueue from 'async-await-queue';

import { timeout } from './platform';

import ipc from 'node-ipc';

const IPC_ID = 'homebridge_lutron_hwi';

const IPC_LutronRequest = 'ipc_lutron_request';
const IPC_LutronOutput = 'ipc_lutron_output';

ipc.config.id = IPC_ID;
ipc.config.retry = 1500;
ipc.config.rawBuffer = false;

// const TelnetPrompt = 'L232>';

// Dimmer level change output example:
//    DL, [01:01:00:02:04], 50
// Sent either asynchronously when a keypad is pressed to change
// dimmer level, or synchronously with an RDL command

export enum OutputType {
  DimLevel = 1,
}

const OutputRegEx = {};

// RegEx must have
// - first group for the unmatched start,
// - second group for entire matched portion
// - last group for the unmatched end
OutputRegEx[OutputType.DimLevel] = /^(.*)(DL\s*,\s*\[([\d:]+)\]\s*,\s*(\d+))(\D.*$)/s;

export enum Priority {
  High = 1,
  Standard = 2,
  Low = 3,
}

enum CommMode {
  Telnet = 'telnet',
  IPC = 'ipc',
}

type IPCRequest = {
    ipcCounter: number;
    priority: Priority;
    cmd: string;
};

type IPCOutput = {
    outCounter: number;
    outType: OutputType;
    matches: Array<string>|null;
};

type LutronTelnetOptions = {
    telnetIP: string;
    telnetPort: number;
    minCmdDelay: number;
};

type OutHandlerCB = (OutputType, Array) => void;


export class LutronTelnet {

  private connection = new Telnet();  // created in constructor
  private connected = false;

  private reqTime = (new Date()).getTime();

  private outCallbacks: { [outType:number] : OutHandlerCB } = {};

  private outData = '';
  private outCounter = 0;

  // only 1 concurrent request to Lutron at a time, 10ms min apart (more added with minCmdDelay)
  private reqQueue = new AsyncQueue(1, 10);

  private minCmdDelay = 200;

  private ipAdr = '';
  private port = 0;

  private ipcCounter = 0;

  constructor(
    private readonly platform: LutronHWIPlatform,
    private readonly commMode: string,
    opts?:LutronTelnetOptions,
  ) {

    if (opts !== undefined) {
      if (opts.telnetIP !== undefined) {
        this.ipAdr = opts.telnetIP;
      }
      if (opts.telnetPort !== undefined) {
        this.port = opts.telnetPort;
      }

      if (opts.minCmdDelay !== undefined) {
        this.minCmdDelay = opts.minCmdDelay;
      }
    }

    // Set IPC logger
    ipc.config.logger = this.platform.log.debug.bind(this.platform.log);
  }

  registerHandler(outType: OutputType, cb:OutHandlerCB) {
    this.outCallbacks[outType] = cb;
  }

  async send(cmd:string, priority:Priority) {
    if (!this.connected) {
      return null;
    }
    if (this.commMode === CommMode.IPC) {
      return await this.ipcClientSend(cmd, priority);
    } else {
      return await this.telnetSend(cmd, priority);
    }
  }

  async telnetSend(cmd:string, priority:Priority) {
    // Await for my turn (Symbol() is a  unique id, priority 1)
    const reqId = Symbol();
    await this.reqQueue.wait(reqId, priority);

    this.reqTime = (new Date()).getTime();
    this.platform.log.info(`XMT 0ms: ${cmd}`);

    try {
      await this.connection.send(cmd + '\r');

      // give RS-232 time to communicate and Lutron time to implement
      await timeout(this.minCmdDelay);
      this.reqQueue.end(reqId);

    } catch (error) {
      this.platform.log.error(`ERR ${(new Date()).getTime() - this.reqTime}ms: ${error} `);

      await timeout(this.minCmdDelay);
      this.reqQueue.end(reqId);
    }
  }

  async ipcClientSend(cmd:string, priority:Priority) {
    const ipcCounter = this.ipcCounter ++;

    const ipcData:IPCRequest = {
      ipcCounter: ipcCounter,
      priority: priority,
      cmd: cmd,
    };

    this.platform.log.info(`IPC XMT ${JSON.stringify(ipcData)}`);

    ipc.of[IPC_ID].emit(IPC_LutronRequest, ipcData);
  }

  /**
   *
   * Telnet setup
   *
   */

  async telnetConnect() {
    this.platform.log.debug('telnetConnect()');

    const params = {
      host: this.ipAdr,
      port: this.port,
      shellPrompt: null, // TelnetPrompt,
      negotiationMandatory: false,
      timeout: 1500,
      irs: '\r',
    };

    try{
      await this.connection.connect(params);
      this.connected = true;

      this.telnetSend('', Priority.High);       // just CR to bring up the prompt
      this.telnetSend('DLMON', Priority.High);  // ensure monitoring of dimmer-level changes

      this.connection.on('data', (buf) => {
        let dataStr = '';
        if (buf instanceof Buffer) {
          dataStr = buf.toString('ascii');
        } else if (buf !== null && buf !== undefined) {
          dataStr = buf.toString();
        }

        if (dataStr) {
          dataStr = dataStr.replace(/\n/g, '\r').replace(/\r+/g, ';');
        }

        this.outData += dataStr;

        let endStr = '';
        let outType;

        for (const outTypeStr in this.outCallbacks) {
          outType = parseInt(outTypeStr);

          const matches = this.outData.match(OutputRegEx[outType]);
          if (matches) {
            this.outCounter ++;
            endStr = matches[matches.length - 1];
            this.outData = matches[1] + ';' + matches[matches.length - 1];
            this.platform.log.info(`RCV ${(new Date()).getTime() - this.reqTime}ms: ${matches[2]}`);

            // return only the portion of matches skipping over the [0] entry for the whole string,
            // the [1] entry for the unmatched start, and the [last] entry for the unmatched end.

            const resultMatches = matches.slice(2, matches.length - 1);

            // Send both to callback handler and to broadcast to IPC clients for their handler

            this.outCallbacks[outType](outType, resultMatches);

            const ipcData:IPCOutput = {
              outCounter: this.outCounter,
              outType: outType,
              matches: resultMatches,
            };
            ipc.server.broadcast(IPC_LutronOutput, ipcData);
          }
        }

        this.outData = endStr;

        // this.platform.log.debug(`Raw ${(new Date()).getTime() - this.reqTime}ms: `, dataStr);
      });

      // Setup to support client-ipc bridges
      this.ipcServerSetup();

    } catch (error) {
      this.platform.log.error(`Unable to connect to Lutron via Telnet: ${error}`);
      this.platform.log.error(`Attempted using params: ${JSON.stringify(params)}`);
    }
  }

  /**
   *
   * IPC setup and handlers
   *
   */

  async connect() {
    if (this.commMode === CommMode.IPC) {
      return await this.ipcClientConnect();
    } else {
      return await this.telnetConnect();
    }
  }

  ipcServerSetup() {
    this.platform.log.debug('ipcServerSetup()');

    ipc.serve( () => {
      this.platform.log.debug('IPC Server started');

      ipc.server.on(IPC_LutronRequest, (data /*, socket */) => {
        this.platform.log.info(`IPC RCV server ${JSON.stringify(data)}`);
        try {
          this.telnetSend(data.cmd, data.priority);  // no need to wait
        } catch (err) {
          this.platform.log.error('ipcServer telnetSend error', err);
        }
      });
    });

    ipc.server.start();
  }

  ipcClientConnect() {
    this.platform.log.debug('ipcClientConnect()');

    return new Promise((resolve, reject) => {
      try {
        ipc.connectTo(IPC_ID, () => {
          this.connected = true;

          ipc.of[IPC_ID].on('connect', () => {
            this.platform.log.debug('ipcClientConnect Connected to server');
          });

          ipc.of[IPC_ID].on('disconnect', () => {
            this.platform.log.debug('ipcClientConnect disconnected from server');
          });

          ipc.of[IPC_ID].on(IPC_LutronOutput, (data) => {
            // Monitor and handle broadcasts of Lutron outputs
            if (data.outType in this.outCallbacks) {
              this.outCallbacks[data.outType](data.outType, data.matches);
            }
          });

          resolve(null);
        });
      } catch(error) {
        this.platform.log.error(`Unable to establish IPC connection: ${error}`);
        reject(error);
      }
    });
  }
}

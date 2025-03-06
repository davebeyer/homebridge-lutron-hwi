import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LightingCircuit } from './lightingCircuit';

import { OutputType, LutronTelnet } from './lutronTelnet';

import fs from 'fs-extra';

const DefaultRoomName = 'Unknown';

// Convenience timeout (for "await timeout(xx)")
export function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * HomebridgePlatform
 *
 * Main platform constructor for parsing the user config and
 * discover/register all lighting circuits.
 */

export class LutronHWIPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public lutronTelnet: LutronTelnet;
  private circuitDict = {};

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.lutronTelnet = new LutronTelnet(this, this.config.commMode, {
      telnetIP : this.config.telnetIP,
      telnetPort : this.config.telnetPort,
      password: this.config.password,
      minCmdDelay : this.config.minInterCmdTime,
    });

    this.lutronTelnet.registerHandler(OutputType.DimLevel, this.handleDimLevelUpdate.bind(this));

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins can then register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already.

    this.api.on('didFinishLaunching', async () => {
      if (!this.config.disabled) {
        try {
          await this.lutronTelnet.connect();
        } catch (err) {
          this.log.error('Unable to connect to Lutron via Telnet or client IPC', err);
          return;
        }
      }

      // run the method to register all lighting circuits as accessories
      await this.discoverDevices();

      this.log.debug('Finished initializing platform:', this.config.name);
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    const room = accessory.context && accessory.context.room ? accessory.context.room : DefaultRoomName;
    this.log.info(`Loading accessory from cache ${accessory.displayName} for room ${room}`);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Discover all lighting circuits.
   *
   * Note that circuits ("accessories") must only be registered once, previously
   * created accessories must not be registered again to prevent
   * "duplicate UUID" errors.
   */

  async discoverDevices() {
    let circuits;

    this.log.debug('Starting discoverDevices()');

    try {
      circuits = await fs.readJson(this.config.circuitsFile);
      this.log.info(`Lutron HWI plugin adding ${circuits.length} circuits`);
    } catch (err) {
      this.log.error('Lutron HWI plugin unable to read circuits.json file: ' + err);
      circuits = [];
    }

    let stdAdr;

    // loop over the devices and register each one if it has not already been registered
    for (const device of circuits) {

      if (device['address'] === undefined || device['name'] === undefined) {
        if (device['comment'] === undefined) {
          // Missing address or name, and not a pure comment, so print error
          this.log.error(`Invalid device record in JSON circuits file: ${JSON.stringify(device)}`);
        }
        continue;   // skip over this record
      }

      stdAdr = this.lutronStdAdr(device['address']);

      if (stdAdr in this.circuitDict) {
        this.log.error(`Duplicate addresses (${device['address']})in JSON circuits file, skipping all but first`);
        continue;
      }

      if (device['dimmable'] === undefined) {
        device['dimmable'] = true;  // defaults to true
      }

      // generate a fixed, unique ID for the accessory
      const uuid = this.api.hap.uuid.generate('lighting circuit:' + device.address);

      // see if an accessory with the same UUID has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // Create the accessory handler for the restored accessory and
        // save in the circuitDict so we can lookup circuits when we
        // receive async updates

        this.circuitDict[stdAdr] = new LightingCircuit(this, existingAccessory);

      } else {

        // the accessory does not yet exist, so we need to create it
        this.log.info(`Adding new accessory ${device.name} to room ${device.room ? device.room : DefaultRoomName}`);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        if (device.room) {
          // NOTE that "room" currently appears to be unused in Homebridge->HomeKit interaction
          // (setting this via Homebridge does not appear to be supported by HomeKit)
          accessory.context.room = device.room;
        }

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly create accessory
        // and save in the circuitDict so we can lookup circuits when we receive async updates

        this.circuitDict[stdAdr] = new LightingCircuit(this, accessory);

        // link accessory to platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // space out slightly to avoid overwhelming the telnet-send
      // queue since it takes time to query the state of each circuit
      await timeout(200);
    }
  }

  handleDimLevelUpdate(outType:OutputType, matches:Array<string>) {
    const stdAdr = matches[1];
    const value = matches[2];

    if (stdAdr in this.circuitDict) {
      this.circuitDict[stdAdr].handleDimLevelUpdate(value);
    }

    // Else, just ignore with assumption it's for another homebridge process
  }

  lutronStdAdr(deviceAdr:string) : string {
    const parts = deviceAdr.split('.');
    const stdParts:Array<string> = [];

    let stdPart:string;
    for (let i = 0; i < parts.length; i++) {
      stdPart = (parseInt(parts[i])).toLocaleString('en-US', {minimumIntegerDigits: 2});
      stdParts.push(stdPart);
    }

    return stdParts.join(':');
  }

}

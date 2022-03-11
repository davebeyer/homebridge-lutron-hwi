import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { LutronHWIPlatform } from './platform';

import { Priority } from './lutronTelnet';

const DimFade_secs = 2;

/**
 * Lutron HWI lighting circuit.
 *
 * Supports on/off and dimming (for circuits that are able to dim)
 */
export class LightingCircuit {
  private service: Service;

  private getBrightnessTimer: ReturnType<typeof setTimeout>|null = null;

  private circuitStates = {
    On: false,
    Brightness: 0,
  };

  constructor(
    private readonly platform: LutronHWIPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Lutron')
      .setCharacteristic(this.platform.Characteristic.Model, 'Homeworks Interactive Circuit');
    // .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    // Set the service name, this is what is displayed as the default name on the Home app
    // Use the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setHandlerOn.bind(this))      // SET - bind to the `setHandlerOn` method below
      .onGet(this.getHandlerOn.bind(this));     // GET - bind to the `getHandlerOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setHandlerBrightness.bind(this))     // SET - bind to the 'setHandlerBrightness` method below
      .onGet(this.getHandlerBrightness.bind(this));    // GET - bind to the `getHandlerBrightness` method below
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of a lighting circuit
   */
  async setHandlerOn(value: CharacteristicValue) {
    const name = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    this.platform.log.debug(`setHandlerOn() for ${name} value ${value}`);

    const dimmable = this.accessory.context.device.dimmable;

    this.circuitStates.On = value as boolean;

    if (value) {
      if (this.circuitStates.Brightness === 0 || !dimmable) {
        this.circuitStates.Brightness = 100;
      } // else use most recent brightness level

      await this.sendLutronDimCmd(DimFade_secs, this.circuitStates.Brightness);
    } else {
      await this.sendLutronDimCmd(DimFade_secs, 0);
    }
  }

  async setHandlerBrightness(value: CharacteristicValue) {
    const name = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    this.platform.log.debug(`setHandlerBrightness() for ${name} level ${value}`);

    const dimmable = this.accessory.context.device.dimmable;

    let fadeSecs;

    if (!dimmable) {
      value = value > 0 ? 100 : 0;
      fadeSecs = 0;
    } else {
      fadeSecs = DimFade_secs;
    }

    this.circuitStates.Brightness = value as number;

    this.sendLutronDimCmd(fadeSecs, this.circuitStates.Brightness);
  }

  async sendLutronDimCmd(fadeSecs:number, brightness:number) {
    const name = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    const adr = this.accessory.context.device.address;
    const dim = this.accessory.context.device.dimmable ? 'dimmable' : 'non-dimmable';

    const cmd = `FADEDIM, ${brightness}, ${fadeSecs}, 0, [${adr}]`;

    let prfx = '';
    if (this.platform.config.disabled) {
      prfx = '[CONNECTION DISABLED] ' ;
    } else {
      try {
        this.platform.lutronTelnet.send(cmd, Priority.High);
      } catch(err) {
        this.platform.log.error('sendLutronDimCmd() lutronTelnet.send() error: ', err);
      }
    }

    this.platform.log.debug(`${prfx}${cmd}: ${name} Lighting (${dim}) to =>`, brightness);
  }

  /**
   * Handle the "GET" requests from HomeKit These are sent when
   * HomeKit wants to know the current state of the accessory, for
   * example, checking if a circuit is On
   */

  async getHandlerOn(): Promise<CharacteristicValue> {
    const name = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    this.platform.log.debug(`getHandlerOn() for ${name}`);

    const brightness = await this.getBrightness();
    return (brightness > 0);
  }

  async getHandlerBrightness(): Promise<CharacteristicValue> {
    const name = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    this.platform.log.debug(`getHandlerBrightness() for ${name}`);

    return await this.getBrightness();
  }

  async getBrightness(): Promise<CharacteristicValue> {
    // Note that because querrying Lutron can take a while,
    // particularly when refreshing the states in a large room or
    // zone, or during initialization, we instead return the most
    // recent known state immediately while also issuing a request to
    // Lutron, which will result in an asynchronouse update of the
    // On and Brightness characteristics later.

    // Also, avoid multiple getBrightness() requests for the same circuit
    // within a very short period.  In particular, this avoids duplicate
    // requests during initialization generated from consecutive calls to
    // getHandlerOn() and getHandlerBrightness().

    if (this.getBrightnessTimer) {
      // Return most recent known state for now
      return this.circuitStates.Brightness;
    }

    this.getBrightnessTimer = setTimeout( () => {
      this.getBrightnessTimer = null;
    }, 250);

    // Kickoff request, but don't wait for it
    const adr = this.accessory.context.device.address;
    const cmd = `RDL, [${adr}]`;

    try {
      this.platform.lutronTelnet.send(cmd, Priority.Standard);
    } catch(err) {
      this.platform.log.error('getBrightness() lutronTelnet.send() error: ', err);
    }

    // Return most recent known state for now
    return this.circuitStates.Brightness;
  }

  handleDimLevelUpdate(level:number) {
    const name = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    const adr = this.accessory.context.device.address;

    this.platform.log.info(`UPD Dim level for ${name}[${adr}] to ${level}`);

    this.service.updateCharacteristic(this.platform.Characteristic.On, level > 0);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, level);

    // Track most recent known state
    this.circuitStates.On = level > 0;
    this.circuitStates.Brightness = level;
  }
}

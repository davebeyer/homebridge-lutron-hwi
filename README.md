# Homebridge plugin for Lutron Homeworks Interactive

This homebridge plugin allows you to connect your HomeKit (and Apple
Home app) to Lutron Homeworks Interactive lighting.  It works with
Lutron's "Homeworks Interactive" processor model, or other models that
provide an RS-232 interface that support the "FADEDIM", "RDL", and
"DLMON" commands and the "DL" status updates as used and formatted in
Homeworks Interactive.

Features:

* Allows dimmable (and non-dimmable) control of Lutron Homeworks
  Interactive lighting circuits.

* A custom ```circuits.json``` file is used to list the names and Lutron 
  addresses of all lighting circuits.

* Responds to Apple HomeKit state requests immediately with last known
  state while issuing a (slower, RS-232) state request in the
  background.

* Recognizes and handles asynchronous state updates (such as when
  someone turns on, off, or dims a circuit using a keypad).

* Prioritizes user commands (switch a light on or off, or dim it) over
  lower-priority HomeKit-generated requests for current lighting
  status, which can be of particularl benefit just after re-activating
  the Home app as it requests current status on many or all circuits
  at once.

* Handles circuit counts in excess of the Apple HomeKit limit of 149
  devices per bridge by supporting multiple Homebridge processes with
  a single 'server' process providing the RS-232 interface (via
  telnet) and the other 'client' processes feeding requests and receiving
  status via IPC sockets.


## Setup:

The basic steps for using this plugin are:

* Run a [Homebridge](https://homebridge.io/) process on some
  server (always-on computer) on your local home network, such as on a
  [Raspberry Pi processor](https://homebridge.io/raspberry-pi-image).
  Also see [Homebridge Service
  Command](https://github.com/oznu/homebridge-config-ui-x/wiki/Homebridge-Service-Command)
  for details on how to setup Homebridge as a service.  E.g., start, stop, and restart
  the homebridge process using ```sudo hb-service [start|stop|restart]```.

* Install this ```homebridge-lutron-hwi``` plugin into your system.  Typically:

```
sudo npm -g install @davebeyer/homebridge-lutron-hwi
```

* Add the plugin into your Homebridge configuration on the "plugins" page
  in the Homebridge UI.

* Create your JSON circuits file (see format below) to give the names
  and Lutron addresses for your lighting circuits.

* Set the plugin configuration parameters using the Homebridge UI, or directly
  in the homebridge config.json file (see config options below).

* Scan the QR code on the status page of the Homebridge UI web page on
  your iOS device to register your lighting bridge with HomeKit.


Your lighting circuits should then appear, initially all in the
"Default Room" of your Apple iOS "Home" app, ready to switch on & off or
dim from 0 to 100%.


## Connecting to Lutron

This plugin currently assumes a TCP/Telnet-to-RS232 converter is used
to communicate with the Lutron Homeworks Interactive processor(s),
such as the [Digi Connect SP](https://www.digi.com/products/networking/infrastructure-management/serial-connectivity/device-servers/digiconnectsp).
Consult the Homeworks documentation for the required RS-232 settings.
Once you have Telnet from a terminal window working, you're ready to connect
via this plugin.


## Config options

The following settings are used to configure the plugin (accessible
via the plugin's "Settings" in the Homebridge UI, or directly by
editing the homebridge ```config.json``` file.


| Name         | Type   | Default  | Description                  |
|--------------|--------|----------|------------------------------|
| name         | string | Lutron Lighting Bridge | Name of this homebridge plugin |
| circuitsFile | string | (none)   | Full path to the lighting circuits JSON file (see below for file format) |
| commMode     | string | telnet   | Communication mode, either "telnet" or "ipc".  One Homebridge process must provide the Telnet connection to the Lutron  processor.  Any others (running on the same machine) must use IPC to share  access to this telnet channel. |
| telnetIP     | string | (none)   | IP address of the Telnet-to-RS232 converter that's  connected to the Lutron processor(s) (only used with commMode set to 'telnet'). |
| telnetPort   | integer | (none)  |    TCP port used for the Telnet-to-RS232 communication  (only used with commMode set to 'telnet'). |
| minInterCmdTime | integer | 200 | The minimum delay, in milliseconds, between consecutive RS232 commands (that don't expect a response) to the Lutron processor.  |
| disabled     | boolean | false | When set to true, communication with the Lutron is deactivated and only logging is generated (to indicate what commands would have been sent to Lutron).  |


## Specifying circuit addresses and names

Specify the circuit addresses and names in a JSON file, referenced in
the config options.  The file must be in JSON format and provide an
array that lists each circuit's address and name structured like the following:

```
[
  { "address" : "1.1.2.1.3", "name" : "Kitchen Island" },
  { "address" : "1.1.2.1.4", "name" : "Family Room Pendant" },
  ...
]
```

It seems that a good practice is to prefix the circuit names with the
full, precise name of the "Room" that is defined in the Home app so
that it's not only easier to move them into the appropriate Rooms in
the app, but also so that this room prefix is automatically hidden
(due to the matching strings) within that Room's page.

The address is the Lutron processor address for that lighting circuit.
For non-dimmable lights or switches, add the ```dimmable`` property like:

```
  { "address" : "1.1.2.2.1", "name" : "Bathroom Fan", "dimmable" : false },
```

Additionally, comments can be inserted into the list using objects with only
a ```comment``` property, like:

```
  { "comment" : "*** Basement Circuits Follow ***"},
```

Before updating with a new JSON circuits file, test that the file is
valid using something like [this JSON Formatter &
Validator](https://jsonformatter.curiousconcept.com) online tool, and
be sure there are no errors or even informational messages about stray
commas.

Note that due to a HomeKit limitation, Homebridge limits each bridge
to 149 accessories (i.e., lighting circuits).  If you have more than
that, you'll need to [create multiple
bridges](https://github.com/oznu/homebridge-config-ui-x/wiki/Homebridge-Service-Command#multiple-instances)
to keep below this limit.  In this case, separate the circuits into
two or more files, one for each homebridge process.


## Other Notes

* The Homeworks Interactive processor was not designed for API-type of
  control like this, so the delays (particularly during
  initialization) and uncoordinated status messages output onto the
  the RS-232 communication may result in occasional errors in
  reporting current lighting levels, which can sometimes lead to
  incorrect status being displayed in the Apple Home application.
  However, these inconsistencies are typically resolved after
  re-visiting a single room or switching the state of that particular
  lighting circuit via the UI of the Home app.

* This plugin was created using the [Homebridge Plugin
  Template](https://github.com/homebridge/homebridge-plugin-template)
  as a starting point.


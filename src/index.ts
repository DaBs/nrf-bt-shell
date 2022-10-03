import { SerialPort } from "serialport";
import { BitSet, BitField } from 'easy-bits';
import { escapeRegExp } from "./utils";
import { CHARACTERISTIC_OUTPUT_PATTERN, SERVICE_OUTPUT_PATTERN } from "./patterns";
import { timeStamp } from "console";

export enum AdvertisedProperties {
    CONNECTABLE = 0,
    SCANNABLE = 1 << 1,
    DIRECTED = 1 << 2,
    SCAN_RESPONSE = 1 << 3,
    EXTENDED_ADVERTISING = 1 << 4
}

export enum CharacteristicProperties {
    BROADCAST = 0,
    READ = 1 << 1,
    WRITE_WITHOUT_RESPONSE = 1 << 2,
    WRITE = 1 << 3,
    NOTIFY = 1 << 4,
    INDICATE = 1 << 5,
    AUTHENTICATED_SIGNED_WRITES = 1 << 6,
    EXTENDED_PROPERTIES = 1 << 7,
}

export type NRFBTAddressType = 'public' | 'random';

export interface NRFBTScanFilter {
    name?: string;
    address?: string;
    rssi?: number;
}

export interface NRFBTAdvertisingEvent {
    address: string;
    addressType: NRFBTAddressType;
    rssi: number;
}

export interface NRFDescriptors {
    uuid: string;
    value: Buffer;
}

export interface NRFBTCharacteristic {
    uuid: string;
    handle: string;
    properties: BitSet<CharacteristicProperties>;
    value?: Buffer;
}

export interface NRFBTService {
    uuid: string;
    startHandle: string;
    endHandle: string;
    characteristicUUIDs?: string[];
}

export interface NRFBTDevice {
    address: string;
    addressType: NRFBTAddressType;
    advertisedProperties: BitSet<AdvertisedProperties>;
    rssi: number;
    name?: string;
    scanResponse?: Buffer;
}

export class NRFBTShell {

    private comPort: string;
    private baudRate: number;

    private currentIncomingMessage: string = '';

    private serialPort: SerialPort | null = null;

    private btSelectedId: string | null = null;

    private btDevices: Record<string, NRFBTDevice> = {};
    private btServices: Record<string, Record<string, NRFBTService>> = {};
    private btCharacteristics: Record<string, Record<string, NRFBTCharacteristic>> = {};

    private scanUnsubscribe: (() => void) | null = null;

    constructor(path: string = 'COM3', baudRate: number = 115200) {
        this.comPort = path;
        this.baudRate = baudRate;
    }

    private updateDevice(address: string, device: NRFBTDevice): NRFBTDevice {
        if (!this.btDevices[address]) {
            this.btDevices[address] = device;
        }

        this.btDevices[address] = { ...this.btDevices[address], ...device };

        return this.btDevices[address];
    }

    private parseAdvertisement(advertisement: string, passedMatches: string[] | null) {
        const scannedDeviceLineRegEx = /\[DEVICE\]: (.{17}) \(([a-z]+)\), AD evt type (\d), RSSI (-?[0-9]+) (.+) C:(\d) S:(\d) D:(\d) SR:(\d) E:(\d) Prim: (.+), Secn: (.+), Interval: ([0-9x]+) .+, SID: ([0-9a-fx]+)/;
        const matches = passedMatches ? passedMatches : advertisement.match(scannedDeviceLineRegEx) || [];

        const [, 
            address, 
            deviceType, 
            eventType, 
            rssi,
            name,
            connectable,
            scannable,
            directed,
            scanResponse,
            extendedAdvertising
        ] = matches;

        const advertisedProperties = new BitField<AdvertisedProperties>();

        if (Boolean(parseInt(connectable, 10))) advertisedProperties.on(AdvertisedProperties.CONNECTABLE);
        if (Boolean(parseInt(scannable, 10))) advertisedProperties.on(AdvertisedProperties.SCANNABLE);
        if (Boolean(parseInt(directed, 10))) advertisedProperties.on(AdvertisedProperties.DIRECTED);
        if (Boolean(parseInt(scanResponse, 10))) advertisedProperties.on(AdvertisedProperties.SCAN_RESPONSE);
        if (Boolean(parseInt(extendedAdvertising, 10))) advertisedProperties.on(AdvertisedProperties.EXTENDED_ADVERTISING);

        const newDevice: NRFBTDevice = {
            address,
            addressType: (deviceType as NRFBTAddressType),
            advertisedProperties,
            rssi: parseInt(rssi, 10),
        }

        // Support the case where the advertising type 0 has the name and the subsequent scan response does not. A merge of these would null the name.
        if (name) {
            newDevice.name = name;
        }

        return this.updateDevice(address, newDevice);
    }

    private writeMessage(message: string) {
        this.serialPort?.write(message + '\n');
    }


    private collectMessagesBetween(startPattern: RegExp, endPattern: RegExp): Promise<string> {

        const collectorPromise = new Promise(resolve => {
            let collectorMessageBuffer = '';
            let singleMessageBuffer = '';
            let isLookingForStart = true;
            const onData = (data: Buffer) => {
                const dataString = data.toString("ascii");
                if (isLookingForStart) {
                    singleMessageBuffer += dataString;
                }
                if (isLookingForStart && singleMessageBuffer.includes('\n') && singleMessageBuffer.match(startPattern)) {
                    singleMessageBuffer = '';
                    isLookingForStart = false;
                } else {
                    collectorMessageBuffer += dataString;
                    const endPatternMatches = collectorMessageBuffer.match(endPattern);
                    console.log(collectorMessageBuffer);
                    if (endPatternMatches) {
                        let cleanDataString = collectorMessageBuffer.replace(/\r\n/gm, '')
                        cleanDataString = cleanDataString.replace(/\\x1B\[[0-9J;]*/gm, '');
                        cleanDataString = cleanDataString.replace(/muart:~\$[ m]?[ mD]?[ mD]?/gm, '');
                        console.log(endPatternMatches);
                        console.log(cleanDataString);
                        this.serialPort?.off("data", onData);
                        resolve(collectorMessageBuffer);
                    }
                }
            };

            this.serialPort?.on("data", onData);
        });

        return collectorPromise as Promise<string>;
    }

    private attachToMessages(callback: (message: string, matches: string[] | null) => void, filterByPattern?: RegExp, stopPattern?: RegExp) {
        let messageBuffer = '';
        const onData = (data: Buffer) => {
            const dataString = data.toString("ascii");
            messageBuffer += dataString;
            if (messageBuffer.includes('\n')) {
                const matches = filterByPattern ? messageBuffer.match(filterByPattern) : null;
                const stopMatch = stopPattern ? !!messageBuffer.match(stopPattern) : false;
                if (!filterByPattern || matches) {
                    callback(messageBuffer, matches);
                }

                if (stopMatch) {
                    this.serialPort?.off('data', onData);
                }

                messageBuffer = '';
            }
        };

        this.serialPort?.on("data", onData);

        return () => { this.serialPort?.off('data', onData); };
    }

    private attachDisconnectListener(callback: (address: string, reason: string | null) => void, address: string) {
        // Setup disconnect listener for this device
        const unsubscribe = this.attachToMessages((message, matches) => {
            unsubscribe();
            callback(address, matches ? matches[3] : null);
        }, /Disconnected: (.{17}) \(([a-z]+)\) \(reason (0x\d{2})\)/);

        return () => unsubscribe();
    }

    private async waitForMessage(messageOrPattern: string | RegExp, timeout: number = 10000): Promise<{ message: string, matches: string[] | null}>  {
        const pattern = messageOrPattern instanceof RegExp ? messageOrPattern : new RegExp(escapeRegExp(messageOrPattern));
        const timeoutPromise = new Promise<never>((resolve, reject) => {
            setTimeout(() => {
                reject();
            }, timeout);
        });
        const messagePromise = new Promise<{ message: string, matches: string[] | null}>((resolve, reject) => {
            const unsubscribe = this.attachToMessages((message, matches) => {
                unsubscribe();
                resolve({ message, matches });
            }, pattern);
        });

        return Promise.race([
            timeoutPromise,
            messagePromise
        ]);
    }

    private async getSelectedId() {
        const idPromise = this.waitForMessage(/(\*?)(\d+): (.{17}) \(([a-z]+)\)/);
        this.writeMessage('bt id-show');
        const { message, matches } = await idPromise;
        if (!matches) return null;
        const [, selected, id, address, addressType] = matches;
        this.btSelectedId = id;
        return id;
    }

    private async guardSelectedDevice(address: string) {

    }

    private addServiceForDevice(service: NRFBTService, address: string) {
        if (!this.btServices[address]) {
            this.btServices[address] = {};
        }

        this.btServices[address][service.uuid] = service;
    }

    public async init() {
        if (!this.serialPort) {
            await new Promise((resolve, reject) => {
                this.serialPort = new SerialPort({ path: this.comPort, baudRate: this.baudRate }, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });
            })
        }

        if (!this.serialPort) throw new Error('Somehow failed setting serial port');

        const initPromise = this.waitForMessage('Bluetooth initialized');
        this.writeMessage('bt init');
        await initPromise;
    }

    public async startScanning(callback?: (device: NRFBTDevice) => void | null, scanFilter?: NRFBTScanFilter) {
        const devicePattern = /\[DEVICE\]: (.{17}) \(([a-z]+)\), AD evt type (\d), RSSI (-?[0-9]+) (.*) C:(\d) S:(\d) D:(\d) SR:(\d) E:(\d) Prim: (.+), Secn: (.+), Interval: ([0-9x]+) .+, SID: ([0-9a-fx]+)/;
        this.attachToMessages((message, matches) => {
            const device = this.parseAdvertisement(message, matches);
            if (scanFilter && !(
                (!scanFilter.name || device.name?.includes(scanFilter.name)) &&
                (!scanFilter.address || device.address === scanFilter.address)
            )) {
                return;
            }
            if (callback) callback(device);
        }, devicePattern);
        this.writeMessage('bt scan on');
    }

    public async isScanning() {

    }

    public async stopScanning() {
        if (this.scanUnsubscribe) {
            this.scanUnsubscribe();
            this.scanUnsubscribe = null;
        }
        this.writeMessage('bt scan off');
    }

    public async connect(btAddress: string, overrideConnectionType?: NRFBTAddressType) {
        const connectionType = this.btDevices[btAddress].addressType;
        const connectedPromise = this.waitForMessage(`Connected: ${btAddress} (${connectionType})`);
        this.writeMessage(`bt connect ${btAddress} ${connectionType}`);
        await connectedPromise;
        this.btSelectedId = await this.getSelectedId();

        // Setup disconnect listener for this device
        this.attachDisconnectListener(() => {}, btAddress);
    }

    public async discoverPrimaryServices(btAddress: string) {
        await this.guardSelectedDevice(btAddress);
        const discoverRemove = this.attachToMessages((message, matches) => {
            if (!matches) throw new Error('Discovered weird service' + message);
            const [, uuid, startHandle, endHandle] = matches;
            const service: NRFBTService = {
                uuid, startHandle, endHandle
            };
            this.addServiceForDevice(service, btAddress);
        }, SERVICE_OUTPUT_PATTERN);
        const discoverCompletePromise = this.waitForMessage('Discover complete');
        this.writeMessage('gatt discover-primary');
        await discoverCompletePromise;
        discoverRemove();

        return this.btServices[btAddress];
    }

    public async discoverCharacteristicsForService(btAddress: string, serviceUUID: string) {
        await this.guardSelectedDevice(btAddress);
        const service = this.btServices[btAddress][serviceUUID];
        const collectedBufferPromise = this.collectMessagesBetween(/Discover pending/, /Discover complete/);
        this.writeMessage(`gatt discover-characteristic : ${service.startHandle} ${service.endHandle}`);
        let collectedBuffer = await collectedBufferPromise;
        const characteristicMatches = collectedBuffer.matchAll(CHARACTERISTIC_OUTPUT_PATTERN);
        const characteristicsArr = [...characteristicMatches];
        console.log(characteristicsArr);
    }

    public async discoverAllServicesAndCharacteristics(btAddress: string) {
        const services = await this.discoverPrimaryServices(btAddress);
        console.log(services);
        for (const service of Object.values(services)) {
            const characteristics = await this.discoverCharacteristicsForService(btAddress, service.uuid)
        }
    }


}
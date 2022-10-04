import { SerialPort } from "serialport";
import { BitSet, BitField } from 'easy-bits';
import stripAnsi from 'strip-ansi';
import { escapeRegExp } from "./utils";
import { CHARACTERISTIC_DEFINITION_OUTPUT_PATTERN, CHARACTERISTIC_PROPERTIES_PATTERN, SERVICE_OUTPUT_PATTERN } from "./patterns";

const NRF_READ_OUTPUT_LENGTH = 16;

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
    handle: number;
    serviceUUID?: string;
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
    mtu?: number;
    name?: string;
    scanResponse?: Buffer;
}

export class NRFBTShell {

    private path: string;
    private baudRate: number;

    private currentIncomingMessage: string = '';

    private serialPort: SerialPort | null = null;

    private btSelectedId: string | null = null;

    private btDevices: Record<string, NRFBTDevice> = {};
    private btServices: Record<string, Record<string, NRFBTService>> = {};
    private btCharacteristics: Record<string, Record<string, NRFBTCharacteristic>> = {};

    private scanUnsubscribe: (() => void) | null = null;

    constructor(path: string = 'COM3', baudRate: number = 115200) {
        this.path = path;
        this.baudRate = baudRate;
    }

    private updateDevice(address: string, device: Partial<NRFBTDevice>): NRFBTDevice {
        if (!this.btDevices[address]) {
            this.btDevices[address] = { ...device, address } as NRFBTDevice;
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

    private cleanMessages(messages: string): string;
    private cleanMessages(messages: string[]): string[];
    private cleanMessages(messages: any): any {
        if (typeof messages === 'string') {
            const result = messages.replace(/(\x9B|\x1B\[)[0-?]*[ -\/]*[@-~]/gm, '').replace(/uart:~\$ /gm, '');
            return result;
        } else {
            const results = messages.map((message: string) => {
                const result = message.replace(/(\x9B|\x1B\[)[0-?]*[ -\/]*[@-~]/gm, '').replace(/uart:~\$ /gm, '');
                return result;
            });
            return results;
        }
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
                    if (endPatternMatches) {
                        // console.log(collectorMessageBuffer);
                        this.serialPort?.off("data", onData);
                        collectorMessageBuffer = this.cleanMessages(collectorMessageBuffer);
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
                messageBuffer = this.cleanMessages(messageBuffer);
                const matches = filterByPattern ? messageBuffer.match(filterByPattern) : null;
                const stopMatch = stopPattern ? !!messageBuffer.match(stopPattern) : false;
                if (!filterByPattern || matches) {
                    if (filterByPattern && filterByPattern.lastIndex) filterByPattern.lastIndex = 0;
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

    private addCharacteristicForDevice(characteristic: NRFBTCharacteristic, address: string) {
        if (!this.btCharacteristics[address]) {
            this.btCharacteristics[address] = {};
        }

        this.btCharacteristics[address][characteristic.uuid] = { ...this.btCharacteristics[address][characteristic.uuid], ...characteristic };
    }

    private parsePropertyRawToProperty(propertyRaw: string) {
        switch (propertyRaw) {
            case "[write]": return CharacteristicProperties.WRITE;
            case "[write w/w rsp]": return CharacteristicProperties.WRITE_WITHOUT_RESPONSE;
            case "[read]": return CharacteristicProperties.READ;
            case "[notify]": return CharacteristicProperties.NOTIFY;
            case "[indicate]": return CharacteristicProperties.INDICATE;
            default: return null;
        }
    }

    public async init() {
        if (!this.serialPort) {
            await new Promise((resolve, reject) => {
                this.serialPort = new SerialPort({ path: this.path, baudRate: this.baudRate }, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });
            })
        }

        if (!this.serialPort) throw new Error('Somehow failed setting serial port');

        let dataBuff = '';
        this.serialPort.on('data', (data) => {
            const dataString = data.toString("ascii");
            dataBuff += dataString;
            if (dataBuff.includes('\n')) {
                //console.log(dataBuff);
                dataBuff = '';
            }
        });

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

    public async getMTU(btAddress: string) {
        await this.guardSelectedDevice(btAddress);
        const mtuValuePromise = this.waitForMessage(/MTU size: (\d+)/);
        this.writeMessage('gatt att_mtu');
        const mtuValue = await mtuValuePromise;
        if (!mtuValue.matches) return null;
        const mtu = parseInt(mtuValue.matches[1], 10);
        this.updateDevice(btAddress, { mtu });
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
        const outputLines = collectedBuffer.split('\n');

        let currentCharacteristic: NRFBTCharacteristic | null = null;
        let characteristics: NRFBTCharacteristic[] = [];

        for (let i = 0; i < outputLines.length; i++) {
            const currentLine = outputLines[i];
            if (!currentCharacteristic) {
                const characteristicMatches = currentLine.match(CHARACTERISTIC_DEFINITION_OUTPUT_PATTERN);
                if (characteristicMatches) {
                    const [, uuid, handle] = characteristicMatches;
                    const characteristicProperties = new BitField<CharacteristicProperties>();
                    currentCharacteristic = { uuid, handle: parseInt(handle, 16), serviceUUID, properties: characteristicProperties };
                    if (outputLines[i + 1]?.includes('Properties:')) {
                        i++; // We skip this line;
                        let propertiesLine = i + 1;
                        let propertiesMatch = null;
                        do {
                            propertiesMatch = outputLines[propertiesLine].match(CHARACTERISTIC_PROPERTIES_PATTERN);
                            if (propertiesMatch) {
                                const [, propertyRaw] = propertiesMatch;
                                const property = this.parsePropertyRawToProperty(propertyRaw);
                                if (property) {
                                    currentCharacteristic.properties.on(property);
                                }
                                propertiesLine++;
                            }
                        } while (propertiesMatch);
                        i = propertiesLine;
                    }
                    characteristics.push({ ...currentCharacteristic });
                    this.addCharacteristicForDevice({ ...currentCharacteristic }, btAddress);
                    currentCharacteristic = null;
                }
            }
        }

        return characteristics;
    }

    public async discoverAllServicesAndCharacteristics(btAddress: string) {
        await this.guardSelectedDevice(btAddress);
        const services = await this.discoverPrimaryServices(btAddress);
        for (const service of Object.values(services)) {
            await this.discoverCharacteristicsForService(btAddress, service.uuid);
        }
    }

    public async readCharacteristic(btAddress: string, characteristicUUID: string) {
        await this.guardSelectedDevice(btAddress);
        const characteristic = this.btCharacteristics[btAddress][characteristicUUID];
        const collectedMessagesPromise = this.collectMessagesBetween(/Read pending/, /Read complete: err (0x\d{2}) length 0/);
        this.writeMessage(`gatt read ${(characteristic.handle + 1).toString(16)} 0`);
        const collectedMessages = await collectedMessagesPromise;
        let collectedLines = collectedMessages.split('\n');

        let collectedBuffer = Buffer.alloc(0).fill(0x00);

        for (let i = 0; i < collectedLines.length; i++) {
            
            let currentReadMatch = null;
            let currentReadLength = 0;
            do {
                currentReadMatch = collectedLines[i].match(/Read complete: err (0x\d{2}) length (\d+)/);
                if (!currentReadMatch) continue;

                const error = currentReadMatch[1];
                if (error !== '0x00') throw new Error(`Error reading, err: ${error}`);

                currentReadLength = parseInt(currentReadMatch[2] || '0', 10);
                if (currentReadMatch && currentReadLength !== 0) {
                    i++;
                    const linesToEat = Math.ceil(currentReadLength / NRF_READ_OUTPUT_LENGTH);
                    let linesBuffer = Buffer.alloc(currentReadLength);
                    for (let j = 0; j < linesToEat; j++) {
                        const valueLine = collectedLines[i + j];
                        const matches = valueLine.match(/(\d{8}): ([a-zA-Z0-9 ]+)/);
                        if (!matches) continue;
                        const [, offsetRaw, rawHexString] = matches;
                        const offset = parseInt(offsetRaw, 16);
                        const buffer = Buffer.from(rawHexString.replace(/ /gm, ''), 'hex');
                        buffer.copy(linesBuffer, offset);
                    }
                    collectedBuffer = Buffer.concat([collectedBuffer, linesBuffer]);
                    i += linesToEat;
                }
            } while(currentReadMatch && currentReadLength !== 0);
        }

        return collectedBuffer;
    }

    public async writeCharacteristic(btAddress: string, characteristicUUID: string, data: Buffer): Promise<boolean> {
        await this.guardSelectedDevice(btAddress);
        const characteristic = this.btCharacteristics[btAddress][characteristicUUID];
        const waitingPromise = this.waitForMessage(/Write complete: err (0x\d{2})/);
        this.writeMessage(`gatt write ${(characteristic.handle + 1).toString(16)} 0 ${data.toString('hex')}`);
        const { message, matches } = await waitingPromise;
        if (matches && matches[1] !== '0x00') {
            throw new Error(`Error writing to characteristic ${characteristic.uuid}, err: ${matches[1]}`);
        }

        return true;
    }

    public async monitorCharacteristic(btAddress: string, characteristicUUID: string, callback: (error: Error | null, data: Buffer | null) => void) {
        await this.guardSelectedDevice(btAddress);
        const characteristic = this.btCharacteristics[btAddress][characteristicUUID];

        const unsubscribe = this.attachToMessages(async (message, matches) => {
            if (!matches) return null;
            const [, address, length] = matches;
            const notifyDataPromise = this.waitForMessage(/Notify data: (.+)/);
            this.writeMessage(`read_notify_data ${address} ${length}`);
            const notifyData = await notifyDataPromise;
            if (!notifyData.matches?.[1]) return null;
            const notifyDataBuffer = Buffer.from(notifyData.matches[1].replace(/ /gm, '').replace(/0x/gm, ''), 'hex');
            if (callback) callback(null, notifyDataBuffer);
        }, /Notification: data (0x[a-zA-Z0-9]+) length (\d+)/);

        // FIXME: Should discover descriptors and locations for it instead of this crap, but eh.
        this.writeMessage(`gatt subscribe ${(characteristic.handle + 2).toString(16)} ${(characteristic.handle + 1).toString(16)} 0`);

        return () => {
            if (unsubscribe) unsubscribe();
        }
    }


}
import { SerialPort } from "serialport";
import { NRFBTDevice, NRFBTShell } from '../src/index';


const main = async () => {

    const shell = new NRFBTShell('/dev/tty.usbmodem141201');

    await shell.init();
    console.log('Initialized');
    const device: NRFBTDevice = await new Promise((resolve, reject) => shell.startScanning(device => {
        resolve(device as NRFBTDevice);
    }, { name: 'OnePlus 8' }));
    console.log('Found device', device);
    shell.stopScanning();
    await shell.connect(device.address);
    console.log('Connected');
    await shell.discoverAllServicesAndCharacteristics(device.address);
    console.log('Discovered all services and characteristics');
    const value = await shell.readCharacteristic(device.address, '57ba394e-4abd-4a91-b802-10d3a0d100f5');
    console.log(value);
    await shell.writeCharacteristic(device.address, 'd9b912db-ba72-4aff-b517-2c8a95401cfd', Buffer.from([0xaa, 0xbb]));
    shell.monitorCharacteristic(device.address, '57ba394e-4abd-4a91-b802-10d3a0d100f5', (error, data) => {
        if (error) throw error;
        console.log(data);
    });
}


main().then(() => {
    console.log('Finished');
})
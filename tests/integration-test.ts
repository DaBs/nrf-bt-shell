import { NRFBTDevice, NRFBTShell } from '../src/index';


const main = async () => {
    const shell = new NRFBTShell();

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
}


main().then(() => {
    console.log('Finished');
})
// GramJS memanggil os.type()/os.release() untuk "device info"; di browser tidak ada modul os.
export const type = () => 'Browser';
export const release = () => 'web';
export const platform = () => 'browser';
export const arch = () => 'wasm';
export const hostname = () => 'localhost';
export default { type, release, platform, arch, hostname };

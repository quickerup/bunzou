export function crc32(str: string): number {
    const poly = 0xEDB88320;
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i);
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? poly : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

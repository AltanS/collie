// The encoder qrcode-terminal vendors and its own renderer uses. It ships no types; these name only
// what `qrModules` (scripts/qr.ts) calls. Pinned by scripts/qr.test.ts, which scans what it returns.

declare module "qrcode-terminal/vendor/QRCode/index.js" {
  export default class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
}

declare module "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js" {
  const level: { readonly L: number; readonly M: number; readonly Q: number; readonly H: number };
  export default level;
}

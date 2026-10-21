declare module 'upng-js' {
  const UPNG: {
    decode(buffer: ArrayBuffer): { width: number; height: number; [key: string]: any };
    toRGBA8(decoded: any): ArrayBuffer[];
    encode(buffers: ArrayBuffer[], width: number, height: number, colors: number, delays?: number[], forbidPalette?: boolean): ArrayBuffer;
  };
  export default UPNG;
}

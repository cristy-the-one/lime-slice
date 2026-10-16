/** Node's file reader, used by unit tests that check source on disk. */
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: string): string;
  export function readFileSync(path: URL | string): { readUInt32LE(offset: number): number; readFloatLE(offset: number): number };
}

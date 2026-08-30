declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  pid: number;
  platform: string;
  exitCode?: number;
  stdout: { write(value: string): void };
  stderr: { write(value: string): void };
  on(event: string, listener: (...args: any[]) => void): any;
  off(event: string, listener: (...args: any[]) => void): any;
  kill(pid: number, signal?: string | number): void;
};

declare const Buffer: {
  from(value: string | Uint8Array, encoding?: string): any;
  byteLength(value: string, encoding?: string): number;
  concat(values: any[]): any;
};

declare namespace NodeJS {
  type Signals = string;
}

declare module "node:assert/strict" { const value: any; export default value; }
declare module "node:child_process" { export const spawn: any; export const spawnSync: any; }
declare module "node:crypto" { export const createHash: any; export const randomUUID: any; }
declare module "node:events" { export const once: any; }
declare module "node:fs" {
  export const accessSync: any;
  export const chmodSync: any;
  export const closeSync: any;
  export const constants: any;
  export const createReadStream: any;
  export const createWriteStream: any;
  export const existsSync: any;
  export const fstatSync: any;
  export const fsyncSync: any;
  export const lstatSync: any;
  export const linkSync: any;
  export const mkdirSync: any;
  export const mkdtempSync: any;
  export const openSync: any;
  export const readFileSync: any;
  export const realpathSync: any;
  export const readdirSync: any;
  export const renameSync: any;
  export const rmSync: any;
  export const statSync: any;
  export const unlinkSync: any;
  export const writeFileSync: any;
  export const writeSync: any;
};
declare module "node:os" { export const homedir: any; export const tmpdir: any; }
declare module "node:path" {
  export const basename: any;
  export const dirname: any;
  export const isAbsolute: any;
  export const join: any;
  export const relative: any;
  export const resolve: any;
  export const sep: string;
};
declare module "node:test" { const test: any; export default test; }
declare module "node:url" { export const fileURLToPath: any; export const pathToFileURL: any; }

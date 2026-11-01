// Android's asset merger treats .gz sidecars as duplicate resources.
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../dist/', import.meta.url));
const target = fileURLToPath(new URL('./www/', import.meta.url));
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true, filter: path => !/\.(gz|br)$/.test(path) });

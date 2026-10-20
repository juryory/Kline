import { readSource } from '../server/source-config.js';
const source = process.env.SYNC_SOURCE_OVERRIDE || readSource();
await import(source === 'ifind' ? './sync-ifind.js' : './sync.js');

import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {getUSUniverse} from '../server/universe.mjs';

// The nightly scorer consumes today's official listings, even if the public
// frontend has not been rebuilt since the prior trading session.
const target = process.argv[2];
if (!target) throw new Error('Pass the private staging directory.');
const catalog = await getUSUniverse();
if (catalog.sourceMode !== 'directory' || catalog.sources.length !== 2 ||
    !catalog.sources.every(source => source.createdAtET.slice(0,10) === catalog.asOf)) {
  throw new Error('Both Nasdaq Trader files must identify the same publication day.');
}
await mkdir(target, {recursive:true});
await writeFile(path.join(target, 'us-listings.json'), JSON.stringify(catalog));
console.log(catalog.asOf);

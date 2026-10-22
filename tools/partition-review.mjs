import { pathToFileURL } from 'node:url';
import { createPartitionReview, recordPartitionReview, recordGlobalReview, partitionReviewStatus, finalizePartitionReview, zoomPartitionReview } from '../src/partition-review.mjs';

const usage = 'Usage: node tools/partition-review.mjs create REFERENCE CANDIDATE OUT [--tile-size 640 --overlap 96] | record OUT RECORD_JSON | global OUT GLOBAL_JSON | status OUT | finalize OUT | zoom OUT X1 Y1 X2 Y2 LABEL';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === 'create') {
      if (args.length < 3 || (args.length - 3) % 2) throw new Error(usage);
      const options = {}, seen = new Set();
      for (let i = 3; i < args.length; i += 2) {
        const key = { '--tile-size': 'tileSize', '--overlap': 'overlap' }[args[i]];
        if (!key || seen.has(key)) throw new Error(usage);
        options[key] = Number(args[i + 1]); seen.add(key);
      }
      result = await createPartitionReview(...args.slice(0, 3), options);
    } else if (command === 'zoom') {
      if (args.length !== 6) throw new Error(usage);
      result = await zoomPartitionReview(args[0], args.slice(1, 5).map(Number), args[5]);
    } else {
      const commands = { record: [2, recordPartitionReview], global: [2, recordGlobalReview], status: [1, partitionReviewStatus], finalize: [1, finalizePartitionReview] };
      if (!commands[command] || args.length !== commands[command][0]) throw new Error(usage);
      result = await commands[command][1](...args);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

import { pathToFileURL } from 'node:url';
import { freezeInventory, measureSource, reviewVersion, finalizeVersion, registerVersionIssues, resolveVersionIssues, amendInventory, planIssueClosure, applyIssueClosure } from '../src/evidence.mjs';

const usage = 'Usage: node tools/evidence.mjs inventory RUN INVENTORY_JSON | amend RUN AMENDMENT_JSON LABEL | measure RUN SPEC_JSON LABEL | review RUN VERSION REVIEW_JSON LABEL | issue RUN VERSION ISSUES_JSON LABEL | resolve RUN VERSION RESOLUTIONS_JSON LABEL | closure-plan RUN VERSION LABEL | closure-apply RUN VERSION DECISIONS_JSON LABEL | finalize RUN VERSION REVIEW_LABEL';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const commands = { inventory: [2, freezeInventory], amend: [3, amendInventory], measure: [3, measureSource], review: [4, reviewVersion], issue: [4, registerVersionIssues], resolve: [4, resolveVersionIssues], 'closure-plan': [3, planIssueClosure], 'closure-apply': [4, applyIssueClosure], finalize: [3, finalizeVersion] };
    if (!commands[command] || args.length !== commands[command][0]) throw new Error(usage);
    process.stdout.write(`${JSON.stringify(await commands[command][1](...args), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

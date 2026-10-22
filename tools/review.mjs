import { pathToFileURL } from 'node:url';
import { prepareReview, reopenReview, nextReviewItem, recordReviewItem, submitReview, closeReviewIssues, finishReview, workflowStatus } from '../src/review-workflow.mjs';

const usage = 'Usage: node tools/review.mjs prepare RUN [VERSION] | reopen RUN | next RUN | record RUN RESPONSE_JSON | submit RUN [DECISIONS_JSON] | close RUN DECISIONS_JSON | status RUN | finish RUN';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, run, argument, ...extra] = process.argv.slice(2);
    const operations = { prepare: [prepareReview, 1, 2], reopen: [reopenReview, 1, 1], next: [nextReviewItem, 1, 1], record: [recordReviewItem, 2, 2],
      submit: [submitReview, 1, 2], close: [closeReviewIssues, 2, 2], status: [workflowStatus, 1, 1], finish: [finishReview, 1, 1] };
    const operation = operations[command], count = [run, argument, ...extra].filter(x => x !== undefined).length;
    if (!operation || count < operation[1] || count > operation[2] || extra.length) throw new Error(usage);
    const result = await operation[0](run, argument);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

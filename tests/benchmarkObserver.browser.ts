import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observeCacheCompletion, waitForAllCached } from './benchmarks/cache-observer';

test('benchmark waits for every true completion and honors retractions, not rounded 100%', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<article class="document-row" data-file-id="fast"><div class="cache-ring is-complete"></div></article>' +
      '<article class="document-row" data-file-id="slow"><div class="cache-ring" aria-valuenow="100"></div></article>');
    await observeCacheCompletion(page);
    await assert.rejects(waitForAllCached(page, 2, 150), /Timeout/,
      'A rounded 100% on an incomplete second file must not finish the batch');
    await page.locator('[data-file-id=fast] .cache-ring').evaluate(element => element.classList.remove('is-complete'));
    await page.locator('[data-file-id=slow] .cache-ring').evaluate(element => element.classList.add('is-complete'));
    await assert.rejects(waitForAllCached(page, 2, 150), /Timeout/,
      'Retracting a previously complete file must keep the batch pending');
    await page.locator('[data-file-id=fast] .cache-ring').evaluate(element => element.classList.add('is-complete'));
    const result = await waitForAllCached(page, 2, 1000);
    assert.equal(result.length, 2);
    assert.ok(result.find(file => file.fileId === 'fast')!.completedAtMs >
      result.find(file => file.fileId === 'slow')!.completedAtMs);
  } finally { await browser.close(); }
});

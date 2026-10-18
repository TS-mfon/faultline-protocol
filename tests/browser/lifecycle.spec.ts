import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { hashCanonical, hashText, type Operation, type WorkflowRecord, type WorkflowStatus } from '@faultline/protocol';
import { handoff, makeManifest, scenarios } from '../../examples/src/scenarios';

// Mocked API/wallet fixtures exercise the browser boundary only. These are never live evidence.
const addresses = [1, 2, 3, 4].map(n => `0x${n.toString(16).padStart(40, '0')}`);
const actors = { creator: addresses[0]!, agents: addresses.slice(0, 3) as [string, string, string], repairer: addresses[3]! };
const txHash = hashText('browser-fixture-transaction');
async function browserFixture(page: Page, status: WorkflowStatus = 'draft', empty = false) {
  const manifest = makeManifest('software', actors, `browser-fixture-${status}`);
  manifest.title = 'Browser fixture: caller-owned lifecycle';
  const record: WorkflowRecord = { manifest, hash: hashCanonical(manifest), mode: 'live', status, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 604800000).toISOString(), accepted: [], bonded: {}, handoffs: [], acknowledgments: [], suspendedNodes: [], revision: 0 };
  const operations: Operation[] = [];
  const posts: { path: string; body: any; key?: string; authorization?: string }[] = [];
  let exists = !empty;
  await page.route('**/api/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace('/api/v1', '');
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      posts.push({ path, body, key: req.headers()['idempotency-key'], authorization: req.headers().authorization });
      if (path === '/auth/challenge') return send({ id: 'browser-challenge', address: actors.creator, message: 'Browser fixture: authorize API requests only. No spending.', expiresAt: Date.now() + 300000 });
      if (path === '/auth/verify') return send({ address: actors.creator, token: 'browser-fixture-session', expiresAt: Date.now() + 3600000 });
      if (path === '/artifacts') return send({ hash: hashText(body.text) }, 202);
      if (path.endsWith('/confirm')) {
        const operation = operations.find(op => path.includes(op.id))!;
        operation.txHash = body.txHash; operation.status = 'confirming';
        return send(operation, 202);
      }
      if (path === '/workflows') {
        record.manifest = body.manifest; record.hash = hashCanonical(body.manifest); exists = true;
      }
      const kind = path === '/workflows' ? 'register' : path.split('/').at(-1)!;
      const chain = kind === 'fund' ? 'base' : 'genlayer';
      const operation: Operation = { id: hashText(`browser:${path}:${operations.length}`), workflowId: record.manifest.id, kind, status: kind === 'adjudicate' ? 'queued' : 'awaiting_signature', createdAt: record.createdAt, updatedAt: record.createdAt,
        ...(kind === 'adjudicate' ? {} : { intent: { chain, chainId: chain === 'base' ? 84532 : 4221, to: addresses[3]!, functionName: kind === 'fund' ? 'depositBond' : kind === 'accept' ? 'accept_mandate' : kind, args: [record.manifest.id], value: '0' } }) };
      operations.push(operation); return send(operation, 202);
    }
    if (path === '/workflows') return send(exists ? [record] : []);
    if (path.endsWith('/audit')) return send({ mode: 'live', workflow: record, operations, evidence: [], receipts: [], trust: { fixture: 'Browser mock only; no actual chain evidence' } });
    if (path.startsWith('/workflows/')) return send(record);
    if (path.endsWith('/finality')) return send({ supported: true, mode: 'live', status: 'ACCEPTED', canAppeal: true, canFinalize: true, successfulFinality: false, observedBlock: '123' });
    if (path.startsWith('/operations/')) return send(operations.find(op => path.endsWith(op.id)));
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('/');
  await expect(page.getByText('Service workspace', { exact: true })).toBeVisible();
  return { record, operations, posts };
}

async function authorize(page: Page) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: /Read-only access/ }).click();
  await page.getByLabel('Or enter your wallet address').fill(actors.creator);
  await page.getByRole('button', { name: 'Request authentication message', exact: true }).click();
  await expect(page.getByText('Browser fixture: authorize API requests only. No spending.')).toBeVisible();
  await page.getByText('Use a signature from another wallet', { exact: true }).click();
  await page.getByLabel('Personal-message signature').fill(`0x${'11'.repeat(65)}`);
  await page.getByRole('button', { name: 'Verify signature', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('wallet refusal never authenticates or prepares a transaction', async ({ page }) => {
  const fixture = await browserFixture(page);
  await page.evaluate(address => { (window as any).ethereum = { request: async ({ method }: { method: string }) => { if (method === 'personal_sign') throw new Error('User rejected the request'); return [address]; } }; }, actors.creator);
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: /Read-only access/ }).click();
  await page.getByRole('button', { name: 'Connect browser wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Sign with wallet', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('User rejected the request');
  expect(fixture.posts.map(p => p.path)).toEqual(['/auth/challenge']);
});

test('creation reviews immutable integer amounts before sending an authenticated request', async ({ page }) => {
  const fixture = await browserFixture(page, 'draft', true);
  await authorize(page);
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await page.getByRole('button', { name: 'Configure workflow', exact: true }).click();
  await page.getByLabel('Workflow title').fill('Browser fixture: reviewed creation');
  for (const [index, label] of ['01 · Produce source analysis', '02 · Review and contain', '03 · Publish approved result'].entries()) await page.getByLabel(label, { exact: true }).fill(actors.agents[index]!);
  await page.getByLabel('Repair recipient', { exact: true }).fill(actors.repairer);
  await page.getByLabel('Bond / repair cap (USDC)', { exact: true }).fill('12.000001');
  await page.getByRole('button', { name: 'Review terms', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review immutable terms' })).toBeVisible();
  await expect(page.getByRole('dialog').locator('pre')).toContainText('12000001');
  expect(fixture.posts.filter(p => p.path === '/workflows')).toHaveLength(0);
  await page.getByRole('button', { name: 'Request live creation', exact: true }).click();
  await expect(page.getByText('Service response received', { exact: true })).toBeVisible();
  const creation = fixture.posts.find(p => p.path === '/workflows')!;
  expect(creation.body.manifest.repairCap).toBe('12000001');
  expect(creation.body.manifest.policy).toMatchObject({ cureWindowSeconds: 86400, repairWindowSeconds: 172800, lockDurationSeconds: 604800 });
  expect(creation.authorization).toBe('Bearer browser-fixture-session');
  expect(creation.key).toBeTruthy();
  expect(fixture.record.accepted).toEqual([]); expect(fixture.record.bonded).toEqual({});
});

for (const action of ['accept', 'fund'] as const) test(`${action}: signature and pending confirmation cannot become acceptance or funding`, async ({ page }) => {
  const fixture = await browserFixture(page);
  await page.getByRole('button', { name: 'Workflow actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Prepare accept mandate', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await authorize(page);
  await page.getByRole('button', { name: 'Workflow actions', exact: true }).click();
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption(action);
  await page.getByRole('button', { name: action === 'accept' ? 'Prepare accept mandate' : 'Prepare fund bond', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Awaiting signature', { exact: true })).toBeVisible();
  if (action === 'fund') {
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download exact approval intent' }).click();
    const path = await (await download).path();
    const approval = JSON.parse(await readFile(path!, 'utf8'));
    expect(approval).toMatchObject({ chainId: 84532, functionName: 'approve', args: [addresses[3], '12000000'] });
  }
  await page.getByLabel('Transaction hash after signing').fill(txHash);
  await page.getByRole('button', { name: 'Submit transaction hash', exact: true }).click();
  await expect(dialog.getByText('Confirming', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Completed', { exact: true })).toHaveCount(0);
  expect(fixture.posts.find(p => p.path.endsWith('/confirm'))?.body).toEqual({ txHash });
  expect(fixture.record.accepted).toEqual([]); expect(fixture.record.bonded).toEqual({});
  if (action === 'accept') {
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Check native appeal & finality', exact: true }).click();
    await expect(page.getByText(/Native status: ACCEPTED\. Appeal open\./)).toContainText('successful finality is still required');
  }
});

test('handoffs, acknowledgments and failure reports preserve caller-supplied evidence', async ({ page }) => {
  const fixture = await browserFixture(page, 'active');
  const h = handoff(fixture.record.manifest, 0, scenarios.software.outputs[0], [], 'https://browser-fixture.invalid/evidence');
  fixture.record.handoffs = [h];
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: /Produce source analysis\. Handoff recorded/ })).toBeVisible();
  await authorize(page);
  for (const action of ['handoffs', 'acknowledgments', 'failures']) {
    await page.getByRole('button', { name: 'Workflow actions', exact: true }).click();
    await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption(action);
    if (action === 'handoffs') await page.getByLabel('Handoff manifest JSON', { exact: true }).fill(JSON.stringify(h));
    if (action === 'acknowledgments') await page.getByRole('combobox', { name: 'Handoff', exact: true }).selectOption(h.id);
    if (action === 'failures') {
      await page.getByRole('combobox', { name: 'Affected mandate', exact: true }).selectOption('publish');
      await page.getByLabel('Observed impact', { exact: true }).fill('Browser fixture: published latency uses the wrong units.');
    }
    await page.getByRole('button', { name: /^Prepare / }).click();
    await expect(page.getByRole('dialog').getByText('Awaiting signature', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  expect(fixture.posts.find(p => p.path.endsWith('/handoffs'))?.body).toEqual(h);
  expect(fixture.posts.find(p => p.path.endsWith('/acknowledgments'))?.body).toEqual({ handoffId: h.id });
  expect(fixture.posts.find(p => p.path.endsWith('/failures'))?.body.nodeId).toBe('publish');
});

test('evidence and adjudication remain submitted work until GenLayer supplies a judgment', async ({ page }) => {
  const fixture = await browserFixture(page, 'evidence_open');
  await authorize(page);
  const evidence = { id: 'reference', hash: hashText(scenarios.software.source), text: scenarios.software.source, submittedBy: actors.creator };
  for (const action of ['evidence', 'close-evidence', 'adjudicate']) {
    await page.getByRole('button', { name: 'Workflow actions', exact: true }).click();
    await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption(action);
    if (action === 'evidence') await page.getByLabel('Evidence item JSON', { exact: true }).fill(JSON.stringify(evidence));
    await page.getByRole('button', { name: /^Prepare / }).click();
    await expect(page.getByRole('dialog').getByText(action === 'adjudicate' ? 'Queued' : 'Awaiting signature', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  expect(fixture.posts.find(p => p.path.endsWith('/evidence'))?.body).toEqual(evidence);
  expect(fixture.record.decision).toBeUndefined();
  await expect(page.getByText('Awaiting judgment', { exact: true })).toBeVisible();
});

test('repair submission and expired-refund views never invent a successful payout', async ({ page }) => {
  const fixture = await browserFixture(page, 'repairing');
  await authorize(page);
  const text = scenarios.software.repair, hash = hashText(text);
  const repair = { schemaVersion: 1, workflowId: fixture.record.manifest.id, caseId: hashText('browser-case'), remedyId: 'correct', recipient: actors.repairer,
    artifacts: [{ hash, uri: `https://browser-fixture.invalid/evidence/${hash}`, mediaType: 'text/plain', size: Buffer.byteLength(text) }],
    evidence: [{ id: 'repair', hash, text, submittedBy: actors.repairer }], previousHashes: [hashText(scenarios.software.outputs[0])] };
  await page.getByRole('button', { name: 'Workflow actions', exact: true }).click();
  await page.getByLabel('Repair submission JSON', { exact: true }).fill(JSON.stringify(repair));
  await page.getByRole('button', { name: 'Prepare submit repair', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Awaiting signature', { exact: true })).toBeVisible();
  expect(fixture.posts.find(p => p.path.endsWith('/repairs'))?.body).toEqual(repair);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  fixture.record.status = 'expired';
  fixture.operations.push({ id: hashText('browser-refund'), workflowId: fixture.record.manifest.id, kind: 'refund_escrow', status: 'confirming', txHash, createdAt: fixture.record.createdAt, updatedAt: fixture.record.createdAt });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Receipts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'refund escrow', exact: true })).toBeVisible();
  await expect(page.getByText('Confirming', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Live payment confirmed');
});

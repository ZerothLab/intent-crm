import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Point this check at a locally built application with development authentication.
// INTENT_PLAYWRIGHT_MODULE can point to an installed Playwright entry point.
const base = process.env.INTENT_BROWSER_URL || 'http://127.0.0.1:3310';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback acceptance server.');
const mode = await (await fetch(`${base}/api/auth/mode`)).json();
assert.equal(mode.demo, true, 'This read-only browser check requires an isolated demo workspace.');
const { chromium } = await import(process.env.INTENT_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.INTENT_BROWSER_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const mutations = [];
page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(new URL(request.url()).pathname); });
const artifacts = process.env.INTENT_BROWSER_ARTIFACTS;
async function screenshot(name) { if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true }); } }
async function signIn() { await page.getByRole('button', { name: 'Enter demo workspace', exact: true }).click(); await page.getByRole('heading', { name: 'Work to handle', exact: true }).waitFor(); }
try {
    await page.goto(base);
    await signIn();
    await page.locator('.sidebar nav a[href="/settings/models"]').click();
    await page.getByRole('heading', { name: 'Model settings', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Enter demo workspace', exact: true }).count(), 0, 'Navigation must preserve the authenticated shell.');

    const failedChunk = '**/assets/workspace-settings-*.js';
    await page.route(failedChunk, route => route.abort());
    await page.locator('.sidebar nav a[href="/settings/workspace"]').click();
    await page.getByRole('heading', { name: 'Unable to display this page' }).waitFor();
    await page.getByRole('button', { name: 'Reload page', exact: true }).waitFor();
    assert.equal(await page.locator('.sidebar').isVisible(), true, 'A page failure must retain navigation.');
    await screenshot('route-recovery-en');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByRole('heading', { name: '无法显示此页面' }).waitFor();
    await screenshot('route-recovery-zh');
    await page.getByRole('combobox', { name: '语言' }).selectOption('en');
    await page.getByRole('link', { name: 'Back to workbench', exact: true }).click();
    await page.getByRole('heading', { name: 'Work to handle', exact: true }).waitFor();
    await page.unroute(failedChunk);

    await page.locator('.sidebar nav a[href="/customers"]').click();
    await page.getByRole('heading', { name: 'Build stronger customer relationships', exact: true }).waitFor();
    await page.route('**/api/work/inbox', route => route.fulfill({ json: { asOf: '2026-11-09T00:00:00Z' } }));
    await page.locator('.sidebar nav a[href="/"]').click();
    await page.getByRole('heading', { name: 'Unable to display this page' }).waitFor();
    await page.unroute('**/api/work/inbox');
    await page.getByRole('link', { name: 'Go to customers', exact: true }).click();
    await page.getByRole('heading', { name: 'Build stronger customer relationships', exact: true }).waitFor();
    await page.locator('.sidebar nav a[href="/"]').click();
    await page.getByRole('heading', { name: 'Work to handle', exact: true }).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
    await toggle.click();
    assert.equal(await page.getByRole('dialog', { name: 'Main navigation' }).isVisible(), true);
    assert.equal(await page.locator('.nav-close').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.app-main').evaluate(element => element.inert), true);
    await page.locator('.sidebar .profile').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.sidebar .brand').evaluate(element => element === document.activeElement), true, 'Tab wraps within the mobile drawer.');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.sidebar .profile').evaluate(element => element === document.activeElement), true, 'Shift+Tab wraps in reverse.');
    await screenshot('mobile-navigation-focus');
    await page.keyboard.press('Escape');
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true, 'Escape restores the navigation trigger.');
    assert.equal(await page.locator('.app-main').evaluate(element => element.inert), false);
    await toggle.click();
    await page.locator('.sidebar .profile').click();
    await page.locator('dialog[open]').waitFor();
    assert.equal(await page.locator('.sidebar').getAttribute('aria-modal'), null, 'Account dialogs close the navigation drawer.');
    assert.equal(await page.locator('dialog[open]').evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');

    await toggle.click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => !document.querySelector('.app-main')?.inert);
    assert.deepEqual(mutations, ['/api/dev/session'], 'Recovery and navigation must never replay business mutations.');
    console.log('Passed: lazy-load failure recovery, render-error recovery, bilingual fallback, session continuity, mobile focus trap, Escape restoration, profile dialog and responsive cleanup.');
} finally { await context.close(); await browser.close(); }

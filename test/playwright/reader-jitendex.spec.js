import {test, expect} from './playwright-util.js';

test('Manabi Reader opens the familiar Jitendex installer only from a trusted click', async ({context}) => {
    const readerUrl = 'https://reader.manabi.io/Reader-Web/b?test=jitendex';
    await context.route(readerUrl, (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><button data-manabitan-install-jitendex="true">Install Jitendex</button></body></html>',
    }));
    const page = await context.newPage();
    await page.goto(readerUrl);
    await expect(page.locator('html')).toHaveAttribute('data-manabitan-content-script-prepared', 'true', {timeout: 30_000});

    await page.evaluate(() => document.querySelector('button')?.click());
    expect(context.pages().filter((tab) => tab.url().includes('readerInstall=jitendex'))).toHaveLength(0);

    const outsideUrl = 'https://outside.example/reader-test';
    await context.route(outsideUrl, (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<button data-manabitan-install-jitendex="true">Install Jitendex</button>',
    }));
    const outsidePage = await context.newPage();
    await outsidePage.goto(outsideUrl);
    await outsidePage.getByRole('button', {name: 'Install Jitendex'}).click();
    expect(context.pages().filter((tab) => tab.url().includes('readerInstall=jitendex'))).toHaveLength(0);

    // Keep the acceptance test offline so it cannot fetch a full release.
    await context.setOffline(true);
    const settingsTabPromise = context.waitForEvent('page', (tab) => tab.url().includes('readerInstall=jitendex'));
    await page.getByRole('button', {name: 'Install Jitendex'}).click();
    const settingsTab = await settingsTabPromise;
    await expect(settingsTab.locator('#recommended-dictionaries-modal')).toBeVisible({timeout: 30_000});
    const jitendex = settingsTab.locator('#recommended-term-dictionaries .settings-item')
        .filter({has: settingsTab.locator('.settings-item-label', {hasText: 'Jitendex'})});
    await expect(jitendex).toBeVisible();
    await expect(jitendex.locator('button[data-action=import-recommended-dictionary]')).toBeDisabled();
});

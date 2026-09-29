const { test, expect } = require('@playwright/test')

const TARGETS = {
  test: 'https://test-brm.comein.cn/login',
  prod: 'https://brm.comein.cn/login',
}

function firstLocator(page, selectors) {
  return page.locator(selectors.join(', ')).first()
}

test('手机号密码登录兼容性巡检', async ({ page }, testInfo) => {
  const targetKey = process.env.TEST_TARGET || 'test'
  const targetUrl = TARGETS[targetKey]
  if (!targetUrl) throw new Error(`不支持的 TEST_TARGET: ${targetKey}`)

  const phoneValue = process.env.LOGIN_PHONE
  const passwordValue = process.env.LOGIN_PASSWORD
  if (!phoneValue || !passwordValue) {
    throw new Error('缺少 LOGIN_PHONE 或 LOGIN_PASSWORD；请通过 GitHub Actions Secrets 注入。')
  }

  const diagnostics = {
    target: targetKey,
    targetUrl,
    browser: 'webkit',
    browserVersion: null,
    pageErrors: [],
    consoleErrors: [],
    requestFailures: [],
    observedResponses: [],
    finalUrl: null,
    loginButtonEnabled: null,
    networkErrorVisible: false,
  }

  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.consoleErrors.push(message.text())
    }
  })
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText || 'request failed',
    })
  })
  page.on('response', (response) => {
    const url = response.url()
    if (url.includes('/json_user_weblogin') || url.includes('/json_identity_query-user-identity-and-invite')) {
      diagnostics.observedResponses.push({
        url: new URL(url).pathname,
        status: response.status(),
      })
    }
  })

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  const phoneTab = page.getByText(/^(Phone|手机号登录|手机登录)$/).first()
  if (await phoneTab.isVisible().catch(() => false)) {
    await phoneTab.click()
  }

  const phoneInput = firstLocator(page, [
    'input[placeholder="请输入手机号"]',
    'input[type="tel"]',
    'input[name="phone-account"]',
    'input[autocomplete="username"]',
  ])
  const passwordInput = firstLocator(page, [
    'input[placeholder="请输入密码"]',
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
  ])

  await expect(phoneInput).toBeVisible()
  await expect(passwordInput).toBeVisible()
  await phoneInput.fill(phoneValue)
  await passwordInput.fill(passwordValue)

  const rememberPassword = page.locator('input[type="checkbox"]').first()
  if (await rememberPassword.isVisible().catch(() => false)) {
    if (!(await rememberPassword.isChecked())) await rememberPassword.check()
  }

  const loginButton = firstLocator(page, [
    'button.login-btn',
    'button[type="submit"]',
    'input[type="submit"]',
  ])
  await expect(loginButton).toBeVisible()
  diagnostics.loginButtonEnabled = await loginButton.isEnabled().catch(() => false)

  await page.screenshot({ path: testInfo.outputPath('before-login-click.png'), fullPage: false })

  if (!diagnostics.loginButtonEnabled) {
    await page.waitForTimeout(8_000)
    await page.screenshot({ path: testInfo.outputPath('login-button-disabled.png'), fullPage: false })
    diagnostics.finalUrl = page.url()
    await testInfo.attach('login-diagnostics', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json',
    })
    throw new Error('登录按钮在填入账号密码后仍未启用。')
  }

  await loginButton.click()
  await page.waitForTimeout(8_000)
  await page.screenshot({ path: testInfo.outputPath('after-login-click.png'), fullPage: false })

  diagnostics.finalUrl = page.url()
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')
  diagnostics.networkErrorVisible = bodyText.includes('网络较差，请稍后重试')

  await testInfo.attach('login-diagnostics', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  })

  expect(diagnostics.networkErrorVisible, '检测到“网络较差，请稍后重试”').toBeFalsy()
})

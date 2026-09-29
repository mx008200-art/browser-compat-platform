const { test, expect } = require('@playwright/test')

const TARGETS = {
  test: 'https://test-brm.comein.cn/login',
  prod: 'https://brm.comein.cn/login',
}

function firstLocator(page, selectors) {
  return page.locator(selectors.join(', ')).first()
}

async function safeScreenshot(page, path, diagnostics) {
  try {
    await page.screenshot({
      path,
      fullPage: false,
      animations: 'disabled',
      timeout: 3_000,
    })
  } catch (error) {
    diagnostics.screenshotErrors.push(error instanceof Error ? error.message : String(error))
  }
}

async function collectFormDiagnostics(page, diagnostics) {
  diagnostics.finalUrl = page.url()
  diagnostics.pageTitle = await page.title().catch(() => '')
  diagnostics.formState = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('input')).map((input) => ({
      type: input.type,
      name: input.name,
      placeholder: input.getAttribute('placeholder'),
      valueLength: input.value?.length || 0,
      disabled: input.disabled,
      readOnly: input.readOnly,
    })),
    buttons: Array.from(document.querySelectorAll('button, input[type="submit"]')).map((button) => ({
      tagName: button.tagName,
      text: button.innerText || button.value || '',
      disabled: button.disabled,
      ariaDisabled: button.getAttribute('aria-disabled'),
      className: button.className,
      outerHTML: button.outerHTML.slice(0, 2000),
    })),
  })).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
  diagnostics.pageText = (await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '')).slice(0, 8_000)
}

async function attachDiagnostics(testInfo, diagnostics, name = 'login-diagnostics') {
  await testInfo.attach(name, {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  })
}

async function runWithTimeout(task, timeoutMs, stepName) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stepName} 超时（${timeoutMs}ms）`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('手机号密码登录兼容性巡检', async ({ page }, testInfo) => {
  // 诊断截图、远程字体和 WebKit 首次渲染可能耗时，不能让它们抢占业务流程的总时限。
  testInfo.setTimeout(120_000)

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
    screenshotErrors: [],
    finalUrl: null,
    pageTitle: null,
    formState: null,
    pageText: '',
    loginButtonCount: null,
    loginButtonVisible: null,
    loginButtonEnabled: null,
    networkErrorVisible: false,
    lastStep: null,
    stepTimeline: [],
  }

  const runStep = async (name, task, timeoutMs = 15_000) => {
    diagnostics.lastStep = name
    diagnostics.stepTimeline.push({ name, startedAt: new Date().toISOString() })
    try {
      return await runWithTimeout(task, timeoutMs, name)
    } catch (error) {
      diagnostics.stepError = error instanceof Error ? error.message : String(error)
      const attachmentName = `diagnostics-${diagnostics.stepTimeline.length}-${name}`.replace(/[^\w-]+/g, '-')
      await attachDiagnostics(testInfo, diagnostics, attachmentName).catch(() => {})
      throw error
    }
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

  const phoneTab = page
    .locator('.login-type-btns .type-btn')
    .filter({ hasText: /^(Phone|手机号登录|手机登录)$/ })
    .first()
  await runStep('切换到手机号登录页签', () => expect(phoneTab).toBeVisible({ timeout: 5_000 }))
  await runStep('点击手机号登录页签', () => phoneTab.click({ timeout: 8_000 }), 10_000)

  const phoneInput = firstLocator(page, [
    'input[name="phone-account"]',
    'input[type="tel"]',
    'input[placeholder="请输入手机号"]',
  ])
  const passwordInput = firstLocator(page, [
    'input[name="password"]',
    'input[placeholder="请输入密码"]',
    'input[type="password"]',
  ])

  await runStep('等待手机号输入框', () => expect(phoneInput).toBeVisible({ timeout: 10_000 }))
  await runStep('等待密码输入框', () => expect(passwordInput).toBeVisible({ timeout: 10_000 }))
  await runStep('填写手机号', () => phoneInput.fill(phoneValue, { timeout: 10_000 }), 12_000)
  diagnostics.lastStep = '手机号填写完成'
  await attachDiagnostics(testInfo, diagnostics, 'diagnostics-before-password-fill')
  await runStep('填写密码', () => passwordInput.fill(passwordValue, { timeout: 10_000 }), 12_000)

  const rememberPassword = page.locator('input[type="checkbox"]').first()
  if (await rememberPassword.isVisible().catch(() => false)) {
    if (!(await rememberPassword.isChecked())) await rememberPassword.check()
  }

  const loginButton = firstLocator(page, [
    'button.login-btn',
    'button[type="submit"]',
    'input[type="submit"]',
  ])
  diagnostics.loginButtonCount = await loginButton.count().catch(() => 0)
  diagnostics.loginButtonVisible = await loginButton.isVisible({ timeout: 5_000 }).catch(() => false)
  if (!diagnostics.loginButtonVisible) {
    await collectFormDiagnostics(page, diagnostics)
    await safeScreenshot(page, testInfo.outputPath('login-button-not-visible.png'), diagnostics)
    await attachDiagnostics(testInfo, diagnostics)
    throw new Error(`登录按钮不可见（匹配数量：${diagnostics.loginButtonCount}）。`)
  }
  diagnostics.loginButtonEnabled = await loginButton.isEnabled().catch(() => false)

  await safeScreenshot(page, testInfo.outputPath('before-login-click.png'), diagnostics)

  if (!diagnostics.loginButtonEnabled) {
    await collectFormDiagnostics(page, diagnostics)
    await safeScreenshot(page, testInfo.outputPath('login-button-disabled.png'), diagnostics)
    // 给页面一个短观察窗口，但不再调用 page.waitForTimeout，避免页面被关闭时覆盖真正诊断。
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    await attachDiagnostics(testInfo, diagnostics)
    throw new Error('登录按钮在填入账号密码后仍未启用。')
  }

  await loginButton.click()
  await page.waitForTimeout(8_000)
  await safeScreenshot(page, testInfo.outputPath('after-login-click.png'), diagnostics)

  await collectFormDiagnostics(page, diagnostics)
  const bodyText = diagnostics.pageText
  diagnostics.networkErrorVisible = bodyText.includes('网络较差，请稍后重试')

  await attachDiagnostics(testInfo, diagnostics)

  expect(diagnostics.networkErrorVisible, '检测到“网络较差，请稍后重试”').toBeFalsy()
})

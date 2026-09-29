const fs = require('fs')
const path = require('path')
const { test, expect } = require('@playwright/test')

const TARGETS = {
  test: 'https://test-brm.comein.cn/login',
  prod: 'https://brm.comein.cn/login',
}

function firstLocator(page, selectors) {
  return page.locator(selectors.join(', ')).first()
}

async function setInputValueByDom(locator, value) {
  await locator.evaluate((element, nextValue) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (!setter) throw new Error('找不到输入框 value setter')
    setter.call(element, nextValue)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function fillInputWithFallback(locator, value, label) {
  const historicalPlaywright = Boolean(process.env.PLAYWRIGHT_VERSION)
  let domError = null

  // 历史 WebKit 的 fill/type 可能一直等待输入事件；先用原生 setter 触发页面框架事件。
  if (historicalPlaywright) {
    try {
      await setInputValueByDom(locator, value)
      return 'dom-event'
    } catch (error) {
      domError = error
    }
  }

  let fillError = null
  try {
    await locator.fill(value, { timeout: 8_000 })
    return 'fill'
  } catch (error) {
    fillError = error
  }

  try {
    await locator.click({ force: true, timeout: 5_000 })
    await locator.type(value, { delay: 30, timeout: 8_000 })
    return 'type'
  } catch (typeError) {
    try {
      await setInputValueByDom(locator, value)
      return 'dom-event'
    } catch (domError) {
      const fillMessage = fillError instanceof Error ? fillError.message : String(fillError)
      const typeMessage = typeError instanceof Error ? typeError.message : String(typeError)
      const domMessage = domError instanceof Error ? domError.message : String(domError)
      throw new Error(`${label}的 fill/type/DOM 回退均失败：fill=${fillMessage}; type=${typeMessage}; dom=${domMessage}`)
    }
  }
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
  const filePath = testInfo.outputPath(`${name}.json`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(diagnostics, null, 2), 'utf8')
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
    phoneFillMethod: null,
    passwordFillMethod: null,
    networkErrorVisible: false,
    lastStep: null,
    stepTimeline: [],
    pointerClickError: null,
  }

  const runStep = async (name, task, timeoutMs = 15_000) => {
    diagnostics.lastStep = name
    diagnostics.stepTimeline.push({ name, startedAt: new Date().toISOString() })
    console.log(`[step:start] ${name}`)
    try {
      const result = await runWithTimeout(task, timeoutMs, name)
      console.log(`[step:done] ${name}`)
      return result
    } catch (error) {
      diagnostics.stepError = error instanceof Error ? error.message : String(error)
      const attachmentName = `diagnostics-${diagnostics.stepTimeline.length}-${name}`.replace(/[^\w-]+/g, '-')
      await attachDiagnostics(testInfo, diagnostics, attachmentName)
      console.error(`[step:error] ${name}: ${diagnostics.stepError}`)
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

  await runStep('打开登录页', () => page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }), 35_000)

  const phoneTab = page
    .locator('.login-type-btns .type-btn')
    .filter({ hasText: /^(Phone|手机号登录|手机登录)$/ })
    .first()
  await runStep('切换到手机号登录页签', () => expect(phoneTab).toBeVisible({ timeout: 5_000 }))
  try {
    await runWithTimeout(() => phoneTab.click({ force: true, timeout: 8_000 }), 10_000, '点击手机号登录页签')
  } catch (error) {
    diagnostics.pointerClickError = error instanceof Error ? error.message : String(error)
    await attachDiagnostics(testInfo, diagnostics, 'diagnostics-pointer-click-failed')
    console.error(`[step:error] 点击手机号登录页签: ${diagnostics.pointerClickError}`)
    await runStep('使用DOM事件切换手机号登录页签', () => phoneTab.dispatchEvent('click'), 8_000)
  }

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
  diagnostics.phoneFillMethod = await runStep(
    '填写手机号',
    () => fillInputWithFallback(phoneInput, phoneValue, '手机号'),
    30_000,
  )
  diagnostics.lastStep = '手机号填写完成'
  await attachDiagnostics(testInfo, diagnostics, 'diagnostics-before-password-fill')
  diagnostics.passwordFillMethod = await runStep(
    '填写密码',
    () => fillInputWithFallback(passwordInput, passwordValue, '密码'),
    30_000,
  )

  const rememberPassword = page.locator('input[type="checkbox"]').first()
  await runStep('处理记住密码', async () => {
    const visible = await rememberPassword.isVisible({ timeout: 5_000 }).catch(() => false)
    console.log(`[diagnostic] 记住密码可见=${visible}`)
    if (!visible) return
    const checked = await rememberPassword.isChecked().catch(() => false)
    console.log(`[diagnostic] 记住密码已选=${checked}`)
    if (!checked) await rememberPassword.check({ timeout: 8_000 })
  }, 20_000)

  const loginButton = firstLocator(page, [
    'button.login-btn',
    'button[type="submit"]',
    'input[type="submit"]',
  ])
  diagnostics.loginButtonCount = await runWithTimeout(() => loginButton.count(), 5_000, '读取登录按钮数量').catch(() => 0)
  diagnostics.loginButtonVisible = await runWithTimeout(
    () => loginButton.isVisible({ timeout: 5_000 }),
    7_000,
    '读取登录按钮可见性',
  ).catch(() => false)
  if (!diagnostics.loginButtonVisible) {
    await runWithTimeout(() => collectFormDiagnostics(page, diagnostics), 5_000, '收集登录按钮诊断').catch(() => {})
    await runWithTimeout(
      () => safeScreenshot(page, testInfo.outputPath('login-button-not-visible.png'), diagnostics),
      5_000,
      '登录按钮不可见截图',
    ).catch(() => {})
    await attachDiagnostics(testInfo, diagnostics)
    throw new Error(`登录按钮不可见（匹配数量：${diagnostics.loginButtonCount}）。`)
  }
  diagnostics.loginButtonEnabled = await loginButton.isEnabled().catch(() => false)

  await runWithTimeout(
    () => safeScreenshot(page, testInfo.outputPath('before-login-click.png'), diagnostics),
    5_000,
    '登录前截图',
  ).catch(() => {})

  if (!diagnostics.loginButtonEnabled) {
    await runWithTimeout(() => collectFormDiagnostics(page, diagnostics), 5_000, '收集禁用按钮诊断').catch(() => {})
    await runWithTimeout(
      () => safeScreenshot(page, testInfo.outputPath('login-button-disabled.png'), diagnostics),
      5_000,
      '禁用按钮截图',
    ).catch(() => {})
    // 给页面一个短观察窗口，但不再调用 page.waitForTimeout，避免页面被关闭时覆盖真正诊断。
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    await attachDiagnostics(testInfo, diagnostics)
    throw new Error('登录按钮在填入账号密码后仍未启用。')
  }

  await runStep('点击登录按钮', () => loginButton.click({ timeout: 10_000 }), 15_000)
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  await runWithTimeout(
    () => safeScreenshot(page, testInfo.outputPath('after-login-click.png'), diagnostics),
    5_000,
    '登录后截图',
  ).catch(() => {})

  await runWithTimeout(() => collectFormDiagnostics(page, diagnostics), 5_000, '收集登录后诊断').catch(() => {})
  const bodyText = diagnostics.pageText
  diagnostics.networkErrorVisible = bodyText.includes('网络较差，请稍后重试')

  await attachDiagnostics(testInfo, diagnostics)

  expect(diagnostics.networkErrorVisible, '检测到“网络较差，请稍后重试”').toBeFalsy()
})

const { defineConfig } = require('@playwright/test')

// WebKit 在远程页面的字体请求迟迟不结束时，截图会一直卡在 document.fonts.ready。
// CI 重点是记录页面状态，字体加载状态不应阻塞业务巡检。
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1'

module.exports = defineConfig({
  testDir: './tests',
  outputDir: 'test-results',
  // macOS WebKit 首次启动、加载远程字体和完成首屏渲染都可能明显慢于 Chromium。
  // 这里给整个测试留出足够时间，具体操作仍由各自的 timeout 控制。
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    browserName: 'webkit',
    headless: true,
    video: 'on',
    screenshot: 'on',
    trace: 'on',
  },
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
})

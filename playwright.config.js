const { defineConfig } = require('@playwright/test')

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

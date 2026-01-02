import * as Sentry from '@sentry/node'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.2,
  profilesSampleRate: 0.0,
  integrations: [nodeProfilingIntegration()],
})

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason)
})

export { Sentry }

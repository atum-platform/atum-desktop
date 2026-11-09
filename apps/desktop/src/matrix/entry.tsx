import '../styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ErrorBoundary } from '@/components/error-boundary'
import { I18nProvider } from '@/i18n'

import { MatrixApp } from './app'
import { applyMatrixMaterial } from './appearance'
import { MatrixCrashFallback } from './crash-fallback'
import { installMatrixDiagnostics, MatrixDesktopServicesBootstrap, reportMatrixRendererError } from './desktop-services'
import { MatrixLoginStartupMention } from './login-startup-settings'

// No legacy main.tsx, messaging composition, reporting or account synchronizer.
applyMatrixMaterial()
installMatrixDiagnostics()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider configClient={null}>
      <ErrorBoundary
        fallback={({ reset }) => <MatrixCrashFallback reset={reset} />}
        label="matrix"
        onError={reportMatrixRendererError}
      >
        <MatrixApp>
          <MatrixDesktopServicesBootstrap />
          <MatrixLoginStartupMention />
        </MatrixApp>
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>
)

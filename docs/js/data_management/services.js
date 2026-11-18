// The one place that picks the Google services: the fakes on localhost (FakeGoogle.js), the real
// ones elsewhere. On localhost the sign-in session (js/auth/AuthSession.js) also runs over fakes of
// the sign-in service and the provider's window, and keeps its tokens in memory. Database,
// ApplicationUtils and DropboxUtils use the services; the application layer uses only the session
// (re-exported by application/utils/auth.js).
import { isLocalhost } from './utils/helpers.js';
import { setConnectionProbe } from './utils/networkState.js';
import { AuthSession } from '../auth/AuthSession.js';

if (isLocalhost()) console.warn('Running locally, using fake Google services.');
// eslint-disable-next-line no-undef
const services = isLocalhost()
    ? await import('../google_sheets_services/FakeGoogle.js')
    : await import('../google_sheets_services/index.js');

export const { GoogleSheetsService, DropboxFiles } = services;
if (isLocalhost()) AuthSession.use(services.fakeSignIn);

export { AuthSession };
export { AUTH_STATUS, classifyError, isAuthError, isNetworkError, isIntegrityError } from '../auth/authStatus.js';

// The connection monitor asks the services whether Google answers (networkState.js)
setConnectionProbe(() => GoogleSheetsService.probeConnection());

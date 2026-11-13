// The one place that picks the Google services: the fakes on localhost (FakeGoogle.js), the real
// ones elsewhere. Database, ApplicationUtils and DropboxUtils use the services. The application
// layer uses only the sign-in session (GoogleSheetsAuth, re-exported by application/utils/auth.js).
import { isLocalhost } from './utils/helpers.js';
import { setConnectionProbe } from './utils/networkState.js';

if (isLocalhost()) console.warn('Running locally, using fake Google services.');
// eslint-disable-next-line no-undef
const services = isLocalhost()
    ? await import('../google_sheets_services/FakeGoogle.js')
    : await import('../google_sheets_services/index.js');

export const { GoogleSheetsService, GoogleSheetsAuth, DropboxFiles } = services;
export { AUTH_STATUS, classifyError, isAuthError, isNetworkError } from '../google_sheets_services/authStatus.js';

// The connection monitor asks the services whether Google answers (networkState.js)
setConnectionProbe(() => GoogleSheetsService.probeConnection());

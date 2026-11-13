/**
 * Google Sheets Services Index
 * 
 * This file exports either the real Google Sheets services or the fake/mock services
 * depending on the environment or configuration needs.
 * 
 * To switch between real and fake services, simply change the import path below.
 */

// Use fake/mock services for testing and development
// export { GoogleSheetsAuth, GoogleSheetsService } from './FakeGoogle.js';

// Use real Google Sheets services for production
export { GoogleSheetsAuth } from './GoogleSheetsAuth.js';
export { GoogleSheetsService } from './GoogleSheetsData.js';
export { DropboxFiles } from './DropboxFiles.js';

// Also export the query functionality
export { SheetSql } from './sheetSql.js';

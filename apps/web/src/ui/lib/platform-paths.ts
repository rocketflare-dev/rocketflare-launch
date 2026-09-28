/**
 * Where the deployment's own administration lives in the UI (`canAdministerPlatform`: a global
 * admin, or in single mode the organisation's owner/admin). One module so a link from anywhere —
 * the Create-app modal's public-URL hint, the nav, the old `/admin/*` redirects — never imports a
 * lazy page to learn a path.
 */
export const PLATFORM_SETTINGS_PATH = '/settings/platform'
export const PLATFORM_SETUP_PATH = `${PLATFORM_SETTINGS_PATH}/setup`
export const PLATFORM_IDENTITY_PATH = `${PLATFORM_SETTINGS_PATH}/identity`
export const PLATFORM_ACCESS_REQUESTS_PATH = `${PLATFORM_SETTINGS_PATH}/access-requests`
